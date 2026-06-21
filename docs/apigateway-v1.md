# apigateway-v1 — API Gateway v1 (REST APIs)

A zero-dependency, in-process emulator for AWS API Gateway v1 (REST APIs).

| Property | Value                 |
| -------- | --------------------- |
| Port     | 4715                  |
| Protocol | REST / JSON           |
| Health   | `GET /_parlel/health` |
| Reset    | `POST /_parlel/reset` |

> Separate from `apigateway-v2` (port 4714, HTTP/WebSocket) and the legacy
> `apigateway` stub (port 4579).

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4715
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Implemented operations

| Operation        | Method + Path                                                  |
| ---------------- | -------------------------------------------------------------- |
| CreateRestApi    | `POST /restapis` (seeds a root `/` resource)                   |
| GetRestApis      | `GET /restapis`                                                |
| GetRestApi       | `GET /restapis/{id}`                                           |
| UpdateRestApi    | `PATCH /restapis/{id}`                                         |
| DeleteRestApi    | `DELETE /restapis/{id}`                                        |
| CreateResource   | `POST /restapis/{id}/resources/{parentId}`                    |
| GetResources     | `GET /restapis/{id}/resources`                                |
| GetResource      | `GET /restapis/{id}/resources/{resourceId}`                   |
| DeleteResource   | `DELETE /restapis/{id}/resources/{resourceId}`                |
| PutMethod        | `PUT /restapis/{id}/resources/{resourceId}/methods/{m}`        |
| GetMethod        | `GET /restapis/{id}/resources/{resourceId}/methods/{m}`        |
| CreateDeployment | `POST /restapis/{id}/deployments`                             |
| GetDeployments   | `GET /restapis/{id}/deployments`                              |
| GetDeployment    | `GET /restapis/{id}/deployments/{id}`                         |
| DeleteDeployment | `DELETE /restapis/{id}/deployments/{id}`                      |
| CreateStage      | `POST /restapis/{id}/stages`                                  |
| GetStages        | `GET /restapis/{id}/stages`                                   |
| GetStage         | `GET /restapis/{id}/stages/{name}`                            |
| UpdateStage      | `PATCH /restapis/{id}/stages/{name}`                          |
| DeleteStage      | `DELETE /restapis/{id}/stages/{name}`                         |
| CreateApiKey     | `POST /apikeys`                                               |
| GetApiKeys       | `GET /apikeys`                                                |
| GetApiKey        | `GET /apikeys/{id}`                                           |

## Access via MCP / preview URL

Point any AWS SDK or MCP tool at the allocated preview URL via
`AWS_ENDPOINT_URL`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                       |
| ----------------- | ------------------------------------------------ |
| Request execution | ✓ No actual request routing/invocation           |
| Integrations      | ⟳ PutIntegration is not implemented              |
| Authorizers       | ⟳ Not implemented                                |
| Usage plans       | ⟳ Not implemented                                |
| Custom domains    | ⟳ Not implemented                                |
| Models            | ⟳ Not implemented                                |
| State             | ✓ In-memory only; lost on restart                |
| Auth              | ◐ AWS SigV4 not validated (credentials accepted) |
| Caching           | ✓ Cache cluster config stored, no real cache     |
| Tags              | ✅ Tags stored and returned on resources         |

## Error codes & shapes

The emulator returns the standard AWS error envelope:

```json
{
  "__type": "NotFoundException",
  "message": "Invalid REST API identifier specified: abc123"
}
```

Error types: `BadRequestException` (400), `UnauthorizedException` (401),
`NotFoundException` (404), `ConflictException` (409),
`TooManyRequestsException` (429), `InternalServerErrorException` (500).

## Manifest

| Key       | Value |
| --------- | ----- |
| Name      | apigateway-v1 |
| Version   | 0.1   |
| Port      | 4715  |
| Protocol  | http  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4715
```

<!-- parlel:testenv:end -->
