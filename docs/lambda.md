# Lambda

Lightweight, dependency-free fake of AWS Lambda that speaks the real Lambda REST-JSON (`restJson1`) wire protocol, so application code using `@aws-sdk/client-lambda` can run against it with zero cost and zero side effects. As a bonus over a pure mock, it can actually **execute** simple Node.js handler source, so `Invoke` returns real, meaningful payloads.

| Key | Value |
|-----|-------|
| Port | 4571 |
| Protocol | AWS Lambda REST-JSON (`restJson1`) over HTTP |
| Compatible client | `@aws-sdk/client-lambda` (v3) |
| Size | ~90 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { LambdaServer } from "./services/lambda/src/server.js";

const server = new LambdaServer(4571);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client and run a function:

```js
import {
  LambdaClient,
  CreateFunctionCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4571",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// A raw Node.js handler stored as the "zip" — the parlel fake executes it.
const handler = `
exports.handler = async (event, context) => {
  return { doubled: event.n * 2, fn: context.functionName };
};
`;

await lambda.send(
  new CreateFunctionCommand({
    FunctionName: "doubler",
    Runtime: "nodejs20.x",
    Role: "arn:aws:iam::123456789012:role/lambda-role",
    Handler: "index.handler",
    Code: { ZipFile: new TextEncoder().encode(handler) },
  }),
);

const res = await lambda.send(
  new InvokeCommand({
    FunctionName: "doubler",
    Payload: new TextEncoder().encode(JSON.stringify({ n: 21 })),
  }),
);

console.log(res.StatusCode); // 200
console.log(JSON.parse(new TextDecoder().decode(res.Payload))); // { doubled: 42, fn: "doubler" }
```

### Executable handlers

`Invoke` actually runs your function when the code is recoverable JavaScript:

- Provide the handler source **raw** in `Code.ZipFile` (a single `index.js`-style module). If the bytes look like real JS (not a real `PK\x03\x04` zip), the fake keeps them executable.
- Or use the parlel-specific `_parlelHandler` field on `CreateFunction` / `UpdateFunctionCode` to pass handler source explicitly.

The runtime supports:
- `async` handlers (return a value / `Promise`)
- callback-style handlers `(event, context, callback)`
- a realistic `context` (`functionName`, `functionVersion`, `invokedFunctionArn`, `awsRequestId`, `getRemainingTimeInMillis()`, ...)
- environment variables (from `Environment.Variables`)
- `console.log`/`error`/`warn`/`info` capture, surfaced via `LogType: "Tail"` → base64 `LogResult`

If the code is not recoverable JS (e.g. a real zip or an S3 reference), `Invoke` falls back to **echoing the input payload** (LocalStack-style), so calls still succeed.

A thrown handler error produces an `Invoke` response with `StatusCode: 200`, header `X-Amz-Function-Error: Unhandled`, and a JSON error payload `{ errorType, errorMessage, trace }` — matching real Lambda.

### Resetting state

State is fully in-memory and ephemeral. Reset it between tests:

```js
server.reset();                                  // in-process
await fetch("http://127.0.0.1:4571/_parlel/reset", { method: "POST" }); // over HTTP
```

Health check:

```js
await fetch("http://127.0.0.1:4571/_parlel/health");
// { status: "ok", service: "lambda", functions: <n> }
```

## Implemented operations

Grouped by area. Every operation below is exercised in `tests/lambda.test.ts`.

### Function lifecycle
- `CreateFunction` — `POST /2015-03-31/functions`
- `GetFunction` — `GET /2015-03-31/functions/{name}`
- `ListFunctions` — `GET /2015-03-31/functions` (paginated via `MaxItems` / `Marker`)
- `DeleteFunction` — `DELETE /2015-03-31/functions/{name}` (supports `?Qualifier` to delete a version)
- `GetFunctionConfiguration` — `GET /2015-03-31/functions/{name}/configuration`
- `UpdateFunctionConfiguration` — `PUT /2015-03-31/functions/{name}/configuration`
- `UpdateFunctionCode` — `PUT /2015-03-31/functions/{name}/code` (requires a code source: `ZipFile`, `S3Bucket`+`S3Key`, or `ImageUri`)

### Invocation
- `Invoke` — `POST /2015-03-31/functions/{name}/invocations` (`RequestResponse`, `Event`, `DryRun`; `LogType: Tail`; `Qualifier`)
- `InvokeAsync` (legacy) — `POST /2015-03-31/functions/{name}/invoke-async`

