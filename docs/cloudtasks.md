# Cloud Tasks

Lightweight, dependency-free fake of Google Cloud Tasks that speaks the real Cloud Tasks v2 REST API (`https://cloudtasks.googleapis.com/v2`), so application code using `@google-cloud/tasks` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4584 |
| Protocol | Cloud Tasks v2 REST API (HTTP + JSON) |
| Compatible client | `@google-cloud/tasks` (v6, google-gax v5) |
| Size | ~60 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { CloudtasksServer } from "./services/cloudtasks/src/server.js";

const server = new CloudtasksServer(4584);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real `@google-cloud/tasks` client. The fake speaks the
**HTTP/1.1 REST** transport (the google-gax `fallback` mode), so the low-level
gapic `CloudTasksClient` must be constructed with `fallback: true`,
`protocol: "http"`, and an explicit `apiEndpoint` + `port` pointing at the fake:

```js
import { v2 } from "@google-cloud/tasks";

const client = new v2.CloudTasksClient({
  projectId: "parlel",
  fallback: true,          // use the HTTP/1.1 REST transport instead of gRPC
  protocol: "http",        // talk plain HTTP to the local fake
  apiEndpoint: "127.0.0.1",
  port: 4584,
  // Any credentials work — the fake never verifies them.
});

const parent = client.locationPath("parlel", "us-central1");
const queueName = client.queuePath("parlel", "us-central1", "emails");

// Create a queue.
await client.createQueue({ parent, queue: { name: queueName } });

// Enqueue an HTTP target task.
const [task] = await client.createTask({
  parent: queueName,
  task: {
    httpRequest: {
      url: "https://example.com/worker",
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({ id: 42 })),
    },
  },
});

// Force an immediate run (records an attempt; no real dispatch happens).
await client.runTask({ name: task.name });
```

### Error decoding note (google-gax v5)

`@google-cloud/tasks` ships **google-gax v5**, whose REST fallback only transcodes
a `google.rpc.Status` error body back into a canonical gRPC status code (e.g.
`NOT_FOUND` → `5`) when the transport's `fetch()` **resolves** on non-2xx
responses instead of throwing. The default `GoogleAuth`/`gaxios` transporter
throws, surfacing the raw HTTP status as `error.code`. In tests we therefore
supply a tiny `authClient` whose `fetch()` always resolves the response (see
`tests/cloudtasks.test.ts`), which makes the client surface real gRPC codes.
The fake itself always returns the correct HTTP status + `google.rpc.Status`
body — this is purely a client transport detail.

## Implemented operations

The fake transcodes the Cloud Tasks v2 `google.api.http` annotations. Every RPC
the real `@google-cloud/tasks` v2 client exposes is implemented.

### Queues (`CloudTasks` service)

| RPC | Method + path |
|-----|---------------|
| `ListQueues` | `GET /v2/{parent=projects/*/locations/*}/queues` |
| `GetQueue` | `GET /v2/{name=projects/*/locations/*/queues/*}` |
| `CreateQueue` | `POST /v2/{parent=projects/*/locations/*}/queues` |
| `UpdateQueue` | `PATCH /v2/{queue.name=projects/*/locations/*/queues/*}` |
| `DeleteQueue` | `DELETE /v2/{name=projects/*/locations/*/queues/*}` |
| `PurgeQueue` | `POST /v2/{name=...}:purge` |
| `PauseQueue` | `POST /v2/{name=...}:pause` |
| `ResumeQueue` | `POST /v2/{name=...}:resume` |

### Tasks

| RPC | Method + path |
|-----|---------------|
| `ListTasks` | `GET /v2/{parent=.../queues/*}/tasks` |
| `GetTask` | `GET /v2/{name=.../queues/*/tasks/*}` |
| `CreateTask` | `POST /v2/{parent=.../queues/*}/tasks` |
| `DeleteTask` | `DELETE /v2/{name=.../queues/*/tasks/*}` |
| `RunTask` | `POST /v2/{name=.../queues/*/tasks/*}:run` |

### IAM (`google.iam.v1`)

| RPC | Method + path |
|-----|---------------|
| `GetIamPolicy` | `POST /v2/{resource=.../queues/*}:getIamPolicy` |
| `SetIamPolicy` | `POST /v2/{resource=.../queues/*}:setIamPolicy` |
| `TestIamPermissions` | `POST /v2/{resource=.../queues/*}:testIamPermissions` |

