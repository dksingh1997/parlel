# amazonmq (parlel)

A zero-dependency, in-process fake of AWS Amazon MQ (managed RabbitMQ /
ActiveMQ). Speaks the Amazon MQ REST/JSON API.

| Field | Value |
| --- | --- |
| Service | `amazonmq` |
| Port | `4738` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4738
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted.

## Implemented operations

| Operation | HTTP |
| --- | --- |
| CreateBroker | `POST /v1/brokers` |
| ListBrokers | `GET /v1/brokers` |
| DescribeBroker | `GET /v1/brokers/{id}` |
| UpdateBroker | `PUT /v1/brokers/{id}` |
| DeleteBroker | `DELETE /v1/brokers/{id}` |
| RebootBroker | `POST /v1/brokers/{id}/reboot` |
| CreateUser | `POST /v1/brokers/{id}/users/{username}` |
| DescribeUser | `GET /v1/brokers/{id}/users/{username}` |
| UpdateUser | `PUT /v1/brokers/{id}/users/{username}` |
| DeleteUser | `DELETE /v1/brokers/{id}/users/{username}` |
| ListUsers | `GET /v1/brokers/{id}/users` |
| CreateConfiguration | `POST /v1/configurations` |
| ListConfigurations | `GET /v1/configurations` |
| DescribeConfiguration | `GET /v1/configurations/{id}` |
| UpdateConfiguration | `PUT /v1/configurations/{id}` |
| DeleteConfiguration | `DELETE /v1/configurations/{id}` |

Engine metadata is returned for both `RABBITMQ` and `ACTIVEMQ`. New brokers
come up `RUNNING` immediately with a synthetic AMQPS endpoint and console URL.

## SDK example

```js
import { MqClient, CreateBrokerCommand } from "@aws-sdk/client-mq";

const mq = new MqClient({
  endpoint: "http://127.0.0.1:4738",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await mq.send(new CreateBrokerCommand({
  brokerName: "broker1",
  engineType: "RABBITMQ",
  deploymentMode: "SINGLE_INSTANCE",
  hostInstanceType: "mq.t3.micro",
  publiclyAccessible: false,
  users: [{ username: "admin", password: "secret9chars" }],
  autoMinorVersionUpgrade: true,
}));
```

## Access via MCP / preview URL

Under the parlel pool, this service is reachable through the MCP gateway and the
pool's preview URL. Issue the same HTTP requests against the preview host.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Messaging | ✓ No real AMQP/STOMP/MQTT broker is started; endpoints are synthetic. |
| Provisioning | ✓ Brokers are immediately RUNNING (no async create). |
| Configurations | ✓ Single revision; no XML config validation. Update stores data but doesn't parse it. |
| Users | ◐ Stored on the broker; no password policy enforcement (12+ char check skipped). |
| Encryption | ✓ encryptionOptions stored but no real KMS integration. |
| Logs | ✓ logs config stored but no real CloudWatch log groups created. |
| Storage | ✓ storageType stored but no real EBS/EFS provisioning. |
| Reboot | ✓ RebootBroker is a no-op; broker stays RUNNING. |
| Tags | ✅ Tags stored and returned on describe. |
| Pagination | ✅ ListBrokers and ListUsers support maxResults/nextToken. |

## Error codes & shapes

Errors follow the AWS JSON error envelope with `x-amzn-errortype` header:

```json
{
  "__type": "BadRequestException",
  "errorAttribute": "",
  "message": "brokerName is required."
}
```

| Code | HTTP Status | When |
| --- | --- | --- |
| BadRequestException | 400 | Missing required fields, invalid JSON body |
| NotFoundException | 404 | Broker/configuration/user not found, unknown path |
| ConflictException | 409 | Duplicate broker name or username |
| InternalServerErrorException | 500 | Unexpected server error |

## Manifest

```json
{
  "name": "amazonmq",
  "version": "0.1",
  "port": 4738,
  "protocol": "http",
  "healthcheck": "/_parlel/health",
  "startup_time_ms": 100,
  "env_vars": {
    "AWS_ACCESS_KEY_ID": "parlel",
    "AWS_SECRET_ACCESS_KEY": "parlel",
    "AWS_REGION": "us-east-1",
    "AWS_ENDPOINT_URL": "http://127.0.0.1:4738"
  }
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4738
```

<!-- parlel:testenv:end -->
