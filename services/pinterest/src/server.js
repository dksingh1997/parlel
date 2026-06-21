import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/pinterest — dependency-free fake of the Pinterest API v5.
//
// Implements pins, boards, and the user account using the real v5 wire shapes
// ({ items: [], bookmark } for lists). Bearer auth. State is in-memory and
// ephemeral.
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

// Pinterest v5 error envelope: { code, message }
function pinError(code, message) {
  return { code, message };
}

function newId() {
  let s = "";
  for (let i = 0; i < 18; i += 1) s += Math.floor(Math.random() * 10);
  return s;
}

export class PinterestServer {
  constructor(port = 4805, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.pins = new Map();
    this.boards = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    this.userAccount = {
      account_type: "BUSINESS",
      username: "parlel",
      profile_image: "https://i.pinimg.com/parlel/avatar.jpg",
      website_url: "https://parlel.dev",
      board_count: 1,
      pin_count: 0,
      follower_count: 0,
      following_count: 0,
    };
    const boardId = newId();
    this.boards.set(boardId, {
      id: boardId,
      name: "Parlel Inspiration",
      description: "A seeded board.",
      owner: { username: "parlel" },
      privacy: "PUBLIC",
      pin_count: 0,
      follower_count: 0,
      created_at: new Date().toISOString(),
    });
    this._defaultBoardId = boardId;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, pinError(500, error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-pinterest");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "v5") {
      return this.send(res, 404, pinError(404, "Not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, pinError(401, "Authentication failed."));
    }

    const route = parts.slice(1);

    // GET /v5/user_account
    if (req.method === "GET" && route[0] === "user_account" && route.length === 1) {
      return this.send(res, 200, clone(this.userAccount));
    }

    // /v5/pins
    if (route[0] === "pins") {
      return this.handlePins(req, res, route, body);
    }

    // /v5/boards
    if (route[0] === "boards") {
      return this.handleBoards(req, res, route, body);
    }

    return this.send(res, 404, pinError(404, "Not found"));
  }

  handlePins(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          items: Array.from(this.pins.values()).map(clone),
          bookmark: null,
        });
      }
      if (req.method === "POST") {
        const data = isPlainObject(body) ? body : {};
        if (typeof data.board_id !== "string" || !data.board_id) {
          return this.send(res, 400, pinError(40, "board_id is required."));
        }
        const id = newId();
        const pin = {
          id,
          created_at: new Date().toISOString(),
          link: data.link || null,
          title: data.title || "",
          description: data.description || "",
          alt_text: data.alt_text || null,
          board_id: data.board_id,
          board_section_id: data.board_section_id || null,
          media: { media_type: "image" },
        };
        this.pins.set(id, pin);
        this.userAccount.pin_count += 1;
        const board = this.boards.get(data.board_id);
        if (board) board.pin_count += 1;
        return this.send(res, 201, clone(pin));
      }
      return this.send(res, 405, pinError(405, "Method not allowed."));
    }

    // /v5/pins/:pin_id
    const id = route[1];
    const pin = this.pins.get(id);
    if (!pin) return this.send(res, 404, pinError(404, "Pin not found."));
    if (req.method === "GET") return this.send(res, 200, clone(pin));
    if (req.method === "DELETE") {
      this.pins.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, pinError(405, "Method not allowed."));
  }

  handleBoards(req, res, route, body) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, {
          items: Array.from(this.boards.values()).map(clone),
          bookmark: null,
        });
      }
      if (req.method === "POST") {
        const data = isPlainObject(body) ? body : {};
        if (typeof data.name !== "string" || !data.name) {
          return this.send(res, 400, pinError(40, "name is required."));
        }
        const id = newId();
        const board = {
          id,
          name: data.name,
          description: data.description || "",
          owner: { username: "parlel" },
          privacy: data.privacy || "PUBLIC",
          pin_count: 0,
          follower_count: 0,
          created_at: new Date().toISOString(),
        };
        this.boards.set(id, board);
        this.userAccount.board_count += 1;
        return this.send(res, 201, clone(board));
      }
      return this.send(res, 405, pinError(405, "Method not allowed."));
    }

    // /v5/boards/:board_id
    const id = route[1];
    const board = this.boards.get(id);
    if (!board) return this.send(res, 404, pinError(404, "Board not found."));
    if (req.method === "GET") return this.send(res, 200, clone(board));
    if (req.method === "DELETE") {
      this.boards.delete(id);
      return this.send(res, 204, null);
    }
    return this.send(res, 405, pinError(405, "Method not allowed."));
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "pins") {
      return this.send(res, 200, { pins: Array.from(this.pins.values()).map(clone), count: this.pins.size });
    }
    if (req.method === "GET" && parts[1] === "boards") {
      return this.send(res, 200, { boards: Array.from(this.boards.values()).map(clone), count: this.boards.size });
    }
    return this.send(res, 404, pinError(404, "not found"));
  }

  root() {
    return {
      name: "pinterest",
      version: "1",
      protocol: "pinterest-v5",
      documentation: "/docs/pinterest.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
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
          this.send(res, 400, pinError(400, "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, pinError(400, "Bad request body"));
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
