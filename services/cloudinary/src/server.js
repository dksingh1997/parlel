import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/cloudinary — a tiny, dependency-free fake of the Cloudinary API.
//
// Speaks the Cloudinary upload + admin REST wire protocol so application code
// using the real `cloudinary` Node SDK can run against it. State is in-memory
// and ephemeral.
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function cldError(message) {
  return { error: { message } };
}

// Minimal multipart parser: returns { fields, files }.
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

export class CloudinaryServer {
  constructor(port = 4838, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    // public_id -> resource record
    this.resources = new Map();
    this.versionCounter = 1600000000;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, cldError(error.message || "internal error"));
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
    res.setHeader("server", "parlel-cloudinary");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, cldError("not found"));
    }

    // All routes: /v1_1/:cloud_name/...
    if (parts[0] !== "v1_1" || parts.length < 2) {
      return this.send(res, 404, cldError("not found"));
    }
    const cloudName = parts[1];
    const route = parts.slice(2);
    const ctype = req.headers["content-type"] || "";
    const fields = this.parseFields(raw, ctype);

    // POST /v1_1/:cloud/image/upload
    if (req.method === "POST" && route[0] === "image" && route[1] === "upload") {
      return this.upload(res, req, raw, ctype, fields, cloudName);
    }
    // POST /v1_1/:cloud/image/destroy
    if (req.method === "POST" && route[0] === "image" && route[1] === "destroy") {
      if (!this.isAuthorized(req, fields)) return this.unauthorized(res);
      return this.destroy(res, fields);
    }
    // GET /v1_1/:cloud/resources/image/upload/:public_id
    if (req.method === "GET" && route[0] === "resources" && route[1] === "image" && route[2] === "upload" && route[3]) {
      if (!this.isAuthorized(req, fields)) return this.unauthorized(res);
      const record = this.resources.get(route.slice(3).join("/"));
      if (!record) return this.send(res, 404, cldError("Resource not found"));
      return this.send(res, 200, record);
    }
    // GET /v1_1/:cloud/resources/image  (admin)
    if (req.method === "GET" && route[0] === "resources" && route[1] === "image") {
      if (!this.isAuthorized(req, fields)) return this.unauthorized(res);
      return this.listResources(res, cloudName);
    }

    return this.send(res, 404, cldError("not found"));
  }

  upload(res, req, raw, ctype, fields, cloudName) {
    // Upload accepts an unsigned preset, a signature, or admin auth.
    const hasAuth = this.isAuthorized(req, fields);
    const hasPreset = typeof fields.upload_preset === "string" && fields.upload_preset.length > 0;
    const hasSignature = typeof fields.signature === "string" && fields.signature.length > 0;
    if (!hasAuth && !hasPreset && !hasSignature) {
      return this.unauthorized(res);
    }

    // Resolve the file content + an inferred format.
    let bytes = 0;
    let format = "png";
    if (ctype.toLowerCase().includes("multipart/form-data")) {
      const boundary = this.boundaryOf(ctype);
      const parsed = parseMultipart(raw, boundary);
      const fileField = parsed.files.find((f) => f.name === "file") || parsed.files[0];
      if (fileField) {
        bytes = fileField.content.length;
        format = this.formatFromName(fileField.filename) || format;
      } else if (typeof parsed.fields.file === "string") {
        bytes = Buffer.byteLength(parsed.fields.file);
        format = this.formatFromName(parsed.fields.file) || format;
      }
    } else if (typeof fields.file === "string") {
      bytes = Buffer.byteLength(fields.file);
      format = this.formatFromName(fields.file) || format;
    }

    const publicId = typeof fields.public_id === "string" && fields.public_id
      ? fields.public_id
      : randomBytes(10).toString("base64").replace(/[+/=]/g, "").slice(0, 20);
    this.versionCounter += 1;
    const version = this.versionCounter;
    const width = 800;
    const height = 600;
    const resource = {
      asset_id: createHash("md5").update(publicId + version).digest("hex"),
      public_id: publicId,
      version,
      version_id: createHash("md5").update(String(version)).digest("hex"),
      signature: createHash("sha1").update(publicId + version).digest("hex"),
      width,
      height,
      format,
      resource_type: "image",
      created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      tags: [],
      bytes: bytes || 1024,
      type: "upload",
      etag: createHash("md5").update(publicId).digest("hex").slice(0, 16),
      placeholder: false,
      url: `http://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.${format}`,
      secure_url: `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.${format}`,
      asset_folder: "",
      display_name: publicId,
      original_filename: publicId,
    };
    this.resources.set(publicId, resource);
    return this.send(res, 200, resource);
  }

  destroy(res, fields) {
    const publicId = fields.public_id;
    if (typeof publicId !== "string" || !publicId) {
      return this.send(res, 400, cldError("Missing required parameter - public_id"));
    }
    if (this.resources.has(publicId)) {
      this.resources.delete(publicId);
      return this.send(res, 200, { result: "ok" });
    }
    return this.send(res, 200, { result: "not found" });
  }

  listResources(res, cloudName) {
    const resources = Array.from(this.resources.values()).map((r) => ({
      asset_id: r.asset_id,
      public_id: r.public_id,
      format: r.format,
      version: r.version,
      resource_type: r.resource_type,
      type: r.type,
      created_at: r.created_at,
      bytes: r.bytes,
      width: r.width,
      height: r.height,
      url: r.url,
      secure_url: r.secure_url,
    }));
    return this.send(res, 200, { resources, rate_limit_allowed: 500, rate_limit_remaining: 499 });
  }

  formatFromName(name) {
    const m = String(name).match(/\.([a-z0-9]+)(?:$|\?)/i);
    return m ? m[1].toLowerCase() : null;
  }

  boundaryOf(ctype) {
    const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    return m ? (m[1] || m[2]).trim() : "";
  }

  parseFields(raw, ctype) {
    const lc = ctype.toLowerCase();
    if (lc.includes("application/json")) {
      try { return JSON.parse(raw.toString("utf8")); } catch { return {}; }
    }
    if (lc.includes("application/x-www-form-urlencoded")) {
      const out = {};
      for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) out[k] = v;
      return out;
    }
    if (lc.includes("multipart/form-data")) {
      const parsed = parseMultipart(raw, this.boundaryOf(ctype));
      return { ...parsed.fields };
    }
    return {};
  }

  root() {
    return { name: "cloudinary", version: "1", protocol: "cloudinary-v1_1", documentation: "/docs/cloudinary.md" };
  }

  isAuthorized(req, fields) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Basic\s+\S+/i.test(auth)) return true;
    // Some clients pass api_key in the body for upload-time admin actions.
    if (fields && typeof fields.api_key === "string" && fields.api_key) return true;
    return false;
  }

  unauthorized(res) {
    return this.send(res, 401, cldError("Invalid credentials"));
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
