import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/instagram — dependency-free fake of the Instagram Graph API.
//
// Implements the IG user node, media listing, the two-step publish flow
// (create container -> media_publish) using the real Graph wire shapes.
// access_token is accepted via ?access_token= query OR Authorization: Bearer.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function igError(message, type, code, subcode) {
  const error = {
    message,
    type,
    code,
    fbtrace_id: randomBytes(8).toString("base64").replace(/[+/=]/g, "").slice(0, 11),
  };
  if (subcode !== undefined) error.error_subcode = subcode;
  return { error };
}

function numericId() {
  let s = "";
  for (let i = 0; i < 17; i += 1) s += Math.floor(Math.random() * 10);
  return s;
}

export class InstagramServer {
  constructor(port = 4802, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.containers = new Map(); // creationId -> container
    this.media = new Map(); // mediaId -> media (with _igUserId)
    this._seedDefaults();
  }

  _seedDefaults() {
    this.igUser = {
      id: "17841400000000001",
      username: "parlel",
      name: "Parlel User",
      followers_count: 0,
      media_count: 0,
    };
    this._defaultIgUserId = this.igUser.id;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, igError(error.message || "Internal server error", "OAuthException", 1));
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
      if (!this.server) {
        resolve();
        return;
      }
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
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-instagram");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (!/^v\d+\.\d+$/.test(parts[0] || "")) {
      return this.send(res, 404, igError("Unknown path", "GraphMethodException", 100));
    }

    if (!this.isAuthorized(req, url, body)) {
      return this.send(res, 401, igError(
        "An active access token must be used to query information about the current user.",
        "OAuthException",
        2500,
      ));
    }

    const route = parts.slice(1);
    const nodeId = route[0];

    // Edges: /v18.0/:igUserId/media  or  /v18.0/:igUserId/media_publish
    if (route.length === 2) {
      const edge = route[1];

      // GET /v18.0/:igUserId/media
      if (req.method === "GET" && edge === "media") {
        const data = Array.from(this.media.values())
          .filter((m) => m._igUserId === nodeId)
          .map((m) => ({ id: m.id }));
        return this.send(res, 200, {
          data,
          paging: { cursors: { before: "MA", after: "MA" } },
        });
      }

      // POST /v18.0/:igUserId/media — create a container
      if (req.method === "POST" && edge === "media") {
        const data = isPlainObject(body) ? body : {};
        if (!data.image_url && !data.video_url && data.media_type !== "CAROUSEL" && !data.is_carousel_item) {
          return this.send(res, 400, igError(
            "The parameter image_url or video_url is required.",
            "OAuthException",
            100,
          ));
        }
        const id = numericId();
        this.containers.set(id, {
          id,
          _igUserId: nodeId,
          caption: data.caption || "",
          image_url: data.image_url,
          video_url: data.video_url,
          media_type: data.media_type || (data.video_url ? "VIDEO" : "IMAGE"),
          status_code: "FINISHED",
        });
        return this.send(res, 200, { id });
      }

      // POST /v18.0/:igUserId/media_publish — publish a container
      if (req.method === "POST" && edge === "media_publish") {
        const data = isPlainObject(body) ? body : {};
        const creationId = data.creation_id;
        if (!creationId || !this.containers.has(String(creationId))) {
          return this.send(res, 400, igError(
            "Media ID is not available",
            "OAuthException",
            9007,
            2207027,
          ));
        }
        const container = this.containers.get(String(creationId));
        const id = numericId();
        this.media.set(id, {
          id,
          _igUserId: nodeId,
          caption: container.caption,
          media_type: container.media_type,
          media_url: container.image_url || container.video_url,
          permalink: `https://www.instagram.com/p/${randomBytes(6).toString("base64").replace(/[+/=]/g, "").slice(0, 11)}/`,
          timestamp: new Date().toISOString(),
        });
        if (nodeId === this.igUser.id) this.igUser.media_count += 1;
        return this.send(res, 200, { id });
      }

      return this.send(res, 404, igError("Unsupported request.", "GraphMethodException", 100));
    }

    // GET /v18.0/:igUserId  (user node or a media node)
    if (req.method === "GET" && route.length === 1) {
      if (nodeId === this.igUser.id) {
        return this.send(res, 200, clone(this.igUser));
      }
      const m = this.media.get(nodeId);
      if (m) {
        return this.send(res, 200, {
          id: m.id,
          caption: m.caption,
          media_type: m.media_type,
          media_url: m.media_url,
          permalink: m.permalink,
          timestamp: m.timestamp,
        });
      }
      const c = this.containers.get(nodeId);
      if (c) {
        return this.send(res, 200, { id: c.id, status_code: c.status_code, status: "FINISHED" });
      }
      return this.send(res, 400, igError(
        `Unsupported get request. Object with ID '${nodeId}' does not exist`,
        "GraphMethodException",
        100,
        33,
      ));
    }

    return this.send(res, 404, igError("Unknown path", "GraphMethodException", 100));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "media") {
      return this.send(res, 200, {
        media: Array.from(this.media.values()).map(clone),
        count: this.media.size,
      });
    }
    if (req.method === "GET" && parts[1] === "containers") {
      return this.send(res, 200, {
        containers: Array.from(this.containers.values()).map(clone),
        count: this.containers.size,
      });
    }
    return this.send(res, 404, igError("not found", "GraphMethodException", 100));
  }

  root() {
    return {
      name: "instagram",
      version: "1",
      protocol: "instagram-graph",
      documentation: "/docs/instagram.md",
    };
  }

  isAuthorized(req, url, body) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    const qToken = url.searchParams.get("access_token");
    if (qToken && qToken.length > 0) return true;
    if (isPlainObject(body) && typeof body.access_token === "string" && body.access_token.length > 0) return true;
    return false;
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        const ct = (req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params.entries()) obj[k] = v;
          resolve(obj);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, igError("Bad request body", "OAuthException", 100));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, igError("Bad request body", "OAuthException", 100));
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