### Locations mixin (`google.cloud.location`)

Served at the `/v1/` prefix (the mixin is versioned independently of the
service), matching the real client.

| RPC | Method + path |
|-----|---------------|
| `ListLocations` | `GET /v1/{name=projects/*}/locations` |
| `GetLocation` | `GET /v1/{name=projects/*/locations/*}` |

### Internal parlel endpoints

These are **not** part of the Cloud Tasks API; they are conveniences for tests
and tooling.

| Endpoint | Purpose |
|----------|---------|
| `GET /_parlel/health` | Liveness + queue/task counts |
| `POST /_parlel/reset` | Wipe all in-memory state |
| `GET /_parlel/dump` | Dump queues + tasks as JSON |

## Behavior notes

- **HTTP target tasks** (`httpRequest`) and **App Engine target tasks**
  (`appEngineHttpRequest`) are both accepted; exactly one must be supplied.
- **`runTask`** records a synthetic successful attempt (incrementing
  `dispatchCount` / `responseCount` and setting `firstAttempt` / `lastAttempt`)
  but performs **no real HTTP dispatch** — zero side effects.
- **Task views**: `FULL` includes the request body; `BASIC` (the default) omits
  `httpRequest.body` / `appEngineHttpRequest.body`.
- **Queue defaults**: newly created queues start `RUNNING` with default
  `rateLimits` (500 dps / 100 burst / 1000 concurrent) and `retryConfig`
  (100 attempts, exponential backoff).
- **`updateQueue`** supports `updateMask` paths in snake_case, including nested
  leaves such as `rate_limits.max_dispatches_per_second`. With no mask, every
  supplied field is patched. It upserts if the queue does not yet exist.
- **`pauseQueue` / `resumeQueue` / `purgeQueue`** flip queue state / clear tasks.
  `runTask` on a paused or disabled queue returns `FAILED_PRECONDITION`.
- **Pagination**: `pageSize` + `pageToken` are honored for all `List*` RPCs (the
  token is an opaque base64 offset), so `*Async` / `*Stream` iterators work.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Queue CRUD + pause/resume/purge | ✅ Supported |
| Task create/get/list/delete/run | ✅ Supported |
| HTTP target & App Engine target tasks | ✅ Supported |
| Scheduled tasks (`scheduleTime`) | ✅ Stored & returned |
| Task name dedup (`ALREADY_EXISTS`) | ✅ Supported |
| `BASIC` / `FULL` response views | ✅ Supported |
| IAM get/set/test policy | ✅ Supported (test grants all permissions) |
| Locations list/get | ✅ Supported |
| List pagination (`pageSize`/`pageToken`) | ✅ Supported |
| Actual HTTP dispatch of tasks to a target | ✓ By design — Intentional for a local, zero-cost test emulator |
| Automatic scheduled delivery / retries | ⟳ Roadmap — Not simulated (use `runTask` to force) |
| Rate-limit / concurrency enforcement | ✓ By design — Config stored but not enforced |
| Task name de-dup retention window | ⟳ Roadmap — Not simulated (dedup only on live tasks) |
| `v2beta2` / `v2beta3` surfaces (e.g. `BufferTask`) | ⟳ Roadmap — v2 only |
| gRPC transport | ⟳ Roadmap — REST (`fallback`) only |

## Error codes & shapes

Errors are returned as a `google.rpc.Status`-shaped JSON body with the matching
HTTP status code:

```json
{
  "error": {
    "code": 404,
    "message": "Queue does not exist: projects/parlel/locations/us-central1/queues/missing",
    "status": "NOT_FOUND"
  }
}
```

| Condition | gRPC status | HTTP |
|-----------|-------------|------|
| Missing queue / task / location | `NOT_FOUND` (5) | 404 |
| Duplicate queue / task name | `ALREADY_EXISTS` (6) | 409 |
| Invalid name / missing payload / bad argument | `INVALID_ARGUMENT` (3) | 400 |
| `runTask` on paused/disabled queue | `FAILED_PRECONDITION` (9) | 400 |
| Unknown verb / path | `UNIMPLEMENTED` (12) / `NOT_FOUND` (5) | 501 / 404 |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
CLOUD_TASKS_EMULATOR_HOST=localhost:4584
CLOUDTASKS_EMULATOR_HOST=localhost:4584
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
