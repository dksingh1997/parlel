# google-calendar

Dependency-free local emulator for Google Calendar API v3 JSON REST calls. It is designed for `googleapis` Calendar clients, raw `fetch`, and AI-agent test flows that need calendars, events, ACL rules, free/busy, colors, settings, and watch channels without calling `https://www.googleapis.com/calendar/v3`.

Default port: `4615`

## Quick start

```js
import { google } from "googleapis";
import { GoogleCalendarServer } from "./services/google-calendar/src/server.js";

const server = new GoogleCalendarServer(4615);
await server.start();

const calendar = google.calendar({ version: "v3", auth: "not-used-by-parlel" });
calendar.context._options.rootUrl = "http://127.0.0.1:4615/";

const created = await calendar.calendars.insert({
  requestBody: { summary: "Engineering", timeZone: "UTC" },
});

await calendar.events.insert({
  calendarId: created.data.id,
  requestBody: {
    summary: "Planning",
    start: { dateTime: "2026-01-01T10:00:00.000Z" },
    end: { dateTime: "2026-01-01T11:00:00.000Z" },
  },
});

await server.stop();
```

Reset state with `server.reset()` or `POST /_parlel/reset`. Health is available at `GET /_parlel/health`.

## Implemented operations

### Calendars

| googleapis method | HTTP endpoint |
| --- | --- |
| `calendar.calendars.insert` | `POST /calendar/v3/calendars` |
| `calendar.calendars.get` | `GET /calendar/v3/calendars/{calendarId}` |
| `calendar.calendars.patch` | `PATCH /calendar/v3/calendars/{calendarId}` |
| `calendar.calendars.update` | `PUT /calendar/v3/calendars/{calendarId}` |
| `calendar.calendars.clear` | `POST /calendar/v3/calendars/{calendarId}/clear` |
| `calendar.calendars.delete` | `DELETE /calendar/v3/calendars/{calendarId}` |

### Calendar list

| googleapis method | HTTP endpoint |
| --- | --- |
| `calendar.calendarList.list` | `GET /calendar/v3/users/me/calendarList` |
| `calendar.calendarList.insert` | `POST /calendar/v3/users/me/calendarList` |
| `calendar.calendarList.get` | `GET /calendar/v3/users/me/calendarList/{calendarId}` |
| `calendar.calendarList.patch` | `PATCH /calendar/v3/users/me/calendarList/{calendarId}` |
| `calendar.calendarList.update` | `PUT /calendar/v3/users/me/calendarList/{calendarId}` |
| `calendar.calendarList.delete` | `DELETE /calendar/v3/users/me/calendarList/{calendarId}` |
| `calendar.calendarList.watch` | `POST /calendar/v3/users/me/calendarList/watch` |

### ACL

| googleapis method | HTTP endpoint |
| --- | --- |
| `calendar.acl.list` | `GET /calendar/v3/calendars/{calendarId}/acl` |
| `calendar.acl.insert` | `POST /calendar/v3/calendars/{calendarId}/acl` |
| `calendar.acl.get` | `GET /calendar/v3/calendars/{calendarId}/acl/{ruleId}` |
| `calendar.acl.patch` | `PATCH /calendar/v3/calendars/{calendarId}/acl/{ruleId}` |
| `calendar.acl.update` | `PUT /calendar/v3/calendars/{calendarId}/acl/{ruleId}` |
| `calendar.acl.delete` | `DELETE /calendar/v3/calendars/{calendarId}/acl/{ruleId}` |
| `calendar.acl.watch` | `POST /calendar/v3/calendars/{calendarId}/acl/watch` |

### Events

| googleapis method | HTTP endpoint |
| --- | --- |
| `calendar.events.list` | `GET /calendar/v3/calendars/{calendarId}/events` |
| `calendar.events.insert` | `POST /calendar/v3/calendars/{calendarId}/events` |
| `calendar.events.import` | `POST /calendar/v3/calendars/{calendarId}/events/import` |
| `calendar.events.quickAdd` | `POST /calendar/v3/calendars/{calendarId}/events/quickAdd?text=...` |
| `calendar.events.get` | `GET /calendar/v3/calendars/{calendarId}/events/{eventId}` |
| `calendar.events.patch` | `PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}` |
| `calendar.events.update` | `PUT /calendar/v3/calendars/{calendarId}/events/{eventId}` |
| `calendar.events.delete` | `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}` |
| `calendar.events.move` | `POST /calendar/v3/calendars/{calendarId}/events/{eventId}/move?destination=...` |
| `calendar.events.instances` | `GET /calendar/v3/calendars/{calendarId}/events/{eventId}/instances` |
| `calendar.events.watch` | `POST /calendar/v3/calendars/{calendarId}/events/watch` |

