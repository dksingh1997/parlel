# apigateway-v2 — API Gateway v2 (HTTP & WebSocket)

A zero-dependency, in-process emulator for AWS API Gateway v2 (HTTP and
WebSocket APIs). Speaks the REST/JSON protocol used by the AWS SDK
`@aws-sdk/client-apigatewayv2` and the raw REST API.

| Property | Value                 |
| -------- | --------------------- |
| Port     | 4714                  |
| Protocol | REST / JSON           |
| Health   | `GET /_parlel/health` |
| Reset    | `POST /_parlel/reset` |

> This is a separate service from the legacy `apigateway` stub (port 4579) and
> from `apigateway-v1` (port 4715, REST APIs).

## Quick start

```ts
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  GetApisCommand,
} from "@aws-sdk/client-apigatewayv2";

const client = new ApiGatewayV2Client({
  endpoint: "http://127.0.0.1:4714",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const api = await client.send(new CreateApiCommand({
  Name: "my-api",
  ProtocolType: "HTTP",
}));
// api.ApiId => alphanumeric string
```

## Implemented operations

All `/v2/*` routes accept and return `application/json`. State is in-memory and
ephemeral (reset via `POST /_parlel/reset`).

### APIs

- `POST /v2/apis` — create an API (`201`). `Name` and `ProtocolType` (`HTTP` | `WEBSOCKET`) required. WebSocket APIs require `RouteSelectionExpression`.
- `GET /v2/apis` — list APIs (`200 { Items: [...] }`).
- `GET /v2/apis/{ApiId}` — retrieve an API (`200`).
- `DELETE /v2/apis/{ApiId}` — delete an API and all sub-resources (`204`).

### Routes

- `POST /v2/apis/{ApiId}/routes` — create a route (`201`). `RouteKey` required.
- `GET /v2/apis/{ApiId}/routes` — list routes (`200 { Items: [...] }`).
- `GET /v2/apis/{ApiId}/routes/{RouteId}` — retrieve a route (`200`).
- `DELETE /v2/apis/{ApiId}/routes/{RouteId}` — delete a route (`204`).

### Integrations

- `POST /v2/apis/{ApiId}/integrations` — create an integration (`201`). `IntegrationType` required (`AWS_PROXY` | `HTTP_PROXY` | `MOCK` | `AWS` | `HTTP`).
- `GET /v2/apis/{ApiId}/integrations` — list integrations (`200 { Items: [...] }`).
- `GET /v2/apis/{ApiId}/integrations/{IntegrationId}` — retrieve (`200`).
- `DELETE /v2/apis/{ApiId}/integrations/{IntegrationId}` — delete (`204`).

### Stages

- `POST /v2/apis/{ApiId}/stages` — create a stage (`201`). `StageName` required. Returns `409 ConflictException` on duplicate.
- `GET /v2/apis/{ApiId}/stages` — list stages (`200 { Items: [...] }`).
- `GET /v2/apis/{ApiId}/stages/{StageName}` — retrieve (`200`).
- `DELETE /v2/apis/{ApiId}/stages/{StageName}` — delete (`204`).

### Deployments

- `POST /v2/apis/{ApiId}/deployments` — create a deployment (`201`). Link to a stage via `StageName`.
- `GET /v2/apis/{ApiId}/deployments` — list deployments (`200 { Items: [...] }`).
- `GET /v2/apis/{ApiId}/deployments/{DeploymentId}` — retrieve (`200`).
- `DELETE /v2/apis/{ApiId}/deployments/{DeploymentId}` — delete (`204`).

## Access via MCP / preview URL

Point any AWS SDK or MCP tool at the allocated preview URL via
`AWS_ENDPOINT_URL` (default `http://127.0.0.1:4714`). The SDK handles
authentication automatically; any non-empty credentials are accepted.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Status |
| --- | --- |
| `CreateApi` / `GetApi` / `GetApis` / `DeleteApi` | ✅ Supported |
| `CreateRoute` / `GetRoute` / `GetRoutes` / `DeleteRoute` | ✅ Supported |
| `CreateIntegration` / `GetIntegration` / `GetIntegrations` / `DeleteIntegration` | ✅ Supported |
| `CreateStage` / `GetStage` / `GetStages` / `DeleteStage` | ✅ Supported |
| `CreateDeployment` / `GetDeployment` / `GetDeployments` / `DeleteDeployment` | ✅ Supported |
| Correct AWS error envelope (`{ message }` + `x-amzn-errortype` header) | ✅ Supported |
| `resourceType` on `NotFoundException` for API lookups | ✅ Supported |
| Pagination (`MaxResults` / `NextToken` query params) | ⟳ Roadmap — list endpoints return all items |
| Update operations (`UpdateApi`, `UpdateRoute`, etc.) | ⟳ Roadmap |
| Authorizers / JWT / IAM auth | ⟳ Roadmap |
| Custom domains / API mappings | ⟳ Roadmap |
| Route-level throttling / request validation | ⟳ Roadmap |
| Actual request routing / Lambda invocation | ✓ By design — no real execution |
| Auth credential enforcement | ✓ By design — any non-empty credential accepted |
| Rate limiting (`429 TooManyRequestsException`) | ✓ By design — never throttles |
| Schema validation (`disableSchemaValidation`) | ✓ By design — not enforced |

## Error codes & shapes

Errors use the standard AWS REST JSON error envelope:

```json
{ "message": "Human-readable error description" }
```

With response headers:
- `x-amzn-ErrorType` — the error code (e.g. `NotFoundException`)
- `x-amzn-RequestId` — unique request ID

For `NotFoundException` on API lookups, the body also includes `resourceType`:

```json
{ "message": "Invalid API identifier specified: abc123", "resourceType": "Api" }
```

| Status | Error Type | When |
| --- | --- | --- |
| `400` | `BadRequestException` | missing required field, invalid `ProtocolType`, invalid `IntegrationType` |
| `404` | `NotFoundException` | unknown API/resource ID, unsupported path |
| `409` | `ConflictException` | duplicate `StageName` |
| `429` | `TooManyRequestsException` | (by design — not enforced locally) |
| `500` | `InternalServerErrorException` | unhandled server error |

## Manifest

See `services/apigateway-v2/manifest.json`:

- name: `apigateway-v2`, image: `parlel/apigateway-v2:0.1`
- port: `4714`, protocol: `http`, healthcheck: `/_parlel/health`, startup ≈ 100ms
- env: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_ENDPOINT_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4714
```

<!-- parlel:testenv:end -->
