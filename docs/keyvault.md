# Azure Key Vault (Secrets)

Lightweight, dependency-free fake of the Azure Key Vault **Secrets** data plane that speaks the real Key Vault Secrets REST API (api-version `2025-07-01`), so application code using `@azure/keyvault-secrets` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4594 |
| Protocol | Azure Key Vault Secrets REST API (HTTP + JSON) |
| Compatible client | `@azure/keyvault-secrets` (v4.x, `SecretClient`) |
| API version | `2025-07-01` (the SDK default) |
| Size | ~40 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { KeyvaultServer } from "./services/keyvault/src/server.js";

const server = new KeyvaultServer(4594);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real `@azure/keyvault-secrets` client. The fake serves over plain
HTTP and presents a synthetic challenge resource, so set
`disableChallengeResourceVerification: true` and `allowInsecureConnection: true`.
Any `TokenCredential` works — the fake accepts **any** non-empty bearer token and
never validates it:

```js
import { SecretClient } from "@azure/keyvault-secrets";

// A minimal fake credential — no real Azure identity required.
const credential = {
  async getToken() {
    return { token: "parlel-fake-token", expiresOnTimestamp: Date.now() + 3600_000 };
  },
};

const client = new SecretClient("http://127.0.0.1:4594", credential, {
  disableChallengeResourceVerification: true,
  allowInsecureConnection: true,
});

// Set a secret (creates a new version).
const set = await client.setSecret("db-password", "s3cr3t", {
  contentType: "text/plain",
  tags: { env: "test" },
});

// Read the latest version.
const got = await client.getSecret("db-password");
console.log(got.value); // "s3cr3t"

// Soft-delete, then purge.
const poller = await client.beginDeleteSecret("db-password");
await poller.pollUntilDone();
await client.purgeDeletedSecret("db-password");
```

> Tip: in tests, pass `{ intervalInMs: 0 }` to `beginDeleteSecret` /
> `beginRecoverDeletedSecret` so the LRO pollers don't wait the default 2s
> between polls.

## Authentication

Azure Key Vault uses **challenge-based bearer authentication**:

1. The SDK sends the first request with an empty body.
2. The fake replies `401` with a `WWW-Authenticate` header advertising the
   authority + resource:
   `Bearer authorization="https://login.microsoftonline.com/parlel-tenant-id", resource="https://vault.azure.net"`
3. The SDK acquires a token from the supplied `TokenCredential` and replays the
   request with `Authorization: Bearer <token>`.

The fake accepts **any** non-empty bearer token, so any credential works
(`ClientSecretCredential`, `DefaultAzureCredential`, or a hand-rolled fake). The
challenge resource is synthetic, which is why
`disableChallengeResourceVerification: true` is required on the client.

## Implemented operations

### Secrets

| SDK method | HTTP | Path |
|-----------|------|------|
| `setSecret` | `PUT` | `/secrets/{name}` |
| `getSecret` (latest) | `GET` | `/secrets/{name}` |
| `getSecret` (version) | `GET` | `/secrets/{name}/{version}` |
| `updateSecretProperties` | `PATCH` | `/secrets/{name}/{version}` |
| `beginDeleteSecret` | `DELETE` | `/secrets/{name}` |
| `listPropertiesOfSecrets` | `GET` | `/secrets` |
| `listPropertiesOfSecretVersions` | `GET` | `/secrets/{name}/versions` |
| `backupSecret` | `POST` | `/secrets/{name}/backup` |
| `restoreSecretBackup` | `POST` | `/secrets/restore` |

### Deleted secrets (soft delete)

| SDK method | HTTP | Path |
|-----------|------|------|
| `getDeletedSecret` | `GET` | `/deletedsecrets/{name}` |
| `listDeletedSecrets` | `GET` | `/deletedsecrets` |
| `beginRecoverDeletedSecret` | `POST` | `/deletedsecrets/{name}/recover` |
| `purgeDeletedSecret` | `DELETE` | `/deletedsecrets/{name}` |

### Internal (parlel-only, not part of Key Vault)

| HTTP | Path | Purpose |
|------|------|---------|
| `GET` | `/_parlel/health` | Liveness + counts (`{ status, service, secrets, versions, deleted }`) |
| `POST` | `/_parlel/reset` | Wipe all state |
| `GET` | `/_parlel/dump` | List live + deleted secret names |

## Behavior notes

- **Versions** — every `setSecret` creates a new opaque 32-hex-char version. The
  newest version is "latest" and is what `getSecret(name)` returns. Older
  versions remain readable by id.
- **Identifiers** — secret ids are full URLs of the form
  `http://<host>/secrets/<name>/<version>`, parseable by
  `parseKeyVaultSecretIdentifier`.
- **Timestamps** — `created`, `updated`, `nbf`, `exp`, `deletedDate`, and
  `scheduledPurgeDate` are emitted as Unix epoch **seconds**, matching the wire
  format the SDK deserializes into `Date`.
- **Soft delete** — deleted secrets move to a recoverable store with
  `recoveryLevel: "Recoverable+Purgeable"` and a `scheduledPurgeDate` 90 days
  out. They can be recovered (restoring all versions) or purged permanently.
- **Backup blob** — an opaque base64url token that encodes the full secret
  (all versions). `restoreSecretBackup` rebuilds the secret from it.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
|---------|-----------|-------|
| Set / get / update secrets | ✅ | Including content type, tags, `enabled`, `nbf`, `exp` |
| Multiple versions per secret | ✅ | Latest + specific-version reads |
| List secrets / versions | ✅ | Paged via `maxresults` + `$skiptoken` / `nextLink` |
| Soft delete + recover + purge | ✅ | LRO pollers complete near-instantly |
| Backup / restore | ✅ | Opaque base64url blob |
| Challenge-based bearer auth | ✅ | Accepts any non-empty token |
| Pagination | ✅ | Default page size 25 |
| Token signature / scope validation | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| RBAC / access policies | ⟳ Roadmap |
| Keys & Certificates data planes | ⟳ Roadmap |
| HSM / managed-storage / rotation policies | ⟳ Roadmap |
| `x-ms-keyvault-*` regional headers | ⟳ Roadmap |
| Customer-managed encryption | ✓ By design — Plain in-memory storage — transport/at-rest crypto is unnecessary locally |

## Error codes / shapes

Errors use the Key Vault error envelope:

```json
{ "error": { "code": "SecretNotFound", "message": "A secret with (name/id) foo was not found in this key vault." } }
```

| HTTP | `code` | When |
|------|--------|------|
| 400 | `BadParameter` | Invalid secret name, missing `value`, or malformed JSON / backup blob |
| 401 | _(challenge)_ | Missing bearer token — replies with `WWW-Authenticate` |
| 404 | `SecretNotFound` | Unknown secret, version, or deleted secret |
| 405 | `MethodNotAllowed` | Unsupported method on a known path |
| 409 | `Conflict` | Re-creating / restoring a name that is soft-deleted or already exists |

The SDK surfaces these as `RestError` with a matching `statusCode` and `code`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AZURE_KEYVAULT_URL=http://localhost:4594
AZURE_TENANT_ID=parlel-tenant
AZURE_CLIENT_ID=parlel-client
AZURE_CLIENT_SECRET=parlel-secret
```

<!-- parlel:testenv:end -->
