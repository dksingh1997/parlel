# parlel/cognito

A zero-dependency, in-process fake of **AWS Cognito** — both the Identity
Provider (user pools) and Identity (federated identities) services. Speaks AWS
JSON 1.1 and serves OIDC discovery + JWKS.

| Property     | Value                                                       |
| ------------ | ----------------------------------------------------------- |
| Service name | `cognito`                                                   |
| Port         | `4732`                                                      |
| Protocol     | AWS JSON 1.1 (POST `/`) + REST JWKS/OIDC (GET)              |
| Targets      | `AWSCognitoIdentityProviderService.<Op>`, `AWSCognitoIdentityService.<Op>` |
| Healthcheck  | `GET /_parlel/health`                                       |
| Account ID   | `000000000000`                                              |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4732
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Service          | Operations                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Identity Provider| CreateUserPool, ListUserPools, DescribeUserPool, DeleteUserPool, CreateUserPoolClient, AdminCreateUser, SignUp, ConfirmSignUp, AdminInitiateAuth, InitiateAuth, GetUser, AdminGetUser, ListUsers |
| Identity (pools) | CreateIdentityPool, DescribeIdentityPool, ListIdentityPools, DeleteIdentityPool, GetId, GetCredentialsForIdentity |

### JWT tokens + JWKS

Auth flows (`InitiateAuth` / `AdminInitiateAuth`) return real JWT-shaped
`IdToken` and `AccessToken` values signed with an RSA-2048 key (RS256). The
matching public key is published at:

```
GET /<userPoolId>/.well-known/jwks.json
GET /<userPoolId>/.well-known/openid-configuration
```

## SDK example

```js
import {
  CognitoIdentityProviderClient,
  CreateUserPoolCommand,
  CreateUserPoolClientCommand,
  SignUpCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const idp = new CognitoIdentityProviderClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4732",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { UserPool } = await idp.send(new CreateUserPoolCommand({ PoolName: "demo" }));
const { UserPoolClient } = await idp.send(
  new CreateUserPoolClientCommand({ UserPoolId: UserPool.Id, ClientName: "web" }),
);
await idp.send(new SignUpCommand({ ClientId: UserPoolClient.ClientId, Username: "bob", Password: "Passw0rd!" }));
const auth = await idp.send(
  new InitiateAuthCommand({
    ClientId: UserPoolClient.ClientId,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: "bob", PASSWORD: "Passw0rd!" },
  }),
);
console.log(auth.AuthenticationResult.IdToken);
```

## Access via MCP / preview URL

When run inside parlel, Cognito is reachable through the pool's MCP bridge and
any assigned preview URL. Point `AWS_ENDPOINT_URL` at the preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Limitation                                                       |
| ----------------- | ---------------------------------------------------------------- |
| Password policy   | Policies are stored but not enforced.                            |
| MFA / triggers    | MFA, Lambda triggers, and challenges are not modeled.            |
| Token validation  | Tokens are signed but the server does not verify them on input.  |
| Confirmation code | `ConfirmSignUp` accepts any code.                                |
| Hosted UI         | OAuth2 endpoints are advertised in OIDC config but not served.   |
| State             | In memory, cleared on reset.                                     |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4732
```

<!-- parlel:testenv:end -->