### Versions
- `PublishVersion` — `POST /2015-03-31/functions/{name}/versions` (supports `CodeSha256` / `RevisionId` preconditions)
- `ListVersionsByFunction` — `GET /2015-03-31/functions/{name}/versions`

### Aliases
- `CreateAlias` — `POST /2015-03-31/functions/{name}/aliases`
- `GetAlias` — `GET /2015-03-31/functions/{name}/aliases/{alias}`
- `UpdateAlias` — `PUT /2015-03-31/functions/{name}/aliases/{alias}`
- `DeleteAlias` — `DELETE /2015-03-31/functions/{name}/aliases/{alias}`
- `ListAliases` — `GET /2015-03-31/functions/{name}/aliases` (filterable by `FunctionVersion`)

### Permissions / resource policy
- `AddPermission` — `POST /2015-03-31/functions/{name}/policy`
- `RemovePermission` — `DELETE /2015-03-31/functions/{name}/policy/{statementId}`
- `GetPolicy` — `GET /2015-03-31/functions/{name}/policy`

### Tags
- `TagResource` — `POST /2017-03-31/tags/{arn}`
- `UntagResource` — `DELETE /2017-03-31/tags/{arn}?tagKeys=...`
- `ListTags` — `GET /2017-03-31/tags/{arn}`

### Concurrency
- `PutFunctionConcurrency` — `PUT /functions/{name}/concurrency`
- `GetFunctionConcurrency` — `GET /functions/{name}/concurrency`
- `DeleteFunctionConcurrency` — `DELETE /functions/{name}/concurrency`
- `PutProvisionedConcurrencyConfig` — `PUT /2019-09-30/functions/{name}/provisioned-concurrency?Qualifier=...`
- `GetProvisionedConcurrencyConfig` — `GET /2019-09-30/functions/{name}/provisioned-concurrency?Qualifier=...`
- `ListProvisionedConcurrencyConfigs` — `GET /2019-09-30/functions/{name}/provisioned-concurrency?List=ALL`
- `DeleteProvisionedConcurrencyConfig` — `DELETE /2019-09-30/functions/{name}/provisioned-concurrency?Qualifier=...`

### Function URLs
- `CreateFunctionUrlConfig` — `POST /2021-10-31/functions/{name}/url`
- `GetFunctionUrlConfig` — `GET /2021-10-31/functions/{name}/url`
- `UpdateFunctionUrlConfig` — `PUT /2021-10-31/functions/{name}/url`
- `DeleteFunctionUrlConfig` — `DELETE /2021-10-31/functions/{name}/url`
- `ListFunctionUrlConfigs` — `GET /2021-10-31/functions/{name}/urls`

### Event source mappings
- `CreateEventSourceMapping` — `POST /2015-03-31/event-source-mappings`
- `GetEventSourceMapping` — `GET /2015-03-31/event-source-mappings/{uuid}`
- `ListEventSourceMappings` — `GET /2015-03-31/event-source-mappings` (filterable by `FunctionName` / `EventSourceArn`)
- `UpdateEventSourceMapping` — `PUT /2015-03-31/event-source-mappings/{uuid}`
- `DeleteEventSourceMapping` — `DELETE /2015-03-31/event-source-mappings/{uuid}`

### Layers
- `PublishLayerVersion` — `POST /2018-10-31/layers/{name}/versions`
- `ListLayers` — `GET /2018-10-31/layers`
- `ListLayerVersions` — `GET /2018-10-31/layers/{name}/versions`
- `GetLayerVersion` — `GET /2018-10-31/layers/{name}/versions/{version}`
- `DeleteLayerVersion` — `DELETE /2018-10-31/layers/{name}/versions/{version}`

### Async invoke config (retry/destinations)
- `PutFunctionEventInvokeConfig` — `PUT /2019-09-25/functions/{name}/event-invoke-config`
- `UpdateFunctionEventInvokeConfig` — `POST /2019-09-25/functions/{name}/event-invoke-config`
- `GetFunctionEventInvokeConfig` — `GET /2019-09-25/functions/{name}/event-invoke-config`
- `ListFunctionEventInvokeConfigs` — `GET /2019-09-25/functions/{name}/event-invoke-config/list`
- `DeleteFunctionEventInvokeConfig` — `DELETE /2019-09-25/functions/{name}/event-invoke-config`

