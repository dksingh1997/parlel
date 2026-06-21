import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mux — a tiny, dependency-free fake of the Mux Video API.
//
// Speaks the Mux REST wire protocol ({ data } envelopes, Basic auth with
// token id:secret) so application code using the real `@mux/mux-node` SDK can
// run against it. State is in-memory and ephemeral. Newly-created assets are
// immediately "ready" (no real ingest/encoding happens).
// ---------------------------------------------------------------------------

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function muxError(messages) {
  return { error: { type: "invalid_parameters", messages: Array.isArray(messages) ? messages : [messages] } };
}

function newId() {
  return randomBytes(18).toString("hex");
}

export class MuxServer {
  constructor(port = 4839, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.assets = new Map();
    this.uploads = new Map();
  }

  makeAsset(input, passthrough, playbackPolicy) {
    const id = newId();
    const policies = Array.isArray(playbackPolicy)
      ? playbackPolicy
      : [playbackPolicy || "public"];
    const playback_ids = policies.map((policy) => ({ id: newId(), policy }));
    const asset = {
      id,
      status: "ready",
      created_at: String(Math.floor(Date.now() / 1000)),
      duration: 23.4,
      max_stored_resolution: "HD",
      max_stored_frame_rate: 30,
      aspect_ratio: "16:9",
      playback_ids,
      mp4_support: "none",
      master_access: "none",
      encoding_tier: "smart",
      tracks: [
        { type: "video", id: newId(), duration: 23.4, max_width: 1280, max_height: 720 },
        { type: "audio", id: newId(), duration: 23.4, max_channels: 2 },
      ],
    };
    if (input) asset.input = input;
    if (passthrough) asset.passthrough = passthrough;
    this.assets.set(id, asset);
    return asset;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, muxError(error.message || "internal error"));
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
    res.setHeader("server", "parlel-mux");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, muxError("not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, muxError("Unauthorized"));
    }

    let body = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
    }

    // /video/v1/assets ...
    if (parts[0] === "video" && parts[1] === "v1" && parts[2] === "assets") {
      return this.handleAssets(req, res, parts.slice(3), body);
    }
    // /video/v1/uploads ...
    if (parts[0] === "video" && parts[1] === "v1" && parts[2] === "uploads") {
      return this.handleUploads(req, res, parts.slice(3), body);
    }

    return this.send(res, 404, muxError("not found"));
  }

  handleAssets(req, res, route, body) {
    // POST /video/v1/assets
    if (route.length === 0 && req.method === "POST") {
      const input = body.input;
      const policy = body.playback_policy ?? body.playback_policies;
      const asset = this.makeAsset(input, body.passthrough, policy);
      return this.send(res, 201, { data: asset });
    }
    // GET /video/v1/assets
    if (route.length === 0 && req.method === "GET") {
      return this.send(res, 200, { data: Array.from(this.assets.values()) });
    }

    const id = route[0];
    const asset = this.assets.get(id);

    // GET /video/v1/assets/:id/playback-ids
    if (route[1] === "playback-ids" && route.length === 2) {
      if (!asset) return this.send(res, 404, muxError("Asset not found"));
      if (req.method === "GET") {
        return this.send(res, 200, { data: asset.playback_ids });
      }
      if (req.method === "POST") {
        const pid = { id: newId(), policy: body.policy || "public" };
        asset.playback_ids.push(pid);
        return this.send(res, 201, { data: pid });
      }
    }

    if (!asset) return this.send(res, 404, muxError("Asset not found"));

    // GET /video/v1/assets/:id
    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { data: asset });
    }
    // DELETE /video/v1/assets/:id
    if (route.length === 1 && req.method === "DELETE") {
      this.assets.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, muxError("method not allowed"));
  }

  handleUploads(req, res, route, body) {
    // POST /video/v1/uploads — direct upload URL
    if (route.length === 0 && req.method === "POST") {
      const id = newId();
      const upload = {
        id,
        status: "waiting",
        url: `https://storage.googleapis.com/parlel-mux-upload/${id}`,
        timeout: 3600,
        new_asset_settings: isPlainObject(body.new_asset_settings) ? body.new_asset_settings : {},
        cors_origin: body.cors_origin || "*",
      };
      this.uploads.set(id, upload);
      return this.send(res, 201, { data: upload });
    }
    // GET /video/v1/uploads
    if (route.length === 0 && req.method === "GET") {
      return this.send(res, 200, { data: Array.from(this.uploads.values()) });
    }

    const id = route[0];
    const upload = this.uploads.get(id);
    if (!upload) return this.send(res, 404, muxError("Upload not found"));

    if (route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { data: upload });
    }
    if (route[1] === "cancel" && req.method === "PUT") {
      upload.status = "cancelled";
      return this.send(res, 200, { data: upload });
    }
    return this.send(res, 405, muxError("method not allowed"));
  }

  root() {
    return { name: "mux", version: "1", protocol: "mux-video-v1", documentation: "/docs/mux.md" };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    return /^Basic\s+\S+/i.test(req.headers.authorization || "");
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
