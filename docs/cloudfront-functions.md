# cloudfront-functions — CloudFront Functions & KeyValueStore

A zero-dependency, in-process emulator for the AWS CloudFront Functions control
plane and CloudFront KeyValueStore (with a simple data-plane key/value API).

| Property    | Value                 |
| ----------- | --------------------- |
| Port        | 4713                  |
| Protocol    | REST / XML (+ JSON data plane) |
| API Version | 2020-05-31            |
| Health      | `GET /_parlel/health` |
| Reset       | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4713
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation             | Path                                              |
| --------------------- | ------------------------------------------------- |
| CreateFunction        | `POST /2020-05-31/function`                       |
| ListFunctions         | `GET /2020-05-31/function`                         |
| DescribeFunction      | `GET /2020-05-31/function/{name}`                  |
| PublishFunction       | `POST /2020-05-31/function/{name}/publish`         |
| TestFunction          | `POST /2020-05-31/test-function`                   |
| DeleteFunction        | `DELETE /2020-05-31/function/{name}`               |
| CreateKeyValueStore   | `POST /2020-05-31/key-value-store`                 |
| ListKeyValueStores    | `GET /2020-05-31/key-value-store`                  |

### KeyValueStore data plane (parlel extension)

| Operation | Path                                              |
| --------- | ------------------------------------------------- |
| PutKey    | `PUT /2020-05-31/key-value-store/{name}/keys/{k}` |
| GetKey    | `GET /2020-05-31/key-value-store/{name}/keys/{k}` |
| DeleteKey | `DELETE /2020-05-31/key-value-store/{name}/keys/{k}` |
| ListKeys  | `GET /2020-05-31/key-value-store/{name}/keys`     |

`TestFunction` actually executes the function code with a synthetic event,
returning `FunctionOutput`, so you can validate handler logic.

## SDK usage example

```ts
import {
  CloudFrontClient,
  CreateFunctionCommand,
  TestFunctionCommand,
} from "@aws-sdk/client-cloudfront";

const cf = new CloudFrontClient({
  endpoint: "http://127.0.0.1:4713",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await cf.send(
  new CreateFunctionCommand({
    Name: "redirect",
    FunctionConfig: { Comment: "", Runtime: "cloudfront-js-2.0" },
    FunctionCode: Buffer.from(
      "function handler(event){ event.request.uri='/index.html'; return event.request; }",
    ),
  }),
);
```

## Access via MCP / preview URL

Point any AWS SDK or MCP tool at the allocated preview URL via
`AWS_ENDPOINT_URL`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                       |
| ----------------- | ------------------------------------------------ |
| Runtime           | `TestFunction` uses `node:Function`, not the real CF runtime |
| UpdateFunction    | Not implemented                                  |
| ETag concurrency  | ETag returned but not enforced on update/publish |
| Associations      | Function-to-distribution associations not tracked|
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4713
```

<!-- parlel:testenv:end -->
