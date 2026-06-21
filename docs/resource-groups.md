# parlel/resource-groups

A zero-dependency, in-process fake of **AWS Resource Groups**.
Speaks the REST/JSON wire protocol used by `@aws-sdk/client-resource-groups`.

| Property     | Value                          |
| ------------ | ------------------------------ |
| Service name | `resource-groups`             |
| Port         | `4736`                         |
| Protocol     | REST/JSON                      |
| Healthcheck  | `GET /_parlel/health`          |
| Account ID   | `000000000000`                 |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4736
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation          | Path                              |
| ------------------ | --------------------------------- |
| CreateGroup        | `POST /groups`                    |
| ListGroups         | `GET /groups` (or `POST /groups/list`) |
| GetGroup           | `GET /groups/{name}`              |
| DeleteGroup        | `DELETE /groups/{name}`           |
| SearchResources    | `POST /resources/search`          |
| ListGroupResources | `GET /groups/{name}/resources`    |
| Tag                | `PUT /resources/{arn}/tags`       |
| GetTags            | `GET /resources/{arn}/tags`       |

## SDK example

```js
import {
  ResourceGroupsClient,
  CreateGroupCommand,
  GetGroupCommand,
} from "@aws-sdk/client-resource-groups";

const rg = new ResourceGroupsClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4736",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await rg.send(
  new CreateGroupCommand({
    Name: "prod-resources",
    ResourceQuery: {
      Type: "TAG_FILTERS_1_0",
      Query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "env", Values: ["prod"] }] }),
    },
  }),
);
const { Group } = await rg.send(new GetGroupCommand({ GroupName: "prod-resources" }));
console.log(Group.GroupArn);
```

## Access via MCP / preview URL

When run inside parlel, Resource Groups is reachable through the pool's MCP
bridge and any assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area            | Limitation                                                       |
| --------------- | ---------------------------------------------------------------- |
| SearchResources | Returns a small synthetic resource set, not real query results.  |
| Resources       | `ListGroupResources` reflects only explicitly attached ARNs.     |
| Tagging         | Tagging is supported for group ARNs only.                        |
| State           | In memory, cleared on reset.                                     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4736
```

<!-- parlel:testenv:end -->
