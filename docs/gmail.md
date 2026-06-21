# Gmail

Lightweight, dependency-free in-process fake of the Gmail v1 REST API for testing `googleapis` Gmail integrations with zero external side effects.

Default port: `4610`

## Quick start

```js
import { google } from "googleapis";
import { GmailServer } from "./services/gmail/src/server.js";

const server = new GmailServer(4610);
await server.start();

const gmail = google.gmail({ version: "v1", auth: "fake-token" });
gmail.context._options.rootUrl = "http://127.0.0.1:4610/";

const created = await gmail.users.messages.insert({
  userId: "me",
  requestBody: {
    raw: Buffer.from("Subject: hi\r\n\r\nhello").toString("base64url"),
    labelIds: ["INBOX"],
  },
});

console.log(created.data.id);
await server.stop();
```

State is in-memory and ephemeral. Reset it with `server.reset()` or `POST /_parlel/reset`.

## Implemented operations

Profile and watch:

- `GET /gmail/v1/users/{userId}/profile` - `users.getProfile`
- `POST /gmail/v1/users/{userId}/watch` - `users.watch` (requires `topicName`)
- `POST /gmail/v1/users/{userId}/stop` - `users.stop`

Messages:

- `GET /gmail/v1/users/{userId}/messages` - `users.messages.list`
- `GET /gmail/v1/users/{userId}/messages/{id}` - `users.messages.get` (`format`: `full`, `metadata`, `minimal`, `raw`)
- `POST /gmail/v1/users/{userId}/messages/send` - `users.messages.send`
- `POST /gmail/v1/users/{userId}/messages/import` - `users.messages.import`
- `POST /gmail/v1/users/{userId}/messages/insert` - `users.messages.insert`
- `POST /gmail/v1/users/{userId}/messages/{id}/modify` - `users.messages.modify`
- `POST /gmail/v1/users/{userId}/messages/{id}/trash` - `users.messages.trash`
- `POST /gmail/v1/users/{userId}/messages/{id}/untrash` - `users.messages.untrash`
- `DELETE /gmail/v1/users/{userId}/messages/{id}` - `users.messages.delete`
- `POST /gmail/v1/users/{userId}/messages/batchModify` - `users.messages.batchModify`
- `POST /gmail/v1/users/{userId}/messages/batchDelete` - `users.messages.batchDelete`
- `GET /gmail/v1/users/{userId}/messages/{id}/attachments/{attachmentId}` - `users.messages.attachments.get`

Drafts:

- `GET /gmail/v1/users/{userId}/drafts` - `users.drafts.list`
- `POST /gmail/v1/users/{userId}/drafts` - `users.drafts.create`
- `GET /gmail/v1/users/{userId}/drafts/{id}` - `users.drafts.get`
- `PUT /gmail/v1/users/{userId}/drafts/{id}` - `users.drafts.update`
- `POST /gmail/v1/users/{userId}/drafts/send` - `users.drafts.send`
- `DELETE /gmail/v1/users/{userId}/drafts/{id}` - `users.drafts.delete`

Threads:

- `GET /gmail/v1/users/{userId}/threads` - `users.threads.list`
- `GET /gmail/v1/users/{userId}/threads/{id}` - `users.threads.get`
- `POST /gmail/v1/users/{userId}/threads/{id}/modify` - `users.threads.modify`
- `POST /gmail/v1/users/{userId}/threads/{id}/trash` - `users.threads.trash`
- `POST /gmail/v1/users/{userId}/threads/{id}/untrash` - `users.threads.untrash`
- `DELETE /gmail/v1/users/{userId}/threads/{id}` - `users.threads.delete`

Labels and history:

- `GET /gmail/v1/users/{userId}/labels` - `users.labels.list`
- `POST /gmail/v1/users/{userId}/labels` - `users.labels.create` (duplicate `name` → `409`)
- `GET /gmail/v1/users/{userId}/labels/{id}` - `users.labels.get`
- `PATCH /gmail/v1/users/{userId}/labels/{id}` - `users.labels.patch`
- `PUT /gmail/v1/users/{userId}/labels/{id}` - `users.labels.update`
- `DELETE /gmail/v1/users/{userId}/labels/{id}` - `users.labels.delete`
- `GET /gmail/v1/users/{userId}/history` - `users.history.list` (`startHistoryId` is required → `400` if omitted)

Settings:

