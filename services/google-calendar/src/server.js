// parlel/google-calendar - lightweight, dependency-free fake of Google Calendar API v3.
// Compatible with the `googleapis` Calendar client when its rootUrl is pointed at
// this server. State is in-memory and ephemeral. Reset with reset() or
// POST /_parlel/reset.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

class ApiError extends Error {
  constructor(code, message, reason = "badRequest", options = {}) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.domain = options.domain || "global";
    this.locationType = options.locationType;
    this.location = options.location;
  }
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function makeEventId() {
  return randomBytes(8).toString("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function etag() {
  return `\"${randomBytes(8).toString("hex")}\"`;
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function eventStartValue(event) {
  return event.start?.dateTime || event.start?.date || "";
}

function eventEndValue(event) {
  return event.end?.dateTime || event.end?.date || eventStartValue(event);
}

function overlaps(event, timeMin, timeMax) {
  const start = eventStartValue(event);
  const end = eventEndValue(event);
  if (timeMin && end && end <= timeMin) return false;
  if (timeMax && start && start >= timeMax) return false;
  return true;
}

function addDays(iso, days) {
  const base = new Date(iso || now());
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString();
}

function addWeeks(iso, weeks) {
  return addDays(iso, weeks * 7);
}

function shiftDateValue(value, index, freq) {
  if (!value) return value;
  if (freq === "WEEKLY") return addWeeks(value, index);
  return addDays(value, index);
}

export class GoogleCalendarServer {
  constructor(port = 4615, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.userEmail = options.userEmail || "parlel@example.com";
    this.server = null;
    this.reset();
  }

  reset() {
    this.calendars = new Map();
    this.calendarList = new Map();
    this.events = new Map();
    this.acl = new Map();
    this.channels = new Map();
    this.settings = new Map([
      ["dateFieldOrder", { kind: "calendar#setting", etag: etag(), id: "dateFieldOrder", value: "MDY" }],
      ["format24HourTime", { kind: "calendar#setting", etag: etag(), id: "format24HourTime", value: "false" }],
      ["hideInvitations", { kind: "calendar#setting", etag: etag(), id: "hideInvitations", value: "false" }],
      ["locale", { kind: "calendar#setting", etag: etag(), id: "locale", value: "en" }],
      ["reminderMethod", { kind: "calendar#setting", etag: etag(), id: "reminderMethod", value: "popup" }],
      ["timezone", { kind: "calendar#setting", etag: etag(), id: "timezone", value: "UTC" }],
      ["weekStart", { kind: "calendar#setting", etag: etag(), id: "weekStart", value: "0" }],
    ]);
    const primary = this.makeCalendar({ id: "primary", summary: "Primary Calendar", primary: true });
    this.calendars.set(primary.id, primary);
    this.calendarList.set(primary.id, this.makeCalendarListEntry(primary, { primary: true, selected: true, accessRole: "owner" }));
    this.acl.set(primary.id, new Map([[`user:${this.userEmail}`, this.makeAclRule(primary.id, { role: "owner", scope: { type: "user", value: this.userEmail } })]]));
    this.events.set(primary.id, new Map());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof ApiError ? error : new ApiError(500, error.message || "Internal error", "backendError"));
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

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    const pathname = url.pathname;
    res.setHeader("x-google-calendar-emulator", "parlel");

    if (pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "google-calendar", calendars: this.calendars.size, events: this.totalEvents() });
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/calendar/v3" || pathname === "/v3") return this.sendJson(res, 200, { kind: "calendar#parlel" });

    const body = this.parseJson(await this.readBody(req));
    const prefix = pathname.startsWith("/calendar/v3/") ? "/calendar/v3/" : pathname.startsWith("/v3/") ? "/v3/" : null;
    if (!prefix) throw new ApiError(404, "Not Found", "notFound");
    return this.route(res, method, splitPath(pathname.slice(prefix.length)), url.searchParams, body);
  }

  route(res, method, parts, q, body) {
    const [resource, ...rest] = parts;
    if (resource === "users" && rest[0] === "me" && rest[1] === "calendarList") return this.routeCalendarList(res, method, rest.slice(2), q, body);
    if (resource === "users" && rest[0] === "me" && rest[1] === "settings") return this.routeSettings(res, method, rest.slice(2), q, body);
    if (resource === "calendars") return this.routeCalendars(res, method, rest, q, body);
    if (resource === "colors" && rest.length === 0) {
      if (method === "GET") return this.getColors(res);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (resource === "freeBusy" && rest.length === 0) {
      if (method === "POST") return this.queryFreebusy(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (resource === "channels" && rest[0] === "stop" && rest.length === 1) {
      if (method === "POST") return this.stopChannel(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeCalendars(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "POST") return this.insertCalendar(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    const calendarId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.getCalendar(res, calendarId);
      if (method === "PATCH" || method === "PUT") return this.updateCalendar(res, calendarId, body, method === "PUT");
      if (method === "DELETE") return this.deleteCalendar(res, calendarId);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 2 && parts[1] === "clear" && method === "POST") return this.clearCalendar(res, calendarId);
    if (parts[1] === "acl") return this.routeAcl(res, method, calendarId, parts.slice(2), q, body);
    if (parts[1] === "events") return this.routeEvents(res, method, calendarId, parts.slice(2), q, body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeCalendarList(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listCalendarList(res, q);
      if (method === "POST") return this.insertCalendarList(res, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1 && parts[0] === "watch" && method === "POST") return this.watch(res, body, "calendarList", "calendarList");
    if (parts.length === 1) {
      if (method === "GET") return this.getCalendarList(res, parts[0]);
      if (method === "PATCH" || method === "PUT") return this.updateCalendarList(res, parts[0], body, method === "PUT");
      if (method === "DELETE") return this.deleteCalendarList(res, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeAcl(res, method, calendarId, parts, q, body) {
    this.mustCalendar(calendarId);
    if (parts.length === 0) {
      if (method === "GET") return this.listAcl(res, calendarId, q);
      if (method === "POST") return this.insertAcl(res, calendarId, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1 && parts[0] === "watch" && method === "POST") return this.watch(res, body, `acl/${calendarId}`, `calendars/${calendarId}/acl`);
    if (parts.length === 1) {
      if (method === "GET") return this.getAcl(res, calendarId, parts[0]);
      if (method === "PATCH" || method === "PUT") return this.updateAcl(res, calendarId, parts[0], body, method === "PUT");
      if (method === "DELETE") return this.deleteAcl(res, calendarId, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeEvents(res, method, calendarId, parts, q, body) {
    this.mustCalendar(calendarId);
    if (parts.length === 0) {
      if (method === "GET") return this.listEvents(res, calendarId, q);
      if (method === "POST") return this.insertEvent(res, calendarId, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1) {
      if (parts[0] === "import" && method === "POST") return this.importEvent(res, calendarId, body);
      if (parts[0] === "quickAdd" && method === "POST") return this.quickAddEvent(res, calendarId, q);
      if (parts[0] === "watch" && method === "POST") return this.watch(res, body, `events/${calendarId}`, `calendars/${calendarId}/events`);
      if (method === "GET") return this.getEvent(res, calendarId, parts[0]);
      if (method === "PATCH" || method === "PUT") return this.updateEvent(res, calendarId, parts[0], body, method === "PUT");
      if (method === "DELETE") return this.deleteEvent(res, calendarId, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 2 && parts[1] === "instances" && method === "GET") return this.eventInstances(res, calendarId, parts[0], q);
    if (parts.length === 2 && parts[1] === "move" && method === "POST") return this.moveEvent(res, calendarId, parts[0], q);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeSettings(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listSettings(res, q);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1 && parts[0] === "watch" && method === "POST") return this.watch(res, body, "settings", "users/me/settings");
    if (parts.length === 1 && method === "GET") return this.getSetting(res, parts[0]);
    throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
  }

  insertCalendar(res, body) {
    this.require(body.summary, "summary");
    const calendar = this.makeCalendar(body);
    if (this.calendars.has(calendar.id)) throw new ApiError(409, "The requested identifier already exists.", "duplicate");
    this.calendars.set(calendar.id, calendar);
    this.calendarList.set(calendar.id, this.makeCalendarListEntry(calendar, { accessRole: "owner" }));
    this.acl.set(calendar.id, new Map([[`user:${this.userEmail}`, this.makeAclRule(calendar.id, { role: "owner", scope: { type: "user", value: this.userEmail } })]]));
    this.events.set(calendar.id, new Map());
    return this.sendJson(res, 200, clone(calendar));
  }

  getCalendar(res, calendarId) {
    return this.sendJson(res, 200, clone(this.mustCalendar(calendarId)));
  }

  updateCalendar(res, calendarId, body, replace) {
    const current = this.mustCalendar(calendarId);
    const updated = replace ? this.makeCalendar({ id: calendarId, ...body, primary: current.primary }) : { ...current, ...body };
    updated.id = calendarId;
    updated.kind = "calendar#calendar";
    updated.etag = etag();
    this.calendars.set(calendarId, updated);
    const entry = this.calendarList.get(calendarId);
    if (entry) this.calendarList.set(calendarId, { ...entry, summary: updated.summary, description: updated.description, location: updated.location, timeZone: updated.timeZone, etag: etag() });
    return this.sendJson(res, 200, clone(updated));
  }

  deleteCalendar(res, calendarId) {
    const calendar = this.mustCalendar(calendarId);
    if (calendar.primary) throw new ApiError(400, "Cannot delete the primary calendar", "invalidArgument");
    this.calendars.delete(calendarId);
    this.calendarList.delete(calendarId);
    this.events.delete(calendarId);
    this.acl.delete(calendarId);
    return this.sendEmpty(res, 204);
  }

  clearCalendar(res, calendarId) {
    this.mustCalendar(calendarId);
    this.events.set(calendarId, new Map());
    return this.sendEmpty(res, 204);
  }

  listCalendarList(res, q) {
    let items = [...this.calendarList.values()];
    if (q.get("minAccessRole")) {
      const rank = { freeBusyReader: 1, reader: 2, writer: 3, owner: 4 };
      const min = rank[q.get("minAccessRole")] || 0;
      items = items.filter((item) => (rank[item.accessRole] || 0) >= min);
    }
    if (q.get("showHidden") !== "true") items = items.filter((item) => !item.hidden);
    return this.sendPage(res, "calendar#calendarList", "items", items.map(clone), q);
  }

  insertCalendarList(res, body) {
    this.require(body.id, "id");
    const calendar = this.mustCalendar(body.id);
    const entry = this.makeCalendarListEntry(calendar, body);
    this.calendarList.set(calendar.id, entry);
    return this.sendJson(res, 200, clone(entry));
  }

  getCalendarList(res, calendarId) {
    const entry = this.calendarList.get(calendarId);
    if (!entry) throw new ApiError(404, "Calendar list entry not found", "notFound");
    return this.sendJson(res, 200, clone(entry));
  }

  updateCalendarList(res, calendarId, body, replace) {
    const current = this.calendarList.get(calendarId);
    if (!current) throw new ApiError(404, "Calendar list entry not found", "notFound");
    const calendar = this.mustCalendar(calendarId);
    const updated = replace ? this.makeCalendarListEntry(calendar, body) : { ...current, ...body };
    updated.id = calendarId;
    updated.kind = "calendar#calendarListEntry";
    updated.etag = etag();
    this.calendarList.set(calendarId, updated);
    return this.sendJson(res, 200, clone(updated));
  }

  deleteCalendarList(res, calendarId) {
    if (!this.calendarList.has(calendarId)) throw new ApiError(404, "Calendar list entry not found", "notFound");
    this.calendarList.delete(calendarId);
    return this.sendEmpty(res, 204);
  }

  listAcl(res, calendarId, q) {
    return this.sendPage(res, "calendar#acl", "items", [...this.mustAcl(calendarId).values()].map(clone), q);
  }

  insertAcl(res, calendarId, body) {
    this.require(body.role, "role");
    this.require(body.scope, "scope");
    const rule = this.makeAclRule(calendarId, body);
    const rules = this.mustAcl(calendarId);
    if (rules.has(rule.id)) throw new ApiError(409, "The requested identifier already exists.", "duplicate");
    rules.set(rule.id, rule);
    return this.sendJson(res, 200, clone(rule));
  }

  getAcl(res, calendarId, ruleId) {
    return this.sendJson(res, 200, clone(this.mustAclRule(calendarId, ruleId)));
  }

  updateAcl(res, calendarId, ruleId, body, replace) {
    const current = this.mustAclRule(calendarId, ruleId);
    const updated = replace ? this.makeAclRule(calendarId, { ...body, id: ruleId }) : { ...current, ...body };
    updated.id = ruleId;
    updated.kind = "calendar#aclRule";
    updated.etag = etag();
    this.mustAcl(calendarId).set(ruleId, updated);
    return this.sendJson(res, 200, clone(updated));
  }

  deleteAcl(res, calendarId, ruleId) {
    const rules = this.mustAcl(calendarId);
    if (!rules.has(ruleId)) throw new ApiError(404, "ACL rule not found", "notFound");
    rules.delete(ruleId);
    return this.sendEmpty(res, 204);
  }

  insertEvent(res, calendarId, body) {
    this.validateEventTime(body);
    const event = this.makeEvent(calendarId, body);
    const events = this.mustEvents(calendarId);
    if (events.has(event.id)) throw new ApiError(409, "The requested identifier already exists.", "duplicate");
    events.set(event.id, event);
    return this.sendJson(res, 200, clone(event));
  }

  importEvent(res, calendarId, body) {
    this.validateEventTime(body);
    const event = this.makeEvent(calendarId, { ...body, status: body.status || "confirmed" });
    const events = this.mustEvents(calendarId);
    if (events.has(event.id)) throw new ApiError(409, "The requested identifier already exists.", "duplicate");
    events.set(event.id, event);
    return this.sendJson(res, 200, clone(event));
  }

  quickAddEvent(res, calendarId, q) {
    const text = q.get("text") || "Untitled event";
    const start = now();
    const event = this.makeEvent(calendarId, { summary: text, description: text, start: { dateTime: start }, end: { dateTime: addDays(start, 0) } });
    this.mustEvents(calendarId).set(event.id, event);
    return this.sendJson(res, 200, clone(event));
  }

  getEvent(res, calendarId, eventId) {
    return this.sendJson(res, 200, clone(this.mustEvent(calendarId, eventId)));
  }

  listEvents(res, calendarId, q) {
    if (q.get("orderBy") === "startTime" && q.get("singleEvents") !== "true") throw new ApiError(400, "The requested ordering is not available for the particular query.", "invalid", { domain: "calendar", locationType: "parameter", location: "orderBy" });
    let items = [...this.mustEvents(calendarId).values()];
    const showDeleted = q.get("showDeleted") === "true";
    if (!showDeleted) items = items.filter((event) => event.status !== "cancelled");
    if (q.get("q")) {
      const term = q.get("q").toLowerCase();
      items = items.filter((event) => [event.summary, event.description, event.location].some((value) => String(value || "").toLowerCase().includes(term)));
    }
    if (q.get("iCalUID")) items = items.filter((event) => event.iCalUID === q.get("iCalUID"));
    if (q.get("timeMin") || q.get("timeMax")) items = items.filter((event) => overlaps(event, q.get("timeMin"), q.get("timeMax")));
    if (q.get("updatedMin")) items = items.filter((event) => event.updated >= q.get("updatedMin"));
    if (q.get("singleEvents") === "true") items = items.flatMap((event) => this.expandEvent(event, q));
    if (q.get("orderBy") === "startTime") items.sort((a, b) => eventStartValue(a).localeCompare(eventStartValue(b)));
    else if (q.get("orderBy") === "updated") items.sort((a, b) => a.updated.localeCompare(b.updated));
    return this.sendEventPage(res, calendarId, items.map(clone), q);
  }

  updateEvent(res, calendarId, eventId, body, replace) {
    const current = this.mustEvent(calendarId, eventId);
    const updated = replace ? this.makeEvent(calendarId, { ...body, id: eventId, iCalUID: current.iCalUID, created: current.created }) : { ...current, ...body };
    updated.id = eventId;
    updated.kind = "calendar#event";
    updated.updated = now();
    updated.etag = etag();
    this.mustEvents(calendarId).set(eventId, updated);
    return this.sendJson(res, 200, clone(updated));
  }

  deleteEvent(res, calendarId, eventId) {
    const events = this.mustEvents(calendarId);
    if (!events.has(eventId)) throw new ApiError(404, "Event not found", "notFound");
    events.delete(eventId);
    return this.sendEmpty(res, 204);
  }

  moveEvent(res, calendarId, eventId, q) {
    const destination = q.get("destination");
    if (!destination) throw new ApiError(400, "Missing required parameter: destination", "required");
    this.mustCalendar(destination);
    const event = this.mustEvent(calendarId, eventId);
    this.mustEvents(calendarId).delete(eventId);
    const moved = { ...event, organizer: { email: destination, self: true }, updated: now(), etag: etag() };
    this.mustEvents(destination).set(eventId, moved);
    return this.sendJson(res, 200, clone(moved));
  }

  eventInstances(res, calendarId, eventId, q) {
    const event = this.mustEvent(calendarId, eventId);
    const instances = this.expandEvent(event, q);
    return this.sendEventPage(res, calendarId, instances.map(clone), q);
  }

  queryFreebusy(res, body) {
    this.require(body.timeMin, "timeMin");
    this.require(body.timeMax, "timeMax");
    if (!Array.isArray(body.items)) throw new ApiError(400, "Required", "required", { domain: "calendar", locationType: "parameter", location: "items" });
    const timeMin = body.timeMin || "0000-01-01T00:00:00.000Z";
    const timeMax = body.timeMax || "9999-12-31T23:59:59.999Z";
    const calendars = {};
    for (const item of body.items || []) {
      const calendarId = item.id;
      try {
        this.mustCalendar(calendarId);
        calendars[calendarId] = {
          busy: [...this.mustEvents(calendarId).values()]
            .filter((event) => event.status !== "cancelled" && event.transparency !== "transparent" && overlaps(event, timeMin, timeMax))
            .map((event) => ({ start: eventStartValue(event), end: eventEndValue(event) })),
        };
      } catch (error) {
        calendars[calendarId] = { errors: [{ domain: "global", reason: "notFound" }], busy: [] };
      }
    }
    return this.sendJson(res, 200, { kind: "calendar#freeBusy", timeMin, timeMax, groups: {}, calendars });
  }

  getColors(res) {
    return this.sendJson(res, 200, {
      kind: "calendar#colors",
      updated: now(),
      calendar: {
        "1": { background: "#ac725e", foreground: "#1d1d1d" },
        "2": { background: "#d06b64", foreground: "#1d1d1d" },
        "9": { background: "#5484ed", foreground: "#1d1d1d" },
      },
      event: {
        "1": { background: "#a4bdfc", foreground: "#1d1d1d" },
        "2": { background: "#7ae7bf", foreground: "#1d1d1d" },
        "11": { background: "#dc2127", foreground: "#1d1d1d" },
      },
    });
  }

  listSettings(res, q) {
    return this.sendPage(res, "calendar#settings", "items", [...this.settings.values()].map(clone), q);
  }

  getSetting(res, settingId) {
    const setting = this.settings.get(settingId);
    if (!setting) throw new ApiError(404, "Setting not found", "notFound");
    return this.sendJson(res, 200, clone(setting));
  }

  watch(res, body, resourceId, resourceUri) {
    this.require(body.id, "id");
    this.require(body.type, "type");
    this.require(body.address, "address");
    const channel = {
      kind: "api#channel",
      id: body.id,
      resourceId,
      resourceUri,
      token: body.token,
      type: body.type || "web_hook",
      address: body.address,
      expiration: body.expiration || String(Date.now() + 3600000),
    };
    this.channels.set(channel.id, channel);
    return this.sendJson(res, 200, clone(channel));
  }

  stopChannel(res, body) {
    this.require(body.id, "id");
    this.require(body.resourceId, "resourceId");
    if (body.id) this.channels.delete(body.id);
    return this.sendEmpty(res, 204);
  }

  makeCalendar(input = {}) {
    const calendarId = input.id || id("calendar");
    return {
      kind: "calendar#calendar",
      etag: etag(),
      id: calendarId,
      summary: input.summary || "Untitled calendar",
      description: input.description || "",
      location: input.location || "",
      timeZone: input.timeZone || "UTC",
      conferenceProperties: input.conferenceProperties || { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
      primary: Boolean(input.primary),
    };
  }

  makeCalendarListEntry(calendar, input = {}) {
    return {
      kind: "calendar#calendarListEntry",
      etag: etag(),
      id: calendar.id,
      summary: calendar.summary,
      description: calendar.description,
      location: calendar.location,
      timeZone: calendar.timeZone,
      colorId: input.colorId || "9",
      backgroundColor: input.backgroundColor || "#5484ed",
      foregroundColor: input.foregroundColor || "#ffffff",
      selected: input.selected !== false,
      accessRole: input.accessRole || "owner",
      primary: Boolean(input.primary || calendar.primary),
      hidden: Boolean(input.hidden),
      defaultReminders: input.defaultReminders || [],
      notificationSettings: input.notificationSettings || { notifications: [] },
    };
  }

  makeAclRule(calendarId, input = {}) {
    const scope = input.scope || { type: "default" };
    const ruleId = input.id || (scope.type === "default" ? "default" : `${scope.type}:${scope.value}`);
    return {
      kind: "calendar#aclRule",
      etag: etag(),
      id: ruleId,
      scope,
      role: input.role || "reader",
      calendarId,
    };
  }

  makeEvent(calendarId, input = {}) {
    const created = input.created || now();
    const eventId = input.id || makeEventId();
    return {
      kind: "calendar#event",
      etag: etag(),
      id: eventId,
      status: input.status || "confirmed",
      htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eventId)}`,
      created,
      updated: now(),
      summary: input.summary || "Untitled event",
      description: input.description || "",
      location: input.location || "",
      colorId: input.colorId,
      creator: input.creator || { email: this.userEmail, self: true },
      organizer: input.organizer || { email: calendarId, self: true },
      start: input.start || { dateTime: now(), timeZone: "UTC" },
      end: input.end || { dateTime: now(), timeZone: "UTC" },
      endTimeUnspecified: Boolean(input.endTimeUnspecified),
      recurrence: input.recurrence || undefined,
      recurringEventId: input.recurringEventId,
      originalStartTime: input.originalStartTime,
      transparency: input.transparency || "opaque",
      visibility: input.visibility || "default",
      iCalUID: input.iCalUID || `${eventId}@parlel.local`,
      sequence: input.sequence || 0,
      attendees: input.attendees || [],
      attendeesOmitted: Boolean(input.attendeesOmitted),
      extendedProperties: input.extendedProperties || {},
      reminders: input.reminders || { useDefault: true },
      eventType: input.eventType || "default",
      conferenceData: input.conferenceData,
      attachments: input.attachments,
    };
  }

  expandEvent(event, q) {
    if (!event.recurrence?.length) return [event];
    const rule = event.recurrence.find((entry) => String(entry).startsWith("RRULE:")) || "";
    const freq = rule.match(/FREQ=([^;]+)/)?.[1] || "DAILY";
    const count = Math.max(1, Math.min(250, Number(rule.match(/COUNT=(\d+)/)?.[1] || 1)));
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const startKey = event.start?.dateTime ? "dateTime" : "date";
      const endKey = event.end?.dateTime ? "dateTime" : "date";
      const start = { ...event.start, [startKey]: shiftDateValue(event.start?.[startKey], index, freq) };
      const end = { ...event.end, [endKey]: shiftDateValue(event.end?.[endKey], index, freq) };
      const instance = {
        ...event,
        id: `${event.id}_${index}`,
        recurringEventId: event.id,
        recurrence: undefined,
        start,
        end,
        originalStartTime: start,
      };
      if (overlaps(instance, q.get("timeMin"), q.get("timeMax"))) items.push(instance);
    }
    return items;
  }

  mustCalendar(calendarId) {
    const calendar = this.calendars.get(calendarId);
    if (!calendar) throw new ApiError(404, "Not Found", "notFound");
    return calendar;
  }

  mustAcl(calendarId) {
    const rules = this.acl.get(calendarId);
    if (!rules) throw new ApiError(404, "Not Found", "notFound");
    return rules;
  }

  mustAclRule(calendarId, ruleId) {
    const rule = this.mustAcl(calendarId).get(ruleId);
    if (!rule) throw new ApiError(404, "Not Found", "notFound");
    return rule;
  }

  mustEvents(calendarId) {
    const events = this.events.get(calendarId);
    if (!events) throw new ApiError(404, "Not Found", "notFound");
    return events;
  }

  mustEvent(calendarId, eventId) {
    const event = this.mustEvents(calendarId).get(eventId);
    if (!event) throw new ApiError(404, "Not Found", "notFound");
    return event;
  }

  require(value, field) {
    if (value === undefined || value === null || value === "") throw new ApiError(400, "Required", "required", { domain: "calendar", locationType: "parameter", location: field });
  }

  validateEventTime(body) {
    this.require(body.start, "start");
    this.require(body.end, "end");
    if (!body.start.date && !body.start.dateTime) throw new ApiError(400, "Required", "required", { domain: "calendar", locationType: "parameter", location: "start" });
    if (!body.end.date && !body.end.dateTime) throw new ApiError(400, "Required", "required", { domain: "calendar", locationType: "parameter", location: "end" });
  }

  totalEvents() {
    return [...this.events.values()].reduce((total, events) => total + events.size, 0);
  }

  sendPage(res, kind, key, items, q) {
    const start = Math.max(0, Number(q.get("pageToken") || 0));
    if (Number.isNaN(start)) throw new ApiError(400, "Invalid page token", "invalidArgument");
    const pageSize = Math.max(1, Math.min(250, Number(q.get("maxResults") || items.length || 250)));
    const page = items.slice(start, start + pageSize);
    const out = { kind, etag: etag(), [key]: page };
    if (start + pageSize < items.length) out.nextPageToken = String(start + pageSize);
    return this.sendJson(res, 200, out);
  }

  sendEventPage(res, calendarId, items, q) {
    const calendar = this.mustCalendar(calendarId);
    const start = Math.max(0, Number(q.get("pageToken") || 0));
    if (Number.isNaN(start)) throw new ApiError(400, "Invalid page token", "invalidArgument");
    const pageSize = Math.max(1, Math.min(2500, Number(q.get("maxResults") || items.length || 250)));
    const page = items.slice(start, start + pageSize);
    const out = {
      kind: "calendar#events",
      etag: etag(),
      summary: calendar.summary,
      description: calendar.description,
      updated: now(),
      timeZone: calendar.timeZone,
      accessRole: this.calendarList.get(calendarId)?.accessRole || "owner",
      defaultReminders: this.calendarList.get(calendarId)?.defaultReminders || [],
      items: page,
    };
    if (start + pageSize < items.length) out.nextPageToken = String(start + pageSize);
    else out.nextSyncToken = `sync_${Date.now()}`;
    return this.sendJson(res, 200, out);
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
    }
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(body));
  }

  sendEmpty(res, status) {
    res.statusCode = status;
    res.end();
  }

  sendError(res, error) {
    const detail = { message: error.message || "Internal error", domain: error.domain || "global", reason: error.reason || "backendError" };
    if (error.locationType) detail.locationType = error.locationType;
    if (error.location) detail.location = error.location;
    this.sendJson(res, error.code || 500, {
      error: {
        code: error.code || 500,
        message: error.message || "Internal error",
        errors: [detail],
      },
    });
  }
}

export default GoogleCalendarServer;
