import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  DeleteTableCommand,
  UpdateTableCommand,
  PutItemCommand,
  GetItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteItemCommand,
  BatchGetItemCommand,
  TransactWriteItemsCommand,
  TransactGetItemsCommand,
  TagResourceCommand,
  ListTagsOfResourceCommand,
  UpdateTimeToLiveCommand,
  DescribeTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamodbServer } from "../services/dynamodb/src/server.js";

const PORT = 14567;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new DynamoDBClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
  });
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected error ${code} but call succeeded`);
  } catch (err: any) {
    const name = err?.name || err?.Code || err?.code || "";
    const combined = `${name} ${err?.message || ""}`;
    expect(combined).toContain(code);
    return err;
  }
}

async function createUsersTable(db: DynamoDBClient, name = "Users") {
  return db.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
}

describe("DynamoDB Service", () => {
  let server: DynamodbServer;
  let db: DynamoDBClient;

  beforeAll(async () => {
    server = new DynamodbServer(PORT);
    await server.start();
    db = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    db.destroy();
    await server.stop();
  });

  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("defaults to port 4567", () => {
      expect(new DynamodbServer().port).toBe(4567);
    });

    it("health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(json.service).toBe("dynamodb");
    });

    it("POST /_parlel/reset", async () => {
      await createUsersTable(db);
      const r = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect((await r.json()).ok).toBe(true);
      expect(server.tables.size).toBe(0);
    });
  });

  describe("table ops", () => {
    it("CreateTable + DescribeTable", async () => {
      const c = await createUsersTable(db);
      expect(c.TableDescription?.TableName).toBe("Users");
      expect(c.TableDescription?.TableStatus).toBe("ACTIVE");
      expect(c.TableDescription?.TableArn).toContain("table/Users");

      const d = await db.send(new DescribeTableCommand({ TableName: "Users" }));
      expect(d.Table?.KeySchema).toHaveLength(2);
      expect(d.Table?.BillingModeSummary?.BillingMode).toBe("PAY_PER_REQUEST");
    });

    it("ListTables", async () => {
      await createUsersTable(db, "A");
      await createUsersTable(db, "B");
      const l = await db.send(new ListTablesCommand({}));
      expect(l.TableNames).toContain("A");
      expect(l.TableNames).toContain("B");
    });

    it("DeleteTable", async () => {
      await createUsersTable(db);
      const del = await db.send(new DeleteTableCommand({ TableName: "Users" }));
      expect(del.TableDescription?.TableStatus).toBe("DELETING");
      const l = await db.send(new ListTablesCommand({}));
      expect(l.TableNames).not.toContain("Users");
    });

    it("UpdateTable adjusts throughput", async () => {
      await createUsersTable(db);
      const u = await db.send(
        new UpdateTableCommand({
          TableName: "Users",
          ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 20 },
        }),
      );
      expect(u.TableDescription?.ProvisionedThroughput?.ReadCapacityUnits).toBe(10);
    });

    it("DescribeTable on missing table errors", async () => {
      await expectError(
        db.send(new DescribeTableCommand({ TableName: "Nope" })),
        "ResourceNotFoundException",
      );
    });

    it("CreateTable duplicate errors", async () => {
      await createUsersTable(db);
      await expectError(createUsersTable(db), "ResourceInUseException");
    });
  });

  describe("item ops", () => {
    beforeEach(async () => {
      await createUsersTable(db);
    });

    it("PutItem + GetItem round trip", async () => {
      await db.send(
        new PutItemCommand({
          TableName: "Users",
          Item: {
            pk: { S: "u1" },
            sk: { S: "profile" },
            name: { S: "Alice" },
            age: { N: "30" },
            active: { BOOL: true },
          },
        }),
      );
      const g = await db.send(
        new GetItemCommand({
          TableName: "Users",
          Key: { pk: { S: "u1" }, sk: { S: "profile" } },
        }),
      );
      expect(g.Item?.name?.S).toBe("Alice");
      expect(g.Item?.age?.N).toBe("30");
      expect(g.Item?.active?.BOOL).toBe(true);
    });

    it("GetItem missing returns no Item", async () => {
      const g = await db.send(
        new GetItemCommand({ TableName: "Users", Key: { pk: { S: "x" }, sk: { S: "y" } } }),
      );
      expect(g.Item).toBeUndefined();
    });

    it("DeleteItem removes item", async () => {
      await db.send(
        new PutItemCommand({ TableName: "Users", Item: { pk: { S: "u1" }, sk: { S: "p" } } }),
      );
      await db.send(
        new DeleteItemCommand({ TableName: "Users", Key: { pk: { S: "u1" }, sk: { S: "p" } } }),
      );
      const g = await db.send(
        new GetItemCommand({ TableName: "Users", Key: { pk: { S: "u1" }, sk: { S: "p" } } }),
      );
      expect(g.Item).toBeUndefined();
    });

    it("UpdateItem SET + ADD", async () => {
      await db.send(
        new PutItemCommand({
          TableName: "Users",
          Item: { pk: { S: "u1" }, sk: { S: "p" }, count: { N: "1" } },
        }),
      );
      const u = await db.send(
        new UpdateItemCommand({
          TableName: "Users",
          Key: { pk: { S: "u1" }, sk: { S: "p" } },
          UpdateExpression: "SET #n = :name ADD #c :inc",
          ExpressionAttributeNames: { "#n": "name", "#c": "count" },
          ExpressionAttributeValues: { ":name": { S: "Bob" }, ":inc": { N: "5" } },
          ReturnValues: "ALL_NEW",
        }),
      );
      expect(u.Attributes?.name?.S).toBe("Bob");
      expect(u.Attributes?.count?.N).toBe("6");
    });

    it("PutItem with attribute_not_exists condition fails on duplicate", async () => {
      await db.send(
        new PutItemCommand({ TableName: "Users", Item: { pk: { S: "u1" }, sk: { S: "p" } } }),
      );
      await expectError(
        db.send(
          new PutItemCommand({
            TableName: "Users",
            Item: { pk: { S: "u1" }, sk: { S: "p" } },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        ),
        "ConditionalCheckFailedException",
      );
    });
  });

  describe("query + scan", () => {
    beforeEach(async () => {
      await createUsersTable(db);
      for (const sk of ["order#1", "order#2", "profile"]) {
        await db.send(
          new PutItemCommand({
            TableName: "Users",
            Item: { pk: { S: "u1" }, sk: { S: sk }, amount: { N: "10" } },
          }),
        );
      }
      await db.send(
        new PutItemCommand({
          TableName: "Users",
          Item: { pk: { S: "u2" }, sk: { S: "profile" }, amount: { N: "99" } },
        }),
      );
    });

    it("Query by partition key", async () => {
      const q = await db.send(
        new QueryCommand({
          TableName: "Users",
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": { S: "u1" } },
        }),
      );
      expect(q.Count).toBe(3);
      expect(q.Items?.every((i) => i.pk.S === "u1")).toBe(true);
    });

    it("Query with begins_with on sort key", async () => {
      const q = await db.send(
        new QueryCommand({
          TableName: "Users",
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":pk": { S: "u1" }, ":p": { S: "order#" } },
        }),
      );
      expect(q.Count).toBe(2);
    });

    it("Scan with FilterExpression", async () => {
      const s = await db.send(
        new ScanCommand({
          TableName: "Users",
          FilterExpression: "amount > :v",
          ExpressionAttributeValues: { ":v": { N: "50" } },
        }),
      );
      expect(s.Count).toBe(1);
      expect(s.Items?.[0].pk.S).toBe("u2");
    });

    it("Scan returns all items", async () => {
      const s = await db.send(new ScanCommand({ TableName: "Users" }));
      expect(s.Count).toBe(4);
    });

    it("Query ScanIndexForward false reverses", async () => {
      const q = await db.send(
        new QueryCommand({
          TableName: "Users",
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":pk": { S: "u1" }, ":p": { S: "order#" } },
          ScanIndexForward: false,
        }),
      );
      expect(q.Items?.[0].sk.S).toBe("order#2");
    });
  });

  describe("batch + transactions", () => {
    beforeEach(async () => {
      await createUsersTable(db);
    });

    it("BatchWriteItem + BatchGetItem", async () => {
      await db.send(
        new BatchWriteItemCommand({
          RequestItems: {
            Users: [
              { PutRequest: { Item: { pk: { S: "a" }, sk: { S: "1" } } } },
              { PutRequest: { Item: { pk: { S: "b" }, sk: { S: "1" } } } },
            ],
          },
        }),
      );
      const g = await db.send(
        new BatchGetItemCommand({
          RequestItems: {
            Users: {
              Keys: [
                { pk: { S: "a" }, sk: { S: "1" } },
                { pk: { S: "b" }, sk: { S: "1" } },
              ],
            },
          },
        }),
      );
      expect(g.Responses?.Users).toHaveLength(2);
    });

    it("TransactWriteItems + TransactGetItems", async () => {
      await db.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: "Users", Item: { pk: { S: "t1" }, sk: { S: "1" }, v: { N: "1" } } } },
            { Put: { TableName: "Users", Item: { pk: { S: "t2" }, sk: { S: "1" }, v: { N: "2" } } } },
          ],
        }),
      );
      const g = await db.send(
        new TransactGetItemsCommand({
          TransactItems: [
            { Get: { TableName: "Users", Key: { pk: { S: "t1" }, sk: { S: "1" } } } },
            { Get: { TableName: "Users", Key: { pk: { S: "t2" }, sk: { S: "1" } } } },
          ],
        }),
      );
      expect(g.Responses?.[0].Item?.v?.N).toBe("1");
      expect(g.Responses?.[1].Item?.v?.N).toBe("2");
    });

    it("TransactWriteItems rolls back on failed condition", async () => {
      await db.send(
        new PutItemCommand({ TableName: "Users", Item: { pk: { S: "exists" }, sk: { S: "1" } } }),
      );
      await expectError(
        db.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: "Users",
                  Item: { pk: { S: "exists" }, sk: { S: "1" } },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        ),
        "TransactionCanceledException",
      );
    });
  });

  describe("failure scenarios (error fidelity)", () => {
    it("data-plane op on missing table -> RNF 'Cannot do operations on a non-existent table'", async () => {
      // Real DynamoDB: Get/Put/Query/Scan/Batch on a missing table return the
      // data-plane message, NOT the control-plane "Requested resource not found".
      const err: any = await expectError(
        db.send(new GetItemCommand({ TableName: "Ghost", Key: { pk: { S: "x" }, sk: { S: "y" } } })),
        "ResourceNotFoundException",
      );
      expect(err.message).toBe("Cannot do operations on a non-existent table");
      expect(err.$metadata?.httpStatusCode).toBe(400);
    });

    it("control-plane DescribeTable on missing table -> 'Requested resource not found'", async () => {
      const err: any = await expectError(
        db.send(new DescribeTableCommand({ TableName: "Ghost" })),
        "ResourceNotFoundException",
      );
      expect(err.message).toBe("Requested resource not found: Table: Ghost not found");
    });

    it("PutItem on missing table -> data-plane RNF message", async () => {
      const err: any = await expectError(
        db.send(new PutItemCommand({ TableName: "Ghost", Item: { pk: { S: "a" }, sk: { S: "b" } } })),
        "ResourceNotFoundException",
      );
      expect(err.message).toBe("Cannot do operations on a non-existent table");
    });

    it("BatchGetItem on missing table -> data-plane RNF message", async () => {
      const err: any = await expectError(
        db.send(
          new BatchGetItemCommand({
            RequestItems: { Ghost: { Keys: [{ pk: { S: "a" }, sk: { S: "b" } }] } },
          }),
        ),
        "ResourceNotFoundException",
      );
      expect(err.message).toBe("Cannot do operations on a non-existent table");
    });

    it("ConditionalCheckFailed returns exact message + 400", async () => {
      await createUsersTable(db);
      await db.send(
        new PutItemCommand({ TableName: "Users", Item: { pk: { S: "u1" }, sk: { S: "p" } } }),
      );
      const err: any = await expectError(
        db.send(
          new PutItemCommand({
            TableName: "Users",
            Item: { pk: { S: "u1" }, sk: { S: "p" } },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        ),
        "ConditionalCheckFailedException",
      );
      expect(err.message).toBe("The conditional request failed");
      expect(err.$metadata?.httpStatusCode).toBe(400);
    });

    it("unknown operation -> UnknownOperationException 400 (raw wire)", async () => {
      // The SDK won't model an unknown op, so hit the wire directly.
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "DynamoDB_20120810.Frobnicate",
        },
        body: "{}",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.__type).toContain("UnknownOperationException");
      // Real wire: coral-framework prefix for this exception.
      expect(body.__type).toBe("com.amazon.coral.service#UnknownOperationException");
    });

    it("error envelope uses lowercase `message` and dynamodb __type prefix", async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "DynamoDB_20120810.DescribeTable",
        },
        body: JSON.stringify({ TableName: "Ghost" }),
      });
      expect(res.status).toBe(400);
      const raw = await res.text();
      const body = JSON.parse(raw);
      expect(body.__type).toBe(
        "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException",
      );
      expect(body.message).toBe("Requested resource not found: Table: Ghost not found");
      // Real DynamoDB does NOT emit a capitalized `Message` field.
      expect(raw).not.toContain('"Message"');
    });

    it("TransactWriteItems cancellation reasons are request-ordered with None placeholders", async () => {
      await createUsersTable(db);
      await db.send(
        new PutItemCommand({ TableName: "Users", Item: { pk: { S: "exists" }, sk: { S: "1" } } }),
      );
      const err: any = await expectError(
        db.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              // index 0: succeeds
              { Put: { TableName: "Users", Item: { pk: { S: "new" }, sk: { S: "1" } } } },
              // index 1: fails (item already exists)
              {
                Put: {
                  TableName: "Users",
                  Item: { pk: { S: "exists" }, sk: { S: "1" } },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        ),
        "TransactionCanceledException",
      );
      expect(err.$metadata?.httpStatusCode).toBe(400);
      const reasons = err.CancellationReasons;
      expect(reasons).toHaveLength(2);
      expect(reasons[0].Code).toBe("None");
      expect(reasons[1].Code).toBe("ConditionalCheckFailed");
      expect(reasons[1].Message).toBe("The conditional request failed");
      // Transaction must not have partially applied.
      const g = await db.send(
        new GetItemCommand({ TableName: "Users", Key: { pk: { S: "new" }, sk: { S: "1" } } }),
      );
      expect(g.Item).toBeUndefined();
    });
  });

  describe("tags + ttl", () => {
    let arn: string;
    beforeEach(async () => {
      const c = await createUsersTable(db);
      arn = c.TableDescription!.TableArn!;
    });

    it("TagResource + ListTagsOfResource", async () => {
      await db.send(
        new TagResourceCommand({ ResourceArn: arn, Tags: [{ Key: "env", Value: "test" }] }),
      );
      const t = await db.send(new ListTagsOfResourceCommand({ ResourceArn: arn }));
      expect(t.Tags?.find((x) => x.Key === "env")?.Value).toBe("test");
    });

    it("UpdateTimeToLive + DescribeTimeToLive", async () => {
      await db.send(
        new UpdateTimeToLiveCommand({
          TableName: "Users",
          TimeToLiveSpecification: { Enabled: true, AttributeName: "expireAt" },
        }),
      );
      const d = await db.send(new DescribeTimeToLiveCommand({ TableName: "Users" }));
      expect(d.TimeToLiveDescription?.TimeToLiveStatus).toBe("ENABLED");
      expect(d.TimeToLiveDescription?.AttributeName).toBe("expireAt");
    });
  });
});
