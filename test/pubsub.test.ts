import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { PubsubServer } from "../services/pubsub/src/server.js";

// A lightweight, dependency-free fake of Google Cloud Pub/Sub exercised through
// the real `@google-cloud/pubsub` client over its HTTP/1.1 REST transport (the
// google-gax `fallback` mode). Mirrors the structure/style of
// tests/redis.test.ts and tests/postgres.test.ts.

const PORT = 14582;
const HOST = `127.0.0.1:${PORT}`;
const PROJECT = "parlel";

// The Pub/Sub client must see the emulator host before it is constructed.
process.env.PUBSUB_EMULATOR_HOST = HOST;
process.env.PUBSUB_PROJECT_ID = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT = PROJECT;

// A real RSA key so client-side JWT signing for credentials works without any
// network access. The parlel fake never validates the token.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const CREDENTIALS = {
  client_email: "parlel@parlel.iam.gserviceaccount.com",
  private_key: PRIVATE_KEY_PEM,
};

// Imported lazily after the env var is set.
let PubSub: any;
let v1: any;

let server: PubsubServer;
let pubsub: any;
let subscriberClient: any;
let publisherClient: any;
let schemaClient: any;

const COMMON_OPTS = {
  projectId: PROJECT,
  fallback: true as const,
  protocol: "http" as const,
  credentials: CREDENTIALS,
};

// Low-level gapic clients need the endpoint explicitly (only the high-level
// PubSub wrapper auto-reads PUBSUB_EMULATOR_HOST).
const GAPIC_OPTS = {
  ...COMMON_OPTS,
  apiEndpoint: "127.0.0.1",
  port: PORT,
};

function topicPath(id: string): string {
  return `projects/${PROJECT}/topics/${id}`;
}
function subPath(id: string): string {
  return `projects/${PROJECT}/subscriptions/${id}`;
}
function snapPath(id: string): string {
  return `projects/${PROJECT}/snapshots/${id}`;
}

// Raw HTTP helper for the internal endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resetServer(): Promise<void> {
  await rawRequest({ method: "POST", path: "/_parlel/reset" });
}

// Convenience: publish via the low-level PublisherClient (REST).
async function publishRaw(
  topicId: string,
  messages: Array<{ data?: string; attributes?: Record<string, string>; orderingKey?: string }>,
): Promise<string[]> {
  const [resp] = await publisherClient.publish({
    topic: topicPath(topicId),
    messages: messages.map((m) => ({
      data: m.data !== undefined ? Buffer.from(m.data) : undefined,
      attributes: m.attributes,
      orderingKey: m.orderingKey,
    })),
  });
  return resp.messageIds;
}

async function pullRaw(subId: string, maxMessages = 10): Promise<any[]> {
  const [resp] = await subscriberClient.pull({
    subscription: subPath(subId),
    maxMessages,
  });
  return resp.receivedMessages || [];
}

