import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/box — a tiny, dependency-free fake of the Box Content API v2.
//
// Speaks the Box REST wire protocol (folders, files, upload via multipart,
// download, users) so application code using the real `box-node-sdk` can run
// against it. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString().replace(/\.\d+Z$/, "-00:00");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boxError(status, code, message) {
  return {
    type: "error",
    status,
    code,
    message,
    request_id: createHash("md5").update(String(Math.random())).digest("hex").slice(0, 12),
  };
}

// Minimal multipart/form-data parser. Returns { fields: {}, files: [{name, filename, content}] }.
function parseMultipart(buffer, boundary) {
  const result = { fields: {}, files: [] };
  const delimiter = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(delimiter);
  if (start === -1) return result;
  start += delimiter.length;
  while (start < buffer.length) {
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // closing --
    // skip CRLF
    if (buffer[start] === 0x0d) start += 2;
    const headerEnd = buffer.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(delimiter, bodyStart);
    const bodyEnd = next === -1 ? buffer.length : next - 2; // strip trailing CRLF
    const content = buffer.slice(bodyStart, bodyEnd);
    const nameMatch = headers.match(/name="([^"]*)"/i);
    const fileMatch = headers.match(/filename="([^"]*)"/i);
    const name = nameMatch ? nameMatch[1] : "";
    if (fileMatch) {
      result.files.push({ name, filename: fileMatch[1], content });
    } else {
      result.fields[name] = content.toString("utf8");
    }
    if (next === -1) break;
    start = next + delimiter.length;
  }
  return result;
}

export class BoxServer {
  constructor(port = 4837, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.folders = new Map(); // id -> folder
    this.files = new Map(); // id -> { meta, content }
    this.idCounter = 1000;
    // Seed the root folder ("0").
    this.folders.set("0", {
      type: "folder",
      id: "0",
      name: "All Files",
      created_at: now(),
      modified_at: now(),
      parent: null,
      item_collection: { total_count: 0, entries: [] },
    });
  }

  newId() {
    this.idCounter += 1;
    return String(this.idCounter);
  }

  fileMeta(id, name, parentId, content) {
    return {
      type: "file",
      id,
      name,
      size: content.length,
      sha1: createHash("sha1").update(content).digest("hex"),
      created_at: now(),
      modified_at: now(),
      description: "",
      parent: { type: "folder", id: parentId, name: this.folders.get(parentId)?.name || "All Files" },
      item_status: "active",
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, boxError(500, "internal_server_error", error.message || "error"));
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
    res.setHeader("server", "parlel-box");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, boxError(404, "not_found", "not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, boxError(401, "unauthorized", "Access token not found"));
    }

    if (parts[0] !== "2.0") return this.send(res, 404, boxError(404, "not_found", "not found"));
    const route = parts.slice(1);
    const ctype = req.headers["content-type"] || "";
    let body = {};
    if (raw.length && ctype.toLowerCase().includes("application/json")) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }

    // Folders
    if (route[0] === "folders") return this.handleFolders(req, res, route, body, url);
    // Files
    if (route[0] === "files") return this.handleFiles(req, res, route, body, raw, ctype);
    // Users
    if (route[0] === "users" && route[1] === "me") return this.handleUsersMe(res);

