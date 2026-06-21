# Klaviyo

Lightweight, dependency-free, in-memory fake of the Klaviyo HTTP REST API for testing application code that talks to Klaviyo directly with the `axios` HTTP client (the documented integration path). Speaks the exact JSON:API wire protocol the real service uses, with zero cost and zero side effects. State is in-memory, ephemeral, and resettable.

Default port: `4658`

## Quick start

Start the server:

```js
import { KlaviyoServer } from "./services/klaviyo/src/server.js";

const server = new KlaviyoServer(4658);
await server.start();
// ... run your app / tests ...
await server.stop();
```

Point the real `axios` client at it. Klaviyo's modern API lives under `/api`, authenticates with a `Klaviyo-Key` header, and requires a `revision` header on every request:

```js
import axios from "axios";

const klaviyo = axios.create({
  baseURL: "http://127.0.0.1:4658/api", // point at the parlel fake
  headers: {
    Authorization: `Klaviyo-Key ${process.env.KLAVIYO_API_KEY}`,
    revision: "2024-10-15",
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// Create a profile (JSON:API body shape)
const { data } = await klaviyo.post("/profiles/", {
  data: { type: "profile", attributes: { email: "ada@parlel.test", first_name: "Ada" } },
});
// data.data.id => a generated profile id

// Track an event (returns HTTP 202, empty body)
await klaviyo.post("/events/", {
  data: {
    type: "event",
    attributes: {
      metric: { data: { type: "metric", attributes: { name: "Viewed Product" } } },
      profile: { data: { type: "profile", attributes: { email: "ada@parlel.test" } } },
      properties: { ProductName: "Widget" },
      value: 9.99,
    },
  },
});
```

For the public, browser/SDK-facing endpoints (`/client/*`), authenticate with the public key via the `company_id` query parameter instead of a header:

```js
await axios.post(
  "http://127.0.0.1:4658/client/events/?company_id=PARLEL",
  { data: { type: "event", attributes: { /* metric + profile */ } } },
);
```

Every write is captured in memory and can be inspected/reset via the `/__parlel/*` endpoints (see below).

## Implemented operations

### Profiles
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/profiles/` | List profiles (supports `filter=equals(email,"…")`, `phone_number`, `id`, `external_id`) |
| POST | `/api/profiles/` | Create a profile (409 on duplicate email) |
| GET | `/api/profiles/{id}/` | Get a profile |
| PATCH | `/api/profiles/{id}/` | Update a profile |
| GET | `/api/profiles/{id}/lists/` | Lists this profile belongs to |
| GET | `/api/profiles/{id}/segments/` | Segments this profile belongs to |
| POST | `/api/profile-import/` | Upsert a profile by email (201 create / 200 update) |
| POST | `/api/profile-subscription-bulk-create-jobs/` | Bulk subscribe profiles (202) |
| POST | `/api/profile-suppression-bulk-create-jobs/` | Bulk suppress profiles (202) |

### Lists
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/lists/` | List lists |
| POST | `/api/lists/` | Create a list |
| GET | `/api/lists/{id}/` | Get a list |
| PATCH | `/api/lists/{id}/` | Update a list |
| DELETE | `/api/lists/{id}/` | Delete a list |
| GET | `/api/lists/{id}/profiles/` | Profiles in a list |
| POST | `/api/lists/{id}/relationships/profiles/` | Add profiles to a list (204) |
| DELETE | `/api/lists/{id}/relationships/profiles/` | Remove profiles from a list (204) |

### Segments
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/segments/` | List segments |
| POST | `/api/segments/` | Create a segment |
| GET | `/api/segments/{id}/` | Get a segment |
| GET | `/api/segments/{id}/profiles/` | Profiles in a segment |

### Events
| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/events/` | Create an event (202, upserts profile + metric) |
| GET | `/api/events/` | List events (supports `filter=equals(metric_id,"…")`) |
| GET | `/api/events/{id}/` | Get an event |

### Metrics
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/metrics/` | List metrics (built-ins seeded: "Placed Order", "Active on Site") |
| GET | `/api/metrics/{id}/` | Get a metric |
| POST | `/api/metric-aggregates/` | Query aggregated metric data |

### Campaigns
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/campaigns/` | List campaigns |
| POST | `/api/campaigns/` | Create a campaign (status `Draft`) |
| GET | `/api/campaigns/{id}/` | Get a campaign |
| PATCH | `/api/campaigns/{id}/` | Update a campaign |
| DELETE | `/api/campaigns/{id}/` | Delete a campaign |
| POST | `/api/campaign-send-jobs/` | Send a campaign (202, sets status `Sent`) |

