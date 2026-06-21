import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/zoom — dependency-free fake of the Zoom API v2.
//
// Implements OAuth token issuance, user lookups, and meeting CRUD using the
// real Zoom wire shapes so application code / SDKs can run with zero cost.
// State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowISO() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Zoom error envelope: { code, message }
function zoomError(code, message) {
  return { code, message };
}

export class ZoomServer {
  constructor(port = 4797, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.meetings = new Map();
    this.users = new Map();
    this.meetingIdCounter = 80000000000;
    this._seedDefaults();
  }

  _seedDefaults() {
    const me = {
      id: "me0000000000000000001",
      first_name: "Parlel",
      last_name: "User",
      email: "user@parlel.dev",
      type: 2,
      status: "active",
      timezone: "America/New_York",
      account_id: "acc00000000000000001",
      created_at: nowISO(),
    };
    this.users.set("me", me);
    this.users.set(me.id, me);
  }

  _newMeetingId() {
    this.meetingIdCounter += 7;
    return this.meetingIdCounter;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, zoomError(500, error.message || "Internal server error"));
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
    res.setHeader("server", "parlel-zoom");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // POST /oauth/token — OAuth (server-to-server / authorization_code). No bearer required.
    if (req.method === "POST" && parts[0] === "oauth" && parts[1] === "token") {
      return this.send(res, 200, {
        access_token: `parlel.${randomBytes(16).toString("hex")}`,
        token_type: "bearer",
        expires_in: 3599,
        scope: "meeting:read meeting:write user:read",
      });
    }

    if (parts[0] !== "v2") {
      return this.send(res, 404, zoomError(404, "API endpoint not found"));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, zoomError(124, "Invalid access token."));
    }

    const route = parts.slice(1);

    // GET /v2/users
    if (req.method === "GET" && route[0] === "users" && route.length === 1) {
      const users = Array.from(this.users.values()).filter((u) => u.id !== undefined);
      const unique = [];
      const seen = new Set();
      for (const u of users) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        unique.push(u);
      }
      return this.send(res, 200, {
        page_count: 1,
        page_number: 1,
        page_size: 30,
        total_records: unique.length,
        users: unique.map(clone),
      });
    }

    // GET /v2/users/:userId
    if (req.method === "GET" && route[0] === "users" && route.length === 2) {
      const user = this.users.get(route[1]);
      if (!user) return this.send(res, 404, zoomError(1001, "User does not exist."));
      return this.send(res, 200, clone(user));
    }

    // GET/POST /v2/users/:userId/meetings
    if (route[0] === "users" && route[2] === "meetings" && route.length === 3) {
      const userId = route[1];
      const resolvedUser = this.users.get(userId);
      const hostId = resolvedUser ? resolvedUser.id : userId;
      if (req.method === "GET") {
        const meetings = Array.from(this.meetings.values())
          .filter((m) => m.host_id === hostId)
          .map((m) => ({
            uuid: m.uuid,
            id: m.id,
            host_id: m.host_id,
            topic: m.topic,
            type: m.type,
            start_time: m.start_time,
            duration: m.duration,
            timezone: m.timezone,
            created_at: m.created_at,
            join_url: m.join_url,
          }));
        return this.send(res, 200, {
          page_count: 1,
          page_number: 1,
          page_size: 30,
          total_records: meetings.length,
          meetings,
        });
      }
      if (req.method === "POST") {
        if (!resolvedUser) return this.send(res, 404, zoomError(1001, "User does not exist."));
        const meeting = this._createMeeting(hostId, body);
        return this.send(res, 201, clone(meeting));
      }
      return this.send(res, 405, zoomError(405, "Method not allowed."));
    }

    // GET/PATCH/DELETE /v2/meetings/:meetingId
    if (route[0] === "meetings" && route.length === 2) {
      const meeting = this.meetings.get(String(route[1]));
      if (!meeting) return this.send(res, 404, zoomError(3001, `Meeting does not exist: ${route[1]}.`));
      if (req.method === "GET") return this.send(res, 200, clone(meeting));
      if (req.method === "PATCH") {
        if (isPlainObject(body)) {
          for (const key of ["topic", "type", "start_time", "duration", "timezone", "agenda", "password"]) {
            if (body[key] !== undefined) meeting[key] = body[key];
          }
          if (isPlainObject(body.settings)) {
            meeting.settings = { ...meeting.settings, ...body.settings };
          }
        }
        // PATCH returns 204 No Content in the real API.
        return this.send(res, 204, null);
      }
      if (req.method === "DELETE") {
        this.meetings.delete(String(route[1]));
        return this.send(res, 204, null);
      }
      return this.send(res, 405, zoomError(405, "Method not allowed."));
    }

    return this.send(res, 404, zoomError(404, "API endpoint not found"));
  }

  _createMeeting(hostId, body) {
    const id = this._newMeetingId();
    const data = isPlainObject(body) ? body : {};
    const meeting = {
      uuid: randomUUID().replace(/-/g, "").slice(0, 22),
      id,
      host_id: hostId,
      host_email: "user@parlel.dev",
      topic: typeof data.topic === "string" ? data.topic : "Parlel Meeting",
      type: typeof data.type === "number" ? data.type : 2,
      status: "waiting",
      start_time: data.start_time || nowISO(),
      duration: typeof data.duration === "number" ? data.duration : 60,
      timezone: data.timezone || "America/New_York",
      agenda: data.agenda || "",
      created_at: nowISO(),
      start_url: `https://zoom.us/s/${id}?zak=parlel.${randomBytes(8).toString("hex")}`,
      join_url: `https://zoom.us/j/${id}`,
      password: data.password || randomBytes(4).toString("hex").slice(0, 6),
      settings: isPlainObject(data.settings) ? clone(data.settings) : {
        host_video: false,
        participant_video: false,
        join_before_host: false,
        mute_upon_entry: false,
        waiting_room: true,
        approval_type: 2,
      },
    };
    this.meetings.set(String(id), meeting);
    return meeting;
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "meetings") {
      return this.send(res, 200, {
        meetings: Array.from(this.meetings.values()).map(clone),
        count: this.meetings.size,
      });
    }
    if (req.method === "GET" && parts[1] === "users") {
      const unique = [];
      const seen = new Set();
      for (const u of this.users.values()) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        unique.push(u);
      }
      return this.send(res, 200, { users: unique.map(clone), count: unique.length });
    }
    return this.send(res, 404, zoomError(404, "not found"));
  }

  root() {
    return {
      name: "zoom",
      version: "1",
      protocol: "zoom-v2",
      documentation: "/docs/zoom.md",
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
          this.send(res, 400, zoomError(400, "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, zoomError(400, "Bad request body"));
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
