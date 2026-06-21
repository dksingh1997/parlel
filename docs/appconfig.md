# appconfig (parlel)

A zero-dependency, in-process fake of AWS AppConfig. Speaks the AppConfig
REST/JSON API.

| Field | Value |
| --- | --- |
| Service | `appconfig` |
| Port | `4739` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4739
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| CreateApplication | `POST /applications` |
| ListApplications | `GET /applications` |
| GetApplication | `GET /applications/{id}` |
| CreateEnvironment | `POST /applications/{id}/environments` |
| ListEnvironments | `GET /applications/{id}/environments` |
| CreateConfigurationProfile | `POST /applications/{id}/configurationprofiles` |
| ListConfigurationProfiles | `GET /applications/{id}/configurationprofiles` |
| StartDeployment | `POST /applications/{id}/environments/{envId}/deployments` |
| (helper) ListDeployments | `GET /applications/{id}/environments/{envId}/deployments` |

Deployments complete synchronously (`State: COMPLETE`, 100%).

## SDK example

```js
import { AppConfigClient, CreateApplicationCommand } from "@aws-sdk/client-appconfig";

const ac = new AppConfigClient({
  endpoint: "http://127.0.0.1:4739",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const app = await ac.send(new CreateApplicationCommand({ Name: "my-app" }));
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Deployment strategies | Strategy IDs accepted but not enforced (no bake/rollout time). |
| Configuration data | `GetConfiguration`/`GetLatestConfiguration` not implemented. |
| Validators | Stored but never executed. |
| Pagination | `Items` returned in full, no `NextToken`. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4739
```

<!-- parlel:testenv:end -->
