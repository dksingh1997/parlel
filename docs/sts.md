# parlel/sts

A zero-dependency, in-process fake of **AWS STS** (Security Token Service).
Speaks the AWS Query/XML wire protocol (API version `2011-06-15`).

| Property     | Value                          |
| ------------ | ------------------------------ |
| Service name | `sts`                          |
| Port         | `4729`                         |
| Protocol     | AWS Query (form POST `/`, XML) |
| API version  | `2011-06-15`                   |
| Healthcheck  | `GET /_parlel/health`          |
| Account ID   | `000000000000`                 |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4729
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted.

## Supported operations

| Operation                  | Notes                                                          |
| -------------------------- | -------------------------------------------------------------- |
| GetCallerIdentity          | Returns `Account`, `Arn`, `UserId`.                            |
| AssumeRole                 | Returns `Credentials` + `AssumedRoleUser`.                     |
| GetSessionToken            | Returns temporary `Credentials`.                              |
| AssumeRoleWithWebIdentity  | Returns `Credentials` + `SubjectFromWebIdentityToken`.        |
| GetFederationToken         | Returns `Credentials` + `FederatedUser`.                      |
| DecodeAuthorizationMessage | Returns a synthetic decoded authorization message.            |

All temporary access keys are generated with the `ASIA` prefix and include a
secret, a session token, and an ISO-8601 expiration timestamp.

## SDK example

```js
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const sts = new STSClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4729",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const res = await sts.send(
  new AssumeRoleCommand({ RoleArn: "arn:aws:iam::000000000000:role/app", RoleSessionName: "demo" }),
);
console.log(res.Credentials.AccessKeyId); // ASIA...
```

## Access via MCP / preview URL

When run inside parlel, STS is reachable through the pool's MCP bridge and any
assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL to drive it
from an agent or remote client.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area          | Limitation                                                        |
| ------------- | ----------------------------------------------------------------- |
| Validation    | Role trust policies and identity tokens are not verified.         |
| Credentials   | Returned credentials are not usable against real AWS.             |
| Policy size   | `PackedPolicySize` is a fixed synthetic value.                    |
| State         | Issued sessions are tracked in memory and cleared on reset.       |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4729
```

<!-- parlel:testenv:end -->
