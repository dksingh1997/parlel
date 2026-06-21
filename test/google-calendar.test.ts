import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleCalendarServer } from "../services/google-calendar/src/server.js";

const PORT = 24615;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json | string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: typeof body === "string" ? headers : body ? { "content-type": "application/json", ...headers } : headers,
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: text && contentType.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}

async function createCalendar(summary = "Team Calendar") {
  return (await api("POST", "/calendar/v3/calendars", { summary, timeZone: "UTC" })).data;
}

async function createEvent(calendarId = "primary", summary = "Planning") {
  return (await api("POST", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    summary,
    description: "weekly planning",
    location: "Room 1",
    start: { dateTime: "2026-01-01T10:00:00.000Z", timeZone: "UTC" },
    end: { dateTime: "2026-01-01T11:00:00.000Z", timeZone: "UTC" },
    attendees: [{ email: "agent@example.com" }],
  })).data;
}

describe("Google Calendar Service", () => {
  let server: GoogleCalendarServer;

  beforeAll(async () => {
    server = new GoogleCalendarServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server", () => {
    it("starts, serves discovery and health, and resets ephemeral state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.calendars.has("primary")).toBe(true);

      const discovery = await api("GET", "/calendar/v3");
      expect(discovery).toMatchObject({ status: 200, data: { kind: "calendar#parlel" } });

      const altDiscovery = await api("GET", "/v3");
      expect(altDiscovery.data.kind).toBe("calendar#parlel");

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "google-calendar", calendars: 1, events: 0 });

      await createCalendar("Reset Me");
      await createEvent("primary", "Reset Event");
      expect(server.calendars.size).toBe(2);
      expect(server.events.get("primary")?.size).toBe(1);

      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toMatchObject({ status: 200, data: { ok: true } });
      expect(server.calendars.size).toBe(1);
      expect(server.events.get("primary")?.size).toBe(0);
    });

    it("returns Google-shaped JSON errors", async () => {
      const missing = await api("GET", "/calendar/v3/calendars/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error).toMatchObject({ code: 404, message: "Not Found" });
      expect(missing.data.error.status).toBeUndefined();
      expect(missing.data.error.errors[0]).toMatchObject({ domain: "global", reason: "notFound" });

      const invalid = await api("POST", "/calendar/v3/calendars", "{", { "content-type": "application/json" });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("parseError");

      const method = await api("GET", "/calendar/v3/freeBusy");
      expect(method.status).toBe(405);
      expect(method.data.error.errors[0].reason).toBe("methodNotAllowed");

      const missingSummary = await api("POST", "/calendar/v3/calendars", { timeZone: "UTC" });
      expect(missingSummary.status).toBe(400);
      expect(missingSummary.data.error.errors[0]).toMatchObject({ domain: "calendar", reason: "required", location: "summary" });
    });
  });

  describe("Calendars", () => {
    it("insert, get, patch, update, clear, and delete calendars", async () => {
      const created = await createCalendar("Engineering");
      expect(created).toMatchObject({ kind: "calendar#calendar", summary: "Engineering", timeZone: "UTC" });

      const got = await api("GET", `/calendar/v3/calendars/${created.id}`);
      expect(got.data.summary).toBe("Engineering");

      const patched = await api("PATCH", `/calendar/v3/calendars/${created.id}`, { description: "Build calendar", location: "Remote" });
      expect(patched.data).toMatchObject({ summary: "Engineering", description: "Build calendar", location: "Remote" });

      const updated = await api("PUT", `/calendar/v3/calendars/${created.id}`, { summary: "Platform", timeZone: "America/New_York" });
      expect(updated.data).toMatchObject({ id: created.id, summary: "Platform", timeZone: "America/New_York" });

      await api("POST", `/calendar/v3/calendars/${created.id}/events`, {
        summary: "to clear",
        start: { dateTime: "2026-01-01T10:00:00.000Z" },
        end: { dateTime: "2026-01-01T11:00:00.000Z" },
      });
      expect(server.events.get(created.id)?.size).toBe(1);
      const cleared = await api("POST", `/calendar/v3/calendars/${created.id}/clear`);
      expect(cleared.status).toBe(204);
      expect(server.events.get(created.id)?.size).toBe(0);

      const deleted = await api("DELETE", `/calendar/v3/calendars/${created.id}`);
      expect(deleted.status).toBe(204);
      expect(server.calendars.has(created.id)).toBe(false);

      const primaryDelete = await api("DELETE", "/calendar/v3/calendars/primary");
      expect(primaryDelete.status).toBe(400);
      expect(primaryDelete.data.error.errors[0].reason).toBe("invalidArgument");
    });
  });

  describe("Calendar list", () => {
    it("list, insert, get, patch, update, watch, and delete calendar list entries", async () => {
      const calendar = await createCalendar("List Target");
      await api("DELETE", `/calendar/v3/users/me/calendarList/${calendar.id}`);

      const inserted = await api("POST", "/calendar/v3/users/me/calendarList", { id: calendar.id, colorId: "2", hidden: true, selected: false });
      expect(inserted.data).toMatchObject({ kind: "calendar#calendarListEntry", id: calendar.id, hidden: true, selected: false });

      const hiddenList = await api("GET", "/calendar/v3/users/me/calendarList");
      expect(hiddenList.data.items.map((item: Json) => item.id)).not.toContain(calendar.id);

      const list = await api("GET", "/calendar/v3/users/me/calendarList?showHidden=true&maxResults=1");
      expect(list.data.items).toHaveLength(1);
      expect(list.data.nextPageToken).toBeDefined();

      const got = await api("GET", `/calendar/v3/users/me/calendarList/${calendar.id}`);
      expect(got.data.id).toBe(calendar.id);

      const patched = await api("PATCH", `/calendar/v3/users/me/calendarList/${calendar.id}`, { hidden: false, selected: true, backgroundColor: "#000000" });
      expect(patched.data).toMatchObject({ hidden: false, selected: true, backgroundColor: "#000000" });

      const updated = await api("PUT", `/calendar/v3/users/me/calendarList/${calendar.id}`, { selected: false, accessRole: "reader" });
      expect(updated.data).toMatchObject({ id: calendar.id, selected: false, accessRole: "reader" });

      const watch = await api("POST", "/calendar/v3/users/me/calendarList/watch", { id: "chan-calendar-list", type: "web_hook", address: "https://example.test/calendar-list" });
      expect(watch.data).toMatchObject({ kind: "api#channel", id: "chan-calendar-list", resourceId: "calendarList" });
      expect(server.channels.has("chan-calendar-list")).toBe(true);

      const deleted = await api("DELETE", `/calendar/v3/users/me/calendarList/${calendar.id}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/calendar/v3/users/me/calendarList/${calendar.id}`);
      expect(missing.status).toBe(404);
    });
  });

  describe("ACL", () => {
    it("insert, list, get, patch, update, watch, and delete ACL rules", async () => {
      const calendar = await createCalendar("ACL Target");
      const created = await api("POST", `/calendar/v3/calendars/${calendar.id}/acl`, { role: "reader", scope: { type: "user", value: "agent@example.com" } });
      expect(created.data).toMatchObject({ kind: "calendar#aclRule", id: "user:agent@example.com", role: "reader" });

      const duplicate = await api("POST", `/calendar/v3/calendars/${calendar.id}/acl`, { role: "reader", scope: { type: "user", value: "agent@example.com" } });
      expect(duplicate.status).toBe(409);
      expect(duplicate.data.error.errors[0].reason).toBe("duplicate");

      const missingRole = await api("POST", `/calendar/v3/calendars/${calendar.id}/acl`, { scope: { type: "user", value: "missing@example.com" } });
      expect(missingRole.status).toBe(400);
      expect(missingRole.data.error.errors[0]).toMatchObject({ reason: "required", location: "role" });

      const list = await api("GET", `/calendar/v3/calendars/${calendar.id}/acl`);
      expect(list.data.items.map((rule: Json) => rule.id)).toContain("user:agent@example.com");

      const ruleId = encodeURIComponent("user:agent@example.com");
      const got = await api("GET", `/calendar/v3/calendars/${calendar.id}/acl/${ruleId}`);
      expect(got.data.scope.value).toBe("agent@example.com");

      const patched = await api("PATCH", `/calendar/v3/calendars/${calendar.id}/acl/${ruleId}`, { role: "writer" });
      expect(patched.data.role).toBe("writer");

      const updated = await api("PUT", `/calendar/v3/calendars/${calendar.id}/acl/${ruleId}`, { role: "owner", scope: { type: "user", value: "agent@example.com" } });
      expect(updated.data).toMatchObject({ id: "user:agent@example.com", role: "owner" });

      const watch = await api("POST", `/calendar/v3/calendars/${calendar.id}/acl/watch`, { id: "chan-acl", type: "web_hook", address: "https://example.test/acl" });
      expect(watch.data).toMatchObject({ kind: "api#channel", id: "chan-acl", resourceId: `acl/${calendar.id}` });

      const deleted = await api("DELETE", `/calendar/v3/calendars/${calendar.id}/acl/${ruleId}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/calendar/v3/calendars/${calendar.id}/acl/${ruleId}`);
      expect(missing.status).toBe(404);
    });
  });

  describe("Events", () => {
    it("insert, get, list, patch, update, watch, and delete events", async () => {
      const created = await createEvent("primary", "Planning Meeting");
      expect(created).toMatchObject({ kind: "calendar#event", summary: "Planning Meeting", status: "confirmed" });

      const duplicate = await api("POST", "/calendar/v3/calendars/primary/events", {
        id: created.id,
        summary: "duplicate",
        start: { dateTime: "2026-01-01T10:00:00.000Z" },
        end: { dateTime: "2026-01-01T11:00:00.000Z" },
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.data.error.errors[0].reason).toBe("duplicate");

      const got = await api("GET", `/calendar/v3/calendars/primary/events/${created.id}`);
      expect(got.data.attendees[0].email).toBe("agent@example.com");

      const patched = await api("PATCH", `/calendar/v3/calendars/primary/events/${created.id}`, { summary: "Planning Updated", colorId: "2" });
      expect(patched.data).toMatchObject({ summary: "Planning Updated", colorId: "2" });

      const updated = await api("PUT", `/calendar/v3/calendars/primary/events/${created.id}`, {
        summary: "Planning Replaced",
        start: { dateTime: "2026-01-02T10:00:00.000Z", timeZone: "UTC" },
        end: { dateTime: "2026-01-02T11:00:00.000Z", timeZone: "UTC" },
      });
      expect(updated.data).toMatchObject({ id: created.id, summary: "Planning Replaced" });

      const listed = await api("GET", "/calendar/v3/calendars/primary/events?q=Planning&timeMin=2026-01-02T00:00:00.000Z&timeMax=2026-01-03T00:00:00.000Z&orderBy=startTime&singleEvents=true&maxResults=1");
      expect(listed.data.items).toHaveLength(1);
      expect(listed.data.items[0].id).toBe(created.id);
      expect(listed.data.nextSyncToken).toMatch(/^sync_/);

      const watch = await api("POST", "/calendar/v3/calendars/primary/events/watch", { id: "chan-events", type: "web_hook", address: "https://example.test/events" });
      expect(watch.data).toMatchObject({ kind: "api#channel", id: "chan-events", resourceId: "events/primary" });
      expect(server.channels.has("chan-events")).toBe(true);

      const deleted = await api("DELETE", `/calendar/v3/calendars/primary/events/${created.id}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/calendar/v3/calendars/primary/events/${created.id}`);
      expect(missing.status).toBe(404);

      const missingStart = await api("POST", "/calendar/v3/calendars/primary/events", { summary: "No start", end: { dateTime: "2026-01-01T11:00:00.000Z" } });
      expect(missingStart.status).toBe(400);
      expect(missingStart.data.error.errors[0]).toMatchObject({ domain: "calendar", reason: "required", location: "start" });
    });

    it("import, quickAdd, instances, move, list deleted events, and validate edge cases", async () => {
      const imported = await api("POST", "/calendar/v3/calendars/primary/events/import", {
        id: "imported-1",
        iCalUID: "ical-1@example.com",
        summary: "Imported",
        start: { dateTime: "2026-02-01T09:00:00.000Z" },
        end: { dateTime: "2026-02-01T10:00:00.000Z" },
      });
      expect(imported.data).toMatchObject({ id: "imported-1", iCalUID: "ical-1@example.com" });

      const byIcal = await api("GET", "/calendar/v3/calendars/primary/events?iCalUID=ical-1@example.com");
      expect(byIcal.data.items[0].id).toBe("imported-1");

      const quick = await api("POST", "/calendar/v3/calendars/primary/events/quickAdd?text=Lunch%20with%20Ada");
      expect(quick.data.summary).toBe("Lunch with Ada");

      const recurring = await api("POST", "/calendar/v3/calendars/primary/events", {
        summary: "Daily standup",
        start: { dateTime: "2026-03-01T09:00:00.000Z" },
        end: { dateTime: "2026-03-01T09:15:00.000Z" },
        recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
      });
      const instances = await api("GET", `/calendar/v3/calendars/primary/events/${recurring.data.id}/instances?timeMin=2026-03-01T00:00:00.000Z&timeMax=2026-03-04T00:00:00.000Z`);
      expect(instances.data.items).toHaveLength(3);
      expect(instances.data.items[0].recurringEventId).toBe(recurring.data.id);
      expect(instances.data.items[0].id).toBe(`${recurring.data.id}_0`);

      const singleEvents = await api("GET", "/calendar/v3/calendars/primary/events?singleEvents=true&q=Daily");
      expect(singleEvents.data.items).toHaveLength(3);

      const destination = await createCalendar("Destination");
      const moved = await api("POST", `/calendar/v3/calendars/primary/events/${imported.data.id}/move?destination=${destination.id}`);
      expect(moved.data.organizer.email).toBe(destination.id);
      expect(server.events.get("primary")?.has(imported.data.id)).toBe(false);
      expect(server.events.get(destination.id)?.has(imported.data.id)).toBe(true);

      const missingDestination = await api("POST", `/calendar/v3/calendars/primary/events/${quick.data.id}/move`);
      expect(missingDestination.status).toBe(400);
      expect(missingDestination.data.error.errors[0].reason).toBe("required");

      await api("PATCH", `/calendar/v3/calendars/primary/events/${quick.data.id}`, { status: "cancelled" });
      const withoutDeleted = await api("GET", "/calendar/v3/calendars/primary/events?q=Lunch");
      expect(withoutDeleted.data.items).toHaveLength(0);
      const withDeleted = await api("GET", "/calendar/v3/calendars/primary/events?q=Lunch&showDeleted=true");
      expect(withDeleted.data.items[0]).toMatchObject({ id: quick.data.id, status: "cancelled" });

      const badPage = await api("GET", "/calendar/v3/calendars/primary/events?pageToken=bad");
      expect(badPage.status).toBe(400);

      const badOrder = await api("GET", "/calendar/v3/calendars/primary/events?orderBy=startTime");
      expect(badOrder.status).toBe(400);
      expect(badOrder.data.error.errors[0]).toMatchObject({ domain: "calendar", reason: "invalid", location: "orderBy" });
    });
  });

  describe("Freebusy, colors, settings, and channels", () => {
    it("queries freebusy and gets colors", async () => {
      await createEvent("primary", "Busy Focus");
      await api("POST", "/calendar/v3/calendars/primary/events", {
        summary: "Transparent Hold",
        transparency: "transparent",
        start: { dateTime: "2026-01-01T10:30:00.000Z" },
        end: { dateTime: "2026-01-01T11:30:00.000Z" },
      });

      const freebusy = await api("POST", "/calendar/v3/freeBusy", {
        timeMin: "2026-01-01T00:00:00.000Z",
        timeMax: "2026-01-02T00:00:00.000Z",
        items: [{ id: "primary" }, { id: "missing" }],
      });
      expect(freebusy.data.kind).toBe("calendar#freeBusy");
      expect(freebusy.data.calendars.primary.busy).toEqual([{ start: "2026-01-01T10:00:00.000Z", end: "2026-01-01T11:00:00.000Z" }]);
      expect(freebusy.data.calendars.missing.errors[0].reason).toBe("notFound");

      const missingTime = await api("POST", "/calendar/v3/freeBusy", { timeMax: "2026-01-02T00:00:00.000Z", items: [{ id: "primary" }] });
      expect(missingTime.status).toBe(400);
      expect(missingTime.data.error.errors[0]).toMatchObject({ domain: "calendar", reason: "required", location: "timeMin" });

      const colors = await api("GET", "/calendar/v3/colors");
      expect(colors.data.kind).toBe("calendar#colors");
      expect(colors.data.calendar["9"].background).toBe("#5484ed");
      expect(colors.data.event["11"].background).toBe("#dc2127");
    });

    it("lists, gets, watches settings, and stops channels", async () => {
      const settings = await api("GET", "/calendar/v3/users/me/settings?maxResults=2");
      expect(settings.data.kind).toBe("calendar#settings");
      expect(settings.data.items).toHaveLength(2);
      expect(settings.data.nextPageToken).toBeDefined();

      const timezone = await api("GET", "/calendar/v3/users/me/settings/timezone");
      expect(timezone.data).toMatchObject({ kind: "calendar#setting", id: "timezone", value: "UTC" });

      const missing = await api("GET", "/calendar/v3/users/me/settings/missing");
      expect(missing.status).toBe(404);

      const settingsWatch = await api("POST", "/calendar/v3/users/me/settings/watch", { id: "chan-settings", type: "web_hook", address: "https://example.test/settings" });
      expect(settingsWatch.data).toMatchObject({ kind: "api#channel", id: "chan-settings", resourceId: "settings" });
      expect(server.channels.has("chan-settings")).toBe(true);

      const stop = await api("POST", "/calendar/v3/channels/stop", { id: "chan-settings", resourceId: "settings" });
      expect(stop).toMatchObject({ status: 204, text: "" });
      expect(server.channels.has("chan-settings")).toBe(false);

      const invalidWatch = await api("POST", "/calendar/v3/users/me/settings/watch", { type: "web_hook" });
      expect(invalidWatch.status).toBe(400);
      expect(invalidWatch.data.error.errors[0]).toMatchObject({ reason: "required", location: "id" });

      const invalidStop = await api("POST", "/calendar/v3/channels/stop", { id: "chan-settings" });
      expect(invalidStop.status).toBe(400);
      expect(invalidStop.data.error.errors[0]).toMatchObject({ reason: "required", location: "resourceId" });
    });
  });
});
