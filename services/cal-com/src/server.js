import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/cal-com — dependency-free in-memory fake of the Cal.com API v2 (and
// v1-style ?apiKey= access). Bearer auth with cal_... keys. v2 responses use
// the documented shape { status: "success", data: ... }.
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

function uid(n) {
  // Cal.com booking uids look like short opaque slugs.
  return ("bk" + String(n).padStart(10, "0") + "calparlel").slice(0, 20);
}

export class CalComServer {
  constructor(port = 4849, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.bookings = new Map(); // uid -> booking
    this.eventTypes = new Map();
    this._bookingCounter = 0;
    this._eventCounter = 0;
    this.me = {
      id: 1,
      username: "parlel",
      email: "user@parlel.dev",
      name: "Parlel User",
      timeZone: "UTC",
      weekStart: "Monday",
      timeFormat: 24,
      locale: "en",
      organizationId: null,
    };
    this._seed();
  }

  _seed() {
    this._createEventType({ title: "30 Minute Meeting", slug: "30min", lengthInMinutes: 30 });
    this._createEventType({ title: "60 Minute Meeting", slug: "60min", lengthInMinutes: 60 });
  }

  _createEventType(props) {
    this._eventCounter += 1;
    const id = this._eventCounter;
    const et = {
      id,
      title: props.title || "Meeting",
      slug: props.slug || `event-${id}`,
      lengthInMinutes: props.lengthInMinutes || 30,
      length: props.lengthInMinutes || 30,
      hidden: false,
      ownerId: this.me.id,
      description: props.description || "",
    };
    this.eventTypes.set(id, et);
    return et;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { status: "error", error: { code: "INTERNAL_SERVER_ERROR", message: error.message } });
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

  ok(data) {
    return { status: "success", data };
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, cal-api-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-cal-com");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v2" && parts[0] !== "v1") {
      return this.send(res, 404, { status: "error", error: { code: "NOT_FOUND", message: "not found" } });
    }

    if (!this.isAuthorized(req, url)) {
      return this.send(res, 401, { status: "error", error: { code: "UNAUTHORIZED", message: "No API key found in request" } });
    }

    const route = parts.slice(1);

    // GET /v2/me
    if (req.method === "GET" && route[0] === "me" && route.length === 1) {
      return this.send(res, 200, this.ok(clone(this.me)));
    }

    // GET /v2/event-types
    if (req.method === "GET" && route[0] === "event-types" && route.length === 1) {
      const list = Array.from(this.eventTypes.values()).map(clone);
      return this.send(res, 200, this.ok({ eventTypeGroups: [{ eventTypes: list }], eventTypes: list }));
    }

    // GET /v2/slots  (?eventTypeId=&start=&end=)
    if (req.method === "GET" && route[0] === "slots" && route.length === 1) {
      const start = url.searchParams.get("start") || "2024-01-01";
      const day = start.slice(0, 10);
      const slots = {
        [day]: [
          { start: `${day}T09:00:00.000Z` },
          { start: `${day}T09:30:00.000Z` },
          { start: `${day}T10:00:00.000Z` },
        ],
      };
      return this.send(res, 200, this.ok(slots));
    }

    // /v2/bookings ...
    if (route[0] === "bookings") {
      if (route.length === 1) {
        if (req.method === "GET") {
          const list = Array.from(this.bookings.values()).map(clone);
          return this.send(res, 200, this.ok(list));
        }
        if (req.method === "POST") {
          return this.createBooking(res, body);
        }
      }

      const bookingUid = route[1];
      const booking = this.bookings.get(bookingUid);

      // GET /v2/bookings/:uid
      if (route.length === 2 && req.method === "GET") {
        if (!booking) return this.notFound(res);
        return this.send(res, 200, this.ok(clone(booking)));
      }
      // POST /v2/bookings/:uid/cancel
      if (route.length === 3 && route[2] === "cancel" && req.method === "POST") {
        if (!booking) return this.notFound(res);
        booking.status = "cancelled";
        return this.send(res, 200, this.ok(clone(booking)));
      }
      // PATCH /v2/bookings/:uid (reschedule helper)
      if (route.length === 2 && req.method === "PATCH") {
        if (!booking) return this.notFound(res);
        if (isPlainObject(body)) {
          if (typeof body.start === "string") booking.start = body.start;
          if (typeof body.end === "string") booking.end = body.end;
        }
        return this.send(res, 200, this.ok(clone(booking)));
      }
    }

    return this.notFound(res);
  }

  createBooking(res, body) {
    const data = isPlainObject(body) ? body : {};
    this._bookingCounter += 1;
    const id = this._bookingCounter;
    const bookingUid = uid(id);
    const attendee = isPlainObject(data.attendee)
      ? data.attendee
      : { name: data.name || "Attendee", email: data.email || "attendee@parlel.dev", timeZone: "UTC" };
    const booking = {
      id,
      uid: bookingUid,
      title: data.title || "Meeting",
      status: "accepted",
      start: data.start || "2024-01-01T09:00:00.000Z",
      end: data.end || "2024-01-01T09:30:00.000Z",
      eventTypeId: data.eventTypeId || 1,
      attendees: [attendee],
      hosts: [{ id: this.me.id, name: this.me.name, email: this.me.email }],
      meetingUrl: null,
      location: data.location || "integrations:daily",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    this.bookings.set(bookingUid, booking);
    return this.send(res, 201, this.ok(clone(booking)));
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { status: "error", error: { code: "NOT_FOUND", message: "Resource not found" } });
  }

  root() {
    return {
      name: "cal-com",
      version: "1",
      protocol: "cal-com-v2",
      documentation: "/docs/cal-com.md",
    };
  }

  isAuthorized(req, url) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    if (/^Bearer\s+\S+/i.test(auth)) return true;
    const query = url.searchParams.get("apiKey") || url.searchParams.get("apikey");
    if (query && query.length > 0) return true;
    return false;
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { status: "error", error: { code: "BAD_REQUEST", message: "Bad request body" } });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { status: "error", error: { code: "BAD_REQUEST", message: "Bad request body" } });
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