### Templates
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/templates/` | List templates |
| POST | `/api/templates/` | Create a template |
| GET | `/api/templates/{id}/` | Get a template |
| PATCH | `/api/templates/{id}/` | Update a template |
| DELETE | `/api/templates/{id}/` | Delete a template |

### Tags
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/tags/` | List tags |
| POST | `/api/tags/` | Create a tag |
| GET | `/api/tags/{id}/` | Get a tag |
| PATCH | `/api/tags/{id}/` | Update a tag (204) |
| DELETE | `/api/tags/{id}/` | Delete a tag |

### Flows
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/flows/` | List flows |
| POST | `/api/flows/` | Create a flow |
| GET | `/api/flows/{id}/` | Get a flow |

### Accounts
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/accounts/` | List accounts |
| GET | `/api/accounts/{id}/` | Get an account (only `PARLEL` exists) |

### Client (public) endpoints
Authenticate with `?company_id=<PUBLIC_KEY>`. All return HTTP 202 with an empty body.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/client/events/` | Track a public event |
| POST | `/client/profiles/` | Identify/update a public profile |
| POST | `/client/subscriptions/` | Create a subscription |
| POST | `/client/push-tokens/` | Register a push token |

### parlel control / inspection
| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check (unauthenticated) |
| POST | `/__parlel/reset` | Reset all in-memory state |
| GET | `/__parlel/state` | Counts of each resource type |
| GET | `/__parlel/events` | Dump all captured events |
| POST | `/__parlel/seed/segment` | Seed a segment (with optional `profileIds`) |
| POST | `/__parlel/seed/flow` | Seed a flow |

## Authentication

- **Private API (`/api/*`)**: `Authorization: Klaviyo-Key <pk_...>` header. A plain `Bearer <token>` is also accepted for flexibility. Missing/invalid auth returns `401` with code `not_authenticated`.
- **Public API (`/client/*`)**: `?company_id=<PUBLIC_KEY>` query parameter. Missing returns `400`.
- Every modern request normally carries a `revision` header (e.g. `2024-10-15`); the fake accepts any value.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Profiles CRUD + import/upsert + bulk jobs | ✅ Supported |
| Lists CRUD + membership relationships | ✅ Supported |
| Segments (list/get/create + membership) | ✅ Supported |
| Events (create/list/get) + Metrics + aggregates | ✅ Supported |
| Campaigns CRUD + send jobs | ✅ Supported |
| Templates / Tags / Flows / Accounts | ✅ Supported |
| Client public endpoints (events/profiles/subscriptions/push-tokens) | ✅ Supported |
| JSON:API error envelope + status codes | ✅ Supported |
| Duplicate-profile (409) + validation (400) + not-found (404) | ✅ Supported |
| Real list/segment evaluation engine (definitions are stored, not evaluated) | ⛔ Not implemented |
| Cursor pagination (`page[cursor]`) — links present but always single page | ⛔ Not implemented |
| `included`/sparse-fieldset relationship side-loading | ⛔ Not implemented |
| Webhooks delivery, OAuth flows, rate-limit (429) backoff | ⛔ Not implemented |
| Async job polling (bulk jobs complete synchronously) | ⛔ Not implemented |
| Real email/SMS delivery (campaign send is a no-op status change) | ⛔ Not implemented (by design) |

## Error codes / shapes

Errors use the Klaviyo JSON:API error envelope:

```json
{
  "errors": [
    {
      "id": "<uuid>",
      "status": "400",
      "code": "invalid",
      "title": "Invalid Input",
      "detail": "Invalid email address.",
      "source": { "pointer": "/data/attributes/email" },
      "links": {},
      "meta": {}
    }
  ]
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid` | Validation failure (bad type, missing required field, malformed JSON) |

| 404 | `not_found` | Resource id does not exist / unknown route |
| 405 | `method_not_allowed` | HTTP method not supported on a route |
| 409 | `duplicate_profile` | Creating a profile with an email that already exists (includes `meta.duplicate_profile_id`) |

Successful writes return JSON:API documents `{ data, links, meta }`. Create operations return `201`; updates return `200` (or `204` for tags); deletes return `204`; event/bulk/send operations return `202` with no body.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
KLAVIYO_API_KEY=pk_parlel_test_private_key
KLAVIYO_PUBLIC_API_KEY=PARLEL
KLAVIYO_BASE_URL=http://localhost:4658
KLAVIYO_API_BASE_URL=http://localhost:4658/api
KLAVIYO_API_REVISION=2024-10-15
```

<!-- parlel:testenv:end -->
