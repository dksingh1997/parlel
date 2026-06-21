# Azure Blob Storage

Lightweight, dependency-free fake of Azure Blob Storage that speaks the real Azure Blob REST API (XML wire protocol + `x-ms-*` headers), so application code using `@azure/storage-blob` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4590 |
| Protocol | Azure Blob Storage REST API (HTTP + XML) |
| Compatible client | `@azure/storage-blob` (v12) |
| API version | `2025-05-05` |
| Size | ~96 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { AzureblobServer } from "./services/azureblob/src/server.js";

const server = new AzureblobServer(4590);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real Azure SDK client. The fake uses path-style addressing (like Azurite), so the blob endpoint always includes the account name:

```js
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

const account = "devstoreaccount1";
const key =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const credential = new StorageSharedKeyCredential(account, key);
const svc = new BlobServiceClient(
  `http://127.0.0.1:4590/${account}`,
  credential,
);

const container = svc.getContainerClient("my-container");
await container.create();

const blob = container.getBlockBlobClient("hello.txt");
await blob.upload("hello parlel", 12);

const dl = await blob.download();
// dl.readableStreamBody -> "hello parlel"
```

You can also connect via a connection string:

```js
const conn =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
  "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
  "BlobEndpoint=http://127.0.0.1:4590/devstoreaccount1;";

const svc = BlobServiceClient.fromConnectionString(conn);
```

> Note: the fake does **not** validate the Shared Key signature — any account name / key is accepted. The well-known Azurite dev account above is provided for convenience and copy-paste compatibility.

### Addressing

URLs are path-style: `http://127.0.0.1:4590/{account}/{container}/{blob}?{comp}=...`

## Implemented Operations

### Service (`BlobServiceClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Get Service Properties | `GET` | `/{account}/?restype=service&comp=properties` |
| Set Service Properties | `PUT` | `/{account}/?restype=service&comp=properties` |
| Get Account Information | `GET` | `/{account}/?comp=properties&restype=account` |
| Get Service Statistics | `GET` | `/{account}/?comp=stats` |
| List Containers | `GET` | `/{account}/?comp=list` |
| Find Blobs by Tags | `GET` | `/{account}/?comp=blobs&where=...` |
| Undelete Container | `PUT` | `/{account}/{container}?restype=container&comp=undelete` |
| Submit Batch | `POST` | `/{account}/?comp=batch` |

### Container (`ContainerClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Create Container | `PUT` | `/{account}/{container}?restype=container` |
| Get Container Properties / exists | `GET`/`HEAD` | `/{account}/{container}?restype=container` |
| Delete Container | `DELETE` | `/{account}/{container}?restype=container` |
| Set Container Metadata | `PUT` | `/{account}/{container}?restype=container&comp=metadata` |
| Get Container ACL | `GET` | `/{account}/{container}?restype=container&comp=acl` |
| Set Container ACL | `PUT` | `/{account}/{container}?restype=container&comp=acl` |
| Lease Container | `PUT` | `/{account}/{container}?restype=container&comp=lease` |
| List Blobs (flat + hierarchy) | `GET` | `/{account}/{container}?restype=container&comp=list` |

### Blob (`BlobClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Download / Get Blob (range, conditional) | `GET` | `/{account}/{container}/{blob}` |
| Get Blob Properties / exists | `HEAD` | `/{account}/{container}/{blob}` |
| Delete Blob | `DELETE` | `/{account}/{container}/{blob}` |
| Undelete Blob | `PUT` | `/{account}/{container}/{blob}?comp=undelete` |
| Set HTTP Headers | `PUT` | `/{account}/{container}/{blob}?comp=properties` |
| Set Metadata | `PUT` | `/{account}/{container}/{blob}?comp=metadata` |
| Set Tags | `PUT` | `/{account}/{container}/{blob}?comp=tags` |
| Get Tags | `GET` | `/{account}/{container}/{blob}?comp=tags` |
| Set Access Tier | `PUT` | `/{account}/{container}/{blob}?comp=tier` |
| Create Snapshot | `PUT` | `/{account}/{container}/{blob}?comp=snapshot` |
| Lease Blob | `PUT` | `/{account}/{container}/{blob}?comp=lease` |
| Copy From URL (sync) | `PUT` | `/{account}/{container}/{blob}` (`x-ms-copy-source`) |
| Begin Copy From URL (async) | `PUT` | `/{account}/{container}/{blob}` (`x-ms-copy-source`) |
| Abort Copy | `PUT` | `/{account}/{container}/{blob}?comp=copy&copyid=...` |

### Block Blob (`BlockBlobClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Upload (Put Blob) | `PUT` | `/{account}/{container}/{blob}` (`x-ms-blob-type: BlockBlob`) |
| Stage Block | `PUT` | `/{account}/{container}/{blob}?comp=block&blockid=...` |
| Stage Block From URL | `PUT` | `?comp=block&blockid=...` (`x-ms-copy-source`) |
| Commit Block List | `PUT` | `/{account}/{container}/{blob}?comp=blocklist` |
| Get Block List | `GET` | `/{account}/{container}/{blob}?comp=blocklist` |

`uploadData`, `uploadStream`, `uploadFile`, `downloadToBuffer` all work via the above (large uploads are automatically split into staged blocks by the SDK).

