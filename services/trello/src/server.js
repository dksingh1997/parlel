import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/trello — a tiny, dependency-free fake of the Trello REST API.
//
// Auth is via ?key=&token= query params (any non-empty values accepted).
// Most write params can arrive either as query params or in a JSON body; we
// merge both. Resource ids are 24-char hex strings, matching Trello. State is
// in-memory and ephemeral.
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

function newId() {
  return randomBytes(12).toString("hex"); // 24-hex
}

export class TrelloServer {
  constructor(port = 4792, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.boards = new Map();
    this.lists = new Map();
    this.cards = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    this.me = {
      id: newId(),
      username: "parlel",
      fullName: "Parlel User",
      email: "parlel@example.com",
    };
    const boardId = newId();
    this.boards.set(boardId, {
      id: boardId,
      name: "Parlel Board",
      desc: "",
      closed: false,
      idOrganization: null,
      url: `https://trello.com/b/${boardId.slice(0, 8)}`,
    });
    this.defaultBoard = boardId;
    const listId = newId();
    this.lists.set(listId, {
      id: listId,
      name: "To Do",
      closed: false,
      idBoard: boardId,
      pos: 16384,
    });
    this.defaultList = listId;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message || "Internal server error" });
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
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-trello");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Trello API is rooted at /1.
    if (parts[0] !== "1") {
      return this.send(res, 404, { message: "not found" });
    }
    if (!this.isAuthorized(url)) {
      // Trello returns 401 with a plain-text body; we serve JSON for consistency.
      return this.send(res, 401, { message: "invalid key" });
    }

    // Merge query params + JSON body into a single params bag.
    const params = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    if (isPlainObject(body)) Object.assign(params, body);

    const route = parts.slice(1);

    if (route[0] === "members" && route[1] === "me" && route.length === 2 && req.method === "GET") {
      return this.send(res, 200, clone(this.me));
    }
    if (route[0] === "boards") return this.handleBoards(req, res, route, params);
    if (route[0] === "lists") return this.handleLists(req, res, route, params);
    if (route[0] === "cards") return this.handleCards(req, res, route, params);

    return this.send(res, 404, { message: "not found" });
  }

  // -------------------------------------------------------------------------
  // Boards
  // -------------------------------------------------------------------------
  handleBoards(req, res, route, params) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.boards.values()].map(clone));
      }
      if (req.method === "POST") {
        if (typeof params.name !== "string" || !params.name) {
          return this.send(res, 400, { message: "invalid value for name" });
        }
        const id = newId();
        const board = {
          id,
          name: params.name,
          desc: params.desc || "",
          closed: false,
          idOrganization: params.idOrganization || null,
          url: `https://trello.com/b/${id.slice(0, 8)}`,
        };
        this.boards.set(id, board);
        return this.send(res, 200, clone(board));
      }
      return this.send(res, 405, { message: "method not allowed" });
    }

    const id = route[1];
    const board = this.boards.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!board) return this.send(res, 404, { message: "board not found" });
        return this.send(res, 200, clone(board));
      }
      if (req.method === "PUT") {
        if (!board) return this.send(res, 404, { message: "board not found" });
        if (typeof params.name === "string") board.name = params.name;
        if (typeof params.desc === "string") board.desc = params.desc;
        if (params.closed !== undefined) board.closed = params.closed === true || params.closed === "true";
        return this.send(res, 200, clone(board));
      }
      if (req.method === "DELETE") {
        if (!board) return this.send(res, 404, { message: "board not found" });
        this.boards.delete(id);
        return this.send(res, 200, { _value: null });
      }
      return this.send(res, 405, { message: "method not allowed" });
    }
    return this.send(res, 404, { message: "not found" });
  }

  // -------------------------------------------------------------------------
  // Lists
  // -------------------------------------------------------------------------
  handleLists(req, res, route, params) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.lists.values()].map(clone));
      }
      if (req.method === "POST") {
        if (typeof params.name !== "string" || !params.name) {
          return this.send(res, 400, { message: "invalid value for name" });
        }
        const id = newId();
        const list = {
          id,
          name: params.name,
          closed: false,
          idBoard: params.idBoard ? String(params.idBoard) : this.defaultBoard,
          pos: params.pos != null ? Number(params.pos) : 16384,
        };
        this.lists.set(id, list);
        return this.send(res, 200, clone(list));
      }
      return this.send(res, 405, { message: "method not allowed" });
    }

    const id = route[1];
    const list = this.lists.get(id);
    if (route.length === 2 && req.method === "GET") {
      if (!list) return this.send(res, 404, { message: "list not found" });
      return this.send(res, 200, clone(list));
    }
    if (route.length === 2 && req.method === "PUT") {
      if (!list) return this.send(res, 404, { message: "list not found" });
      if (typeof params.name === "string") list.name = params.name;
      return this.send(res, 200, clone(list));
    }
    return this.send(res, 404, { message: "not found" });
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------
  handleCards(req, res, route, params) {
    if (route.length === 1) {
      if (req.method === "GET") {
        return this.send(res, 200, [...this.cards.values()].map(clone));
      }
      if (req.method === "POST") {
        if (typeof params.idList !== "string" && typeof params.idList !== "number") {
          return this.send(res, 400, { message: "invalid value for idList" });
        }
        const idList = String(params.idList);
        const list = this.lists.get(idList);
        const idBoard = list ? list.idBoard : this.defaultBoard;
        const id = newId();
        const card = {
          id,
          name: typeof params.name === "string" ? params.name : "",
          desc: params.desc || "",
          closed: false,
          idBoard,
          idList,
          pos: params.pos != null ? Number(params.pos) : 16384,
          due: params.due || null,
          dueComplete: false,
          url: `https://trello.com/c/${id.slice(0, 8)}`,
          shortUrl: `https://trello.com/c/${id.slice(0, 8)}`,
        };
        this.cards.set(id, card);
        return this.send(res, 200, clone(card));
      }
      return this.send(res, 405, { message: "method not allowed" });
    }

    const id = route[1];
    const card = this.cards.get(id);
    if (route.length === 2) {
      if (req.method === "GET") {
        if (!card) return this.send(res, 404, { message: "card not found" });
        return this.send(res, 200, clone(card));
      }
      if (req.method === "PUT") {
        if (!card) return this.send(res, 404, { message: "card not found" });
        if (typeof params.name === "string") card.name = params.name;
        if (typeof params.desc === "string") card.desc = params.desc;
        if (params.idList) {
          card.idList = String(params.idList);
          const list = this.lists.get(card.idList);
          if (list) card.idBoard = list.idBoard;
        }
        if (params.closed !== undefined) card.closed = params.closed === true || params.closed === "true";
        if (params.dueComplete !== undefined) card.dueComplete = params.dueComplete === true || params.dueComplete === "true";
        return this.send(res, 200, clone(card));
      }
      if (req.method === "DELETE") {
        if (!card) return this.send(res, 404, { message: "card not found" });
        this.cards.delete(id);
        return this.send(res, 200, { _value: null });
      }
      return this.send(res, 405, { message: "method not allowed" });
    }
    return this.send(res, 404, { message: "not found" });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { message: "not found" });
  }

  root() {
    return {
      name: "trello",
      version: "1",
      protocol: "trello-rest",
      documentation: "/docs/trello.md",
    };
  }

  isAuthorized(url) {
    if (!this.requireAuth) return true;
    const key = url.searchParams.get("key");
    const token = url.searchParams.get("token");
    return Boolean(key && token);
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
          const obj = {};
          for (const [k, v] of new URLSearchParams(data).entries()) obj[k] = v;
          resolve(obj);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { message: "Bad request body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { message: "Bad request body" });
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
