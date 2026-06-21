# ActiveCampaign

Lightweight, dependency-free, in-memory fake of the ActiveCampaign v3 HTTP REST API for testing application code that talks to ActiveCampaign directly with the `axios` HTTP client (the documented integration path). Speaks the exact wire protocol the real service uses — singular-keyed request/response bodies, `Api-Token` auth, plural-keyed list envelopes with `meta.total`, and HTTP 422 validation errors — with zero cost and zero side effects. State is in-memory, ephemeral, and resettable.

Default port: `4659`

## Quick start

Start the server:

```js
import { ActivecampaignServer } from "./services/activecampaign/src/server.js";

const server = new ActivecampaignServer(4659);
await server.start();
// ... run your app / tests ...
await server.stop();
```

Point the real `axios` client at it. The v3 API lives under `/api/3` and authenticates with an `Api-Token` request header:

```js
import axios from "axios";

const ac = axios.create({
  baseURL: "http://127.0.0.1:4659/api/3", // point at the parlel fake
  headers: {
    "Api-Token": process.env.ACTIVECAMPAIGN_API_TOKEN,
    "Content-Type": "application/json",
  },
});

// Create a contact (singular-keyed body)
const { data } = await ac.post("/contacts", {
  contact: { email: "ada@parlel.test", firstName: "Ada", lastName: "Lovelace" },
});
// data.contact.id => a generated contact id (string)

// Upsert a contact by email (always responds 201, create or update — and the
// response wraps a top-level `fieldValues` array alongside `contact`)
await ac.post("/contact/sync", {
  contact: { email: "ada@parlel.test", firstName: "Ada B.", fieldValues: [{ field: "1", value: "VIP" }] },
});

// Create a tag and apply it to the contact
const { data: tag } = await ac.post("/tags", { tag: { tag: "VIP", tagType: "contact" } });
await ac.post("/contactTags", { contactTag: { contact: data.contact.id, tag: tag.tag.id } });

// Subscribe the contact to a list (status "1" = subscribe, "2" = unsubscribe)
const { data: list } = await ac.post("/lists", { list: { name: "Newsletter" } });
await ac.post("/contactLists", {
  contactList: { list: list.list.id, contact: data.contact.id, status: "1" },
});

// List contacts (plural-keyed envelope + meta.total)
const { data: page } = await ac.get("/contacts?limit=20&offset=0");
// page.contacts => [...], page.meta.total => "N"
```

Errors raise HTTP status codes (`axios` throws on `>= 400`); inspect `error.response.status` and `error.response.data.errors` for validation failures.

## Wire conventions

