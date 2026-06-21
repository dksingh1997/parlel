import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/dropbox — a tiny, dependency-free fake of the Dropbox API v2.
//
// Speaks the wire protocol used by the official Dropbox HTTP API and SDKs:
// RPC endpoints take a JSON body, content-upload/download endpoints carry the
// arguments in the `Dropbox-API-Arg` header with a raw binary body. State is
// in-memory and ephemeral.
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Dropbox error envelope: { error_summary, error: { ".tag": ... } }
function dbxError(summary, tagObj) {
  return { error_summary: summary, error: tagObj };
}

function normalizePath(p) {
  if (typeof p !== "string" || p === "") return "";
  let out = p.startsWith("/") ? p : `/${p}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function basename(p) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export class DropboxServer {
  constructor(port = 4836, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // path (lowercased) -> file record { meta, content: Buffer }
    this.files = new Map();
    this.idCounter = 0;
  }

  newId() {
    this.idCounter += 1;
    const tail = randomBytes(11).toString("base64").replace(/[+/=]/g, "").slice(0, 11);
    return `id:${tail}${this.idCounter}`;
  }

  fileMeta(path, content) {
    return {
      ".tag": "file",
      name: basename(path),
      path_lower: path.toLowerCase(),
      path_display: path,
      id: this.newId(),
      client_modified: now(),
      server_modified: now(),
      rev: randomBytes(9).toString("hex"),
      size: content.length,
      is_downloadable: true,
      content_hash: createHash("sha256").update(content).digest("hex"),
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, dbxError(error.message || "internal_error", { ".tag": "internal_error" }));
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Dropbox-API-Arg");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-dropbox");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.sendJson(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.sendJson(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.sendJson(res, 200, { ok: true });
      }
      return this.sendJson(res, 404, dbxError("not_found", { ".tag": "other" }));
    }

    if (!this.isAuthorized(req)) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 401;
      res.end("Error in call to API function: invalid access token");
      return;
    }

    const route = parts.join("/");
    let body = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = undefined; // not JSON (content endpoints use header arg)
      }
    }

    // Content endpoints — args in Dropbox-API-Arg header, raw body is content.
    if (req.method === "POST" && route === "2/files/upload") {
      return this.upload(req, res, raw);
    }
    if (req.method === "POST" && route === "2/files/download") {
      return this.download(req, res);
    }

    // RPC endpoints (JSON body)
    if (req.method === "POST" && route === "2/files/list_folder") {
      return this.listFolder(res, body);
    }
    if (req.method === "POST" && route === "2/files/list_folder/continue") {
      return this.sendJson(res, 200, { entries: [], cursor: "", has_more: false });
    }
    if (req.method === "POST" && route === "2/files/delete_v2") {
      return this.deleteV2(res, body);
    }
    if (req.method === "POST" && route === "2/files/get_metadata") {
      return this.getMetadata(res, body);
    }
    if (req.method === "POST" && route === "2/files/create_folder_v2") {
      return this.createFolder(res, body);
    }
    if (req.method === "POST" && route === "2/users/get_current_account") {
      return this.getCurrentAccount(res);
    }
    if (req.method === "POST" && route === "2/users/get_space_usage") {
      return this.sendJson(res, 200, {
        used: this.totalBytes(),
        allocation: { ".tag": "individual", allocated: 2147483648 },
      });
    }

    return this.sendJson(res, 409, dbxError("unknown_endpoint", { ".tag": "other" }));
  }

  totalBytes() {
    let n = 0;
    for (const f of this.files.values()) n += f.content.length;
    return n;
  }

  // POST /2/files/upload
  upload(req, res, raw) {
    const arg = this.parseApiArg(req);
    if (arg === undefined || typeof arg.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const path = normalizePath(arg.path);
    const meta = this.fileMeta(path, raw);
    this.files.set(path.toLowerCase(), { meta, content: raw });
    return this.sendJson(res, 200, meta);
  }

  // POST /2/files/download
  download(req, res) {
    const arg = this.parseApiArg(req);
    if (arg === undefined || typeof arg.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const key = normalizePath(arg.path).toLowerCase();
    const record = this.files.get(key);
    if (!record) {
      return this.sendJson(res, 409, dbxError("path/not_found/.", {
        ".tag": "path",
        path: { ".tag": "not_found" },
      }));
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Dropbox-API-Result", JSON.stringify(record.meta));
    res.statusCode = 200;
    res.end(record.content);
  }

  // POST /2/files/list_folder
  listFolder(res, body) {
    if (!isPlainObject(body) || typeof body.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const folder = normalizePath(body.path); // "" means root
    const prefix = folder === "" ? "/" : `${folder}/`;
    const entries = [];
    for (const record of this.files.values()) {
      const display = record.meta.path_display;
      if (folder === "") {
        // root: include all top-level files
        const rel = display.slice(1);
        if (!rel.includes("/")) entries.push(record.meta);
      } else if (display.toLowerCase().startsWith(prefix.toLowerCase())) {
        const rel = display.slice(prefix.length);
        if (!rel.includes("/")) entries.push(record.meta);
      }
    }
    return this.sendJson(res, 200, {
      entries,
      cursor: randomBytes(12).toString("base64").replace(/[+/=]/g, ""),
      has_more: false,
    });
  }

  // POST /2/files/delete_v2
  deleteV2(res, body) {
    if (!isPlainObject(body) || typeof body.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const key = normalizePath(body.path).toLowerCase();
    const record = this.files.get(key);
    if (!record) {
      return this.sendJson(res, 409, dbxError("path_lookup/not_found/.", {
        ".tag": "path_lookup",
        path_lookup: { ".tag": "not_found" },
      }));
    }
    this.files.delete(key);
    return this.sendJson(res, 200, { metadata: record.meta });
  }

  // POST /2/files/get_metadata
  getMetadata(res, body) {
    if (!isPlainObject(body) || typeof body.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const key = normalizePath(body.path).toLowerCase();
    const record = this.files.get(key);
    if (!record) {
      return this.sendJson(res, 409, dbxError("path/not_found/.", {
        ".tag": "path",
        path: { ".tag": "not_found" },
      }));
    }
    return this.sendJson(res, 200, record.meta);
  }

  // POST /2/files/create_folder_v2
  createFolder(res, body) {
    if (!isPlainObject(body) || typeof body.path !== "string") {
      return this.sendJson(res, 400, dbxError("bad_request", { ".tag": "other" }));
    }
    const path = normalizePath(body.path);
    return this.sendJson(res, 200, {
      metadata: {
        ".tag": "folder",
        name: basename(path),
        path_lower: path.toLowerCase(),
        path_display: path,
        id: this.newId(),
      },
    });
  }

  getCurrentAccount(res) {
    return this.sendJson(res, 200, {
      account_id: "dbid:parlel-account",
      name: {
        given_name: "Parlel",
        surname: "Tester",
        familiar_name: "Parlel",
        display_name: "Parlel Tester",
        abbreviated_name: "PT",
      },
      email: "tester@parlel.dev",
      email_verified: true,
      disabled: false,
      country: "US",
      locale: "en",
      referral_link: "https://db.tt/parlel",
      is_paired: false,
      account_type: { ".tag": "basic" },
    });
  }

  root() {
    return { name: "dropbox", version: "2", protocol: "dropbox-v2", documentation: "/docs/dropbox.md" };
  }

  parseApiArg(req) {
    const header = req.headers["dropbox-api-arg"];
    if (!header) return undefined;
    try {
      return JSON.parse(header);
    } catch {
      return undefined;
    }
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
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
    res.setHeader("Content-Type", "application/json");
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }

  send(res, status, body) {
    return this.sendJson(res, status, body);
  }
}