### Other resources

| googleapis method | HTTP endpoint |
| --- | --- |
| `calendar.freebusy.query` | `POST /calendar/v3/freeBusy` |
| `calendar.colors.get` | `GET /calendar/v3/colors` |
| `calendar.settings.list` | `GET /calendar/v3/users/me/settings` |
| `calendar.settings.get` | `GET /calendar/v3/users/me/settings/{setting}` |
| `calendar.settings.watch` | `POST /calendar/v3/users/me/settings/watch` |
| `calendar.channels.stop` | `POST /calendar/v3/channels/stop` |

All endpoints also accept the short `/v3/...` prefix.

## Access via MCP / preview URL

When run inside a parlel sandbox, point Google Calendar API clients at the preview URL or local base URL, for example `http://127.0.0.1:4615/`. Node `googleapis` users can set `calendar.context._options.rootUrl`; raw clients can call the documented `/calendar/v3/...` paths directly. MCP-driven agents can reset state between scenarios with `POST /_parlel/reset`.

## Surface coverage

Legend: ✅ supported · ◐ accepted-not-enforced · ✓ by design · ⟳ roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| Google Calendar API v3 JSON REST paths for calendars, calendarList, ACL, events, freeBusy, colors, settings, and channels.stop | ✅ supported | Tested over HTTP with `/calendar/v3/...` and `/v3/...` prefixes. |
| In-memory calendars, calendar list entries, ACL rules, events, settings, and watch channels | ✅ supported | Ephemeral and resettable; primary calendar is seeded on reset. |
| Required fields for `calendars.insert`, `events.insert`, `events.import`, `acl.insert`, watch channels, `freeBusy.query`, and `channels.stop` | ✅ supported | Missing fields return Calendar-style `400` JSON errors. |
| Pagination with `maxResults` and numeric `pageToken` | ✅ supported | Calendar/list/settings/ACL cap at 250; events cap at 2500. |
| Common event filters | ✅ supported | `q`, `iCalUID`, `timeMin`, `timeMax`, `updatedMin`, `showDeleted`, `singleEvents`, and `orderBy` are exercised. |
| Recurring event expansion | ◐ accepted-not-enforced | Expands simple `RRULE:FREQ=DAILY|WEEKLY;COUNT=n`; full RFC5545 recurrence semantics are roadmap. |
| Event, calendar, ACL, and channel notification side effects | ✓ by design | Stores request fields and channel metadata but does not send email, reminders, or outbound webhooks. |
| OAuth bearer tokens, API keys, IAM scopes, and per-user permissions | ◐ accepted-not-enforced | Real Google Calendar requires OAuth for most operations; the emulator accepts unauthenticated local requests. |
| Free/busy calculation | ✅ supported | Returns `calendar#freeBusy` and excludes transparent or cancelled events. |
| Google Meet conference creation | ✓ by design | `conferenceData` is stored when provided; no real Meet room is created. |
| Incremental sync semantics for `syncToken` | ⟳ roadmap | List responses can include `nextSyncToken`, but sync-token delta replay and `410 fullSyncRequired` are not implemented. |
| Rate limiting and quota errors | ✓ by design | The local emulator never throttles. |
| Persistence across process restarts | ✓ by design | State is intentionally in-memory only. |

## Error codes & shapes

Errors use the Google Calendar API error envelope documented in the Calendar error guide. The body does not include a top-level `error.status` member.

```json
{
  "error": {
    "errors": [
      {
        "domain": "global",
        "reason": "notFound",
        "message": "Not Found"
      }
    ],
    "code": 404,
    "message": "Not Found"
  }
}
```

Common codes:

| Status | When |
| --- | --- |
| `400` | invalid JSON, missing required field (`reason: required`), invalid query combination |
| `404` | unknown calendar, event, ACL rule, setting, or endpoint (`reason: notFound`) |
| `405` | known resource path with an unsupported HTTP method (`reason: methodNotAllowed`) |
| `409` | duplicate supplied identifier (`reason: duplicate`) |
| `500` | unexpected emulator failure (`reason: backendError`) |

Because auth is accepted-not-enforced, the emulator does not emit real Google `401 authError` responses for missing or invalid OAuth credentials.

## Manifest

See `services/google-calendar/manifest.json`:

- name: `google-calendar`, image: `parlel/google-calendar:0.1`
- port: `4615`, protocol: `http`, healthcheck: `/_parlel/health`, startup approximately `100ms`
- env: `GOOGLE_CALENDAR_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_CALENDAR_EMULATOR_HOST=http://localhost:4615
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
