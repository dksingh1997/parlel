# Secrets Manager

Lightweight, dependency-free fake of AWS Secrets Manager that speaks the real AWS JSON 1.1 wire protocol, so application code using `@aws-sdk/client-secrets-manager` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4572 |
| Protocol | AWS JSON 1.1 (`X-Amz-Target: secretsmanager.<Operation>`) over HTTP |
| Compatible client | `@aws-sdk/client-secrets-manager` (v3) |
| Size | ~80 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { SecretsmanagerServer } from "./services/secretsmanager/src/server.js";

const server = new SecretsmanagerServer(4572);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";

const sm = new SecretsManagerClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4572",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Create a secret
const { ARN } = await sm.send(
  new CreateSecretCommand({ Name: "db/password", SecretString: "s3cr3t" }),
);

// Read it back
const { SecretString } = await sm.send(
  new GetSecretValueCommand({ SecretId: "db/password" }),
);
console.log(SecretString); // "s3cr3t"

// Rotate the stored value (creates a new AWSCURRENT version; the old one
// becomes AWSPREVIOUS)
await sm.send(
  new PutSecretValueCommand({ SecretId: "db/password", SecretString: "n3w-s3cr3t" }),
);

// Inspect metadata + version staging map
const meta = await sm.send(new DescribeSecretCommand({ SecretId: "db/password" }));
console.log(meta.VersionIdsToStages);
```

The `SecretId` parameter accepts either a bare secret name or a full ARN
(`arn:aws:secretsmanager:us-east-1:000000000000:secret:db/password-aB3xZ9`).

## Wire protocol

* Requests: `POST /` with header `X-Amz-Target: secretsmanager.<Operation>` and
  `Content-Type: application/x-amz-json-1.1`. The body is the operation's JSON input.
* `SecretBinary` is base64-encoded on the wire (the SDK handles encode/decode).
* Timestamp fields (`CreatedDate`, `DeletionDate`, `LastChangedDate`, ...) are
  epoch-seconds numbers; the SDK surfaces them as `Date` objects.
* Success: `200` with the operation's JSON output.
* Error: non-2xx with `{ "__type": "<Code>", "message": "<msg>" }` plus an
  `x-amzn-errortype: <Code>` header.

## Implemented operations

All 23 operations exposed by `@aws-sdk/client-secrets-manager` are implemented.

### Secret lifecycle

| Operation | Notes |
|-----------|-------|
| `CreateSecret` | Name validation, tags, KMS key id, replica regions, `ClientRequestToken` idempotency, rejects duplicate names and `SecretString`+`SecretBinary` together. |
| `UpdateSecret` | Updates description/KMS key; a new value creates a fresh `AWSCURRENT` version (old → `AWSPREVIOUS`). |
| `DescribeSecret` | Full metadata + `VersionIdsToStages`, tags, rotation config, replication status, deletion date. |
| `DeleteSecret` | Scheduled deletion with a 7–30 day recovery window (default 30), or `ForceDeleteWithoutRecovery`. |
| `RestoreSecret` | Cancels a scheduled deletion. |

### Secret values

| Operation | Notes |
|-----------|-------|
| `GetSecretValue` | By `VersionId` or `VersionStage` (default `AWSCURRENT`); string or binary. |
| `PutSecretValue` | New version with optional `VersionStages`; rotates `AWSCURRENT`/`AWSPREVIOUS`; `ClientRequestToken` idempotency. |
| `BatchGetSecretValue` | By `SecretIdList` or `Filters` (not both); per-id `Errors` array for missing secrets. |

### Listing

| Operation | Notes |
|-----------|-------|
| `ListSecrets` | `Filters` (name/description/tag-key/tag-value/primary-region/owning-service/all, with `!` negation), `SortBy`/`SortOrder`, `MaxResults`/`NextToken` pagination, `IncludePlannedDeletion`. |
| `ListSecretVersionIds` | Version staging labels, `IncludeDeprecated`, pagination. |

### Version staging

| Operation | Notes |
|-----------|-------|
| `UpdateSecretVersionStage` | Move/remove a staging label across versions; `AWSCURRENT` move shifts `AWSPREVIOUS`. |

### Rotation

| Operation | Notes |
|-----------|-------|
| `RotateSecret` | Enables rotation, stores lambda ARN + rules, computes `NextRotationDate`, creates a new `AWSCURRENT` version when `RotateImmediately` (default). |
| `CancelRotateSecret` | Disables rotation and removes any in-flight `AWSPENDING` version. |

### Resource policies

| Operation | Notes |
|-----------|-------|
| `PutResourcePolicy` | Validates JSON; `BlockPublicPolicy` rejects `Principal: "*"`. |
| `GetResourcePolicy` | Returns the attached policy document. |
| `DeleteResourcePolicy` | Detaches the policy. |
| `ValidateResourcePolicy` | Returns `PolicyValidationPassed` + `ValidationErrors`. |

### Replication

| Operation | Notes |
|-----------|-------|
| `ReplicateSecretToRegions` | Adds replica regions with status; `ForceOverwriteReplicaSecret`. |
| `RemoveRegionsFromReplication` | Removes replica regions. |
| `StopReplicationToReplica` | Promotes a replica to standalone (clears replication status). |

### Tagging & utility

| Operation | Notes |
|-----------|-------|
| `TagResource` | Add/overwrite tags. |
| `UntagResource` | Remove tags by key. |
| `GetRandomPassword` | Length, character-class exclusions, `ExcludeCharacters`, `IncludeSpace`, `RequireEachIncludedType`. |

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Secret CRUD (string + binary) | ✅ Supported |
| Version staging (`AWSCURRENT`/`AWSPREVIOUS`/`AWSPENDING` + custom) | ✅ Supported |
| `ClientRequestToken` idempotency | ✅ Supported |
| Scheduled deletion + recovery window + restore | ✅ Supported |
| Force delete | ✅ Supported |
| Filtering, sorting, pagination on `ListSecrets` | ✅ Supported |
| Tags | ✅ Supported |
| Resource policies + validation + public-policy blocking | ✅ Supported |
| `GetRandomPassword` | ✅ Supported |
| Rotation config + immediate rotation simulation | ✅ Supported (simulated) |
| Replication metadata (regions/status) | ✅ Supported (metadata only) |
| Bare-name **and** full-ARN `SecretId` resolution | ✅ Supported |
| Real KMS encryption of secret values | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |
| Actual rotation-Lambda invocation | ✓ By design — Intentional for a local, zero-cost test emulator |
| Real cross-region replication of data | ⟳ Roadmap — Not supported (status is tracked, no second store) |
| IAM / resource-policy enforcement | ✓ By design — Not supported (policies are stored, not enforced) |
| Persistence across restarts | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error codes

Errors are returned as `{ "__type": "<Code>", "message": "<msg>" }`. The SDK
surfaces `<Code>` as the thrown error's `name`.

| Code | HTTP | When |
|------|------|------|
| `ResourceNotFoundException` | 400 | Secret or version not found (or found but marked for deletion). |
| `ResourceExistsException` | 400 | `CreateSecret` with a name that already exists. |
| `InvalidParameterException` | 400 | Invalid/missing parameters, conflicting `SecretString`+`SecretBinary`, bad recovery window, etc. |
| `InvalidRequestException` | 400 | e.g. creating a secret whose name is scheduled for deletion; malformed JSON body. |
| `InvalidNextTokenException` | 400 | Malformed pagination token. |
| `MalformedPolicyDocumentException` | 400 | Resource policy is not valid JSON. |
| `PublicPolicyException` | 400 | `BlockPublicPolicy` set and the policy grants public access. |
| `LimitExceededException` | 400 | Modeled (quota limits). |
| `PreconditionNotMetException` | 400 | Modeled. |
| `EncryptionFailure` / `DecryptionFailure` | 400 | Modeled (KMS faults). |
| `InternalServiceError` / `InternalFailure` | 500 | Unexpected server-side error. |

## Health & reset

* `GET /_parlel/health` → `{ "status": "ok", "service": "secretsmanager", "secrets": <n> }`
* `POST /_parlel/reset` → clears all in-memory state. You can also call
  `server.reset()` directly in tests.

## Environment variables

The manifest publishes these defaults for AWS-SDK-based clients:

```
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://127.0.0.1:4572
AWS_ENDPOINT_URL=http://127.0.0.1:4572
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:4572
AWS_ENDPOINT_URL=http://localhost:4572
```

<!-- parlel:testenv:end -->
