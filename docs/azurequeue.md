# Azure Queue Storage

Lightweight, dependency-free fake of Azure Queue Storage that speaks the real Azure Queue REST API (XML wire protocol + `x-ms-*` headers), so application code using `@azure/storage-queue` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4593 |
| Protocol | Azure Queue Storage REST API (HTTP + XML) |
| Compatible client | `@azure/storage-queue` (v12) |
| API version | `2025-05-05` |
| Size | ~64 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { AzurequeueServer } from "./services/azurequeue/src/server.js";

const server = new AzurequeueServer(4593);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real Azure SDK client. The fake uses path-style addressing (like Azurite), so the queue endpoint always includes the account name:

```js
import { QueueServiceClient, StorageSharedKeyCredential } from "@azure/storage-queue";

const account = "devstoreaccount1";
const key =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const credential = new StorageSharedKeyCredential(account, key);
const svc = new QueueServiceClient(
  `http://127.0.0.1:4593/${account}`,
  credential,
);

const queue = svc.getQueueClient("my-queue");
await queue.create();

// Send a message.
const sent = await queue.sendMessage("hello parlel");

// Receive (dequeue) it — becomes invisible for the visibility timeout.
const recv = await queue.receiveMessages();
const msg = recv.receivedMessageItems[0];
// msg.messageText -> "hello parlel"

// Delete it once processed.
await queue.deleteMessage(msg.messageId, msg.popReceipt);
```

You can also connect via a connection string:

```js
const conn =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "QueueEndpoint=http://127.0.0.1:4593/devstoreaccount1;";

const svc = QueueServiceClient.fromConnectionString(conn);
```

## URL Shape

```
http://127.0.0.1:4593/<account>/<queue>?<comp>...                 # queue-level
http://127.0.0.1:4593/<account>/<queue>/messages?...              # messages-level
http://127.0.0.1:4593/<account>/<queue>/messages/<messageid>?...  # message-id-level
http://127.0.0.1:4593/<account>/?comp=...                         # service-level
```

## Implemented Operations

Every wire operation the `@azure/storage-queue` client invokes is implemented.

### Service-level (`QueueServiceClient`)

| SDK method | HTTP | Path | Notes |
|------------|------|------|-------|
| `getProperties()` | GET | `/?comp=properties` | Returns logging/metrics/CORS XML |
| `setProperties()` | PUT | `/?comp=properties` | Accepts and stores; returns `202` |
| `getStatistics()` | GET | `/?comp=stats` | Returns geo-replication `live` |
| `getUserDelegationKey()` | POST | `/?comp=userdelegationkey` | Returns a deterministic fake signed key |
| `listQueues()` / `listQueuesSegment()` | GET | `/?comp=list` | Supports `prefix`, `marker`, `maxresults`, `include=metadata`, pagination via `byPage()` |
| `createQueue(name)` | PUT | `/{queue}` | Convenience wrapper over queue create |
| `deleteQueue(name)` | DELETE | `/{queue}` | Convenience wrapper over queue delete |
| `getQueueClient(name)` | — | — | Returns a `QueueClient` (client-side) |

### Queue-level (`QueueClient`)

| SDK method | HTTP | Path | Notes |
|------------|------|------|-------|
| `create()` | PUT | `/{queue}` | `201` created; idempotent `204` if same metadata |
| `createIfNotExists()` | PUT | `/{queue}` | Composes `create` + conflict handling |
| `delete()` | DELETE | `/{queue}` | `204` deleted; `404` if missing |
| `deleteIfExists()` | DELETE | `/{queue}` | Swallows `404` |
| `exists()` | GET | `/{queue}?comp=metadata` | Maps `404` to `false` |
| `getProperties()` | GET | `/{queue}?comp=metadata` | Returns metadata + `x-ms-approximate-messages-count` |
| `setMetadata()` | PUT | `/{queue}?comp=metadata` | Replaces metadata |
| `getAccessPolicy()` | GET | `/{queue}?comp=acl` | Returns stored access policies |
| `setAccessPolicy()` | PUT | `/{queue}?comp=acl` | Up to 5 signed identifiers |

### Messages-level (`QueueClient`)

| SDK method | HTTP | Path | Notes |
|------------|------|------|-------|
| `sendMessage(text)` | POST | `/{queue}/messages` | Supports `visibilitytimeout`, `messagettl` (`-1` = never expires) |
| `receiveMessages()` | GET | `/{queue}/messages` | Supports `numofmessages` (1–32), `visibilitytimeout`; increments `DequeueCount`, rotates pop receipt |
| `peekMessages()` | GET | `/{queue}/messages?peekonly=true` | Read without changing visibility |
| `clearMessages()` | DELETE | `/{queue}/messages` | Removes all messages |

### Message-id-level (`QueueClient`)

| SDK method | HTTP | Path | Notes |
|------------|------|------|-------|
| `updateMessage(id, popReceipt, text, vt)` | PUT | `/{queue}/messages/{id}` | Validates pop receipt; optional text update; returns new `x-ms-popreceipt` + `x-ms-time-next-visible` |
| `deleteMessage(id, popReceipt)` | DELETE | `/{queue}/messages/{id}` | Validates pop receipt |

### Internal (parlel) endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/_parlel/health` | GET | Liveness check (`{ status: "ok", service: "azurequeue", queues: N }`) |
| `/_parlel/reset` | POST | Wipe all in-memory state |

