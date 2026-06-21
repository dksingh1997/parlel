# SSM (Parameter Store)

Lightweight, dependency-free fake of AWS Systems Manager (SSM) Parameter Store that speaks the real AWS JSON 1.1 wire protocol, so application code using `@aws-sdk/client-ssm` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4578 |
| Protocol | AWS JSON 1.1 (`X-Amz-Target: AmazonSSM.<Operation>`) over HTTP |
| Compatible client | `@aws-sdk/client-ssm` (v3) |
| Size | ~60 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { SsmServer } from "./services/ssm/src/server.js";

const server = new SsmServer(4578);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4578",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Write a parameter
await ssm.send(
  new PutParameterCommand({ Name: "/app/db/host", Value: "localhost", Type: "String" }),
);

// Write a secret
await ssm.send(
  new PutParameterCommand({ Name: "/app/db/password", Value: "s3cr3t", Type: "SecureString" }),
);

// Read it back
const { Parameter } = await ssm.send(new GetParameterCommand({ Name: "/app/db/host" }));
console.log(Parameter.Value); // "localhost"

// Fetch a whole hierarchy
const tree = await ssm.send(
  new GetParametersByPathCommand({ Path: "/app", Recursive: true }),
);
console.log(tree.Parameters.map((p) => p.Name));
```

## Configuration via environment variables

The `@aws-sdk/client-ssm` client honors these, set them to point the SDK at the fake:

```
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SSM=http://127.0.0.1:4578
AWS_ENDPOINT_URL=http://127.0.0.1:4578
```

## Implemented operations

### Parameter CRUD
- `PutParameter` — create/overwrite; versions auto-increment; supports `String`, `StringList`, `SecureString`; `Tier` (`Standard` / `Advanced` / `Intelligent-Tiering`); `AllowedPattern`, `Description`, `DataType`, `KeyId`, `Tags` (on create only).
- `GetParameter` — by name, by `name:version`, or `name:label` selector; `WithDecryption` accepted (no-op).
- `GetParameters` — batch (max 10); returns `Parameters` + `InvalidParameters`.
- `GetParametersByPath` — hierarchical fetch, `Recursive`, `ParameterFilters`, pagination.
- `DeleteParameter`
- `DeleteParameters` — batch; returns `DeletedParameters` + `InvalidParameters`.
- `DescribeParameters` — metadata only (no values), legacy `Filters` + modern `ParameterFilters`, pagination.
- `GetParameterHistory` — all versions with labels, in order, pagination.

### Version labels
- `LabelParameterVersion` — attach labels to a version (labels auto-move between versions); validates label rules; returns `InvalidLabels`.
- `UnlabelParameterVersion` — detach labels; returns `RemovedLabels` + `InvalidLabels`.

### Tagging
- `AddTagsToResource`
- `RemoveTagsFromResource`
- `ListTagsForResource`

### Resource policies
- `PutResourcePolicy`
- `GetResourcePolicies`
- `DeleteResourcePolicy`

### Service settings
- `GetServiceSetting`
- `UpdateServiceSetting`
- `ResetServiceSetting`

### Parlel internal (not part of SSM)
- `GET /_parlel/health` — `{ status, service, parameters }`
- `POST /_parlel/reset` — clears all in-memory state

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Parameter Store CRUD (`PutParameter`, `GetParameter(s)`, `GetParametersByPath`, `Delete...`, `Describe...`, `GetParameterHistory`) | ✅ Supported |
| Parameter versioning + version selectors (`name:version`) | ✅ Supported |
| Version labels + label selectors (`name:label`) | ✅ Supported |
| Parameter types `String` / `StringList` / `SecureString` | ✅ Supported |
| Tiers `Standard` / `Advanced` / `Intelligent-Tiering` (size-based promotion) | ✅ Supported |
| `AllowedPattern` validation | ✅ Supported |
| Hierarchies / recursive path queries / `ParameterFilters` | ✅ Supported |
| Tagging (`AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource`) | ✅ Supported |
| Resource policies (`PutResourcePolicy`, `GetResourcePolicies`, `DeleteResourcePolicy`) | ✅ Supported |
| Service settings (`Get/Update/Reset ServiceSetting`) | ✅ Supported |
| Pagination (`MaxResults` / `NextToken`) | ✅ Supported |
| Real KMS encryption of `SecureString` | ✓ By design — Always succeeds deterministically — no real funds move |
| `Policies` (expiration / no-change notifications) actually firing | ⟳ Roadmap — Stored + echoed in metadata, but never executed |
| Automation, Documents (SSM Docs), Run Command (`SendCommand`), Sessions | ⟳ Roadmap — fleet/operations, not Parameter Store |
| Maintenance Windows, Patch Baselines, Inventory, OpsItems, Associations | ⟳ Roadmap |
| Cross-account `Shared` parameters | ⟳ Roadmap |

## Error codes / shapes

Errors are returned with a non-2xx HTTP status and an AWS JSON 1.1 body:

```json
{ "__type": "ParameterNotFound", "message": "Systems Manager could not find the parameter /missing." }
```

The `x-amzn-errortype` response header carries the same code. The `@aws-sdk/client-ssm`
client maps `__type` to `error.name`.

| Code | HTTP | When |
|------|------|------|
| `ParameterNotFound` | 400 | The named parameter (or label) does not exist |
| `ParameterAlreadyExists` | 400 | `PutParameter` on an existing name without `Overwrite: true` |
| `ParameterVersionNotFound` | 400 | A `name:version` selector points at a non-existent version |
| `ParameterPatternMismatchException` | 400 | Value fails `AllowedPattern` |
| `InvalidAllowedPatternException` | 400 | `AllowedPattern` is not a valid regular expression |
| `ValidationException` | 400 | Missing/invalid input (no `Type` on create, bad `Type`, reserved name prefix, oversized value, empty `Names`, bad `Path`, etc.) |
| `InvalidResourceId` | 400 | Tagging a parameter that does not exist |
| `InvalidFilterKey` | 400 | Unknown filter key for `Describe`/`GetParametersByPath` |
| `InvalidNextToken` | 400 | Malformed pagination token |
| `MalformedResourcePolicyDocumentException` | 400 | `PutResourcePolicy` with non-JSON policy |
| `ResourcePolicyNotFoundException` | 400 | `DeleteResourcePolicy` for an unknown `PolicyId` |
| `ResourcePolicyConflictException` | 400 | `PutResourcePolicy` update with a stale `PolicyHash` |
| `InternalFailure` | 500 | Unexpected server error |

## Notes on fidelity

- Timestamps are serialized as epoch-second numbers, matching the AWS JSON 1.1 wire format the SDK expects.
- Parameter names may be flat (`my-param`) or hierarchical (`/a/b/c`). Names beginning with the reserved `aws`/`ssm` prefixes are rejected, matching AWS.
- `SecureString` values are stored as-is (no KMS). This keeps the fake dependency-free; `WithDecryption: true` simply returns the stored value.
- Standard tier caps values at 4096 bytes; Advanced at 8192 bytes. `Intelligent-Tiering` is promoted to `Advanced` when the value exceeds the standard limit or `Policies` are present.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SSM=http://localhost:4578
AWS_ENDPOINT_URL=http://localhost:4578
```

<!-- parlel:testenv:end -->