- **Base path:** `/api/3`
- **Auth:** `Api-Token: <token>` header. Any non-empty token is accepted by the fake. A missing token returns **HTTP 403** with `{ "message": "..." }`.
- **Create / update bodies** wrap the resource under its singular key, e.g. `{ "contact": { ... } }`, `{ "tag": { ... } }`, `{ "deal": { ... } }`.
- **Single-resource responses** wrap under the singular key: `{ "contact": { ... } }`.
- **Collection responses** wrap under the plural key plus a `meta` block: `{ "contacts": [ ... ], "meta": { "total": "N" } }`.
- **IDs** are returned as **strings** (matching ActiveCampaign's serialisation).
- **Pagination:** `?limit=` (default 20, max 100) and `?offset=` (default 0).
- **Validation errors** use **HTTP 422** with the real ActiveCampaign envelope —
  an `errors` array of `{ title, detail, code }`. The v3 API does **not** use the
  JSON:API `source.pointer` convention, so the emulator never emits a `source` key:
  ```json
  { "errors": [ { "title": "...", "detail": "...", "code": "duplicate" } ] }
  ```

## Implemented operations

### Contacts
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/contacts` | List contacts. Filters: `?email=`, `?search=`, `?listid=`. Paginated. |
| POST | `/api/3/contacts` | Create a contact (requires valid, unique `email`). Accepts inline `contact.fieldValues: [{ field, value }]` (unknown field ids ignored). |
| GET | `/api/3/contacts/{id}` | Retrieve a contact. |
| PUT | `/api/3/contacts/{id}` | Update a contact. |
| DELETE | `/api/3/contacts/{id}` | Delete a contact (cascades tags/lists/field values). |
| POST | `/api/3/contact/sync` | Upsert a contact by email. Always returns **201** (create or update) and wraps a top-level `fieldValues` array alongside `contact`. Accepts inline `contact.fieldValues: [{ field, value }]`. |
| GET | `/api/3/contacts/{id}/contactTags` | Tags applied to a contact. |
| GET | `/api/3/contacts/{id}/contactLists` | List memberships for a contact. |
| GET | `/api/3/contacts/{id}/fieldValues` | Custom field values for a contact. |

### Tags
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/tags` | List tags. |
| POST | `/api/3/tags` | Create a tag (unique `tag` name). |
| GET | `/api/3/tags/{id}` | Retrieve a tag. |
| PUT | `/api/3/tags/{id}` | Update a tag. |
| DELETE | `/api/3/tags/{id}` | Delete a tag (cascades contactTags). |

### Contact Tags
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/contactTags` | List all contact-tag links. |
| POST | `/api/3/contactTags` | Apply a tag to a contact (idempotent). |
| DELETE | `/api/3/contactTags/{id}` | Remove a tag from a contact. |

### Lists & Contact Lists
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/lists` | List lists (each carries a live `subscriber_count`). |
| POST | `/api/3/lists` | Create a list. |
| GET | `/api/3/lists/{id}` | Retrieve a list. |
| PUT | `/api/3/lists/{id}` | Update a list. |
| DELETE | `/api/3/lists/{id}` | Delete a list (cascades contactLists). |
| GET | `/api/3/contactLists` | List all subscription records. |
| POST | `/api/3/contactLists` | Subscribe (`status:"1"`) / unsubscribe (`status:"2"`) a contact. Upserts. |

### Custom Fields & Field Values
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/fields` | List custom field definitions. |
| POST | `/api/3/fields` | Create a custom field (requires `title`, `type`). |
| GET | `/api/3/fields/{id}` | Retrieve a custom field. |
| PUT | `/api/3/fields/{id}` | Update a custom field. |
| DELETE | `/api/3/fields/{id}` | Delete a custom field (cascades field values). |
| GET | `/api/3/fieldValues` | List field values. |
| POST | `/api/3/fieldValues` | Set a contact's field value (upsert per contact+field). |
| GET | `/api/3/fieldValues/{id}` | Retrieve a field value. |
| PUT | `/api/3/fieldValues/{id}` | Update a field value. |
| DELETE | `/api/3/fieldValues/{id}` | Delete a field value. |

### Deals, Pipelines (Deal Groups) & Stages
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/deals` | List deals. |
| POST | `/api/3/deals` | Create a deal (requires `title`; validates `stage`). Response wraps `{ "contacts": [...], "deal": {...}, "dealStages": [...] }`; the deal carries `hash`, `nextdate`, `winProbability`, `account`, `isDisabled`, and a `fields` array of `{ customFieldId, fieldValue, dealId }`. `value` is in cents. |
| GET | `/api/3/deals/{id}` | Retrieve a deal. |
| PUT | `/api/3/deals/{id}` | Update a deal. |
| DELETE | `/api/3/deals/{id}` | Delete a deal. |
| GET | `/api/3/dealGroups` | List pipelines (a default pipeline is seeded). |
| POST | `/api/3/dealGroups` | Create a pipeline. |
| GET | `/api/3/dealGroups/{id}` | Retrieve a pipeline. |
| PUT | `/api/3/dealGroups/{id}` | Update a pipeline. |
| DELETE | `/api/3/dealGroups/{id}` | Delete a pipeline. |
| GET | `/api/3/dealStages` | List stages (5 default stages are seeded). |
| POST | `/api/3/dealStages` | Create a stage (requires `title`, valid `group`). |
| GET | `/api/3/dealStages/{id}` | Retrieve a stage. |
| PUT | `/api/3/dealStages/{id}` | Update a stage. |
| DELETE | `/api/3/dealStages/{id}` | Delete a stage. |

### Notes
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/notes` | List notes. |
| POST | `/api/3/notes` | Create a note (requires `note` text). |
| GET | `/api/3/notes/{id}` | Retrieve a note. |
| PUT | `/api/3/notes/{id}` | Update a note. |
| DELETE | `/api/3/notes/{id}` | Delete a note. |

### Accounts (CRM)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/accounts` | List CRM accounts. |
| POST | `/api/3/accounts` | Create an account (requires `name`). |
| GET | `/api/3/accounts/{id}` | Retrieve an account. |
| PUT | `/api/3/accounts/{id}` | Update an account. |
| DELETE | `/api/3/accounts/{id}` | Delete an account. |

### Contact Automations
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/contactAutomations` | List automation enrolments. |
| POST | `/api/3/contactAutomations` | Enrol a contact into an automation. |
| GET | `/api/3/contactAutomations/{id}` | Retrieve an enrolment. |
| DELETE | `/api/3/contactAutomations/{id}` | Remove a contact from an automation. |

### Webhooks
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/webhooks` | List webhooks. |
| POST | `/api/3/webhooks` | Create a webhook (requires `name`, `url`). |
| GET | `/api/3/webhooks/{id}` | Retrieve a webhook. |
| PUT | `/api/3/webhooks/{id}` | Update a webhook. |
| DELETE | `/api/3/webhooks/{id}` | Delete a webhook. |

### Read-only resources (seeded)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/3/campaigns`, `/api/3/campaigns/{id}` | Campaigns (one seeded). |
| GET | `/api/3/automations`, `/api/3/automations/{id}` | Automations (one seeded). |
| GET | `/api/3/segments`, `/api/3/segments/{id}` | Segments (one seeded). |
| GET | `/api/3/users`, `/api/3/users/{id}` | Users (one seeded). |

### Infrastructure / control (parlel-specific)
| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check (no auth). Returns `{ "status": "ok" }`. |
| POST | `/__parlel/reset` | Wipe all user data, keep seeded defaults. |
| GET | `/__parlel/state` | Resource counts for inspection. |

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
| --- | --- | --- |
| `Api-Token` header auth | ✅ | Any non-empty token accepted; missing token → 403 `{ message }`. |
| Contacts CRUD + `contact/sync` upsert | ✅ | Email validation + duplicate detection; sync always returns 201. |
| Inline `contact.fieldValues` on create / sync | ✅ | Upserted against existing field defs; unknown ids ignored. |
| `contact/sync` top-level `fieldValues` in response | ✅ | Mirrors the real `{ fieldValues, contact }` body. |
| Tags / contactTags | ✅ | Idempotent tag application. |
| Lists / contactLists subscribe-unsubscribe | ✅ | Live `subscriber_count`, `listid` filter. |
| Custom fields / field values | ✅ | Upsert per contact+field. |
| Deals / pipelines / stages | ✅ | Default pipeline + 5 stages seeded; `value` in cents, `owner` supported. |
| Deal-create wrapped response (`contacts`, `deal`, `dealStages`) | ✅ | Matches the real 201 envelope; deal carries `hash`, `fields[]`, etc. |
| Notes, accounts, webhooks | ✅ | Full CRUD. |
| Contact automations (enrol/remove) | ✅ | Read-only automation list seeded. |
| 422 error envelope `{ errors: [{ title, detail, code }] }` | ✅ | No fabricated `source.pointer`; real AC codes (`duplicate`, `field_missing`). |
| Pagination (`limit`/`offset`) | ✅ | Default limit 20, max 100. |
| `email=`, `search=`, `listid=` filters on contacts | ✅ | Other server-side filter DSL not modelled. |
| Campaigns, automations, segments, users | ◐ read-only | Seeded fixtures; create/update not modelled. |
| `deal.value` numeric typing | ◐ | Stored/echoed as a string for wire consistency; clients read back what they sent. |
| `?include=` sideloading / nested embeds | ⟳ Roadmap | Not modelled. |
| Tracked events (`trackcmp.net/event`) | ✓ By design | Different host + form encoding; out of scope. |
| Real email sending / campaign delivery | ⟳ Roadmap | |
| Webhook delivery (outbound HTTP callbacks) | ⟳ Roadmap | |
| Persistence across restarts | ✓ By design | In-memory — fast, isolated, resets cleanly between tests. |
| Rate limiting | ✓ By design | Never throttles — local tests run at full speed, zero cost. |

## Error codes / shapes

| Status | Shape | When |
| --- | --- | --- |
| `200` | resource / empty `{}` | Successful GET / PUT / DELETE. |
| `201` | `{ "<resource>": { ... } }` | Successful create. `contact/sync` always returns 201 (create or update) as `{ "fieldValues": [...], "contact": { ... } }`; `POST /deals` returns `{ "contacts": [...], "deal": {...}, "dealStages": [...] }`. |
| `204` | _(empty)_ | OPTIONS preflight. |
| `400` | `{ "message": "Invalid JSON in request body." }` | Malformed JSON. |
| `403` | `{ "message": "..." }` | Missing `Api-Token`. |
| `404` | `{ "message": "No Result." }` | Unknown resource / id. |
| `405` | `{ "message": "Method not allowed." }` | Unsupported method on a known path. |
| `422` | `{ "errors": [ { "title", "detail", "code" } ] }` | Validation failure (missing/invalid field, duplicate, bad relation). Matches the real AC v3 envelope — no `source.pointer`. |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACTIVECAMPAIGN_API_URL` | `http://127.0.0.1:4659` | Base URL of the fake. |
| `ACTIVECAMPAIGN_API_TOKEN` | `parlel-test-api-token` | Token sent via `Api-Token`. |
| `ACTIVECAMPAIGN_ACCOUNT` | `parlel-test` | Account slug (informational). |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ACTIVECAMPAIGN_API_URL=http://localhost:4659
ACTIVECAMPAIGN_API_TOKEN=parlel-test-api-token
ACTIVECAMPAIGN_ACCOUNT=parlel-test
```

<!-- parlel:testenv:end -->