describe("Pub/Sub Service", () => {
  beforeAll(async () => {
    const mod: any = await import("@google-cloud/pubsub");
    PubSub = mod.PubSub;
    v1 = mod.v1;

    server = new PubsubServer(PORT, { projectId: PROJECT });
    await server.start();

    pubsub = new PubSub(COMMON_OPTS);
    publisherClient = new v1.PublisherClient(GAPIC_OPTS);
    subscriberClient = new v1.SubscriberClient(GAPIC_OPTS);
    schemaClient = new v1.SchemaServiceClient(GAPIC_OPTS);
  }, 30000);

  afterAll(async () => {
    for (const c of [pubsub, publisherClient, subscriberClient, schemaClient]) {
      try {
        if (c && typeof c.close === "function") await c.close();
      } catch {
        /* ignore */
      }
    }
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -------------------------------------------------------------------------
  describe("Server / health", () => {
    it("exposes the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("responds to the health endpoint", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("pubsub");
    });

    it("resets in-memory state", async () => {
      await pubsub.createTopic("reset-topic");
      let res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).topics).toBeGreaterThan(0);
      await resetServer();
      res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).topics).toBe(0);
    });

    it("dumps internal state", async () => {
      await pubsub.createTopic("dump-topic");
      const res = await rawRequest({ path: "/_parlel/dump" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.topics.some((t: any) => t.name === topicPath("dump-topic"))).toBe(true);
    });

    it("404s unknown paths", async () => {
      const res = await rawRequest({ path: "/nope" });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Topics", () => {
    it("creates a topic (CreateTopic)", async () => {
      const [topic] = await pubsub.createTopic("t-create");
      expect(topic.name).toBe(topicPath("t-create"));
    });

    it("rejects duplicate topic (ALREADY_EXISTS)", async () => {
      await pubsub.createTopic("t-dup");
      // Over the REST fallback transport a create-conflict surfaces as a
      // non-retryable FAILED_PRECONDITION (code 9); the underlying service
      // semantic is ALREADY_EXISTS.
      await expect(pubsub.createTopic("t-dup")).rejects.toMatchObject({ code: 9 });
    });

    it("rejects invalid topic name (INVALID_ARGUMENT)", async () => {
      await expect(
        publisherClient.createTopic({ name: topicPath("ab") }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("gets a topic (GetTopic)", async () => {
      await pubsub.createTopic("t-get");
      const [topic] = await pubsub.topic("t-get").get();
      const [meta] = await topic.getMetadata();
      expect(meta.name).toBe(topicPath("t-get"));
    });

    it("returns NOT_FOUND for a missing topic", async () => {
      await expect(pubsub.topic("t-missing").getMetadata()).rejects.toMatchObject({ code: 5 });
    });

    it("creates a topic with labels and updates it (UpdateTopic)", async () => {
      await publisherClient.createTopic({ name: topicPath("t-upd"), labels: { env: "test" } });
      const [updated] = await publisherClient.updateTopic({
        topic: { name: topicPath("t-upd"), labels: { env: "prod", team: "core" } },
        updateMask: { paths: ["labels"] },
      });
      expect(updated.labels).toEqual({ env: "prod", team: "core" });
    });

    it("lists topics (ListTopics)", async () => {
      await pubsub.createTopic("t-list-a");
      await pubsub.createTopic("t-list-b");
      const [topics] = await pubsub.getTopics();
      const names = topics.map((t: any) => t.name).sort();
      expect(names).toEqual([topicPath("t-list-a"), topicPath("t-list-b")]);
    });

    it("paginates topics (ListTopics pageToken)", async () => {
      for (let i = 0; i < 5; i++) await pubsub.createTopic(`t-page-${i}`);
      const [resp] = await publisherClient.listTopics({
        project: `projects/${PROJECT}`,
        pageSize: 2,
      });
      expect(resp.length).toBe(5); // gax auto-pages by default
    });

    it("deletes a topic (DeleteTopic)", async () => {
      await pubsub.createTopic("t-del");
      await pubsub.topic("t-del").delete();
      await expect(pubsub.topic("t-del").getMetadata()).rejects.toMatchObject({ code: 5 });
    });

    it("returns NOT_FOUND when deleting a missing topic", async () => {
      await expect(pubsub.topic("t-del-missing").delete()).rejects.toMatchObject({ code: 5 });
    });

    it("lists subscriptions for a topic (ListTopicSubscriptions)", async () => {
      const [topic] = await pubsub.createTopic("t-subs");
      await topic.createSubscription("s-of-topic");
      const [resp] = await publisherClient.listTopicSubscriptions({ topic: topicPath("t-subs") });
      expect(resp).toContain(subPath("s-of-topic"));
    });

    it("lists snapshots for a topic (ListTopicSnapshots)", async () => {
      const [topic] = await pubsub.createTopic("t-snaps");
      await topic.createSubscription("s-for-snap");
      await subscriberClient.createSnapshot({ name: snapPath("snap-of-topic"), subscription: subPath("s-for-snap") });
      const [resp] = await publisherClient.listTopicSnapshots({ topic: topicPath("t-snaps") });
      expect(resp).toContain(snapPath("snap-of-topic"));
    });
  });

  // -------------------------------------------------------------------------
  describe("Publish", () => {
    it("publishes a message and returns a messageId (Publish)", async () => {
      await pubsub.createTopic("p-basic");
      const ids = await publishRaw("p-basic", [{ data: "hello" }]);
      expect(ids).toHaveLength(1);
      expect(ids[0]).toBeTruthy();
    });

    it("publishes multiple messages", async () => {
      await pubsub.createTopic("p-multi");
      const ids = await publishRaw("p-multi", [{ data: "a" }, { data: "b" }, { data: "c" }]);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it("publishes with attributes and orderingKey", async () => {
      const [topic] = await pubsub.createTopic("p-attrs");
      await topic.createSubscription("p-attrs-sub");
      await publishRaw("p-attrs", [{ data: "payload", attributes: { k: "v" }, orderingKey: "ok1" }]);
      const msgs = await pullRaw("p-attrs-sub");
      expect(msgs).toHaveLength(1);
      expect(Buffer.from(msgs[0].message.data, "base64").toString()).toBe("payload");
      expect(msgs[0].message.attributes).toEqual({ k: "v" });
      expect(msgs[0].message.orderingKey).toBe("ok1");
    });

    it("rejects publish to a missing topic (NOT_FOUND)", async () => {
      await expect(publishRaw("p-missing", [{ data: "x" }])).rejects.toMatchObject({ code: 5 });
    });

    it("rejects an empty message (INVALID_ARGUMENT)", async () => {
      await pubsub.createTopic("p-empty");
      await expect(
        publisherClient.publish({ topic: topicPath("p-empty"), messages: [{}] }),
      ).rejects.toMatchObject({ code: 3 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Subscriptions", () => {
    it("creates a subscription (CreateSubscription)", async () => {
      const [topic] = await pubsub.createTopic("s-topic");
      const [sub] = await topic.createSubscription("s-create");
      expect(sub.name).toBe(subPath("s-create"));
    });

    it("rejects subscription on a missing topic (NOT_FOUND)", async () => {
      await expect(
        subscriberClient.createSubscription({ name: subPath("s-orphan"), topic: topicPath("nope-topic") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("rejects duplicate subscription (ALREADY_EXISTS)", async () => {
      const [topic] = await pubsub.createTopic("s-dup-topic");
      await topic.createSubscription("s-dup");
      // Create-conflict surfaces as FAILED_PRECONDITION (code 9) over REST.
      await expect(topic.createSubscription("s-dup")).rejects.toMatchObject({ code: 9 });
    });

    it("rejects an out-of-range ackDeadline (INVALID_ARGUMENT)", async () => {
      await pubsub.createTopic("s-bad-ack-topic");
      await expect(
        subscriberClient.createSubscription({
          name: subPath("s-bad-ack"),
          topic: topicPath("s-bad-ack-topic"),
          ackDeadlineSeconds: 5,
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("creates with rich config (push, filter, retry, dead-letter, ordering)", async () => {
      await pubsub.createTopic("s-rich-topic");
      await pubsub.createTopic("s-dlq");
      const [sub] = await subscriberClient.createSubscription({
        name: subPath("s-rich"),
        topic: topicPath("s-rich-topic"),
        ackDeadlineSeconds: 30,
        retainAckedMessages: true,
        enableMessageOrdering: true,
        filter: 'attributes.tier = "gold"',
        pushConfig: { pushEndpoint: "https://example.com/push" },
        deadLetterPolicy: { deadLetterTopic: topicPath("s-dlq"), maxDeliveryAttempts: 5 },
        retryPolicy: { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } },
      });
      expect(sub.ackDeadlineSeconds).toBe(30);
      expect(sub.filter).toBe('attributes.tier = "gold"');
      expect(sub.pushConfig.pushEndpoint).toBe("https://example.com/push");
      expect(sub.deadLetterPolicy.maxDeliveryAttempts).toBe(5);
      expect(sub.enableMessageOrdering).toBe(true);
    });

    it("gets a subscription (GetSubscription)", async () => {
      const [topic] = await pubsub.createTopic("s-get-topic");
      await topic.createSubscription("s-get");
      const [meta] = await subscriberClient.getSubscription({ subscription: subPath("s-get") });
      expect(meta.name).toBe(subPath("s-get"));
      expect(meta.topic).toBe(topicPath("s-get-topic"));
    });

    it("returns NOT_FOUND for a missing subscription", async () => {
      await expect(
        subscriberClient.getSubscription({ subscription: subPath("s-missing") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("updates a subscription (UpdateSubscription)", async () => {
      await pubsub.createTopic("s-upd-topic");
      await subscriberClient.createSubscription({
        name: subPath("s-upd"),
        topic: topicPath("s-upd-topic"),
        ackDeadlineSeconds: 10,
      });
      const [updated] = await subscriberClient.updateSubscription({
        subscription: { name: subPath("s-upd"), ackDeadlineSeconds: 60, labels: { x: "y" } },
        updateMask: { paths: ["ackDeadlineSeconds", "labels"] },
      });
      expect(updated.ackDeadlineSeconds).toBe(60);
      expect(updated.labels).toEqual({ x: "y" });
    });

    it("lists subscriptions (ListSubscriptions)", async () => {
      const [topic] = await pubsub.createTopic("s-list-topic");
      await topic.createSubscription("s-list-a");
      await topic.createSubscription("s-list-b");
      const [subs] = await pubsub.getSubscriptions();
      const names = subs.map((s: any) => s.name).sort();
      expect(names).toContain(subPath("s-list-a"));
      expect(names).toContain(subPath("s-list-b"));
    });

    it("deletes a subscription (DeleteSubscription)", async () => {
      const [topic] = await pubsub.createTopic("s-del-topic");
      await topic.createSubscription("s-del");
      await subscriberClient.deleteSubscription({ subscription: subPath("s-del") });
      await expect(
        subscriberClient.getSubscription({ subscription: subPath("s-del") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("detaches a subscription (DetachSubscription)", async () => {
      const [topic] = await pubsub.createTopic("s-detach-topic");
      await topic.createSubscription("s-detach");
      await publisherClient.detachSubscription({ subscription: subPath("s-detach") });
      const [meta] = await subscriberClient.getSubscription({ subscription: subPath("s-detach") });
      expect(meta.detached).toBe(true);
    });

    it("modifies push config (ModifyPushConfig)", async () => {
      const [topic] = await pubsub.createTopic("s-push-topic");
      await topic.createSubscription("s-push");
      await subscriberClient.modifyPushConfig({
        subscription: subPath("s-push"),
        pushConfig: { pushEndpoint: "https://example.com/hook" },
      });
      const [meta] = await subscriberClient.getSubscription({ subscription: subPath("s-push") });
      expect(meta.pushConfig.pushEndpoint).toBe("https://example.com/hook");
    });
  });

  // -------------------------------------------------------------------------
  describe("Pull / Acknowledge / ModifyAckDeadline", () => {
    async function setup(topicId: string, subId: string) {
      const [topic] = await pubsub.createTopic(topicId);
      await topic.createSubscription(subId);
      return topic;
    }

    it("pulls a published message (Pull)", async () => {
      await setup("pl-topic", "pl-sub");
      await publishRaw("pl-topic", [{ data: "msg1" }]);
      const msgs = await pullRaw("pl-sub");
      expect(msgs).toHaveLength(1);
      expect(Buffer.from(msgs[0].message.data, "base64").toString()).toBe("msg1");
      expect(msgs[0].ackId).toBeTruthy();
    });

    it("returns no messages when backlog is empty", async () => {
      await setup("pl-empty-topic", "pl-empty-sub");
      const msgs = await pullRaw("pl-empty-sub");
      expect(msgs).toHaveLength(0);
    });

    it("respects maxMessages", async () => {
      await setup("pl-max-topic", "pl-max-sub");
      await publishRaw("pl-max-topic", [{ data: "1" }, { data: "2" }, { data: "3" }]);
      const msgs = await pullRaw("pl-max-sub", 2);
      expect(msgs).toHaveLength(2);
    });

    it("acknowledges messages so they are not redelivered (Acknowledge)", async () => {
      await setup("ack-topic", "ack-sub");
      await publishRaw("ack-topic", [{ data: "to-ack" }]);
      const msgs = await pullRaw("ack-sub");
      await subscriberClient.acknowledge({
        subscription: subPath("ack-sub"),
        ackIds: msgs.map((m: any) => m.ackId),
      });
      const again = await pullRaw("ack-sub");
      expect(again).toHaveLength(0);
    });

    it("redelivers when ack deadline is set to 0 via ModifyAckDeadline (nack)", async () => {
      await setup("nack-topic", "nack-sub");
      await publishRaw("nack-topic", [{ data: "to-nack" }]);
      const msgs = await pullRaw("nack-sub");
      await subscriberClient.modifyAckDeadline({
        subscription: subPath("nack-sub"),
        ackIds: msgs.map((m: any) => m.ackId),
        ackDeadlineSeconds: 0,
      });
      const again = await pullRaw("nack-sub");
      expect(again).toHaveLength(1);
    });

    it("extends the ack deadline (ModifyAckDeadline)", async () => {
      await setup("ext-topic", "ext-sub");
      await publishRaw("ext-topic", [{ data: "to-extend" }]);
      const msgs = await pullRaw("ext-sub");
      await expect(
        subscriberClient.modifyAckDeadline({
          subscription: subPath("ext-sub"),
          ackIds: msgs.map((m: any) => m.ackId),
          ackDeadlineSeconds: 60,
        }),
      ).resolves.toBeTruthy();
      // Still outstanding (not redelivered) immediately after extending.
      const again = await pullRaw("ext-sub");
      expect(again).toHaveLength(0);
    });

    it("rejects pull on a missing subscription (NOT_FOUND)", async () => {
      await expect(pullRaw("pl-missing-sub")).rejects.toMatchObject({ code: 5 });
    });

    it("reports deliveryAttempt when a dead-letter policy is set", async () => {
      await pubsub.createTopic("dl-topic");
      await pubsub.createTopic("dl-dlq");
      await subscriberClient.createSubscription({
        name: subPath("dl-sub"),
        topic: topicPath("dl-topic"),
        deadLetterPolicy: { deadLetterTopic: topicPath("dl-dlq"), maxDeliveryAttempts: 5 },
      });
      await publishRaw("dl-topic", [{ data: "dl-msg" }]);
      const msgs = await pullRaw("dl-sub");
      expect(msgs[0].deliveryAttempt).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("Snapshots", () => {
    async function setupSub(topicId: string, subId: string) {
      const [topic] = await pubsub.createTopic(topicId);
      await topic.createSubscription(subId);
    }

    it("creates a snapshot (CreateSnapshot)", async () => {
      await setupSub("snap-topic", "snap-sub");
      const [snap] = await subscriberClient.createSnapshot({
        name: snapPath("snap-create"),
        subscription: subPath("snap-sub"),
      });
      expect(snap.name).toBe(snapPath("snap-create"));
      expect(snap.topic).toBe(topicPath("snap-topic"));
    });

    it("rejects a snapshot on a missing subscription (NOT_FOUND)", async () => {
      await expect(
        subscriberClient.createSnapshot({ name: snapPath("snap-orphan"), subscription: subPath("nope-sub") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("gets a snapshot (GetSnapshot)", async () => {
      await setupSub("snap-get-topic", "snap-get-sub");
      await subscriberClient.createSnapshot({ name: snapPath("snap-get"), subscription: subPath("snap-get-sub") });
      const [snap] = await subscriberClient.getSnapshot({ snapshot: snapPath("snap-get") });
      expect(snap.name).toBe(snapPath("snap-get"));
    });

    it("lists snapshots (ListSnapshots)", async () => {
      await setupSub("snap-list-topic", "snap-list-sub");
      await subscriberClient.createSnapshot({ name: snapPath("snap-list-a"), subscription: subPath("snap-list-sub") });
      const [snaps] = await subscriberClient.listSnapshots({ project: `projects/${PROJECT}` });
      expect(snaps.map((s: any) => s.name)).toContain(snapPath("snap-list-a"));
    });

    it("updates a snapshot (UpdateSnapshot)", async () => {
      await setupSub("snap-upd-topic", "snap-upd-sub");
      await subscriberClient.createSnapshot({ name: snapPath("snap-upd"), subscription: subPath("snap-upd-sub") });
      const [updated] = await subscriberClient.updateSnapshot({
        snapshot: { name: snapPath("snap-upd"), labels: { env: "test" } },
        updateMask: { paths: ["labels"] },
      });
      expect(updated.labels).toEqual({ env: "test" });
    });

    it("deletes a snapshot (DeleteSnapshot)", async () => {
      await setupSub("snap-del-topic", "snap-del-sub");
      await subscriberClient.createSnapshot({ name: snapPath("snap-del"), subscription: subPath("snap-del-sub") });
      await subscriberClient.deleteSnapshot({ snapshot: snapPath("snap-del") });
      await expect(
        subscriberClient.getSnapshot({ snapshot: snapPath("snap-del") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("seeks a subscription to a snapshot (Seek by snapshot)", async () => {
      await setupSub("seek-topic", "seek-sub");
      await publishRaw("seek-topic", [{ data: "seek-msg" }]);
      // Snapshot captures the unacked backlog.
      await subscriberClient.createSnapshot({ name: snapPath("seek-snap"), subscription: subPath("seek-sub") });
      // Pull + ack drains the backlog.
      const msgs = await pullRaw("seek-sub");
      await subscriberClient.acknowledge({ subscription: subPath("seek-sub"), ackIds: msgs.map((m: any) => m.ackId) });
      expect(await pullRaw("seek-sub")).toHaveLength(0);
      // Seek back to the snapshot restores the message.
      await subscriberClient.seek({ subscription: subPath("seek-sub"), snapshot: snapPath("seek-snap") });
      const restored = await pullRaw("seek-sub");
      expect(restored).toHaveLength(1);
    });

    it("seeks a subscription to a time (Seek by time)", async () => {
      await setupSub("seek-time-topic", "seek-time-sub");
      await publishRaw("seek-time-topic", [{ data: "time-msg" }]);
      const msgs = await pullRaw("seek-time-sub");
      // Seek to now re-queues outstanding messages.
      await subscriberClient.seek({
        subscription: subPath("seek-time-sub"),
        time: { seconds: Math.floor(Date.now() / 1000) },
      });
      const restored = await pullRaw("seek-time-sub");
      expect(restored.length).toBeGreaterThanOrEqual(1);
      expect(msgs).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("Schemas", () => {
    const AVRO_DEF = JSON.stringify({
      type: "record",
      name: "Avro",
      fields: [{ name: "name", type: "string" }],
    });

    it("creates a schema (CreateSchema)", async () => {
      const [schema] = await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-create",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      expect(schema.name).toBe(`projects/${PROJECT}/schemas/sc-create`);
      expect(schema.type).toBe("AVRO");
      expect(schema.revisionId).toBeTruthy();
    });

    it("rejects an invalid AVRO schema (INVALID_ARGUMENT)", async () => {
      await expect(
        schemaClient.createSchema({
          parent: `projects/${PROJECT}`,
          schemaId: "sc-bad",
          schema: { type: "AVRO", definition: "{not json" },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("gets a schema (GetSchema)", async () => {
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-get",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      const [schema] = await schemaClient.getSchema({ name: `projects/${PROJECT}/schemas/sc-get` });
      expect(schema.definition).toBe(AVRO_DEF);
    });

    it("returns NOT_FOUND for a missing schema", async () => {
      await expect(
        schemaClient.getSchema({ name: `projects/${PROJECT}/schemas/sc-missing` }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("lists schemas (ListSchemas)", async () => {
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-list",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      const [schemas] = await schemaClient.listSchemas({ parent: `projects/${PROJECT}` });
      expect(schemas.map((s: any) => s.name)).toContain(`projects/${PROJECT}/schemas/sc-list`);
    });

    it("commits a new revision and lists revisions (CommitSchema/ListSchemaRevisions)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-rev`;
      const [first] = await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-rev",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      const newDef = JSON.stringify({
        type: "record",
        name: "Avro",
        fields: [
          { name: "name", type: "string" },
          { name: "age", type: "int" },
        ],
      });
      const [committed] = await schemaClient.commitSchema({
        name,
        schema: { name, type: "AVRO", definition: newDef },
      });
      expect(committed.revisionId).not.toBe(first.revisionId);
      const [revs] = await schemaClient.listSchemaRevisions({ name });
      expect(revs.length).toBe(2);
    });

    it("rolls back to a previous revision (RollbackSchema)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-roll`;
      const [first] = await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-roll",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      const def2 = JSON.stringify({ type: "record", name: "Avro", fields: [{ name: "x", type: "int" }] });
      await schemaClient.commitSchema({ name, schema: { name, type: "AVRO", definition: def2 } });
      const [rolled] = await schemaClient.rollbackSchema({ name, revisionId: first.revisionId });
      expect(rolled.definition).toBe(AVRO_DEF);
    });

    it("deletes a schema revision (DeleteSchemaRevision)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-delrev`;
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-delrev",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      const def2 = JSON.stringify({ type: "record", name: "Avro", fields: [{ name: "x", type: "int" }] });
      const [committed] = await schemaClient.commitSchema({ name, schema: { name, type: "AVRO", definition: def2 } });
      await schemaClient.deleteSchemaRevision({ name, revisionId: committed.revisionId });
      const [revs] = await schemaClient.listSchemaRevisions({ name });
      expect(revs.length).toBe(1);
    });

    it("validates a schema (ValidateSchema)", async () => {
      await expect(
        schemaClient.validateSchema({
          parent: `projects/${PROJECT}`,
          schema: { type: "AVRO", definition: AVRO_DEF },
        }),
      ).resolves.toBeTruthy();
    });

    it("rejects validation of a malformed schema", async () => {
      await expect(
        schemaClient.validateSchema({
          parent: `projects/${PROJECT}`,
          schema: { type: "AVRO", definition: "nope" },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("validates a message against a schema (ValidateMessage)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-msg`;
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-msg",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      await expect(
        schemaClient.validateMessage({
          parent: `projects/${PROJECT}`,
          name,
          message: Buffer.from(JSON.stringify({ name: "ok" })),
          encoding: "JSON",
        }),
      ).resolves.toBeTruthy();
    });

    it("rejects an invalid message (ValidateMessage)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-msg-bad`;
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-msg-bad",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      await expect(
        schemaClient.validateMessage({
          parent: `projects/${PROJECT}`,
          name,
          message: Buffer.from("not json at all {"),
          encoding: "JSON",
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("deletes a schema (DeleteSchema)", async () => {
      const name = `projects/${PROJECT}/schemas/sc-del`;
      await schemaClient.createSchema({
        parent: `projects/${PROJECT}`,
        schemaId: "sc-del",
        schema: { type: "AVRO", definition: AVRO_DEF },
      });
      await schemaClient.deleteSchema({ name });
      await expect(schemaClient.getSchema({ name })).rejects.toMatchObject({ code: 5 });
    });
  });

  // -------------------------------------------------------------------------
  describe("IAM", () => {
    it("gets a default (empty) IAM policy (GetIamPolicy)", async () => {
      await pubsub.createTopic("iam-topic");
      const [policy] = await publisherClient.getIamPolicy({ resource: topicPath("iam-topic") });
      expect(policy.bindings).toEqual([]);
      expect(policy.etag).toBeTruthy();
    });

    it("sets and reads back an IAM policy (SetIamPolicy)", async () => {
      await pubsub.createTopic("iam-set-topic");
      const bindings = [{ role: "roles/pubsub.publisher", members: ["user:a@example.com"] }];
      await publisherClient.setIamPolicy({
        resource: topicPath("iam-set-topic"),
        policy: { bindings },
      });
      const [policy] = await publisherClient.getIamPolicy({ resource: topicPath("iam-set-topic") });
      expect(policy.bindings[0].role).toBe("roles/pubsub.publisher");
      expect(policy.bindings[0].members).toEqual(["user:a@example.com"]);
    });

    it("tests IAM permissions (TestIamPermissions)", async () => {
      await pubsub.createTopic("iam-test-topic");
      const [resp] = await publisherClient.testIamPermissions({
        resource: topicPath("iam-test-topic"),
        permissions: ["pubsub.topics.publish", "pubsub.topics.get"],
      });
      expect(resp.permissions).toEqual(["pubsub.topics.publish", "pubsub.topics.get"]);
    });

    it("returns NOT_FOUND for IAM on a missing resource", async () => {
      await expect(
        publisherClient.getIamPolicy({ resource: topicPath("iam-missing") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -------------------------------------------------------------------------
  describe("End-to-end flow", () => {
    it("publish -> pull -> ack across the high-level + low-level clients", async () => {
      const [topic] = await pubsub.createTopic("e2e-topic");
      await topic.createSubscription("e2e-sub");
      await publishRaw("e2e-topic", [
        { data: "one", attributes: { seq: "1" } },
        { data: "two", attributes: { seq: "2" } },
      ]);
      const msgs = await pullRaw("e2e-sub");
      expect(msgs).toHaveLength(2);
      const decoded = msgs
        .map((m: any) => Buffer.from(m.message.data, "base64").toString())
        .sort();
      expect(decoded).toEqual(["one", "two"]);
      await subscriberClient.acknowledge({
        subscription: subPath("e2e-sub"),
        ackIds: msgs.map((m: any) => m.ackId),
      });
      expect(await pullRaw("e2e-sub")).toHaveLength(0);
    });
  });
});
