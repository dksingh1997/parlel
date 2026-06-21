# parlel/iam

A zero-dependency, in-process fake of **AWS IAM** (Identity & Access Management).
Speaks the AWS Query/XML wire protocol (API version `2010-05-08`) so the real
`@aws-sdk/client-iam` client works unmodified.

| Property     | Value                          |
| ------------ | ------------------------------ |
| Service name | `iam`                          |
| Port         | `4575`                         |
| Protocol     | AWS Query (form POST `/`, XML) |
| API version  | `2010-05-08`                   |
| Healthcheck  | `GET /_parlel/health`          |
| Account ID   | `000000000000`                 |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4575
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted.

## Supported operations

| Category          | Operations                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Users             | CreateUser, GetUser, ListUsers, DeleteUser, UpdateUser                                                 |
| Roles             | CreateRole, GetRole, ListRoles, DeleteRole                                                             |
| Managed policies  | CreatePolicy, GetPolicy, ListPolicies, DeletePolicy, CreatePolicyVersion                               |
| Attach/detach     | AttachUserPolicy, AttachRolePolicy, DetachUserPolicy, DetachRolePolicy, ListAttachedUserPolicies, ListAttachedRolePolicies |
| Inline policies   | PutUserPolicy, GetUserPolicy, PutRolePolicy, GetRolePolicy, ListUserPolicies, ListRolePolicies         |
| Access keys       | CreateAccessKey, ListAccessKeys, DeleteAccessKey, UpdateAccessKey                                      |
| Instance profiles | CreateInstanceProfile, GetInstanceProfile, ListInstanceProfiles, AddRoleToInstanceProfile              |
| Groups            | CreateGroup, GetGroup, ListGroups, DeleteGroup, AddUserToGroup, RemoveUserFromGroup                    |
| Tags              | TagRole, TagUser, ListRoleTags, ListUserTags, UntagRole, UntagUser                                     |

ARNs follow the real AWS shape (`arn:aws:iam::000000000000:user/<name>`,
`.../role/<name>`, `.../policy/<name>`). Unique IDs are generated with the
correct prefixes (`AIDA...` users, `AROA...` roles, `AKIA...` access keys,
`ANPA...` policies, `AGPA...` groups, `AIPA...` instance profiles).

## SDK example

```js
import { IAMClient, CreateUserCommand, CreateAccessKeyCommand } from "@aws-sdk/client-iam";

const iam = new IAMClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4575",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await iam.send(new CreateUserCommand({ UserName: "alice" }));
const key = await iam.send(new CreateAccessKeyCommand({ UserName: "alice" }));
console.log(key.AccessKey.AccessKeyId); // AKIA...
```

## Access via MCP / preview URL

When run inside parlel, the IAM emulator is reachable through the pool's MCP
bridge and any assigned preview URL. Point `AWS_ENDPOINT_URL` (or
`AWS_ENDPOINT_URL_IAM`) at the preview URL to drive it from an agent or remote
client.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                                          |
| ----------------- | ------------------------------------------------------------------- |
| Authorization     | Policies are stored but never evaluated; all requests are allowed.  |
| State             | In-memory and ephemeral; cleared on `reset()` / `POST /_parlel/reset`. |
| Pagination        | Single-page responses (`IsTruncated=false`); no `Marker` paging.    |
| MFA / credentials | Login profiles, MFA devices, SSH keys, and SAML are not modeled.    |
| Policy versions   | Versions stored but document validation is not enforced.            |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_IAM=http://localhost:4575
AWS_ENDPOINT_URL=http://localhost:4575
```

<!-- parlel:testenv:end -->
