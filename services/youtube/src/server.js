import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/youtube — dependency-free fake of the YouTube Data API v3.
//
// Implements channels, videos, search, playlists, and playlistItems using the
// real { kind, etag, items, pageInfo } wire shapes. Auth via ?key= query OR an
// Authorization: Bearer header. State is in-memory and ephemeral.
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

function etag() {
  return `"${randomBytes(12).toString("base64").replace(/[+/=]/g, "").slice(0, 16)}"`;
}

// YouTube/Google API error envelope: { error: { code, message, errors: [...] } }
function ytError(code, message, reason) {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain: "youtube", reason }],
    },
  };
}

function listResponse(kind, items, totalResults) {
  return {
    kind: `youtube#${kind}`,
    etag: etag(),
    items,
    pageInfo: {
      totalResults: typeof totalResults === "number" ? totalResults : items.length,
      resultsPerPage: items.length,
    },
  };
}

export class YoutubeServer {
  constructor(port = 4803, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.playlists = new Map();
    this.playlistCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    this.channel = {
      kind: "youtube#channel",
      etag: etag(),
      id: "UCparlel000000000000001",
      snippet: {
        title: "Parlel Channel",
        description: "The parlel test channel.",
        customUrl: "@parlel",
        publishedAt: "2020-01-01T00:00:00Z",
        thumbnails: { default: { url: "https://yt3.ggpht.com/parlel/default.jpg" } },
      },
      contentDetails: {
        relatedPlaylists: { likes: "", uploads: "UUparlel000000000000001" },
      },
      statistics: { viewCount: "0", subscriberCount: "0", videoCount: "0" },
    };
    this.videos = new Map();
    const v = {
      kind: "youtube#video",
      etag: etag(),
      id: "parlelVid001",
      snippet: {
        publishedAt: "2021-06-01T00:00:00Z",
        channelId: this.channel.id,
        title: "Welcome to Parlel",
        description: "Sample video.",
        thumbnails: { default: { url: "https://i.ytimg.com/vi/parlelVid001/default.jpg" } },
        channelTitle: "Parlel Channel",
      },
      contentDetails: { duration: "PT3M30S", definition: "hd" },
      statistics: { viewCount: "1234", likeCount: "100", commentCount: "5" },
    };
    this.videos.set(v.id, v);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, ytError(500, error.message || "Internal server error", "internalError"));
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
    res.setHeader("server", "parlel-youtube");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // /youtube/v3/...
    if (parts[0] !== "youtube" || parts[1] !== "v3") {
      return this.send(res, 404, ytError(404, "Not Found", "notFound"));
    }

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, ytError(
        401,
        "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
        "authError",
      ));
    }

    const resource = parts[2];
    const q = url.searchParams;

    // GET /youtube/v3/channels
    if (req.method === "GET" && resource === "channels") {
      return this.send(res, 200, listResponse("channelListResponse", [clone(this.channel)], 1));
    }

    // GET /youtube/v3/videos?id=...
    if (req.method === "GET" && resource === "videos") {
      const ids = (q.get("id") || "").split(",").map((s) => s.trim()).filter(Boolean);
      let items;
      if (ids.length === 0) {
        items = Array.from(this.videos.values()).map(clone);
      } else {
        items = ids.map((id) => this.videos.get(id)).filter(Boolean).map(clone);
      }
      return this.send(res, 200, listResponse("videoListResponse", items, items.length));
    }

    // GET /youtube/v3/search?q=...
    if (req.method === "GET" && resource === "search") {
      const query = q.get("q") || "";
      const items = Array.from(this.videos.values()).map((v) => ({
        kind: "youtube#searchResult",
        etag: etag(),
        id: { kind: "youtube#video", videoId: v.id },
        snippet: {
          publishedAt: v.snippet.publishedAt,
          channelId: v.snippet.channelId,
          title: v.snippet.title,
          description: v.snippet.description,
          thumbnails: v.snippet.thumbnails,
          channelTitle: v.snippet.channelTitle,
        },
      }));
      const result = listResponse("searchListResponse", items, items.length);
      result.regionCode = "US";
      result._query = undefined;
      delete result._query;
      void query;
      return this.send(res, 200, result);
    }

    // POST /youtube/v3/playlists
    if (req.method === "POST" && resource === "playlists") {
      const snippet = isPlainObject(body) ? body.snippet : undefined;
      if (!isPlainObject(snippet) || typeof snippet.title !== "string" || !snippet.title) {
        return this.send(res, 400, ytError(400, "The playlist snippet must include a title.", "required"));
      }
      this.playlistCounter += 1;
      const id = `PLparlel${String(this.playlistCounter).padStart(10, "0")}`;
      const playlist = {
        kind: "youtube#playlist",
        etag: etag(),
        id,
        snippet: {
          publishedAt: new Date().toISOString(),
          channelId: this.channel.id,
          title: snippet.title,
          description: snippet.description || "",
          thumbnails: {},
          channelTitle: "Parlel Channel",
        },
        status: { privacyStatus: (isPlainObject(body) && isPlainObject(body.status) && body.status.privacyStatus) || "private" },
        contentDetails: { itemCount: 0 },
      };
      this.playlists.set(id, playlist);
      return this.send(res, 200, clone(playlist));
    }

    // GET /youtube/v3/playlistItems
    if (req.method === "GET" && resource === "playlistItems") {
      const playlistId = q.get("playlistId") || "";
      const items = Array.from(this.videos.values()).map((v, i) => ({
        kind: "youtube#playlistItem",
        etag: etag(),
        id: `${playlistId || "PLparlel"}.${i}`,
        snippet: {
          publishedAt: v.snippet.publishedAt,
          channelId: this.channel.id,
          title: v.snippet.title,
          playlistId: playlistId || "PLparlel",
          position: i,
          resourceId: { kind: "youtube#video", videoId: v.id },
        },
      }));
      return this.send(res, 200, listResponse("playlistItemListResponse", items, items.length));
    }

    return this.send(res, 404, ytError(404, "Not Found", "notFound"));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "playlists") {
      return this.send(res, 200, {
        playlists: Array.from(this.playlists.values()).map(clone),
        count: this.playlists.size,
      });
    }
    return this.send(res, 404, ytError(404, "not found", "notFound"));
  }

  root() {
    return {
      name: "youtube",
      version: "1",
      protocol: "youtube-data-v3",
      documentation: "/docs/youtube.md",
    };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    const key = url.searchParams.get("key");
    if (key && key.length > 0) return true;
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
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, ytError(400, "Bad request body", "parseError"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, ytError(400, "Bad request body", "parseError"));
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
