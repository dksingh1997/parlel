# cloud-map — AWS Cloud Map (Service Discovery)

A zero-dependency, in-process emulator for AWS Cloud Map (Route 53 Auto Naming):
namespaces, services, and instances with service discovery.

| Property      | Value                           |
| ------------- | ------------------------------- |
| Port          | 4717                            |
| Protocol      | AWS JSON 1.1                    |
| Target prefix | `Route53AutoNaming_v20170314`  |
| Health        | `GET /_parlel/health`          |
| Reset         | `POST /_parlel/reset`          |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4717
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation                   | Notes                                  |
| --------------------------- | -------------------------------------- |
| CreateHttpNamespace         | Returns `OperationId`                  |
| CreatePrivateDnsNamespace   | Returns `OperationId`                  |
| CreatePublicDnsNamespace    | Returns `OperationId`                  |
| ListNamespaces              |                                        |
| GetNamespace                |                                        |
| DeleteNamespace             | Fails if it still contains services    |
| CreateService               |                                        |
| ListServices                | Filter by `NAMESPACE_ID`               |
| GetService                  |                                        |
| DeleteService               | Fails if it still contains instances   |
| RegisterInstance            | Returns `OperationId`                  |
| DeregisterInstance          | Returns `OperationId`                  |
| GetInstance                 |                                        |
| ListInstances               |                                        |
| DiscoverInstances           | Filtered by `QueryParameters`          |
| GetOperation                | Always `SUCCESS`                       |

## SDK usage example

```ts
import {
  ServiceDiscoveryClient,
  CreateHttpNamespaceCommand,
  DiscoverInstancesCommand,
} from "@aws-sdk/client-servicediscovery";

const sd = new ServiceDiscoveryClient({
  endpoint: "http://127.0.0.1:4717",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await sd.send(new CreateHttpNamespaceCommand({ Name: "my-ns" }));
```

## Access via MCP / preview URL

Point any AWS SDK or MCP tool at the allocated preview URL via
`AWS_ENDPOINT_URL`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                       |
| ----------------- | ------------------------------------------------ |
| DNS resolution    | No actual DNS records are created or resolved    |
| Health checks     | Instances are always reported `HEALTHY`          |
| Operations        | All operations complete instantly with `SUCCESS` |
| Update operations | Update operations are not implemented            |
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4717
```

<!-- parlel:testenv:end -->
