# parlel/organizations

A zero-dependency, in-process fake of **AWS Organizations**.
Speaks AWS JSON 1.1 (`X-Amz-Target: AWSOrganizationsV20161128.<Op>`).

| Property     | Value                                    |
| ------------ | ---------------------------------------- |
| Service name | `organizations`                          |
| Port         | `4733`                                   |
| Protocol     | AWS JSON 1.1 (POST `/`)                  |
| Target       | `AWSOrganizationsV20161128.<Operation>`  |
| Healthcheck  | `GET /_parlel/health`                    |
| Account ID   | `000000000000`                           |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4733
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Category      | Operations                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Organization  | CreateOrganization, DescribeOrganization, DeleteOrganization, ListRoots                         |
| Accounts      | ListAccounts, CreateAccount, DescribeCreateAccountStatus, DescribeAccount                       |
| OUs           | CreateOrganizationalUnit, DescribeOrganizationalUnit, ListOrganizationalUnitsForParent, DeleteOrganizationalUnit |
| Policies      | CreatePolicy, DescribePolicy, ListPolicies, DeletePolicy, AttachPolicy, DetachPolicy, ListPoliciesForTarget |

`CreateOrganization` seeds the management account (`000000000000`) and a root.
`CreateAccount` returns a `SUCCEEDED` `CreateAccountStatus` immediately.

## SDK example

```js
import {
  OrganizationsClient,
  CreateOrganizationCommand,
  CreateAccountCommand,
  ListAccountsCommand,
} from "@aws-sdk/client-organizations";

const org = new OrganizationsClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4733",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await org.send(new CreateOrganizationCommand({ FeatureSet: "ALL" }));
await org.send(new CreateAccountCommand({ AccountName: "dev", Email: "dev@example.com" }));
const { Accounts } = await org.send(new ListAccountsCommand({}));
console.log(Accounts.length); // 2
```

## Access via MCP / preview URL

When run inside parlel, Organizations is reachable through the pool's MCP bridge
and any assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area             | Limitation                                                       |
| ---------------- | ---------------------------------------------------------------- |
| Account creation | Synchronous and always succeeds; no async provisioning.          |
| SCP enforcement  | Policies are stored/attached but never evaluated.                |
| Handshakes       | Invitations and account move/remove flows are not implemented.   |
| State            | In memory, cleared on reset.                                     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4733
```

<!-- parlel:testenv:end -->
