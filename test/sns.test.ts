import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SNSClient,
  // Topics
  CreateTopicCommand,
  DeleteTopicCommand,
  ListTopicsCommand,
  GetTopicAttributesCommand,
  SetTopicAttributesCommand,
  // Subscriptions
  SubscribeCommand,
  UnsubscribeCommand,
  ConfirmSubscriptionCommand,
  ListSubscriptionsCommand,
  ListSubscriptionsByTopicCommand,
  GetSubscriptionAttributesCommand,
  SetSubscriptionAttributesCommand,
  // Publishing
  PublishCommand,
  PublishBatchCommand,
  // Permissions
  AddPermissionCommand,
  RemovePermissionCommand,
  // Tags
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
  // Data protection policy
  GetDataProtectionPolicyCommand,
  PutDataProtectionPolicyCommand,
  // SMS
  GetSMSAttributesCommand,
  SetSMSAttributesCommand,
  CheckIfPhoneNumberIsOptedOutCommand,
  OptInPhoneNumberCommand,
  ListPhoneNumbersOptedOutCommand,
  ListOriginationNumbersCommand,
  // SMS sandbox
  GetSMSSandboxAccountStatusCommand,
  CreateSMSSandboxPhoneNumberCommand,
  VerifySMSSandboxPhoneNumberCommand,
  DeleteSMSSandboxPhoneNumberCommand,
  ListSMSSandboxPhoneNumbersCommand,
  // Platform applications & endpoints
  CreatePlatformApplicationCommand,
  DeletePlatformApplicationCommand,
  GetPlatformApplicationAttributesCommand,
  SetPlatformApplicationAttributesCommand,
  ListPlatformApplicationsCommand,
  CreatePlatformEndpointCommand,
  DeleteEndpointCommand,
  GetEndpointAttributesCommand,
  SetEndpointAttributesCommand,
  ListEndpointsByPlatformApplicationCommand,
} from "@aws-sdk/client-sns";
import { SnsServer } from "../services/sns/src/server.js";