### Append Blob (`AppendBlobClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Create | `PUT` | `/{account}/{container}/{blob}` (`x-ms-blob-type: AppendBlob`) |
| Append Block | `PUT` | `/{account}/{container}/{blob}?comp=appendblock` |
| Append Block From URL | `PUT` | `?comp=appendblock` (`x-ms-copy-source`) |
| Seal | `PUT` | `/{account}/{container}/{blob}?comp=seal` |

### Page Blob (`PageBlobClient`)

| Operation | HTTP | Endpoint |
|-----------|------|----------|
| Create | `PUT` | `/{account}/{container}/{blob}` (`x-ms-blob-type: PageBlob`) |
| Upload Pages | `PUT` | `/{account}/{container}/{blob}?comp=page` (`x-ms-page-write: update`) |
| Upload Pages From URL | `PUT` | `?comp=page` (`x-ms-copy-source`) |
| Clear Pages | `PUT` | `/{account}/{container}/{blob}?comp=page` (`x-ms-page-write: clear`) |
| Get Page Ranges | `GET` | `/{account}/{container}/{blob}?comp=pagelist` |
| Resize | `PUT` | `/{account}/{container}/{blob}?comp=properties` (`x-ms-blob-content-length`) |

### Lease (`BlobLeaseClient`)

Acquire, Renew, Change, Release, Break — for both blobs and containers via `comp=lease` and the `x-ms-lease-action` header.

### Batch (`BlobBatchClient`)

`multipart/mixed` sub-request batching at `comp=batch`:

- `deleteBlobs(...)` — batch Delete Blob
- `setBlobsAccessTier(...)` — batch Set Access Tier

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Containers: create / delete / list / metadata / ACL / lease | ✅ Supported |
| Block blobs: upload / download / stage / commit / block list | ✅ Supported |
| Append blobs: create / append / append-from-URL / seal | ✅ Supported |
| Page blobs: create / pages / ranges / clear / resize | ✅ Supported |
| Blob metadata, HTTP headers, tags, access tier | ✅ Supported |
| Snapshots (`createSnapshot`, `withSnapshot`) | ✅ Supported |
| Copy: sync (`syncCopyFromURL`), async (`beginCopyFromURL`), abort | ✅ Supported |
| `*FromURL` family (stage / append / pages) | ✅ Supported |
| Soft delete + undelete (blob & container) | ✅ Supported |
| Delete blob with `x-ms-delete-snapshots` (include / only) | ✅ Supported |
| Find blobs by tags | ✅ Supported |
| Range reads + conditional headers (If-Match / If-None-Match / If-(Un)Modified-Since) | ✅ Supported |
| Leases (blob + container, all actions) | ✅ Supported |
| Batch delete / set-tier | ✅ Supported |
| Shared Key signature **validation** | ✓ By design — Not enforced (any key accepted) |
| SAS token generation / validation | ✓ By design — Not enforced |
| User delegation keys | ⟳ Roadmap |
| Object/container immutability & legal hold | ✓ By design — No-op / not enforced |
| Encryption scopes (real crypto) | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Lease expiry timers (duration countdown) | ⟳ Roadmap — Leases never auto-expire |
| Blob versioning (`x-ms-version-id`) | ⟳ Roadmap — Snapshots only |
| Page range diff / incremental copy | ⟳ Roadmap |
| Geo-replication (real) | ⟳ Roadmap — Stats reported as `live` only |

## Error Codes & Shapes

Errors are returned as Azure-style XML with a matching `x-ms-error-code` response header:

```xml
<?xml version="1.0" encoding="utf-8"?>
<Error><Code>BlobNotFound</Code><Message>The specified blob does not exist.</Message></Error>
```

| HTTP | Code | When |
|------|------|------|
| 400 | `InvalidResourceName` | Invalid container name |
| 400 | `Md5Mismatch` | `Content-MD5` did not match the body |
| 400 | `InvalidBlockList` | Commit referenced an unknown block |
| 404 | `ContainerNotFound` | Operation on a missing container |
| 404 | `BlobNotFound` | Operation on a missing blob |
| 404 | `CannotVerifyCopySource` | Copy/`*FromURL` source not found |
| 409 | `ContainerAlreadyExists` | Create on an existing container |
| 409 | `InvalidBlobType` | Wrong blob-type for the operation |
| 409 | `LeaseAlreadyPresent` | Acquire on an already-leased resource |
| 409 | `LeaseIdMismatchWithLeaseOperation` | Lease id did not match |
| 409 | `SnapshotsPresent` | Delete blob with snapshots and no `x-ms-delete-snapshots` |
| 412 | `ConditionNotMet` | Conditional header precondition failed |
| 412 | `AppendPositionConditionNotMet` | `x-ms-blob-condition-appendpos` mismatch |
| 416 | `InvalidRange` | Requested range outside the blob |

## Health & Reset

Non-Azure internal endpoints for orchestration:

- `GET /_parlel/health` → `{ "status": "ok", "service": "azureblob", "containers": <n> }`
- `POST /_parlel/reset` → `{ "ok": true }` — clears all in-memory state.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AZURE_STORAGE_ACCOUNT=devstoreaccount1
AZURE_STORAGE_KEY=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:4590/devstoreaccount1;
```

<!-- parlel:testenv:end -->
