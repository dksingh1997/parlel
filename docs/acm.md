# parlel/acm

A zero-dependency, in-process fake of **AWS Certificate Manager (ACM)**.
Speaks the AWS JSON 1.1 wire protocol (`X-Amz-Target: CertificateManager.<Op>`),
so the AWS SDK for ACM (`@aws-sdk/client-acm`, boto3, AWS CLI `aws acm ...`) works
against it unmodified — request a certificate, describe it, list, get the PEM, tag,
import, and delete.

| Property     | Value                              |
| ------------ | ---------------------------------- |
| Service name | `acm`                              |
| Port         | `4731`                             |
| Protocol     | AWS JSON 1.1 (POST `/`)            |
| Target       | `CertificateManager.<Operation>`  |
| Healthcheck  | `GET /_parlel/health`             |
| Account ID   | `000000000000`                     |

## Quick start

```
AWS_ENDPOINT_URL=http://127.0.0.1:4731
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

```js
import { ACMClient, RequestCertificateCommand, DescribeCertificateCommand } from "@aws-sdk/client-acm";

const acm = new ACMClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4731",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { CertificateArn } = await acm.send(new RequestCertificateCommand({ DomainName: "example.com" }));
const { Certificate } = await acm.send(new DescribeCertificateCommand({ CertificateArn }));
console.log(Certificate.Status); // ISSUED
```

## Implemented operations

| Operation                  | Notes                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| RequestCertificate         | Auto-issues (`Status: ISSUED`) with DNS validation records. Returns `{ CertificateArn }`. |
| ImportCertificate          | Imports a cert (`Certificate` + `PrivateKey` required); `Type: IMPORTED`. |
| DescribeCertificate        | Returns full `CertificateDetail` + `DomainValidationOptions`.        |
| ListCertificates           | `CertificateStatuses` filter; `MaxItems` + `NextToken` pagination.    |
| GetCertificate             | Returns a synthetic PEM body + chain (`Certificate`, `CertificateChain`). |
| DeleteCertificate          | Removes the certificate.                                              |
| AddTagsToCertificate       | Merge tags onto a certificate.                                        |
| RemoveTagsFromCertificate  | Remove tags by key.                                                   |
| ListTagsForCertificate     | List tags (`{ Tags: [{ Key, Value }] }`).                            |
| ResendValidationEmail      | Validates `Domain`/`ValidationDomain`; empty body on success.        |
| UpdateCertificateOptions   | Updates certificate transparency logging preference.                 |

Each requested certificate includes a `DomainValidationOptions` entry per
domain/SAN with a DNS validation `ResourceRecord` (CNAME -> `acm-validations.aws`).
Imported certificates carry no `DomainValidationOptions` (ACM does not domain-validate
imports).

## Access via MCP / preview URL

When run inside parlel, ACM is reachable through the pool's MCP bridge and any
assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area                                                     | Status | Detail                                                            |
| -------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| Request / Describe / List / Get / Delete certificate     | ✅     | Wire-faithful AWS JSON 1.1 request + response shapes.             |
| Import certificate                                       | ✅     | `Type: IMPORTED`; requires `Certificate` + `PrivateKey`.          |
| Tag operations (Add / Remove / List)                     | ✅     | Exact `{ Tags: [{ Key, Value }] }` shape.                         |
| ListCertificates pagination                              | ✅     | `MaxItems` + opaque `NextToken` honored.                          |
| Error envelope + status codes                            | ✅     | `__type` / `x-amzn-errortype`; 400/404; ResourceNotFound, InvalidArn, Validation, UnknownOperation. |
| SigV4 authentication                                     | ◐      | Accepted but not verified (dummy `parlel` creds work).            |
| DNS / email domain validation                            | ✓      | Certs auto-issue (`ISSUED`); no real DNS/email round-trip.        |
| PEM material                                             | ✓      | `GetCertificate` returns a placeholder PEM, not a real X.509.     |
| Managed renewal / RenewCertificate / ExportCertificate   | ⟳      | Not modeled.                                                      |
| State                                                    | ✓      | In memory, cleared on reset.                                      |

## Error codes & shapes

Errors use the AWS JSON 1.1 envelope: HTTP status + `x-amzn-errortype` header +
`{ "__type": "<Code>", "message": "..." }` body.

| Scenario                                 | Status | `__type`                    |
| ---------------------------------------- | ------ | --------------------------- |
| Certificate ARN not found                | 400    | `ResourceNotFoundException` |
| Missing required `CertificateArn`        | 400    | `ValidationException`       |
| Malformed certificate ARN                | 400    | `InvalidArnException`       |
| Missing `DomainName` on RequestCertificate | 400  | `ValidationException`       |
| Missing `Certificate`/`PrivateKey` on import | 400 | `ValidationException`       |
| Unknown `X-Amz-Target` action            | 404    | `UnknownOperationException` |

## Manifest

```json
{
  "name": "acm",
  "port": 4731,
  "protocol": "http",
  "healthcheck": "/_parlel/health",
  "env_vars": {
    "AWS_ACCESS_KEY_ID": "parlel",
    "AWS_SECRET_ACCESS_KEY": "parlel",
    "AWS_REGION": "us-east-1",
    "AWS_ENDPOINT_URL": "http://127.0.0.1:4731"
  }
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4731
```

<!-- parlel:testenv:end -->