- `GET|PUT /gmail/v1/users/{userId}/settings/autoForwarding` - `getAutoForwarding`, `updateAutoForwarding`
- `GET|PUT /gmail/v1/users/{userId}/settings/imap` - `getImap`, `updateImap`
- `GET|PUT /gmail/v1/users/{userId}/settings/language` - `getLanguage`, `updateLanguage`
- `GET|PUT /gmail/v1/users/{userId}/settings/pop` - `getPop`, `updatePop`
- `GET|PUT /gmail/v1/users/{userId}/settings/vacation` - `getVacation`, `updateVacation`
- `GET|POST|GET by id|DELETE /gmail/v1/users/{userId}/settings/filters` - filter list/create/get/delete
- `GET|POST|GET by email|DELETE /gmail/v1/users/{userId}/settings/forwardingAddresses` - forwarding address list/create/get/delete
- `GET|POST|GET by email|DELETE /gmail/v1/users/{userId}/settings/delegates` - delegate list/create/get/delete
- `GET|POST|GET by email|PATCH|PUT|DELETE /gmail/v1/users/{userId}/settings/sendAs` - send-as list/create/get/patch/update/delete
- `POST /gmail/v1/users/{userId}/settings/sendAs/{sendAsEmail}/verify` - send-as verify
- `GET|POST|GET by id|DELETE /gmail/v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo` - S/MIME list/insert/get/delete
- `POST /gmail/v1/users/{userId}/settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault` - S/MIME set default
- `GET|POST|GET by email|PATCH|DELETE /gmail/v1/users/{userId}/settings/cse/identities` - CSE identity list/create/get/patch/delete
- `GET|POST|GET by id /gmail/v1/users/{userId}/settings/cse/keypairs` - CSE keypair list/create/get
- `POST /gmail/v1/users/{userId}/settings/cse/keypairs/{keyPairId}/disable` - CSE keypair disable
- `POST /gmail/v1/users/{userId}/settings/cse/keypairs/{keyPairId}/enable` - CSE keypair enable
- `POST /gmail/v1/users/{userId}/settings/cse/keypairs/{keyPairId}/obliterate` - CSE keypair obliterate

Upload aliases:

- `/upload/gmail/v1/...` is routed to the same handlers as `/gmail/v1/...` for media-capable `googleapis` methods.

Internal parlel endpoints:

- `GET /_parlel/health`
- `POST /_parlel/reset`

## Access via MCP / preview URL

When run inside a parlel sandbox the service is reachable at its preview URL
(the `GMAIL_EMULATOR_HOST` env var, e.g. `http://127.0.0.1:4610`). Point the
`googleapis` Gmail client at that address by overriding
`gmail.context._options.rootUrl`. MCP-driven agents can call any documented
endpoint directly; the `/_parlel/reset` control endpoint clears state between
scenarios.

## Surface coverage

This emulator faithfully replicates the Gmail v1 surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `users.getProfile` / `watch` / `stop` | ✅ Supported |
| `users.messages.*` (list/get/send/insert/import/modify/trash/untrash/delete/batchModify/batchDelete) | ✅ Supported |
| `users.messages.attachments.get` | ✅ Supported |
| `users.drafts.*` (create/list/get/update/send/delete) | ✅ Supported |
| `users.threads.*` (list/get/modify/trash/untrash/delete) | ✅ Supported |
| `users.labels.*` (list/create/get/patch/update/delete) | ✅ Supported |
| Duplicate label `name` → `409 ALREADY_EXISTS` | ✅ Supported |
| `users.history.list` (`startHistoryId` required → `400`) | ✅ Supported |
| `users.settings.*` (autoForwarding/imap/language/pop/vacation/filters/forwardingAddresses/delegates/sendAs/smimeInfo/cse) | ✅ Supported |
| Message `format` (`full`/`metadata`/`minimal`/`raw`) | ✅ Supported |
| List pagination (`maxResults`/`pageToken`) | ✅ Supported |
| Google JSON error envelope (`error.{code,message,errors,status}` with canonical `status`) | ✅ Supported |
| `/gmail/v1` + `/upload/gmail/v1` routing | ✅ Supported |
| Gmail query (`from:`/`to:`/`subject:`/substring) | ◐ Accepted — a subset of the real Gmail search grammar |
| Opaque base64 page tokens | ✓ By design — deterministic numeric offsets keep tests reproducible |
| OAuth / IAM enforcement (`401 UNAUTHENTICATED`) | ✓ By design — any credential is accepted; no real secrets needed |
| Real email delivery / Pub/Sub `watch` delivery | ✓ By design — `send` and `watch` mutate local state only |
| Full MIME parsing | ✓ By design — lightweight header/body parsing, realistic enough for client tests |
| Persistent storage | ✓ By design — state is process-local and resettable |
| History pagination across all change types | ⟳ Roadmap |

## Error codes & shapes

Errors use the Gmail/Google JSON API envelope, with a canonical `google.rpc.Code`
in `error.status`:

```json
{
  "error": {
    "code": 404,
    "message": "Message not found",
    "errors": [
      { "message": "Message not found", "domain": "global", "reason": "notFound" }
    ],
    "status": "NOT_FOUND"
  }
}
```

Common returned codes:

| HTTP | `status` | Typical cause |
| --- | --- | --- |
| `400` | `INVALID_ARGUMENT` | Missing required field (`topicName`, `startHistoryId`, label `name`) or invalid label mutation. |
| `404` | `NOT_FOUND` | Missing user resource, message, draft, thread, label, or settings child resource. |
| `405` | `FAILED_PRECONDITION` | Valid endpoint with an unsupported HTTP method. |
| `409` | `ALREADY_EXISTS` | Creating a label whose `name` already exists. |
| `500` | `INTERNAL` | Unexpected server exception. |

## Manifest

See `services/gmail/manifest.json`:

- name: `gmail`, image: `parlel/gmail:0.1`
- port: `4610`, protocol: `http`, healthcheck: `/_parlel/health`, startup ≈ 100ms
- env: `GMAIL_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GMAIL_EMULATOR_HOST=http://localhost:4610
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
