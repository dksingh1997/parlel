# GCS

Lightweight, dependency-free fake of Google Cloud Storage that speaks the real GCS JSON API (`https://storage.googleapis.com/storage/v1`), so application code using `@google-cloud/storage` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4580 |
| Protocol | GCS JSON API (HTTP + JSON) |
| Compatible client | `@google-cloud/storage` (v7) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { GcsServer } from "./services/gcs/src/server.js";

const server = new GcsServer(4580);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real Google Cloud Storage client. Point it at the fake with
either `apiEndpoint` or the `STORAGE_EMULATOR_HOST` environment variable:

```js
import { Storage } from "@google-cloud/storage";

const storage = new Storage({
  apiEndpoint: "http://127.0.0.1:4580",
  projectId: "parlel",
  // Any credentials work — the fake does not verify them.
  credentials: {
    client_email: "parlel@parlel.iam.gserviceaccount.com",
    private_key: "fake",
  },
});

const [bucket] = await storage.createBucket("my-bucket");

const file = bucket.file("hello.txt");
await file.save("hello world", { contentType: "text/plain" });

const [contents] = await file.download();
console.log(contents.toString()); // "hello world"
```

Or via the emulator environment variable (no `apiEndpoint` needed):

```bash
export STORAGE_EMULATOR_HOST=http://127.0.0.1:4580
```

### Authentication

Google credentials and OAuth tokens are **accepted but not verified** (any
credentials work). This matches LocalStack-style local development. Client-side
operations such as `getSignedUrl()` still require a syntactically valid RSA
private key because the signing happens in the client.

### Resettable state

All state is in-memory and ephemeral. Reset it between tests:

```js
// Programmatically
server.reset();

// Or over HTTP
await fetch("http://127.0.0.1:4580/_parlel/reset", { method: "POST" });
```

## Implemented operations / endpoints

### Service / internal

| Operation | Endpoint |
|-----------|----------|
| Health check | `GET /_parlel/health` |
| Reset state | `POST /_parlel/reset` |
| Get service account | `GET /storage/v1/projects/{project}/serviceAccount` |

### Buckets

| Operation | Endpoint |
|-----------|----------|
| Insert (create) bucket | `POST /storage/v1/b` |
| List buckets | `GET /storage/v1/b` |
| Get bucket | `GET /storage/v1/b/{bucket}` |
| Patch bucket | `PATCH /storage/v1/b/{bucket}` |
| Update bucket | `PUT /storage/v1/b/{bucket}` |
| Delete bucket | `DELETE /storage/v1/b/{bucket}` |

Bucket convenience methods that route through patch/update are supported:
`setMetadata`, `setLabels`, `getLabels`, `deleteLabels`, `setStorageClass`,
`setCorsConfiguration`, `addLifecycleRule`, `enableRequesterPays`,
`setRetentionPeriod`, and toggling `versioning`.

### Objects

| Operation | Endpoint |
|-----------|----------|
| List objects (prefix, delimiter, versions, pagination) | `GET /storage/v1/b/{bucket}/o` |
| Get object metadata | `GET /storage/v1/b/{bucket}/o/{object}` |
| Download object media | `GET /storage/v1/b/{bucket}/o/{object}?alt=media` |
| Patch object metadata | `PATCH /storage/v1/b/{bucket}/o/{object}` |
| Update object metadata | `PUT /storage/v1/b/{bucket}/o/{object}` |
| Delete object | `DELETE /storage/v1/b/{bucket}/o/{object}` |
| Copy object | `POST /storage/v1/b/{src}/o/{srcObj}/copyTo/b/{dst}/o/{dstObj}` |
| Rewrite object | `POST /storage/v1/b/{src}/o/{srcObj}/rewriteTo/b/{dst}/o/{dstObj}` |
| Compose objects | `POST /storage/v1/b/{bucket}/o/{object}/compose` |
| Public / XML-style read (for `isPublic`/`publicUrl`) | `GET /{bucket}/{object}` |

Object convenience methods that work on top of these: `save`, `download`
(to memory or disk), `createReadStream`, `createWriteStream`, `exists`,
`getMetadata`, `setMetadata`, `copy`, `move`, `rename`, `makePublic`,
`makePrivate`, `isPublic`, `setStorageClass`, and ranged downloads
(`{ start, end }`).

### Uploads

| Upload type | Endpoint |
|-------------|----------|
| Simple media upload | `POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name=...` |
| Multipart upload (JSON metadata + media) | `POST /upload/storage/v1/b/{bucket}/o?uploadType=multipart` |
| Resumable: start session | `POST /upload/storage/v1/b/{bucket}/o?uploadType=resumable` |
| Resumable: upload chunk(s) | `PUT /upload/storage/v1/b/{bucket}/o?upload_id=...` |

Both single-shot resumable uploads (`Content-Range: bytes 0-*/*`) and
multi-chunk resumable uploads (with `chunkSize`, returning `308` between chunks
with a `Range` header) are supported.

