# transfer-family — AWS Transfer Family

A zero-dependency, in-process emulator for AWS Transfer Family
(SFTP/FTPS/FTP servers and their users).

| Property      | Value                 |
| ------------- | --------------------- |
| Port          | 4718                  |
| Protocol      | AWS JSON 1.1          |
| Target prefix | `TransferService`     |
| Health        | `GET /_parlel/health` |
| Reset         | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4718
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation      | Notes                                    |
| -------------- | ---------------------------------------- |
| CreateServer   | Returns a `s-...` ServerId, State ONLINE |
| ListServers    |                                          |
| DescribeServer |                                          |
| DeleteServer   |                                          |
| StartServer    | Sets State ONLINE                        |
| StopServer     | Sets State OFFLINE                       |
| CreateUser     |                                          |
| ListUsers      |                                          |
| DescribeUser   |                                          |
| DeleteUser     |                                          |

## SDK usage example

```ts
import {
  TransferClient,
  CreateServerCommand,
  CreateUserCommand,
} from "@aws-sdk/client-transfer";

const transfer = new TransferClient({
  endpoint: "http://127.0.0.1:4718",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

const { ServerId } = await transfer.send(
  new CreateServerCommand({ Protocols: ["SFTP"], Domain: "S3" }),
);

await transfer.send(
  new CreateUserCommand({
    ServerId,
    UserName: "alice",
    Role: "arn:aws:iam::000000000000:role/transfer",
    HomeDirectory: "/bucket/alice",
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
| File transfer     | No actual SFTP/FTP endpoint or transfers         |
| Authentication    | Identity provider is metadata only               |
| Workflows         | Not implemented                                  |
| Update operations | Update operations are not implemented            |
| State             | In-memory only; lost on restart                  |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4718
```

<!-- parlel:testenv:end -->
