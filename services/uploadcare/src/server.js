import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/uploadcare — a tiny, dependency-free fake of the Uploadcare Upload +
// REST APIs (collapsed onto a single host).
//
// Upload API:  POST /base/   (multipart, UPLOADCARE_PUB_KEY in body) -> { file }
// REST API:    GET /files/ , GET /files/:uuid/ , DELETE /files/:uuid/storage/
//              Header auth: Authorization: Uploadcare.Simple pub:secret
//
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

// Minimal multipart parser.
function parseMultipart(buffer, boundary) {
  const result = { fields: {}, files: [] };
  const delimiter = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(delimiter);
  if (start === -1) return result;
  start += delimiter.length;
  while (start < buffer.length) {
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break;
    if (buffer[start] === 0x0d) start += 2;
    const headerEnd = buffer.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(delimiter, bodyStart);
    const bodyEnd = next === -1 ? buffer.length : next - 2;
    const content = buffer.slice(bodyStart, bodyEnd);
    const nameMatch = headers.match(/name="([^"]*)"/i);
    const fileMatch = headers.match(/filename="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : "";
    if (fileMatch) result.files.push({ name, filename: fileMatch[1], content });
    else result.fields[name] = content.toString("utf8");
    if (next === -1) break;
    start = next + delimiter.length;
  }
  return result;
}

function newUuid() {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class UploadcareServer {
  constructor(port = 4840, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.files = new Map(); // uuid -> { meta, content }
  }

  fileMeta(uuid, name, content, mime) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    return {
      uuid,
      original_filename: name,
      original_file_url: `https://ucarecdn.com/${uuid}/${encodeURIComponent(name)}`,
      size: content.length,
      mime_type: mime || "application/octet-stream",
      is_image: /^image\//.test(mime || ""),
      is_ready: true,
      datetime_uploaded: now,
      datetime_stored: now,
      datetime_removed: null,
      content_info: {},
      metadata: {},
      url: `https://api.uploadcare.com/files/${uuid}/`,
      variations: null,
      source: null,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { detail: error.message || "internal error" });
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
    const raw = await this.readRaw(req);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-uploadcare");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { detail: "not found" });
    }

    const ctype = req.headers["content-type"] || "";

    // Upload API: POST /base/
    if (parts[0] === "base" && req.method === "POST") {
      return this.uploadBase(res, raw, ctype);
    }

    // REST API: /files/...
    if (parts[0] === "files") {
      if (!this.isRestAuthorized(req)) {
        return this.send(res, 401, { detail: "Incorrect authentication credentials." });
      }
      return this.handleFiles(req, res, parts.slice(1));
    }

    return this.send(res, 404, { detail: "not found" });
  }

  uploadBase(res, raw, ctype) {
    let pubKey = "";
    let filename = "file";
    let mime = "application/octet-stream";
    let content = Buffer.alloc(0);

    if (ctype.toLowerCase().includes("multipart/form-data")) {
      const boundary = this.boundaryOf(ctype);
      const parsed = parseMultipart(raw, boundary);
      pubKey = parsed.fields.UPLOADCARE_PUB_KEY || parsed.fields.pub_key || "";
      const fileField = parsed.files.find((f) => f.name === "file") || parsed.files[0];
      if (fileField) {
        content = fileField.content;
        filename = fileField.filename || filename;
        mime = this.mimeFromName(filename);
      }
    } else if (ctype.toLowerCase().includes("urlencoded")) {
      const params = new URLSearchParams(raw.toString("utf8"));
      pubKey = params.get("UPLOADCARE_PUB_KEY") || params.get("pub_key") || "";
      const f = params.get("file");
      if (f) {
        content = Buffer.from(f, "utf8");
        filename = "file";
      }
    }

    if (!pubKey) {
      return this.send(res, 401, { detail: "UPLOADCARE_PUB_KEY is required" });
    }

    const uuid = newUuid();
    this.files.set(uuid, { meta: this.fileMeta(uuid, filename, content, mime), content });
    // Uploadcare upload returns just { file: "<uuid>" } for a single file upload.
    return this.send(res, 200, { file: uuid });
  }

  handleFiles(req, res, route) {
    // GET /files/
    if (route.length === 0 && req.method === "GET") {
      const results = Array.from(this.files.values()).map((f) => f.meta);
      return this.send(res, 200, {
        next: null,
        previous: null,
        total: results.length,
        per_page: 100,
        results,
      });
    }

    const uuid = route[0];
    const record = this.files.get(uuid);

    // DELETE /files/:uuid/storage/
    if (route[1] === "storage" && req.method === "DELETE") {
      if (!record) return this.send(res, 404, { detail: "Not found." });
      record.meta.datetime_removed = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const meta = record.meta;
      this.files.delete(uuid);
      return this.send(res, 200, meta);
    }

    // GET /files/:uuid/
    if (route.length === 1 && req.method === "GET") {
      if (!record) return this.send(res, 404, { detail: "Not found." });
      return this.send(res, 200, record.meta);
    }
    // DELETE /files/:uuid/
    if (route.length === 1 && req.method === "DELETE") {
      if (!record) return this.send(res, 404, { detail: "Not found." });
      const meta = record.meta;
      this.files.delete(uuid);
      return this.send(res, 200, meta);
    }

    return this.send(res, 404, { detail: "Not found." });
  }

  mimeFromName(name) {
    const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
      txt: "text/plain", json: "application/json", mp4: "video/mp4",
    };
    return map[ext] || "application/octet-stream";
  }

  boundaryOf(ctype) {
    const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    return m ? (m[1] || m[2]).trim() : "";
  }

  root() {
    return { name: "uploadcare", version: "1", protocol: "uploadcare-rest", documentation: "/docs/uploadcare.md" };
  }

  isRestAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Uploadcare(\.Simple|\s)\s*\S+/i.test(auth);
  }

  readRaw(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => resolve(Buffer.alloc(0)));
    });
  }

  send(res, status, body) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
