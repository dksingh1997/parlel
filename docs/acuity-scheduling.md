# Acuity Scheduling

Lightweight, dependency-free, in-memory Acuity Scheduling API fake for testing scheduling code.

Default port: `4850`

## Quick start

```js
import { AcuitySchedulingServer } from "./services/acuity-scheduling/src/server.js";

const server = new AcuitySchedulingServer(4850);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point an Acuity client at `http://127.0.0.1:4850`. Authenticate with HTTP Basic
auth using `userId:apiKey` (any non-empty Basic credentials accepted):

```js
const basic = Buffer.from("parlel:parlel").toString("base64");
const res = await fetch("http://127.0.0.1:4850/api/v1/me", {
  headers: { Authorization: `Basic ${basic}` },
});
```

## Implemented operations

All `/api/v1/*` routes require HTTP Basic auth (numeric `userId` : `apiKey`),
matching the real Acuity Scheduling API. Requests and responses use JSON. State
is in-memory. Created appointments use the real Acuity appointment shape:

```json
{ "id": 1000001, "firstName": "Alice", "lastName": "Smith", "phone": "",
  "email": "alice@parlel.dev", "date": "June 1, 2024", "time": "9:00am",
  "endTime": "9:30am", "datetime": "2024-06-01T09:00:00-0000",
  "price": "0.00", "paid": "no", "amountPaid": "0.00",
  "type": "Initial Consultation", "appointmentTypeID": 1, "classID": null,
  "category": "", "duration": "30", "calendar": "Parlel", "calendarID": 1,
  "location": "", "certificate": null, "confirmationPage": "https://...",
  "formsText": "", "notes": "", "timezone": "UTC", "canceled": false,
  "forms": [], "labels": [] }
```

- `GET /api/v1/meta` — public service metadata (`{ "hooks": [] }`), no auth required.
- `GET /api/v1/me` — the authenticated account (parlel convenience; Acuity has no `/me`).
- `GET /api/v1/appointment-types` — list appointment types.
- `GET /api/v1/availability/dates?month=YYYY-MM` — available dates (deterministic).
- `GET /api/v1/availability/times?date=&appointmentTypeID=` — available times (deterministic).
- `GET /api/v1/appointments` — list appointments. Canceled appointments are
  excluded by default; pass `?canceled=true` for canceled only or `?showall=true` for both.
- `POST /api/v1/appointments` — create (book) an appointment. Required attributes,
  validated in order: `datetime`, `appointmentTypeID`, `firstName`, `lastName`,
  `email`. An unknown `appointmentTypeID` is rejected. Form values may be supplied
  via the `fields` array (`[{ "id": 1, "value": "..." }]`) and are echoed back in
  the `forms` array using the real `{ id, name, values: [{ value, name, fieldID, id }] }` shape.
- `GET /api/v1/appointments/:id` — retrieve an appointment.
- `PUT /api/v1/appointments/:id` — update appointment details from the real
  white-list: `firstName`, `lastName`, `phone`, `email`, `certificate`, `notes`,
  `fields`, `labels`, `smsOptIn`. `datetime` is **not** updatable here (Acuity
  rescheduling is a separate endpoint).
- `PUT /api/v1/appointments/:id/cancel` — cancel an appointment (`canceled: true`).

### Service & inspection (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset state.
- `OPTIONS *` — CORS preflight (`204`).

## Access via MCP / preview URL

The emulator is reachable at `ACUITY_SCHEDULING_BASE_URL`
(`http://127.0.0.1:4850`). When running in the parlel pool, an MCP tool /
preview URL proxies to this base URL — point your Acuity client at that URL with
Basic auth and every `/api/v1/*` endpoint above works as documented.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `GET /api/v1/meta` (public, no auth) | ✅ Supported |
| `GET /api/v1/me` (parlel convenience) | ✓ By design — Acuity has no `/me`; convenience stub |
| Appointment types | ✅ Supported |
| Appointments list (excludes canceled unless `canceled=true`/`showall=true`) | ✅ Supported |
| Appointment create (validates `datetime`, `appointmentTypeID`, `firstName`, `lastName`, `email`, type existence) | ✅ Supported |
| Appointment get / update / cancel | ✅ Supported |
| PUT update white-list (`firstName,lastName,phone,email,certificate,notes,fields,labels,smsOptIn`) | ✅ Supported |
| Real appointment fields (`classID,category,location,confirmationPage,formsText,labels,forms`) | ✅ Supported |
| `forms[].values` shape from POST/PUT `fields` | ✅ Supported |
| Basic auth (`userId:apiKey`) | ✅ Supported |
| Availability dates/times | ◐ Static deterministic stub |
| OAuth2 flow | ⟳ Roadmap (Basic accepted) |
| Forms / certificates / blocks / clients / calendars endpoints | ⟳ Roadmap |
| Reschedule endpoint (`PUT /appointments/:id/reschedule`) | ⟳ Roadmap |
| Real availability computation | ✓ By design — static, zero-cost local emulator |
| Certificate / coupon validation | ✓ By design — accepted, not validated |
| Credential validity | ✓ By design — any non-empty Basic accepted |
| Rate limiting (`429`) | ✓ By design — never throttles; local tests run at full speed, zero cost |

## Error codes & shapes

Errors use the real Acuity envelope `{ status_code, message, error }`, where
`error` is a stable machine-readable code:

| Status | `error` code | When |
| --- | --- | --- |
| `400` | `required_datetime` | `POST /appointments` missing `datetime` |
| `400` | `required_appointment_type_id` | missing `appointmentTypeID` |
| `400` | `required_first_name` | missing `firstName` |
| `400` | `required_last_name` | missing `lastName` |
| `400` | `required_email` | missing `email` |
| `400` | `invalid_appointment_type` | `appointmentTypeID` does not exist |
| `400` | `invalid_json` | malformed JSON body |
| `401` | `unauthorized` | missing Basic credentials (`{ "message": "Unauthorized" }`) |
| `404` | `not_found` | unknown appointment or endpoint |

## Manifest

See `services/acuity-scheduling/manifest.json`:

- name: `acuity-scheduling`, port: `4850`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `ACUITY_SCHEDULING_USER_ID`, `ACUITY_SCHEDULING_API_KEY`, `ACUITY_SCHEDULING_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ACUITY_SCHEDULING_USER_ID=parlel
ACUITY_SCHEDULING_API_KEY=parlel
ACUITY_SCHEDULING_BASE_URL=http://localhost:4850
```

<!-- parlel:testenv:end -->