const PORT = 14569;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new SNSClient({
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

describe("SNS Service", () => {
  let server: SnsServer;
  let sns: SNSClient;

  beforeAll(async () => {
    server = new SnsServer(PORT);
    await server.start();
    sns = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createTopic(name: string, attributes?: Record<string, string>) {
    const res = await sns.send(
      new CreateTopicCommand({ Name: name, Attributes: attributes }),
    );
    return res.TopicArn as string;
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("defaults to port 4569", () => {
      const s = new SnsServer();
      expect(s.port).toBe(4569);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("sns");
    });

    it("has resettable ephemeral state", async () => {
      await createTopic("reset-topic");
      expect(server.topics.size).toBe(1);
      server.reset();
      expect(server.topics.size).toBe(0);
    });

    it("supports POST /_parlel/reset", async () => {
      await createTopic("reset-topic-2");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.topics.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("CreateTopic", () => {
    it("creates a topic and returns an ARN", async () => {
      const arn = await createTopic("my-topic");
      expect(arn).toContain("my-topic");
      expect(arn).toContain("arn:aws:sns:");
    });

    it("is idempotent for the same name", async () => {
      const a = await createTopic("dup-topic");
      const b = await createTopic("dup-topic");
      expect(a).toBe(b);
      expect(server.topics.size).toBe(1);
    });

    it("creates a FIFO topic when the name ends in .fifo", async () => {
      const arn = await createTopic("orders.fifo", { FifoTopic: "true" });
      expect(arn).toContain(".fifo");
      const attrs = await sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
      expect(attrs.Attributes?.FifoTopic).toBe("true");
    });

    it("creates a topic with tags", async () => {
      const res = await sns.send(
        new CreateTopicCommand({
          Name: "tagged-topic",
          Tags: [{ Key: "env", Value: "test" }],
        }),
      );
      const tags = await sns.send(
        new ListTagsForResourceCommand({ ResourceArn: res.TopicArn }),
      );
      expect(tags.Tags).toContainEqual({ Key: "env", Value: "test" });
    });

    it("rejects an invalid topic name", async () => {
      await expectError(
        sns.send(new CreateTopicCommand({ Name: "bad name!" })),
        "InvalidParameter",
      );
    });

    it("rejects FifoTopic=true without .fifo suffix", async () => {
      await expectError(
        sns.send(
          new CreateTopicCommand({ Name: "notfifo", Attributes: { FifoTopic: "true" } }),
        ),
        "InvalidParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListTopics", () => {
    it("lists created topics", async () => {
      await createTopic("topic-a");
      await createTopic("topic-b");
      const res = await sns.send(new ListTopicsCommand({}));
      const arns = (res.Topics || []).map((t) => t.TopicArn);
      expect(arns).toContain(server.topicArn("topic-a"));
      expect(arns).toContain(server.topicArn("topic-b"));
    });

    it("returns an empty list when there are no topics", async () => {
      const res = await sns.send(new ListTopicsCommand({}));
      expect(res.Topics ?? []).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("GetTopicAttributes / SetTopicAttributes", () => {
    it("returns default attributes", async () => {
      const arn = await createTopic("attr-topic");
      const res = await sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
      expect(res.Attributes?.TopicArn).toBe(arn);
      expect(res.Attributes?.Owner).toBe("000000000000");
      expect(res.Attributes?.SubscriptionsConfirmed).toBe("0");
      expect(res.Attributes?.Policy).toContain("Statement");
    });

    it("updates the DisplayName attribute", async () => {
      const arn = await createTopic("display-topic");
      await sns.send(
        new SetTopicAttributesCommand({
          TopicArn: arn,
          AttributeName: "DisplayName",
          AttributeValue: "My Topic",
        }),
      );
      const res = await sns.send(new GetTopicAttributesCommand({ TopicArn: arn }));
      expect(res.Attributes?.DisplayName).toBe("My Topic");
    });

    it("rejects setting an immutable attribute", async () => {
      const arn = await createTopic("immutable-topic");
      await expectError(
        sns.send(
          new SetTopicAttributesCommand({
            TopicArn: arn,
            AttributeName: "Owner",
            AttributeValue: "999",
          }),
        ),
        "InvalidParameter",
      );
    });

    it("throws NotFound for a missing topic", async () => {
      await expectError(
        sns.send(
          new GetTopicAttributesCommand({
            TopicArn: server.topicArn("does-not-exist"),
          }),
        ),
        "NotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteTopic", () => {
    it("deletes a topic", async () => {
      const arn = await createTopic("del-topic");
      await sns.send(new DeleteTopicCommand({ TopicArn: arn }));
      expect(server.topics.size).toBe(0);
    });

    it("is idempotent (deleting a missing topic succeeds)", async () => {
      await sns.send(
        new DeleteTopicCommand({ TopicArn: server.topicArn("ghost") }),
      );
      expect(server.topics.size).toBe(0);
    });

    it("removes subscriptions for the deleted topic", async () => {
      const arn = await createTopic("del-with-subs");
      await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:q",
          ReturnSubscriptionArn: true,
        }),
      );
      expect(server.subscriptions.size).toBe(1);
      await sns.send(new DeleteTopicCommand({ TopicArn: arn }));
      expect(server.subscriptions.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("Subscribe / Unsubscribe", () => {
    it("auto-confirms an sqs subscription", async () => {
      const arn = await createTopic("sub-topic");
      const res = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:q1",
          ReturnSubscriptionArn: true,
        }),
      );
      expect(res.SubscriptionArn).toContain(arn);
      expect(res.SubscriptionArn).not.toBe("pending confirmation");
    });

    it("returns 'pending confirmation' for an http subscription without ReturnSubscriptionArn", async () => {
      const arn = await createTopic("http-topic");
      const res = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "https",
          Endpoint: "https://example.com/hook",
        }),
      );
      expect(res.SubscriptionArn).toBe("pending confirmation");
    });

    it("rejects an invalid protocol", async () => {
      const arn = await createTopic("badproto-topic");
      await expectError(
        sns.send(
          new SubscribeCommand({
            TopicArn: arn,
            Protocol: "carrier-pigeon",
            Endpoint: "nest",
          }),
        ),
        "InvalidParameter",
      );
    });

    it("subscribes with attributes (RawMessageDelivery)", async () => {
      const arn = await createTopic("rawsub-topic");
      const res = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:rawq",
          Attributes: { RawMessageDelivery: "true" },
          ReturnSubscriptionArn: true,
        }),
      );
      const attrs = await sns.send(
        new GetSubscriptionAttributesCommand({
          SubscriptionArn: res.SubscriptionArn,
        }),
      );
      expect(attrs.Attributes?.RawMessageDelivery).toBe("true");
    });

    it("unsubscribes an existing subscription", async () => {
      const arn = await createTopic("unsub-topic");
      const sub = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:uq",
          ReturnSubscriptionArn: true,
        }),
      );
      await sns.send(
        new UnsubscribeCommand({ SubscriptionArn: sub.SubscriptionArn }),
      );
      expect(server.subscriptions.size).toBe(0);
    });

    it("throws NotFound when unsubscribing a missing subscription", async () => {
      await expectError(
        sns.send(
          new UnsubscribeCommand({
            SubscriptionArn: server.topicArn("x") + ":fake",
          }),
        ),
        "NotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ConfirmSubscription", () => {
    it("confirms a pending subscription using its token", async () => {
      const arn = await createTopic("confirm-topic");
      await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "https",
          Endpoint: "https://example.com/confirm",
        }),
      );
      // Grab the token the server generated.
      const token = [...server.pendingConfirmations.keys()][0];
      const res = await sns.send(
        new ConfirmSubscriptionCommand({ TopicArn: arn, Token: token }),
      );
      expect(res.SubscriptionArn).toContain(arn);
      const list = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: arn }),
      );
      expect(list.Subscriptions?.[0].SubscriptionArn).toContain(arn);
    });

    it("rejects an unknown confirmation token", async () => {
      const arn = await createTopic("confirm-bad-topic");
      await expectError(
        sns.send(
          new ConfirmSubscriptionCommand({ TopicArn: arn, Token: "nope" }),
        ),
        "InvalidParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListSubscriptions / ListSubscriptionsByTopic", () => {
    it("lists all subscriptions across topics", async () => {
      const t1 = await createTopic("ls-t1");
      const t2 = await createTopic("ls-t2");
      await sns.send(
        new SubscribeCommand({
          TopicArn: t1,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:a",
          ReturnSubscriptionArn: true,
        }),
      );
      await sns.send(
        new SubscribeCommand({
          TopicArn: t2,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:b",
          ReturnSubscriptionArn: true,
        }),
      );
      const res = await sns.send(new ListSubscriptionsCommand({}));
      expect(res.Subscriptions).toHaveLength(2);
    });

    it("lists subscriptions for a single topic", async () => {
      const t1 = await createTopic("lbt-t1");
      const t2 = await createTopic("lbt-t2");
      await sns.send(
        new SubscribeCommand({
          TopicArn: t1,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:c",
          ReturnSubscriptionArn: true,
        }),
      );
      await sns.send(
        new SubscribeCommand({
          TopicArn: t2,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:d",
          ReturnSubscriptionArn: true,
        }),
      );
      const res = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: t1 }),
      );
      expect(res.Subscriptions).toHaveLength(1);
      expect(res.Subscriptions?.[0].TopicArn).toBe(t1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Get/SetSubscriptionAttributes", () => {
    it("sets and reads a FilterPolicy", async () => {
      const arn = await createTopic("filter-topic");
      const sub = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:fq",
          ReturnSubscriptionArn: true,
        }),
      );
      await sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn,
          AttributeName: "FilterPolicy",
          AttributeValue: JSON.stringify({ type: ["order"] }),
        }),
      );
      const res = await sns.send(
        new GetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn,
        }),
      );
      expect(res.Attributes?.FilterPolicy).toContain("order");
    });

    it("rejects an invalid subscription attribute", async () => {
      const arn = await createTopic("badsubattr-topic");
      const sub = await sns.send(
        new SubscribeCommand({
          TopicArn: arn,
          Protocol: "sqs",
          Endpoint: "arn:aws:sqs:us-east-1:000000000000:zq",
          ReturnSubscriptionArn: true,
        }),
      );
      await expectError(
        sns.send(
          new SetSubscriptionAttributesCommand({
            SubscriptionArn: sub.SubscriptionArn,
            AttributeName: "Bogus",
            AttributeValue: "x",
          }),
        ),
        "InvalidParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Publish", () => {
    it("publishes a message to a topic", async () => {
      const arn = await createTopic("pub-topic");
      const res = await sns.send(
        new PublishCommand({ TopicArn: arn, Message: "hello world" }),
      );
      expect(res.MessageId).toBeTruthy();
      expect(server.published).toHaveLength(1);
      expect(server.published[0].message).toBe("hello world");
    });

    it("publishes with a subject and message attributes", async () => {
      const arn = await createTopic("pubattr-topic");
      const res = await sns.send(
        new PublishCommand({
          TopicArn: arn,
          Subject: "Greeting",
          Message: "hi",
          MessageAttributes: {
            priority: { DataType: "String", StringValue: "high" },
          },
        }),
      );
      expect(res.MessageId).toBeTruthy();
      expect(server.published[0].subject).toBe("Greeting");
      expect(server.published[0].messageAttributes?.priority?.StringValue).toBe(
        "high",
      );
    });

    it("publishes a JSON message structure", async () => {
      const arn = await createTopic("pubjson-topic");
      const res = await sns.send(
        new PublishCommand({
          TopicArn: arn,
          MessageStructure: "json",
          Message: JSON.stringify({ default: "d", sqs: "s" }),
        }),
      );
      expect(res.MessageId).toBeTruthy();
    });

    it("rejects an empty message", async () => {
      const arn = await createTopic("pubempty-topic");
      await expectError(
        sns.send(new PublishCommand({ TopicArn: arn, Message: "" })),
        "InvalidParameter",
      );
    });

    it("rejects JSON message structure without a default entry", async () => {
      const arn = await createTopic("pubbadjson-topic");
      await expectError(
        sns.send(
          new PublishCommand({
            TopicArn: arn,
            MessageStructure: "json",
            Message: JSON.stringify({ sqs: "s" }),
          }),
        ),
        "InvalidParameter",
      );
    });

    it("requires MessageGroupId for FIFO topics and returns a SequenceNumber", async () => {
      const arn = await createTopic("pubfifo.fifo", {
        FifoTopic: "true",
        ContentBasedDeduplication: "true",
      });
      await expectError(
        sns.send(new PublishCommand({ TopicArn: arn, Message: "x" })),
        "InvalidParameter",
      );
      const res = await sns.send(
        new PublishCommand({
          TopicArn: arn,
          Message: "x",
          MessageGroupId: "g1",
        }),
      );
      expect(res.SequenceNumber).toBeTruthy();
    });

    it("publishes to a phone number", async () => {
      const res = await sns.send(
        new PublishCommand({ PhoneNumber: "+15555550123", Message: "sms!" }),
      );
      expect(res.MessageId).toBeTruthy();
      expect(server.published[0].phoneNumber).toBe("+15555550123");
    });

    it("rejects publish with no target", async () => {
      await expectError(
        sns.send(new PublishCommand({ Message: "orphan" })),
        "InvalidParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("PublishBatch", () => {
    it("publishes a batch of messages", async () => {
      const arn = await createTopic("batch-topic");
      const res = await sns.send(
        new PublishBatchCommand({
          TopicArn: arn,
          PublishBatchRequestEntries: [
            { Id: "1", Message: "one" },
            { Id: "2", Message: "two" },
          ],
        }),
      );
      expect(res.Successful).toHaveLength(2);
      expect(res.Failed ?? []).toHaveLength(0);
      expect(server.published).toHaveLength(2);
    });

    it("rejects an empty batch", async () => {
      const arn = await createTopic("emptybatch-topic");
      await expectError(
        sns.send(
          new PublishBatchCommand({
            TopicArn: arn,
            PublishBatchRequestEntries: [],
          }),
        ),
        "EmptyBatch",
      );
    });

    it("rejects duplicate batch entry ids", async () => {
      const arn = await createTopic("dupbatch-topic");
      await expectError(
        sns.send(
          new PublishBatchCommand({
            TopicArn: arn,
            PublishBatchRequestEntries: [
              { Id: "x", Message: "a" },
              { Id: "x", Message: "b" },
            ],
          }),
        ),
        "BatchEntryIdsNotDistinct",
      );
    });

    it("rejects more than 10 entries", async () => {
      const arn = await createTopic("bigbatch-topic");
      const entries = Array.from({ length: 11 }, (_, i) => ({
        Id: String(i),
        Message: "m",
      }));
      await expectError(
        sns.send(
          new PublishBatchCommand({
            TopicArn: arn,
            PublishBatchRequestEntries: entries,
          }),
        ),
        "TooManyEntriesInBatchRequest",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("AddPermission / RemovePermission", () => {
    it("adds and removes a permission", async () => {
      const arn = await createTopic("perm-topic");
      await sns.send(
        new AddPermissionCommand({
          TopicArn: arn,
          Label: "share",
          AWSAccountId: ["111122223333"],
          ActionName: ["Publish"],
        }),
      );
      const topic = server.topics.get(arn);
      expect(topic?.permissions?.has("share")).toBe(true);
      await sns.send(
        new RemovePermissionCommand({ TopicArn: arn, Label: "share" }),
      );
      expect(topic?.permissions?.has("share")).toBe(false);
    });

    it("rejects AddPermission without a Label", async () => {
      const arn = await createTopic("permnolabel-topic");
      await expectError(
        sns.send(
          new AddPermissionCommand({
            TopicArn: arn,
            Label: "",
            AWSAccountId: ["1"],
            ActionName: ["Publish"],
          }),
        ),
        "InvalidParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    it("tags, lists, and untags a topic", async () => {
      const arn = await createTopic("tag-topic");
      await sns.send(
        new TagResourceCommand({
          ResourceArn: arn,
          Tags: [
            { Key: "team", Value: "platform" },
            { Key: "env", Value: "dev" },
          ],
        }),
      );
      let res = await sns.send(
        new ListTagsForResourceCommand({ ResourceArn: arn }),
      );
      expect(res.Tags).toContainEqual({ Key: "team", Value: "platform" });
      expect(res.Tags).toContainEqual({ Key: "env", Value: "dev" });

      await sns.send(
        new UntagResourceCommand({ ResourceArn: arn, TagKeys: ["env"] }),
      );
      res = await sns.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
      const keys = (res.Tags || []).map((t) => t.Key);
      expect(keys).toContain("team");
      expect(keys).not.toContain("env");
    });

    it("throws ResourceNotFound for a missing resource", async () => {
      await expectError(
        sns.send(
          new ListTagsForResourceCommand({
            ResourceArn: server.topicArn("nope"),
          }),
        ),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Data protection policy", () => {
    it("puts and gets a data protection policy", async () => {
      const arn = await createTopic("dpp-topic");
      const policy = JSON.stringify({
        Name: "policy",
        Version: "2021-06-01",
        Statement: [],
      });
      await sns.send(
        new PutDataProtectionPolicyCommand({
          ResourceArn: arn,
          DataProtectionPolicy: policy,
        }),
      );
      const res = await sns.send(
        new GetDataProtectionPolicyCommand({ ResourceArn: arn }),
      );
      expect(res.DataProtectionPolicy).toBe(policy);
    });
  });

  // -----------------------------------------------------------------------
  describe("SMS attributes", () => {
    it("sets and gets SMS attributes", async () => {
      await sns.send(
        new SetSMSAttributesCommand({
          attributes: { DefaultSMSType: "Transactional" },
        }),
      );
      const res = await sns.send(new GetSMSAttributesCommand({}));
      expect(res.attributes?.DefaultSMSType).toBe("Transactional");
    });

    it("filters requested SMS attributes", async () => {
      await sns.send(
        new SetSMSAttributesCommand({
          attributes: { DefaultSMSType: "Promotional", MonthlySpendLimit: "1" },
        }),
      );
      const res = await sns.send(
        new GetSMSAttributesCommand({ attributes: ["MonthlySpendLimit"] }),
      );
      expect(res.attributes?.MonthlySpendLimit).toBe("1");
      expect(res.attributes?.DefaultSMSType).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("Phone number opt-out", () => {
    it("reports a non-opted-out number", async () => {
      const res = await sns.send(
        new CheckIfPhoneNumberIsOptedOutCommand({ phoneNumber: "+15555550100" }),
      );
      expect(res.isOptedOut).toBe(false);
    });

    it("opts a number back in and lists opted-out numbers", async () => {
      server.optedOut.add("+15555550199");
      let list = await sns.send(new ListPhoneNumbersOptedOutCommand({}));
      expect(list.phoneNumbers).toContain("+15555550199");

      await sns.send(
        new OptInPhoneNumberCommand({ phoneNumber: "+15555550199" }),
      );
      const check = await sns.send(
        new CheckIfPhoneNumberIsOptedOutCommand({ phoneNumber: "+15555550199" }),
      );
      expect(check.isOptedOut).toBe(false);

      list = await sns.send(new ListPhoneNumbersOptedOutCommand({}));
      expect(list.phoneNumbers ?? []).not.toContain("+15555550199");
    });

    it("lists origination numbers (empty by default)", async () => {
      const res = await sns.send(new ListOriginationNumbersCommand({}));
      expect(res.PhoneNumbers ?? []).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("SMS sandbox", () => {
    it("reports sandbox account status", async () => {
      const res = await sns.send(new GetSMSSandboxAccountStatusCommand({}));
      expect(typeof res.IsInSandbox).toBe("boolean");
    });

    it("creates, verifies, lists, and deletes a sandbox number", async () => {
      await sns.send(
        new CreateSMSSandboxPhoneNumberCommand({ PhoneNumber: "+15555550150" }),
      );
      let list = await sns.send(new ListSMSSandboxPhoneNumbersCommand({}));
      expect(list.PhoneNumbers?.map((p) => p.PhoneNumber)).toContain(
        "+15555550150",
      );

      await sns.send(
        new VerifySMSSandboxPhoneNumberCommand({
          PhoneNumber: "+15555550150",
          OneTimePassword: "123456",
        }),
      );
      list = await sns.send(new ListSMSSandboxPhoneNumbersCommand({}));
      const entry = list.PhoneNumbers?.find(
        (p) => p.PhoneNumber === "+15555550150",
      );
      expect(entry?.Status).toBe("Verified");

      await sns.send(
        new DeleteSMSSandboxPhoneNumberCommand({ PhoneNumber: "+15555550150" }),
      );
      list = await sns.send(new ListSMSSandboxPhoneNumbersCommand({}));
      expect(list.PhoneNumbers?.map((p) => p.PhoneNumber)).not.toContain(
        "+15555550150",
      );
    });

    it("rejects a bad OTP on verify", async () => {
      await sns.send(
        new CreateSMSSandboxPhoneNumberCommand({ PhoneNumber: "+15555550151" }),
      );
      await expectError(
        sns.send(
          new VerifySMSSandboxPhoneNumberCommand({
            PhoneNumber: "+15555550151",
            OneTimePassword: "000000",
          }),
        ),
        "VerificationException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Platform applications", () => {
    async function createApp(name = "gcm-app") {
      const res = await sns.send(
        new CreatePlatformApplicationCommand({
          Name: name,
          Platform: "GCM",
          Attributes: { PlatformCredential: "secret" },
        }),
      );
      return res.PlatformApplicationArn as string;
    }

    it("creates a platform application", async () => {
      const arn = await createApp();
      expect(arn).toContain("app/GCM/gcm-app");
    });

    it("gets and sets platform application attributes", async () => {
      const arn = await createApp("gcm-attr");
      await sns.send(
        new SetPlatformApplicationAttributesCommand({
          PlatformApplicationArn: arn,
          Attributes: { Enabled: "false" },
        }),
      );
      const res = await sns.send(
        new GetPlatformApplicationAttributesCommand({
          PlatformApplicationArn: arn,
        }),
      );
      expect(res.Attributes?.Enabled).toBe("false");
    });

    it("lists platform applications", async () => {
      const arn = await createApp("gcm-list");
      const res = await sns.send(new ListPlatformApplicationsCommand({}));
      expect(
        res.PlatformApplications?.map((a) => a.PlatformApplicationArn),
      ).toContain(arn);
    });

    it("deletes a platform application", async () => {
      const arn = await createApp("gcm-del");
      await sns.send(
        new DeletePlatformApplicationCommand({ PlatformApplicationArn: arn }),
      );
      expect(server.platformApplications.has(arn)).toBe(false);
    });

    it("throws NotFound for a missing application", async () => {
      await expectError(
        sns.send(
          new GetPlatformApplicationAttributesCommand({
            PlatformApplicationArn: "arn:aws:sns:us-east-1:000000000000:app/GCM/ghost",
          }),
        ),
        "NotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Platform endpoints", () => {
    async function createApp() {
      const res = await sns.send(
        new CreatePlatformApplicationCommand({
          Name: "ep-app",
          Platform: "APNS",
          Attributes: {},
        }),
      );
      return res.PlatformApplicationArn as string;
    }

    it("creates a platform endpoint", async () => {
      const appArn = await createApp();
      const res = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "device-token-1",
          CustomUserData: "user-42",
        }),
      );
      expect(res.EndpointArn).toContain("endpoint/APNS");
    });

    it("is idempotent for the same token", async () => {
      const appArn = await createApp();
      const a = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "dup-token",
        }),
      );
      const b = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "dup-token",
        }),
      );
      expect(a.EndpointArn).toBe(b.EndpointArn);
    });

    it("gets and sets endpoint attributes", async () => {
      const appArn = await createApp();
      const ep = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "attr-token",
        }),
      );
      await sns.send(
        new SetEndpointAttributesCommand({
          EndpointArn: ep.EndpointArn,
          Attributes: { Enabled: "false" },
        }),
      );
      const res = await sns.send(
        new GetEndpointAttributesCommand({ EndpointArn: ep.EndpointArn }),
      );
      expect(res.Attributes?.Enabled).toBe("false");
      expect(res.Attributes?.Token).toBe("attr-token");
    });

    it("lists endpoints by platform application", async () => {
      const appArn = await createApp();
      await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "list-token-1",
        }),
      );
      await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "list-token-2",
        }),
      );
      const res = await sns.send(
        new ListEndpointsByPlatformApplicationCommand({
          PlatformApplicationArn: appArn,
        }),
      );
      expect(res.Endpoints).toHaveLength(2);
    });

    it("deletes an endpoint", async () => {
      const appArn = await createApp();
      const ep = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "del-token",
        }),
      );
      await sns.send(
        new DeleteEndpointCommand({ EndpointArn: ep.EndpointArn }),
      );
      expect(server.platformEndpoints.has(ep.EndpointArn as string)).toBe(false);
    });

    it("publishes to a platform endpoint via TargetArn", async () => {
      const appArn = await createApp();
      const ep = await sns.send(
        new CreatePlatformEndpointCommand({
          PlatformApplicationArn: appArn,
          Token: "pub-token",
        }),
      );
      const res = await sns.send(
        new PublishCommand({ TargetArn: ep.EndpointArn, Message: "push!" }),
      );
      expect(res.MessageId).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  describe("Error wire format", () => {
    it("returns an InvalidAction-style error for an unknown action", async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=BogusAction&Version=2010-03-31",
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("<Code>InvalidAction</Code>");
      expect(text).toContain("<Type>Sender</Type>");
    });
  });
});