### ACLs (canned)

| Operation | Endpoint |
|-----------|----------|
| Object ACL list/get/insert/update/delete | `.../o/{object}/acl[/{entity}]` |
| Bucket ACL list/get/insert/update/delete | `/storage/v1/b/{bucket}/acl[/{entity}]` |
| Default object ACL | `/storage/v1/b/{bucket}/defaultObjectAcl[/{entity}]` |

### IAM (canned)

| Operation | Endpoint |
|-----------|----------|
| Get IAM policy | `GET /storage/v1/b/{bucket}/iam` |
| Set IAM policy | `PUT /storage/v1/b/{bucket}/iam` |
| Test IAM permissions | `GET /storage/v1/b/{bucket}/iam/testPermissions` |

### HMAC keys

| Operation | Endpoint |
|-----------|----------|
| Create HMAC key | `POST /storage/v1/projects/{project}/hmacKeys` |
| List HMAC keys | `GET /storage/v1/projects/{project}/hmacKeys` |
| Get HMAC key | `GET /storage/v1/projects/{project}/hmacKeys/{accessId}` |
| Update HMAC key | `PUT /storage/v1/projects/{project}/hmacKeys/{accessId}` |
| Delete HMAC key | `DELETE /storage/v1/projects/{project}/hmacKeys/{accessId}` |

### Notifications (canned)

| Operation | Endpoint |
|-----------|----------|
| List / create / get / delete notification configs | `/storage/v1/b/{bucket}/notificationConfigs[/{id}]` |

## Feature support

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Bucket CRUD | ✅ | Create, get, list, patch, delete |
| Object upload (simple / multipart / resumable) | ✅ | Including chunked resumable uploads |
| Object download | ✅ | Full + ranged (`Range` / `{ start, end }`) |
| crc32c + md5 hashes | ✅ | Real CRC32C (Castagnoli); client-side validation passes |
| Object metadata (custom + system) | ✅ | `metadata`, `contentType`, `cacheControl`, etc. |
| Listing (prefix, delimiter, prefixes) | ✅ | Plus name-indexed pagination via `pageToken` |
| Pagination | ✅ | `maxResults` + `pageToken` (`nextPageToken` in response) |
| Object versioning / generations | ✅ | Per-bucket `versioning.enabled`; multiple generations retained |
| Preconditions | ✅ | `ifGenerationMatch/NotMatch`, `ifMetagenerationMatch/NotMatch` |
| Copy / move / rename / rewrite / compose | ✅ | |
| ACLs (object / bucket / default) | ⚠️ | Accepted and echoed; **not enforced** |
| IAM policy + testPermissions | ⚠️ | Canned responses; **not enforced** |
| HMAC keys | ✅ | Full lifecycle, in-memory |
| Signed URLs (`getSignedUrl`) | ✅ | Generated client-side; needs a valid RSA key |
| Notifications (Pub/Sub) | ⚠️ | Endpoints respond; no events are delivered |
| Batch requests | ⚠️ | Acknowledged with an empty multipart batch response |
| KMS / CMEK encryption | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Retention / object hold enforcement | ⟳ Roadmap |
| Requester Pays billing | ⟳ Roadmap |
| Real Google auth / quota | ✓ By design — Never throttles — local tests run at full speed, zero cost |

Legend: ✅ fully supported · ✓ by design (intentional for a local emulator) · ⟳ on the roadmap.

## Error codes & shapes

Errors are returned as the standard GCS JSON error envelope:

```json
{
  "error": {
    "code": 404,
    "message": "No such object: my-bucket/missing.txt",
    "errors": [
      {
        "domain": "global",
        "reason": "notFound",
        "message": "No such object: my-bucket/missing.txt"
      }
    ]
  }
}
```

| Status | Reason | When |
|--------|--------|------|
| 400 | `invalid` / `required` | Invalid bucket name, missing `name`, malformed JSON/multipart |
| 404 | `notFound` | Missing bucket, object, upload session, or HMAC key |
| 409 | `conflict` | Bucket already exists, or deleting a non-empty bucket |
| 412 | `conditionNotMet` | Failed `ifGenerationMatch` / `ifMetagenerationMatch` precondition |
| 304 | `conditionNotMet` | `ifGenerationNotMatch` / `ifMetagenerationNotMatch` matched |
| 405 | `methodNotAllowed` | Unsupported HTTP method for a route |
| 500 | `internalError` | Unexpected server error |

Successful downloads include `x-goog-hash` (`crc32c=...,md5=...`),
`x-goog-generation`, `x-goog-metageneration`, and `x-goog-stored-content-length`
headers, mirroring the real service.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `STORAGE_EMULATOR_HOST` | `http://127.0.0.1:4580` | Points `@google-cloud/storage` at the fake |
| `GOOGLE_CLOUD_PROJECT` | `parlel` | Default project id |
| `GCLOUD_PROJECT` | `parlel` | Default project id (legacy var) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
STORAGE_EMULATOR_HOST=http://localhost:4580
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
