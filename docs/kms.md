# parlel/kms

A zero-dependency, in-process fake of **AWS KMS** (Key Management Service).
Speaks the AWS JSON 1.1 wire protocol (`X-Amz-Target: TrentService.<Op>`).

| Property     | Value                                  |
| ------------ | -------------------------------------- |
| Service name | `kms`                                  |
| Port         | `4730`                                 |
| Protocol     | AWS JSON 1.1 (POST `/`)                |
| Target       | `TrentService.<Operation>`             |
| Healthcheck  | `GET /_parlel/health`                  |
| Account ID   | `000000000000`                         |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4730
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Category   | Operations                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------- |
| Keys       | CreateKey, DescribeKey, ListKeys, EnableKey, DisableKey, ScheduleKeyDeletion                  |
| Crypto     | Encrypt, Decrypt, GenerateDataKey, GenerateDataKeyWithoutPlaintext, ReEncrypt                 |
| Signing    | Sign, Verify                                                                                  |
| Aliases    | CreateAlias, ListAliases, DeleteAlias                                                         |
| Rotation   | EnableKeyRotation, DisableKeyRotation, GetKeyRotationStatus                                   |
| Tags       | TagResource, ListResourceTags                                                                 |

### Real-ish crypto

Each key holds in-memory AES-256-GCM material. `Encrypt` produces a reversible
ciphertext blob (base64 envelope embedding the key id, IV, auth tag, and
ciphertext); `Decrypt` reverses it. `Sign`/`Verify` use HMAC-SHA256 keyed by the
per-key material. Encrypt/Decrypt and data keys are fully round-trippable.

## SDK example

```js
import { KMSClient, CreateKeyCommand, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4730",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { KeyMetadata } = await kms.send(new CreateKeyCommand({}));
const enc = await kms.send(new EncryptCommand({ KeyId: KeyMetadata.KeyId, Plaintext: Buffer.from("secret") }));
const dec = await kms.send(new DecryptCommand({ CiphertextBlob: enc.CiphertextBlob }));
console.log(Buffer.from(dec.Plaintext).toString()); // secret
```

## Access via MCP / preview URL

When run inside parlel, KMS is reachable through the pool's MCP bridge and any
assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL to drive it
from an agent or remote client.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area            | Limitation                                                          |
| --------------- | ------------------------------------------------------------------ |
| Signing algos   | Sign/Verify use HMAC regardless of the requested algorithm.        |
| Asymmetric keys | No real RSA/ECC key material is exported.                          |
| Grants/policies | Key policies and grants are not modeled or enforced.               |
| Deletion        | ScheduleKeyDeletion marks state but does not actually delete keys. |
| State           | All keys/aliases are in memory and cleared on reset.               |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4730
```

<!-- parlel:testenv:end -->
