# DynamoDB (parlel emulator)

A zero-dependency, in-process fake of Amazon DynamoDB. Speaks the AWS JSON 1.0
wire protocol so the real `@aws-sdk/client-dynamodb` works unmodified.

| Property    | Value                          |
| ----------- | ------------------------------ |
| Port        | 4567                           |
| Protocol    | AWS JSON 1.0 (`X-Amz-Target: DynamoDB_20120810.<Op>`) |
| Healthcheck | `GET /_parlel/health`          |
| Reset       | `POST /_parlel/reset`          |

## Quick start

```
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://127.0.0.1:4567
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

Any credentials are accepted (the AWS SDK always signs requests, so well-behaved
client code never hits an auth error; SigV4 signatures are not validated).

```ts
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";

const db = new DynamoDBClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4567",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await db.send(new PutItemCommand({
  TableName: "Users",
  Item: { pk: { S: "u1" }, sk: { S: "profile" }, name: { S: "Alice" } },
}));

const { Item } = await db.send(new GetItemCommand({
  TableName: "Users",
  Key: { pk: { S: "u1" }, sk: { S: "profile" } },
}));
```

## Implemented operations

- Tables: `CreateTable`, `DescribeTable`, `ListTables`, `DeleteTable`, `UpdateTable`
- Items: `PutItem`, `GetItem`, `DeleteItem`, `UpdateItem`
- Reads: `Query`, `Scan`
- Batch: `BatchWriteItem`, `BatchGetItem`
- Transactions: `TransactWriteItems`, `TransactGetItems`
- Tagging: `TagResource`, `UntagResource`, `ListTagsOfResource`
- TTL: `UpdateTimeToLive`, `DescribeTimeToLive`
- Misc: `DescribeLimits`, `DescribeEndpoints`

### Expressions

Supports the typed attribute-value format (`S`, `N`, `B`, `BOOL`, `NULL`, `L`,
`M`, `SS`, `NS`, `BS`), `KeyConditionExpression`, `FilterExpression`,
`ConditionExpression`, `UpdateExpression` (`SET`/`ADD`/`REMOVE`/`DELETE`,
`if_not_exists`, arithmetic), `ExpressionAttributeNames` / `Values`, and the
operators `=`, `<>`, `<`, `>`, `<=`, `>=`, `begins_with`, `between`, `AND`,
`OR`, `NOT`, `attribute_exists`, `attribute_not_exists`, `contains`, `size`.

## Access via MCP / preview URL

When run inside a parlel pool, the service is reachable through the pool's MCP
bridge and preview URL. Point any DynamoDB SDK at the advertised endpoint; no
auth setup is required.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area              | Status | Note                                                    |
| ----------------- | ------ | ------------------------------------------------------- |
| Tables CRUD       | ✅     | Create/Describe/List/Delete/Update behave correctly.    |
| Item CRUD         | ✅     | Put/Get/Update/Delete incl. conditions & ReturnValues.  |
| Query / Scan      | ✅     | KeyCondition, FilterExpression, pagination, sort order.  |
| Batch / Transact  | ✅     | Missing-table → ResourceNotFoundException; ordered cancel reasons. |
| Expressions       | ✅     | SET/ADD/REMOVE/DELETE, if_not_exists, arithmetic, funcs. |
| Error envelope    | ✅     | AWS JSON 1.0 `__type` + lowercase `message`, HTTP 400.  |
| Capacity          | ◐     | Provisioned throughput is recorded but never enforced.  |
| Indexes           | ◐     | GSI/LSI metadata is stored; queries scan the base table.|
| TTL               | ◐     | Expiry attribute stored but items are not auto-expired. |
| Streams           | ✓     | Stream specification stored; see the `dynamodb-streams` service. |
| Nested paths      | ✓     | Deep document-path updates/filters are best-effort.     |
| SigV4 auth        | ✓     | Any credentials accepted; signatures are not validated. |
| Table status      | ✓     | `CreateTable` returns `ACTIVE` immediately (no async `CREATING` wait). |
| Auto-scaling      | ⟳     | Not modeled.                                            |

## Error codes & shapes

Errors use the AWS JSON 1.0 envelope and HTTP 400 (client) / 500 (server),
matching the real DynamoDB `2012-08-10` endpoint:

```json
{ "__type": "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
  "message": "Cannot do operations on a non-existent table" }
```

The `__type` carries the full `com.amazonaws.dynamodb.v20120810#` shape-id
prefix and the body uses a lowercase `message` field. The `x-amzn-errortype`
response header echoes the exception name.

| Scenario | Status | `__type` | `message` |
| --- | --- | --- | --- |
| Data-plane op (Get/Put/Update/Delete/Query/Scan/Batch/Transact) on a missing table | 400 | `ResourceNotFoundException` | `Cannot do operations on a non-existent table` |
| Control-plane op (Describe/Delete/UpdateTable, TimeToLive) on a missing table | 400 | `ResourceNotFoundException` | `Requested resource not found: Table: <name> not found` |
| `CreateTable` on an existing name | 400 | `ResourceInUseException` | `Table already exists: <name>` |
| Missing key attribute in `Item`/`Key` | 400 | `ValidationException` | `One of the required keys was not given a value: <key>` |
| Failed `ConditionExpression` (Put/Update/Delete) | 400 | `ConditionalCheckFailedException` | `The conditional request failed` |
| Failed transaction condition | 400 | `TransactionCanceledException` | includes request-ordered `CancellationReasons` (`{"Code":"None"}` / `{"Code":"ConditionalCheckFailed","Message":"The conditional request failed"}`) |
| Unknown / missing `X-Amz-Target` operation | 400 | `com.amazon.coral.service#UnknownOperationException` | `Unknown operation: <op>` |

## Manifest

```json
{
  "name": "dynamodb",
  "port": 4567,
  "protocol": "http",
  "healthcheck": "/_parlel/health",
  "env_vars": {
    "AWS_ACCESS_KEY_ID": "parlel",
    "AWS_SECRET_ACCESS_KEY": "parlel",
    "AWS_REGION": "us-east-1",
    "AWS_ENDPOINT_URL_DYNAMODB": "http://127.0.0.1:4567"
  }
}
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:4567
```

<!-- parlel:testenv:end -->