    return this.send(res, 404, boxError(404, "not_found", "not found"));
  }

  handleFolders(req, res, route, body, url) {
    // POST /2.0/folders — create folder
    if (route.length === 1 && req.method === "POST") {
      if (!isPlainObject(body) || typeof body.name !== "string" || !body.name) {
        return this.send(res, 400, boxError(400, "bad_request", "name is required"));
      }
      const parentId = body.parent?.id ?? "0";
      const id = this.newId();
      const folder = {
        type: "folder",
        id,
        name: body.name,
        created_at: now(),
        modified_at: now(),
        parent: { type: "folder", id: parentId, name: this.folders.get(parentId)?.name || "All Files" },
        item_collection: { total_count: 0, entries: [] },
      };
      this.folders.set(id, folder);
      return this.send(res, 201, folder);
    }

    const id = route[1];
    if (!id) return this.send(res, 404, boxError(404, "not_found", "not found"));

    // GET /2.0/folders/:id/items
    if (route[2] === "items" && req.method === "GET") {
      const folder = this.folders.get(id);
      if (!folder) return this.send(res, 404, boxError(404, "not_found", "Folder not found"));
      const entries = [];
      for (const f of this.folders.values()) {
        if (f.parent?.id === id) entries.push({ type: "folder", id: f.id, name: f.name });
      }
      for (const f of this.files.values()) {
        if (f.meta.parent?.id === id) entries.push({ type: "file", id: f.meta.id, name: f.meta.name });
      }
      return this.send(res, 200, { total_count: entries.length, entries, offset: 0, limit: 100 });
    }

    const folder = this.folders.get(id);
    if (!folder) return this.send(res, 404, boxError(404, "not_found", "Folder not found"));

    if (req.method === "GET") return this.send(res, 200, folder);
    if (req.method === "PUT") {
      if (isPlainObject(body) && typeof body.name === "string") folder.name = body.name;
      folder.modified_at = now();
      return this.send(res, 200, folder);
    }
    if (req.method === "DELETE") {
      this.folders.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, boxError(405, "method_not_allowed", "method not allowed"));
  }

  handleFiles(req, res, route, body, raw, ctype) {
    // POST /2.0/files/content — upload
    if (route[1] === "content" && route.length === 2 && req.method === "POST") {
      return this.uploadFile(res, raw, ctype, body);
    }

    const id = route[1];
    if (!id) return this.send(res, 404, boxError(404, "not_found", "not found"));
    const record = this.files.get(id);

    // GET /2.0/files/:id/content — download
    if (route[2] === "content" && req.method === "GET") {
      if (!record) return this.send(res, 404, boxError(404, "not_found", "File not found"));
      res.setHeader("Content-Type", "application/octet-stream");
      res.statusCode = 200;
      return res.end(record.content);
    }

    if (!record) return this.send(res, 404, boxError(404, "not_found", "File not found"));

    // GET /2.0/files/:id
    if (route.length === 2 && req.method === "GET") {
      return this.send(res, 200, record.meta);
    }
    // PUT /2.0/files/:id — update metadata
    if (route.length === 2 && req.method === "PUT") {
      if (isPlainObject(body) && typeof body.name === "string") record.meta.name = body.name;
      record.meta.modified_at = now();
      return this.send(res, 200, record.meta);
    }
    // DELETE /2.0/files/:id
    if (route.length === 2 && req.method === "DELETE") {
      this.files.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, boxError(405, "method_not_allowed", "method not allowed"));
  }

  uploadFile(res, raw, ctype, jsonBody) {
    let name = "file";
    let parentId = "0";
    let content = Buffer.alloc(0);

    if (ctype.toLowerCase().includes("multipart/form-data")) {
      const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : "";
      const parsed = parseMultipart(raw, boundary);
      if (parsed.fields.attributes) {
        try {
          const attrs = JSON.parse(parsed.fields.attributes);
          if (typeof attrs.name === "string") name = attrs.name;
          if (attrs.parent?.id) parentId = String(attrs.parent.id);
        } catch { /* ignore */ }
      }
      if (parsed.files.length) {
        content = parsed.files[0].content;
        if (parsed.files[0].filename && name === "file") name = parsed.files[0].filename;
      }
    } else if (isPlainObject(jsonBody)) {
      // Convenience: JSON { name, parent_id, content }
      if (typeof jsonBody.name === "string") name = jsonBody.name;
      if (jsonBody.parent?.id) parentId = String(jsonBody.parent.id);
      else if (jsonBody.parent_id) parentId = String(jsonBody.parent_id);
      content = Buffer.from(jsonBody.content ?? "", "utf8");
    } else {
      content = raw;
    }

    const id = this.newId();
    const meta = this.fileMeta(id, name, parentId, content);
    this.files.set(id, { meta, content });
    return this.send(res, 201, { total_count: 1, entries: [meta] });
  }

  handleUsersMe(res) {
    return this.send(res, 200, {
      type: "user",
      id: "10000001",
      name: "Parlel Tester",
      login: "tester@parlel.dev",
      created_at: now(),
      modified_at: now(),
      language: "en",
      status: "active",
      space_amount: 10737418240,
      space_used: 0,
    });
  }

  root() {
    return { name: "box", version: "2.0", protocol: "box-v2", documentation: "/docs/box.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
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
