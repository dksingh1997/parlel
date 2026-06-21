# imds — EC2 Instance Metadata Service

A zero-dependency, in-process emulator for the EC2 Instance Metadata Service
(IMDS), supporting both IMDSv1 and IMDSv2.

| Property | Value                 |
| -------- | --------------------- |
| Port     | 4719                  |
| Protocol | Plain HTTP REST       |
| Health   | `GET /_parlel/health` |
| Reset    | `POST /_parlel/reset` |

## Default connection

```
AWS_EC2_METADATA_SERVICE_ENDPOINT=http://127.0.0.1:4719
AWS_REGION=us-east-1
```

The real IMDS lives at the link-local address `169.254.169.254`. Point the AWS
SDK at this emulator with `AWS_EC2_METADATA_SERVICE_ENDPOINT`.

## Supported endpoints

| Path                                                       | Response     |
| ---------------------------------------------------------- | ------------ |
| `GET /latest/meta-data/`                                   | text listing |
| `GET /latest/meta-data/instance-id`                        | text         |
| `GET /latest/meta-data/instance-type`                      | text         |
| `GET /latest/meta-data/ami-id`                             | text         |
| `GET /latest/meta-data/local-ipv4`                         | text         |
| `GET /latest/meta-data/public-ipv4`                        | text         |
| `GET /latest/meta-data/hostname`                           | text         |
| `GET /latest/meta-data/mac`                                | text         |
| `GET /latest/meta-data/placement/availability-zone`        | text         |
| `GET /latest/meta-data/placement/region`                   | text         |
| `GET /latest/meta-data/iam/security-credentials/`          | text listing |
| `GET /latest/meta-data/iam/security-credentials/{role}`    | JSON creds   |
| `GET /latest/dynamic/instance-identity/document`           | JSON         |
| `PUT /latest/api/token`                                    | IMDSv2 token |

### IMDSv1

Plain `GET` requests work directly — no token required.

### IMDSv2

```
PUT /latest/api/token
  X-aws-ec2-metadata-token-ttl-seconds: 21600
=> <token>

GET /latest/meta-data/instance-id
  X-aws-ec2-metadata-token: <token>
=> i-1234567890abcdef0
```

GETs that carry a token header are validated; an invalid/expired token returns
`401`. GETs without a token header are served (IMDSv1 fallback).

## SDK usage example

```ts
import {
  fromInstanceMetadata,
} from "@aws-sdk/credential-providers";

// Point the SDK at the emulator via env, then resolve credentials:
process.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://127.0.0.1:4719";
const provider = fromInstanceMetadata();
const creds = await provider();
```

## Access via MCP / preview URL

Point the SDK or any HTTP client at the allocated preview URL via
`AWS_EC2_METADATA_SERVICE_ENDPOINT`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                       |
| ----------------- | ------------------------------------------------ |
| Credentials       | Synthetic STS-style creds; not usable against AWS|
| User data         | `/latest/user-data` is not implemented           |
| Network interfaces| Detailed `network/` tree is not implemented      |
| Hop limit / IMDS  | `X-Forwarded-For` hop-limit policy not enforced  |
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_EC2_METADATA_SERVICE_ENDPOINT=http://localhost:4719
AWS_ENDPOINT_URL=http://localhost:4719
```

<!-- parlel:testenv:end -->
