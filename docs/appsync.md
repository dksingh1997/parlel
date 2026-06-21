# AppSync

A zero-dependency, in-process fake of AWS AppSync (GraphQL APIs).

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4728                           |
| Protocol    | REST/JSON (paths under `/v1`)  |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Quick start

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4728
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Implemented operations

| Operation         | Path                                                  |
| ----------------- | ----------------------------------------------------- |
| CreateGraphqlApi  | `POST   /v1/apis`                                      |
| ListGraphqlApis   | `GET    /v1/apis`                                      |
| GetGraphqlApi     | `GET    /v1/apis/{apiId}`                              |
| DeleteGraphqlApi  | `DELETE /v1/apis/{apiId}`                              |
| CreateDataSource  | `POST   /v1/apis/{apiId}/datasources`                 |
| ListDataSources   | `GET    /v1/apis/{apiId}/datasources`                 |
| CreateResolver    | `POST   /v1/apis/{apiId}/types/{typeName}/resolvers`  |
| ListResolvers     | `GET    /v1/apis/{apiId}/types/{typeName}/resolvers`  |
| (resolve)         | `POST   /v1/apis/{apiId}/resolve`                     |

The trivial resolver dispatch at `/v1/apis/{apiId}/resolve` echoes the request
`arguments` back under the resolved `fieldName`.

## SDK example

```ts
import { AppSyncClient, CreateGraphqlApiCommand } from "@aws-sdk/client-appsync";

const appsync = new AppSyncClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4728",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { graphqlApi } = await appsync.send(
  new CreateGraphqlApiCommand({ name: "myapi", authenticationType: "API_KEY" }),
);
console.log(graphqlApi?.uris?.GRAPHQL);
```

## Access via MCP / preview URL

Reachable through the parlel pool MCP bridge and preview URL. No auth setup
required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area        | Status | Notes |
| ----------- | ------ | ----- |
| GraphQL execution | ✓ by design | No real engine; resolver dispatch echoes |
| Schema management | ⟳ roadmap | Schema upload/introspection not modeled |
| VTL templates | ◐ accepted | Stored but not evaluated |
| Auth enforcement | ✓ by design | Types recorded but not enforced |
| Pagination | ⟳ roadmap | List operations return all items |
| CloudWatch logging | ⟳ roadmap | logConfig not modeled |
| X-Ray tracing | ✓ by design | xrayEnabled stored but not enforced |
| Caching | ⟳ roadmap | CachingConfig not modeled |
| Pipeline resolvers | ⟳ roadmap | pipelineConfig not modeled |

## Error codes & shapes

Errors follow the real AWS AppSync format: `{ "__type": "...", "message": "..." }` with `x-amzn-errortype` header.

| Error | Status | When |
|-------|--------|------|
| BadRequestException | 400 | Missing required field, invalid JSON |
| NotFoundException | 404 | API or resource not found |
| UnknownOperationException | 404 | Unknown route/method |
| InternalFailureException | 500 | Server error |

## Manifest

```json
{
  "name": "appsync",
  "version": "0.1",
  "port": 4728,
  "protocol": "http",
  "healthcheck": "/_parlel/health"
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4728
```

<!-- parlel:testenv:end -->