## Message Semantics

- **FIFO ordering** — visible messages are returned oldest-first.
- **Visibility timeout** — `receiveMessages` hides a message for the timeout (default 30s); it reappears (with an incremented `DequeueCount` and a fresh pop receipt) when the timeout elapses.
- **Pop receipts** — every dequeue/update issues a new pop receipt. `updateMessage`/`deleteMessage` reject stale receipts with `PopReceiptMismatch` (`400`).
- **TTL** — messages expire after `messagettl` seconds (default 7 days). `messagettl=-1` means never expire. Expired messages are pruned lazily on access.
- **Peek** — does not change visibility or pop receipts and omits `PopReceipt`/`TimeNextVisible`/`MessageText`-mutating effects.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Create / delete / list queues | ✅ | Full lifecycle |
| Queue metadata | ✅ | `x-ms-meta-*` round-trip |
| Approximate message count | ✅ | `x-ms-approximate-messages-count` |
| Send / receive / peek / clear messages | ✅ | |
| Update / delete by message id | ✅ | Pop-receipt validated |
| Visibility timeout & re-delivery | ✅ | Time-accurate |
| Message TTL & expiry | ✅ | Including `-1` (never) |
| FIFO ordering | ✅ | |
| Stored access policies (ACL) | ✅ | Up to 5 identifiers |
| Service properties / statistics | ✅ | Static, in-memory |
| `getUserDelegationKey` | ✅ | Returns a deterministic fake key (offline AAD SAS flows) |
| List pagination (`marker` / `maxresults`) | ✅ | |
| List `include=metadata` | ✅ | |
| SAS signature **enforcement** | ⟳ Roadmap |
| Real authentication / authorization | ⟳ Roadmap |
| Geo-replication / RA-GRS failover | ⟳ Roadmap |
| Server-side encryption / CMK | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Persistence across restarts | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error Codes

Errors are returned as Azure-style XML with an `x-ms-error-code` response header. Validation errors include additional fields (`QueryParameterName`, `QueryParameterValue`, `MinimumAllowed`, `MaximumAllowed`, `Reason`) matching the real Azure Queue Storage error envelope:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Error>
  <Code>OutOfRangeQueryParameterValue</Code>
  <Message>One of the query parameters specified in the request URI is outside the permissible range.</Message>
  <QueryParameterName>numofmessages</QueryParameterName>
  <QueryParameterValue>0</QueryParameterValue>
  <MinimumAllowed>1</MinimumAllowed>
  <MaximumAllowed>32</MaximumAllowed>
</Error>
```

| HTTP | `x-ms-error-code` | When |
|------|-------------------|------|
| 400 | `OutOfRangeInput` | Queue name fails validation |
| 400 | `InvalidUri` | Request path has no account |
| 400 | `InvalidQueryParameterValue` | Unsupported `comp` operation |
| 400 | `InvalidXmlDocument` | More than 5 access policies |
| 400 | `OutOfRangeQueryParameterValue` | `numofmessages`, `visibilitytimeout`, or `messagettl` out of range (includes `QueryParameterName`, `QueryParameterValue`, `MinimumAllowed`, `MaximumAllowed` fields) |
| 400 | `RequestBodyTooLarge` | Message text exceeds 64 KiB |
| 400 | `MissingRequiredQueryParameter` | `popreceipt` not supplied to update/delete (includes `QueryParameterName` field) |
| 400 | `PopReceiptMismatch` | Pop receipt does not match the message |
| 404 | `QueueNotFound` | Queue does not exist |
| 404 | `MessageNotFound` | Message id does not exist |
| 405 | `UnsupportedHttpVerb` | Verb not allowed for the resource |
| 409 | `QueueAlreadyExists` | Create conflicts with existing queue (different metadata) |
| 500 | `InternalError` | Unexpected server error |

## Environment Variables

| Variable | Default |
|----------|---------|
| `AZURE_STORAGE_ACCOUNT` | `devstoreaccount1` |
| `AZURE_STORAGE_KEY` | `Eby8vdM0…GMGw==` (Azurite well-known dev key) |
| `AZURE_STORAGE_CONNECTION_STRING` | `…;QueueEndpoint=http://127.0.0.1:4593/devstoreaccount1;` |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AZURE_STORAGE_ACCOUNT=devstoreaccount1
AZURE_STORAGE_KEY=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;QueueEndpoint=http://127.0.0.1:4593/devstoreaccount1;
```

<!-- parlel:testenv:end -->
