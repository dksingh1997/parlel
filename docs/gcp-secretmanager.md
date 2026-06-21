# GCP Secret Manager

Lightweight, dependency-free fake of Google Cloud Secret Manager that speaks the real Secret Manager v1 REST API (`https://secretmanager.googleapis.com/v1`), so application code using `@google-cloud/secret-manager` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4585 |
| Protocol | Secret Manager v1 REST API (HTTP + JSON) |
| Compatible client | `@google-cloud/secret-manager` (v6, google-gax v5) |
| Size | ~48 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { GcpSecretmanagerServer } from "./services/gcp-secretmanager/src/server.js";

const server = new GcpSecretmanagerServer(4585);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real `@google-cloud/secret-manager` client. The fake speaks the
**HTTP/1.1 REST** transport (the google-gax `fallback` mode), so the low-level
gapic `SecretManagerServiceClient` must be constructed with `fallback: true`,
`protocol: "http"`, and an explicit `apiEndpoint` + `port` pointing at the fake:

```js
import { v1 } from "@google-cloud/secret-manager";

const client = new v1.SecretManagerServiceClient({
  projectId: "parlel",
  fallback: true,          // use the HTTP/1.1 REST transport instead of gRPC
  protocol: "http",        // talk plain HTTP to the local fake
  apiEndpoint: "127.0.0.1",
  port: 4585,
  // Any credentials work — the fake never verifies them.
});

const parent = client.projectPath("parlel");

// Create a secret with automatic replication.
const [secret] = await client.createSecret({
  parent,
  secretId: "db-password",
  secret: { replication: { automatic: {} } },
});

// Add a secret version (the actual secret material).
await client.addSecretVersion({
  parent: secret.name,
  payload: { data: Buffer.from("s3cr3t-value", "utf8") },
});

// Access the latest version.
const [resp] = await client.accessSecretVersion({
  name: `${secret.name}/versions/latest`,
});
console.log(resp.payload.data.toString("utf8")); // "s3cr3t-value"
```

> The high-level convenience client (`SecretManagerServiceClient` from the
> package root) works the same way — it is the same gapic client under the hood.

## Implemented Operations

All **15** RPCs that the `@google-cloud/secret-manager` v1 client exposes are
implemented. The library's `listSecretsStream` / `listSecretsAsync` /
`listSecretVersionsStream` / `listSecretVersionsAsync` are client-side
pagination variants of `ListSecrets` / `ListSecretVersions` and are exercised by
the fake's pagination support.

### Secrets

| RPC / Method | HTTP route | Notes |
|--------------|------------|-------|
| `createSecret` | `POST /v1/{parent=projects/*}/secrets?secretId=` | `secretId` is a query param; the `Secret` body holds `replication`, `labels`, etc. Defaults to automatic replication when omitted. |
| `getSecret` | `GET /v1/{name=projects/*/secrets/*}` | |
| `listSecrets` | `GET /v1/{parent=projects/*}/secrets` | Supports `pageSize`, `pageToken`, `filter`, and returns `totalSize`. |
| `updateSecret` | `PATCH /v1/{secret.name=projects/*/secrets/*}` | Requires an `updateMask`. Mutable fields: `labels`, `annotations`, `topics`, `expireTime`, `ttl`, `rotation`, `versionAliases`, `versionDestroyTtl`. |
| `deleteSecret` | `DELETE /v1/{name=projects/*/secrets/*}` | Optional `etag` precondition. Cascades to its versions and IAM policy. |

### Secret Versions

| RPC / Method | HTTP route | Notes |
|--------------|------------|-------|
| `addSecretVersion` | `POST /v1/{parent=projects/*/secrets/*}:addVersion` | Auto-assigns incrementing numeric version ids. Validates the optional `payload.dataCrc32c` integrity check. |
| `getSecretVersion` | `GET /v1/{name=projects/*/secrets/*/versions/*}` | Resolves the `latest` alias and any `versionAliases` entries. |
| `listSecretVersions` | `GET /v1/{parent=projects/*/secrets/*}/versions` | Newest-first. Supports `pageSize`, `pageToken`, `filter`, `totalSize`. |
| `accessSecretVersion` | `GET /v1/{name=projects/*/secrets/*/versions/*}:access` | Returns base64 `payload.data` + `payload.dataCrc32c`. Fails on `DISABLED` / `DESTROYED` versions. |
| `enableSecretVersion` | `POST /v1/{name=projects/*/secrets/*/versions/*}:enable` | Optional `etag` precondition. |
| `disableSecretVersion` | `POST /v1/{name=projects/*/secrets/*/versions/*}:disable` | Optional `etag` precondition. |
| `destroySecretVersion` | `POST /v1/{name=projects/*/secrets/*/versions/*}:destroy` | Irrecoverably erases the payload; sets `destroyTime`. |