### Misc config
- `PutFunctionRecursionConfig` — `PUT /2024-08-31/functions/{name}/recursion-config`
- `GetFunctionRecursionConfig` — `GET /2024-08-31/functions/{name}/recursion-config`
- `PutRuntimeManagementConfig` — `PUT /2021-07-20/functions/{name}/runtime-management-config`
- `GetRuntimeManagementConfig` — `GET /2021-07-20/functions/{name}/runtime-management-config`

### Account
- `GetAccountSettings` — `GET /2016-08-19/account-settings`

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
|---------|-----------|-------|
| Function CRUD + configuration | ✅ | Full lifecycle, validation, revision IDs |
| Real handler execution | ✅ | Node.js handler source executed in-process (async + callback styles) |
| Invoke (`RequestResponse` / `Event` / `DryRun`) | ✅ | Real payloads, `FunctionError`, `ExecutedVersion`, tailed logs |
| Versions & aliases | ✅ | Immutable version snapshots; alias routing for `Invoke` |
| Resource policy (Add/Remove/GetPolicy) | ✅ | Statement store; JSON policy document |
| Tags | ✅ | Create-time + `TagResource`/`UntagResource`/`ListTags` |
| Reserved & provisioned concurrency | ✅ | In-memory; provisioned requires a qualifier |
| Function URLs | ✅ | One config per function |
| `restJson1` error envelope | ✅ | Canonical `{ "__type", "message" }` body + `x-amzn-errortype` header |
| Async invoke config / recursion / runtime mgmt | ✅ | Config stored and returned |
| `GetAccountSettings` | ✅ | Static limits + live usage counts |
| Event source mappings | ◐ | Config stored/returned; **no polling/trigger delivery**; `State` resolves straight to `Enabled` |
| Layers | ◐ | Publish/list/get/delete metadata; content not attached to the runtime |
| Function lifecycle `State` (`Pending`→`Active`) | ✓ | Returns `Active` immediately — waiter-safe (`waitUntilFunctionActiveV2` treats `Active` as success) |
| `ListFunctions` field subset | ✓ | Returns the full configuration; real API omits `State`/`StateReason` from list results (extra fields are additive) |
| Code Signing configs | ⟳ Roadmap |
| `InvokeWithResponseStream` | ⟳ Roadmap |
| Real IAM / SigV4 auth enforcement | ⟳ Roadmap — credentials accepted, signature not verified |
| VPC / EFS / X-Ray side effects | ⟳ Roadmap |
| Cold starts / real timeouts / throttling | ⟳ Roadmap |

Event source mappings and layers are stored and returned faithfully, but the fake does **not** poll event sources or attach layer code to the runtime — they exist so configuration-driven application code works unchanged.

## Error codes / shapes

Errors use the `restJson1` shape. The error code is carried in the `x-amzn-errortype` response header (which the SDK reads first) and in the JSON body via the `__type` discriminator and a lowercase `message` — byte-identical to the real Lambda API (no capital-`Message` key):

```json
{ "__type": "ResourceNotFoundException", "message": "Function not found: arn:aws:lambda:..." }
```

| Error code | HTTP status | When |
|------------|-------------|------|
| `ResourceNotFoundException` | 404 | Function/alias/version/mapping/policy/config/layer not found |
| `ProvisionedConcurrencyConfigNotFoundException` | 404 | No provisioned concurrency config for the qualifier |
| `ResourceConflictException` | 409 | Duplicate function name, alias, statement id, or function URL |
| `InvalidParameterValueException` | 400 | Bad name, runtime, memory size, timeout, missing required input, or `UpdateFunctionCode` with no code source |
| `InvalidRequestContentException` | 400 | Request body is not valid JSON |
| `PreconditionFailedException` | 412 | `CodeSha256` / `RevisionId` mismatch on `PublishVersion` |
| `ValidationException` | 400 | Invalid enum value (e.g. recursion config) |
| `ServiceException` | 500 | Unexpected internal error |

The `Invoke` operation is special: a handler that throws is **not** a transport error. It returns HTTP `200` with the header `X-Amz-Function-Error: Unhandled` and a JSON error payload in the body.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_LAMBDA=http://localhost:4571
AWS_ENDPOINT_URL=http://localhost:4571
```

<!-- parlel:testenv:end -->
