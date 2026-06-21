import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SQSClient,
  // queue lifecycle
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  // attributes
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  PurgeQueueCommand,
  // messaging
  SendMessageCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteMessageBatchCommand,
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityBatchCommand,
  // tags
  TagQueueCommand,
  UntagQueueCommand,
  ListQueueTagsCommand,
  // permissions
  AddPermissionCommand,
  RemovePermissionCommand,
  // DLQ / move tasks
  ListDeadLetterSourceQueuesCommand,
  StartMessageMoveTaskCommand,
  CancelMessageMoveTaskCommand,
  ListMessageMoveTasksCommand,
} from "@aws-sdk/client-sqs";
import { SqsServer } from "../services/sqs/src/server.js";

const PORT = 14568;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new SQSClient({
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

describe("SQS Service", () => {
  let server: SqsServer;
  let sqs: SQSClient;

  beforeAll(async () => {
    server = new SqsServer(PORT);
    await server.start();
    sqs = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createQueue(name: string, attributes?: Record<string, string>) {
    const res = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes }));
    return res.QueueUrl as string;
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("sqs");
    });

    it("has resettable ephemeral state", async () => {
      await createQueue("reset-queue");
      expect(server.queues.size).toBe(1);
      server.reset();
      expect(server.queues.size).toBe(0);
    });

    it("supports POST /_parlel/reset", async () => {
      await createQueue("reset-queue-2");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.queues.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("CreateQueue", () => {
    it("creates a queue and returns a URL", async () => {
      const url = await createQueue("my-queue");
      expect(url).toContain("my-queue");
      expect(url).toContain(String(PORT));
    });

    it("is idempotent with matching attributes", async () => {
      const url1 = await createQueue("dup-queue", { DelaySeconds: "5" });
      const url2 = await createQueue("dup-queue", { DelaySeconds: "5" });
      expect(url1).toBe(url2);
    });

    it("rejects re-creation with different attributes", async () => {
      await createQueue("conflict-queue", { DelaySeconds: "5" });
      await expectError(
        sqs.send(new CreateQueueCommand({ QueueName: "conflict-queue", Attributes: { DelaySeconds: "10" } })),
        "QueueNameExists",
      );
    });

    it("creates a FIFO queue", async () => {
      const url = await createQueue("orders.fifo", { FifoQueue: "true" });
      expect(url).toContain("orders.fifo");
    });

    it("rejects FIFO attribute without .fifo suffix", async () => {
      await expectError(
        sqs.send(new CreateQueueCommand({ QueueName: "bad-fifo", Attributes: { FifoQueue: "true" } })),
        "InvalidParameterValue",
      );
    });

    it("rejects invalid queue names", async () => {
      await expectError(
        sqs.send(new CreateQueueCommand({ QueueName: "bad name!" })),
        "InvalidParameterValue",
      );
    });

    it("stores tags passed at creation", async () => {
      const res = await sqs.send(
        new CreateQueueCommand({ QueueName: "tagged-queue", tags: { env: "test" } }),
      );
      const tags = await sqs.send(new ListQueueTagsCommand({ QueueUrl: res.QueueUrl }));
      expect(tags.Tags?.env).toBe("test");
    });
  });

  // -----------------------------------------------------------------------
  describe("GetQueueUrl", () => {
    it("returns the URL of an existing queue", async () => {
      await createQueue("lookup-queue");
      const res = await sqs.send(new GetQueueUrlCommand({ QueueName: "lookup-queue" }));
      expect(res.QueueUrl).toContain("lookup-queue");
    });

    it("throws NonExistentQueue for a missing queue", async () => {
      await expectError(
        sqs.send(new GetQueueUrlCommand({ QueueName: "nope-queue" })),
        "QueueDoesNotExist",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListQueues", () => {
    it("lists all queues", async () => {
      await createQueue("list-a");
      await createQueue("list-b");
      const res = await sqs.send(new ListQueuesCommand({}));
      expect(res.QueueUrls?.length).toBe(2);
    });

    it("filters by prefix", async () => {
      await createQueue("prefix-one");
      await createQueue("prefix-two");
      await createQueue("other-three");
      const res = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "prefix-" }));
      expect(res.QueueUrls?.length).toBe(2);
    });

    it("returns empty list when no queues match", async () => {
      const res = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "zzz" }));
      expect(res.QueueUrls ?? []).toEqual([]);
    });

    it("paginates with MaxResults", async () => {
      for (let i = 0; i < 5; i++) await createQueue(`page-${i}`);
      const res = await sqs.send(new ListQueuesCommand({ MaxResults: 2 }));
      expect(res.QueueUrls?.length).toBe(2);
      expect(res.NextToken).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteQueue", () => {
    it("deletes an existing queue", async () => {
      const url = await createQueue("del-queue");
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
      expect(server.queues.size).toBe(0);
    });

    it("throws for a missing queue", async () => {
      await expectError(
        sqs.send(new DeleteQueueCommand({ QueueUrl: `${ENDPOINT}/000000000000/ghost` })),
        "QueueDoesNotExist",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Queue attributes", () => {
    it("returns default attributes", async () => {
      const url = await createQueue("attr-queue");
      const res = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }),
      );
      expect(res.Attributes?.VisibilityTimeout).toBe("30");
      expect(res.Attributes?.QueueArn).toContain("attr-queue");
      expect(res.Attributes?.ApproximateNumberOfMessages).toBe("0");
    });

    it("returns only requested attributes", async () => {
      const url = await createQueue("attr-queue-2");
      const res = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["VisibilityTimeout"] }),
      );
      expect(res.Attributes?.VisibilityTimeout).toBe("30");
      expect(res.Attributes?.MaximumMessageSize).toBeUndefined();
    });

    it("sets attributes", async () => {
      const url = await createQueue("attr-queue-3");
      await sqs.send(
        new SetQueueAttributesCommand({ QueueUrl: url, Attributes: { VisibilityTimeout: "60" } }),
      );
      const res = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["VisibilityTimeout"] }),
      );
      expect(res.Attributes?.VisibilityTimeout).toBe("60");
    });

    it("rejects unknown attribute names on set", async () => {
      const url = await createQueue("attr-queue-4");
      await expectError(
        sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: { Bogus: "1" } })),
        "InvalidAttributeName",
      );
    });

    it("reports message counts", async () => {
      const url = await createQueue("count-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "x" }));
      const res = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      expect(res.Attributes?.ApproximateNumberOfMessages).toBe("1");
    });
  });

  // -----------------------------------------------------------------------
  describe("SendMessage", () => {
    it("sends a message and returns MessageId + MD5", async () => {
      const url = await createQueue("send-queue");
      const res = await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "hello world" }));
      expect(res.MessageId).toBeDefined();
      // MD5 of "hello world" — the SDK validates this client-side.
      expect(res.MD5OfMessageBody).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
    });

    it("computes MD5 of message attributes (SDK validates it)", async () => {
      const url = await createQueue("send-attr-queue");
      const res = await sqs.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: "body",
          MessageAttributes: {
            color: { DataType: "String", StringValue: "red" },
            count: { DataType: "Number", StringValue: "42" },
          },
        }),
      );
      expect(res.MD5OfMessageAttributes).toBeDefined();
      expect(res.MD5OfMessageAttributes).toHaveLength(32);
    });

    it("rejects empty message body", async () => {
      const url = await createQueue("send-empty-queue");
      await expectError(
        sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "" })),
        "MissingParameter",
      );
    });

    it("respects MaximumMessageSize", async () => {
      const url = await createQueue("send-size-queue", { MaximumMessageSize: "10" });
      await expectError(
        sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "this is way too long" })),
        "InvalidParameterValue",
      );
    });

    it("requires MessageGroupId for FIFO queues", async () => {
      const url = await createQueue("fifo-group.fifo", { FifoQueue: "true" });
      await expectError(
        sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "x", MessageDeduplicationId: "d1" })),
        "MissingParameter",
      );
    });

    it("returns SequenceNumber for FIFO messages", async () => {
      const url = await createQueue("fifo-seq.fifo", { FifoQueue: "true" });
      const res = await sqs.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: "x",
          MessageGroupId: "g1",
          MessageDeduplicationId: "d1",
        }),
      );
      expect(res.SequenceNumber).toBeDefined();
    });

    it("deduplicates FIFO messages with the same dedup id", async () => {
      const url = await createQueue("fifo-dedup.fifo", { FifoQueue: "true" });
      await sqs.send(
        new SendMessageCommand({ QueueUrl: url, MessageBody: "a", MessageGroupId: "g", MessageDeduplicationId: "same" }),
      );
      await sqs.send(
        new SendMessageCommand({ QueueUrl: url, MessageBody: "b", MessageGroupId: "g", MessageDeduplicationId: "same" }),
      );
      const attrs = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("1");
    });

    it("throws NonExistentQueue when sending to a missing queue", async () => {
      await expectError(
        sqs.send(new SendMessageCommand({ QueueUrl: `${ENDPOINT}/000000000000/ghost`, MessageBody: "x" })),
        "QueueDoesNotExist",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("SendMessageBatch", () => {
    it("sends multiple messages", async () => {
      const url = await createQueue("batch-queue");
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: [
            { Id: "1", MessageBody: "one" },
            { Id: "2", MessageBody: "two" },
          ],
        }),
      );
      expect(res.Successful?.length).toBe(2);
      expect(res.Failed?.length ?? 0).toBe(0);
    });

    it("rejects empty batch", async () => {
      const url = await createQueue("batch-empty-queue");
      await expectError(
        sqs.send(new SendMessageBatchCommand({ QueueUrl: url, Entries: [] })),
        "EmptyBatchRequest",
      );
    });

    it("rejects duplicate batch ids", async () => {
      const url = await createQueue("batch-dup-queue");
      await expectError(
        sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: url,
            Entries: [
              { Id: "1", MessageBody: "a" },
              { Id: "1", MessageBody: "b" },
            ],
          }),
        ),
        "BatchEntryIdsNotDistinct",
      );
    });

    it("reports per-entry failures without failing the batch", async () => {
      const url = await createQueue("batch-partial-queue", { MaximumMessageSize: "5" });
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: [
            { Id: "ok", MessageBody: "hi" },
            { Id: "bad", MessageBody: "this is too long" },
          ],
        }),
      );
      expect(res.Successful?.length).toBe(1);
      expect(res.Failed?.length).toBe(1);
      expect(res.Failed?.[0].Id).toBe("bad");
    });
  });

  // -----------------------------------------------------------------------
  describe("ReceiveMessage", () => {
    it("receives a sent message with correct body and MD5", async () => {
      const url = await createQueue("recv-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "hello" }));
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(res.Messages?.length).toBe(1);
      expect(res.Messages?.[0].Body).toBe("hello");
      expect(res.Messages?.[0].ReceiptHandle).toBeDefined();
    });

    it("returns no messages from an empty queue", async () => {
      const url = await createQueue("recv-empty-queue");
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(res.Messages ?? []).toEqual([]);
    });

    it("respects MaxNumberOfMessages", async () => {
      const url = await createQueue("recv-max-queue");
      for (let i = 0; i < 5; i++) {
        await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: `m${i}` }));
      }
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 3 }));
      expect(res.Messages?.length).toBe(3);
    });

    it("hides received messages (visibility timeout)", async () => {
      const url = await createQueue("recv-vis-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "once" }));
      const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(first.Messages?.length).toBe(1);
      const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(second.Messages ?? []).toEqual([]);
    });

    it("redelivers after VisibilityTimeout 0", async () => {
      const url = await createQueue("recv-vis0-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "again" }));
      const first = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url, VisibilityTimeout: 0 }),
      );
      expect(first.Messages?.length).toBe(1);
      const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(second.Messages?.length).toBe(1);
    });

    it("returns requested system attributes", async () => {
      const url = await createQueue("recv-sysattr-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "m" }));
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MessageSystemAttributeNames: ["All"],
        }),
      );
      expect(res.Messages?.[0].Attributes?.ApproximateReceiveCount).toBe("1");
      expect(res.Messages?.[0].Attributes?.SentTimestamp).toBeDefined();
    });

    it("returns requested message attributes with valid MD5", async () => {
      const url = await createQueue("recv-msgattr-queue");
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: url,
          MessageBody: "m",
          MessageAttributes: { tag: { DataType: "String", StringValue: "v" } },
        }),
      );
      const res = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url, MessageAttributeNames: ["All"] }),
      );
      expect(res.Messages?.[0].MessageAttributes?.tag?.StringValue).toBe("v");
    });

    it("preserves FIFO ordering", async () => {
      const url = await createQueue("recv-fifo.fifo", { FifoQueue: "true", ContentBasedDeduplication: "true" });
      for (const b of ["a", "b", "c"]) {
        await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: b, MessageGroupId: "g" }));
      }
      const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
      expect(res.Messages?.map((m) => m.Body)).toEqual(["a", "b", "c"]);
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteMessage", () => {
    it("deletes a received message", async () => {
      const url = await createQueue("delmsg-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "byebye" }));
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      const handle = recv.Messages?.[0].ReceiptHandle as string;
      await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle }));
      const attrs = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
      expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");
    });

    it("rejects a malformed receipt handle", async () => {
      const url = await createQueue("delmsg-bad-queue");
      await expectError(
        sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: "not-a-handle" })),
        "ReceiptHandleIsInvalid",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteMessageBatch", () => {
    it("deletes multiple received messages", async () => {
      const url = await createQueue("delbatch-queue");
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: [
            { Id: "1", MessageBody: "a" },
            { Id: "2", MessageBody: "b" },
          ],
        }),
      );
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
      const entries = (recv.Messages ?? []).map((m, i) => ({
        Id: String(i),
        ReceiptHandle: m.ReceiptHandle as string,
      }));
      const res = await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: entries }));
      expect(res.Successful?.length).toBe(2);
    });

    it("rejects an empty batch", async () => {
      const url = await createQueue("delbatch-empty-queue");
      await expectError(
        sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: [] })),
        "EmptyBatchRequest",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ChangeMessageVisibility", () => {
    it("changes visibility of an inflight message", async () => {
      const url = await createQueue("vis-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "m" }));
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      const handle = recv.Messages?.[0].ReceiptHandle as string;
      await sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 0 }),
      );
      const again = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      expect(again.Messages?.length).toBe(1);
    });

    it("throws MessageNotInflight for an unknown handle", async () => {
      const url = await createQueue("vis-bad-queue");
      await expectError(
        sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: url,
            ReceiptHandle: "abc#def",
            VisibilityTimeout: 30,
          }),
        ),
        "MessageNotInflight",
      );
    });

    it("rejects out-of-range visibility timeout", async () => {
      const url = await createQueue("vis-range-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "m" }));
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url }));
      const handle = recv.Messages?.[0].ReceiptHandle as string;
      await expectError(
        sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: handle, VisibilityTimeout: 99999 }),
        ),
        "InvalidParameterValue",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ChangeMessageVisibilityBatch", () => {
    it("changes visibility for a batch", async () => {
      const url = await createQueue("visbatch-queue");
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: [
            { Id: "1", MessageBody: "a" },
            { Id: "2", MessageBody: "b" },
          ],
        }),
      );
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
      const entries = (recv.Messages ?? []).map((m, i) => ({
        Id: String(i),
        ReceiptHandle: m.ReceiptHandle as string,
        VisibilityTimeout: 0,
      }));
      const res = await sqs.send(new ChangeMessageVisibilityBatchCommand({ QueueUrl: url, Entries: entries }));
      expect(res.Successful?.length).toBe(2);
    });

    it("reports per-entry failure for an unknown handle", async () => {
      const url = await createQueue("visbatch-bad-queue");
      const res = await sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: url,
          Entries: [{ Id: "1", ReceiptHandle: "abc#def", VisibilityTimeout: 30 }],
        }),
      );
      expect(res.Failed?.length).toBe(1);
      expect(res.Failed?.[0].Code).toContain("MessageNotInflight");
    });
  });

  // -----------------------------------------------------------------------
  describe("PurgeQueue", () => {
    it("removes all messages", async () => {
      const url = await createQueue("purge-queue");
      for (let i = 0; i < 3; i++) {
        await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: `m${i}` }));
      }
      await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
      const attrs = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    it("tags, lists, and untags a queue", async () => {
      const url = await createQueue("tag-queue");
      await sqs.send(new TagQueueCommand({ QueueUrl: url, Tags: { team: "infra", env: "dev" } }));
      let res = await sqs.send(new ListQueueTagsCommand({ QueueUrl: url }));
      expect(res.Tags?.team).toBe("infra");
      expect(res.Tags?.env).toBe("dev");
      await sqs.send(new UntagQueueCommand({ QueueUrl: url, TagKeys: ["env"] }));
      res = await sqs.send(new ListQueueTagsCommand({ QueueUrl: url }));
      expect(res.Tags?.env).toBeUndefined();
      expect(res.Tags?.team).toBe("infra");
    });

    it("returns no Tags for an untagged queue", async () => {
      const url = await createQueue("tag-empty-queue");
      const res = await sqs.send(new ListQueueTagsCommand({ QueueUrl: url }));
      expect(res.Tags ?? {}).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  describe("Permissions", () => {
    it("adds and removes a permission", async () => {
      const url = await createQueue("perm-queue");
      await sqs.send(
        new AddPermissionCommand({
          QueueUrl: url,
          Label: "share",
          AWSAccountIds: ["123456789012"],
          Actions: ["SendMessage"],
        }),
      );
      await sqs.send(new RemovePermissionCommand({ QueueUrl: url, Label: "share" }));
    });

    it("rejects duplicate permission labels", async () => {
      const url = await createQueue("perm-dup-queue");
      await sqs.send(
        new AddPermissionCommand({
          QueueUrl: url,
          Label: "dup",
          AWSAccountIds: ["123456789012"],
          Actions: ["SendMessage"],
        }),
      );
      await expectError(
        sqs.send(
          new AddPermissionCommand({
            QueueUrl: url,
            Label: "dup",
            AWSAccountIds: ["123456789012"],
            Actions: ["SendMessage"],
          }),
        ),
        "InvalidParameterValue",
      );
    });

    it("rejects removing an unknown permission label", async () => {
      const url = await createQueue("perm-missing-queue");
      await expectError(
        sqs.send(new RemovePermissionCommand({ QueueUrl: url, Label: "nope" })),
        "InvalidParameterValue",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Dead-letter queues & message move tasks", () => {
    async function setupDlq() {
      const dlqUrl = await createQueue("dlq-target");
      const dlqArn = (
        await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))
      ).Attributes?.QueueArn as string;
      const srcUrl = await createQueue("dlq-source", {
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }),
      });
      return { dlqUrl, dlqArn, srcUrl };
    }

    it("lists dead-letter source queues", async () => {
      const { dlqUrl, srcUrl } = await setupDlq();
      const res = await sqs.send(new ListDeadLetterSourceQueuesCommand({ QueueUrl: dlqUrl }));
      expect(res.queueUrls).toContain(srcUrl);
    });

    it("starts, lists, and cancels a message move task", async () => {
      const { dlqUrl, dlqArn, srcUrl } = await setupDlq();
      // Put messages in the DLQ to be redriven.
      await sqs.send(new SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: "dead-1" }));
      await sqs.send(new SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: "dead-2" }));

      const start = await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));
      expect(start.TaskHandle).toBeDefined();

      const list = await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn }));
      expect(list.Results?.length).toBeGreaterThan(0);
      expect(list.Results?.[0].SourceArn).toBe(dlqArn);

      // Messages were moved back to the source queue.
      const moved = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: srcUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
      );
      expect(moved.Attributes?.ApproximateNumberOfMessages).toBe("2");

      const cancel = await sqs.send(
        new CancelMessageMoveTaskCommand({ TaskHandle: start.TaskHandle as string }),
      );
      expect(cancel.ApproximateNumberOfMessagesMoved).toBe(2);
    });

    it("throws for a move task with an unknown source", async () => {
      await expectError(
        sqs.send(
          new StartMessageMoveTaskCommand({
            SourceArn: "arn:aws:sqs:us-east-1:000000000000:does-not-exist",
          }),
        ),
        "ResourceNotFoundException",
      );
    });

    it("throws for cancelling an unknown task", async () => {
      await expectError(
        sqs.send(new CancelMessageMoveTaskCommand({ TaskHandle: "bogus" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("End-to-end flow", () => {
    it("send -> receive -> delete round trip", async () => {
      const url = await createQueue("e2e-queue");
      await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: "payload" }));
      const recv = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1 }));
      expect(recv.Messages?.[0].Body).toBe("payload");
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: recv.Messages?.[0].ReceiptHandle as string }),
      );
      const after = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      expect(after.Attributes?.ApproximateNumberOfMessages).toBe("0");
      expect(after.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");
    });
  });
});