### IAM

| RPC / Method | HTTP route | Notes |
|--------------|------------|-------|
| `getIamPolicy` | `GET /v1/{resource=projects/*/secrets/*}:getIamPolicy` | Returns a default empty policy if none set. |
| `setIamPolicy` | `POST /v1/{resource=projects/*/secrets/*}:setIamPolicy` | Stores the policy verbatim and re-stamps the etag. |
| `testIamPermissions` | `POST /v1/{resource=projects/*/secrets/*}:testIamPermissions` | Grants every requested permission. |

### Internal (parlel-only) endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /_parlel/health` | Health probe: `{ status, service, secrets, versions }`. |
| `POST /_parlel/reset` | Wipe all in-memory state. |
| `GET /_parlel/dump` | Dump every secret + version for debugging. |

### Regional bindings

Every RPC also has a regional `additional_binding` under
`projects/*/locations/*/...`. The fake is region-agnostic: it normalizes the
`/locations/{loc}` segment away, so a secret created globally is reachable via
its regional name and vice-versa.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Create / Get / List / Update / Delete secrets | ✅ Supported |
| Add / Get / List / Access secret versions | ✅ Supported |
| Enable / Disable / Destroy versions | ✅ Supported |
| `latest` version alias + custom `versionAliases` | ✅ Supported |
| Automatic & user-managed replication (echoed) | ✅ Supported |
| Labels, annotations, topics | ✅ Supported |
| `ttl` → `expireTime` resolution | ✅ Supported |
| `payload.dataCrc32c` integrity validation (CRC32C) | ✅ Supported |
| `clientSpecifiedPayloadChecksum` flag | ✅ Supported |
| etag preconditions on delete / enable / disable / destroy | ✅ Supported |
| Server-side `filter` (name / labels / state) | ✅ Supported (approximate) |
| Pagination (`pageSize`, `pageToken`, `totalSize`) | ✅ Supported |
| IAM get / set / testPermissions | ✅ Supported |
| gRPC transport | ⚠️ Use `fallback: true` (REST). Native gRPC is intentionally not served. |
| Real CMEK encryption / KMS integration | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Pub/Sub rotation notifications | ⟳ Roadmap — Fields stored, no messages published |
| Real IAM enforcement / authn | ⟳ Roadmap — Every caller is granted everything |
| Audit logging | ✓ By design — Not emulated |

## Error codes / shapes

Errors are returned as the standard Google `google.rpc.Status` JSON body, which
the google-gax REST decoder transcodes back into the canonical gRPC status code
on the client (`error.code`):

```json
{
  "error": {
    "code": 404,
    "message": "Secret [projects/parlel/secrets/missing] not found.",
    "status": "NOT_FOUND"
  }
}
```

| Situation | gRPC code | gRPC status |
|-----------|-----------|-------------|
| Secret / version / policy resource not found | `5` | `NOT_FOUND` |
| Invalid secret id, missing `updateMask`, immutable field, bad CRC32C | `3` | `INVALID_ARGUMENT` |
| Accessing a `DISABLED` / `DESTROYED` version, destroying twice, etag mismatch | `9` | `FAILED_PRECONDITION` |
| Creating a secret id that already exists | `9` | `FAILED_PRECONDITION` (non-retryable; see note below) |
| Unknown custom verb | `12` | `UNIMPLEMENTED` |

> **Note on duplicate-create.** The real service returns `ALREADY_EXISTS` (code
> `6`). There is no HTTP status that the gax REST decoder maps back to code `6`
> (HTTP 409 decodes to `ABORTED`, which gax *retries*). To preserve the
> non-retryable, immediately-rejecting behavior callers expect, the fake
> surfaces duplicate-create conflicts as `FAILED_PRECONDITION` (code `9`).

## Running the tests

```bash
npx vitest run tests/gcp-secretmanager.test.ts
```

The suite starts the server on a high non-conflicting port, drives every
operation through the real `@google-cloud/secret-manager` client over the REST
transport, asserts the responses (happy paths + edge cases), and tears the
server down in `afterAll`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
