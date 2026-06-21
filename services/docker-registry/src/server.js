import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/docker-registry — a dependency-free fake of the Docker Registry HTTP
// API V2 (the protocol `docker push` / `docker pull` / skopeo speak).
//
// Implements enough of the V2 distribution spec to list, push and pull
// manifest metadata: the API version check, catalog, tag list, manifest
// HEAD/GET/PUT, and the blob upload session (POST/PUT). Returns the
// `Docker-Content-Digest` header. State is in-memory, ephemeral and resettable.
// No auth required (a Bearer token is accepted but not enforced).
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function digestOf(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

const SENTINEL_BAD_BODY = Symbol("bad-body");

export class DockerRegistryServer {
  constructor(port = 4775, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    this.reset();
  }

  reset() {
    // name -> { manifests: Map<reference, {digest, body, contentType}>, tags: Set, blobs: Map<digest,buf>, uploads: Map }
    this.repositories = new Map();
    this._seed();
  }

  _repo(name) {
    if (!this.repositories.has(name)) {
      this.repositories.set(name, { manifests: new Map(), tags: new Set(), blobs: new Map(), uploads: new Map() });
    }
    return this.repositories.get(name);
  }

  _seed() {
    const repo = this._repo("library/hello-world");
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { mediaType: "application/vnd.docker.container.image.v1+json", size: 7023, digest: digestOf(Buffer.from("config")) },
      layers: [],
    }));
    const digest = digestOf(body);
    repo.manifests.set("latest", { digest, body, contentType: "application/vnd.docker.distribution.manifest.v2+json" });
    repo.manifests.set(digest, { digest, body, contentType: "application/vnd.docker.distribution.manifest.v2+json" });
    repo.tags.add("latest");
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendJson(res, 500, { errors: [{ code: "UNKNOWN", message: error.message || "server error" }] });
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const buf = await this.readRaw(req);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, HEAD, DELETE, OPTIONS");
    res.setHeader("Docker-Distribution-Api-Version", "registry/2.0");
    res.setHeader("server", "parlel-docker-registry");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.sendJson(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.sendJson(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2") return this.sendJson(res, 404, this.notFound());

    // GET /v2/  -> API version check, 200 {}
    if (parts.length === 1) {
      if (req.method === "GET" || req.method === "HEAD") return this.sendJson(res, 200, {});
      return this.sendJson(res, 405, this.notFound());
    }

    // GET /v2/_catalog
    if (parts.length === 2 && parts[1] === "_catalog" && req.method === "GET") {
      return this.sendJson(res, 200, { repositories: [...this.repositories.keys()] });
    }

    // Trailing-segment routing: /v2/<name...>/(tags/list | manifests/<ref> | blobs/uploads | blobs/<digest>)
    const v2 = parts.slice(1);

    // tags/list
    const tagsIdx = this._lastIndexOfPair(v2, "tags", "list");
    if (tagsIdx >= 0) {
      const name = v2.slice(0, tagsIdx).join("/");
      const repo = this.repositories.get(name);
      if (!repo) return this.sendJson(res, 404, this.nameUnknown());
      return this.sendJson(res, 200, { name, tags: [...repo.tags] });
    }

    // manifests/<reference>
    const manIdx = v2.lastIndexOf("manifests");
    if (manIdx >= 0 && manIdx === v2.length - 2) {
      const name = v2.slice(0, manIdx).join("/");
      const reference = v2[v2.length - 1];
      return this.handleManifest(req, res, name, reference, buf);
    }

    // blobs/uploads  (POST starts an upload; PUT completes it)
    const blobsIdx = v2.lastIndexOf("blobs");
    if (blobsIdx >= 0 && v2[blobsIdx + 1] === "uploads") {
      const name = v2.slice(0, blobsIdx).join("/");
      return this.handleBlobUpload(req, res, name, v2.slice(blobsIdx + 2), url, buf);
    }

    // blobs/<digest>  (GET/HEAD pull a blob)
    if (blobsIdx >= 0 && blobsIdx === v2.length - 2) {
      const name = v2.slice(0, blobsIdx).join("/");
      const digest = v2[v2.length - 1];
      const repo = this.repositories.get(name);
      const blob = repo && repo.blobs.get(digest);
      if (!blob) return this.sendJson(res, 404, this.blobUnknown());
      res.setHeader("Docker-Content-Digest", digest);
      res.setHeader("Content-Type", "application/octet-stream");
      if (req.method === "HEAD") return this.send(res, 200, null);
      return this.sendRaw(res, 200, blob);
    }

    return this.sendJson(res, 404, this.notFound());
  }

  handleManifest(req, res, name, reference, buf) {
    const repo = this.repositories.get(name);

    if (req.method === "PUT") {
      const r = this._repo(name);
      const body = buf && buf.length ? buf : Buffer.from("{}");
      const digest = digestOf(body);
      const contentType = req.headers["content-type"] || "application/vnd.docker.distribution.manifest.v2+json";
      const record = { digest, body, contentType };
      r.manifests.set(reference, record);
      r.manifests.set(digest, record);
      if (!reference.startsWith("sha256:")) r.tags.add(reference);
      res.setHeader("Docker-Content-Digest", digest);
      res.setHeader("Location", `/v2/${name}/manifests/${digest}`);
      return this.send(res, 201, null);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (!repo) return this.sendJson(res, 404, this.manifestUnknown());
      const record = repo.manifests.get(reference);
      if (!record) return this.sendJson(res, 404, this.manifestUnknown());
      res.setHeader("Docker-Content-Digest", record.digest);
      res.setHeader("Content-Type", record.contentType);
      if (req.method === "HEAD") return this.send(res, 200, null);
      return this.sendRaw(res, 200, record.body);
    }

    return this.sendJson(res, 405, this.notFound());
  }

  handleBlobUpload(req, res, name, sub, url, buf) {
    const repo = this._repo(name);

    // POST /v2/<name>/blobs/uploads/  -> start session (or monolithic with ?digest=)
    if (req.method === "POST" && sub.length === 0) {
      const digestParam = url.searchParams.get("digest");
      if (digestParam && buf && buf.length) {
        repo.blobs.set(digestParam, buf);
        res.setHeader("Docker-Content-Digest", digestParam);
        res.setHeader("Location", `/v2/${name}/blobs/${digestParam}`);
        return this.send(res, 201, null);
      }
      const uuid = randomUUID();
      repo.uploads.set(uuid, Buffer.alloc(0));
      res.setHeader("Location", `/v2/${name}/blobs/uploads/${uuid}`);
      res.setHeader("Docker-Upload-Uuid", uuid);
      res.setHeader("Range", "0-0");
      return this.send(res, 202, null);
    }

    // PUT /v2/<name>/blobs/uploads/<uuid>?digest=...  -> complete upload
    if (req.method === "PUT" && sub.length === 1) {
      const uuid = sub[0];
      const prior = repo.uploads.get(uuid) || Buffer.alloc(0);
      const full = buf && buf.length ? Buffer.concat([prior, buf]) : prior;
      const digest = url.searchParams.get("digest") || digestOf(full);
      repo.blobs.set(digest, full);
      repo.uploads.delete(uuid);
      res.setHeader("Docker-Content-Digest", digest);
      res.setHeader("Location", `/v2/${name}/blobs/${digest}`);
      return this.send(res, 201, null);
    }

    // PATCH-style chunk upload via PUT to session without digest -> accumulate
    if (req.method === "PATCH" && sub.length === 1) {
      const uuid = sub[0];
      const prior = repo.uploads.get(uuid) || Buffer.alloc(0);
      repo.uploads.set(uuid, buf && buf.length ? Buffer.concat([prior, buf]) : prior);
      res.setHeader("Location", `/v2/${name}/blobs/uploads/${uuid}`);
      res.setHeader("Docker-Upload-Uuid", uuid);
      return this.send(res, 202, null);
    }

    return this.sendJson(res, 404, this.notFound());
  }

  _lastIndexOfPair(arr, a, b) {
    for (let i = arr.length - 2; i >= 0; i--) {
      if (arr[i] === a && arr[i + 1] === b && i + 1 === arr.length - 1) return i;
    }
    return -1;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "repositories") {
      return this.sendJson(res, 200, { repositories: [...this.repositories.keys()], count: this.repositories.size });
    }
    return this.sendJson(res, 404, this.notFound());
  }

  root() {
    return {
      name: "docker-registry",
      version: "1",
      protocol: "docker-registry-v2",
      api_url: `http://${this.host}:${this.port}/v2`,
      documentation: "/docs/docker-registry.md",
    };
  }

  notFound() {
    return { errors: [{ code: "UNSUPPORTED", message: "The operation is unsupported." }] };
  }
  nameUnknown() {
    return { errors: [{ code: "NAME_UNKNOWN", message: "repository name not known to registry" }] };
  }
  manifestUnknown() {
    return { errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] };
  }
  blobUnknown() {
    return { errors: [{ code: "BLOB_UNKNOWN", message: "blob unknown to registry" }] };
  }

  readRaw(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(Buffer.alloc(0)));
    });
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }

  sendRaw(res, status, buf) {
    res.statusCode = status;
    res.end(buf);
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
