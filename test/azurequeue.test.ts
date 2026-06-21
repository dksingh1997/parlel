import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  QueueServiceClient,
  QueueClient,
  StorageSharedKeyCredential,
} from "@azure/storage-queue";
import { AzurequeueServer } from "../services/azurequeue/src/server.js";

const PORT = 14593;
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const ENDPOINT = `http://127.0.0.1:${PORT}/${ACCOUNT}`;

function makeService(): QueueServiceClient {
  const cred = new StorageSharedKeyCredential(ACCOUNT, KEY);
  return new QueueServiceClient(ENDPOINT, cred, {
    retryOptions: { maxTries: 1 },
  });
}

let server: AzurequeueServer;
let svc: QueueServiceClient;
let counter = 0;
function uniqueQueue(): string {
  counter += 1;
  return `q-${Date.now().toString(36)}-${counter}`.toLowerCase().slice(0, 40);
}

describe("Azure Queue Storage Service", () => {
  beforeAll(async () => {
    server = new AzurequeueServer(PORT);
    await server.start();
    svc = makeService();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // -----------------------------------------------------------------------
  // Health / reset
  // -----------------------------------------------------------------------
  describe("internal endpoints", () => {
    it("responds to health", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("azurequeue");
    });

    it("resets state via POST /_parlel/reset", async () => {
      await svc.getQueueClient(uniqueQueue()).create();
      const res = await fetch(`http://127.0.0.1:${PORT}/_parlel/reset`, {
        method: "POST",
      });
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Service-level operations
  // -----------------------------------------------------------------------
  describe("QueueServiceClient", () => {
    it("getProperties returns service properties", async () => {
      const props = await svc.getProperties();
      expect(props).toBeDefined();
      expect(props.cors).toBeDefined();
    });

    it("setProperties succeeds", async () => {
      const resp = await svc.setProperties({
        queueAnalyticsLogging: {
          version: "1.0",
          deleteProperty: false,
          read: false,
          write: false,
          retentionPolicy: { enabled: false },
        },
      });
      expect(resp._response.status).toBe(202);
    });

    it("getStatistics returns geo-replication info", async () => {
      const stats = await svc.getStatistics();
      expect(stats.geoReplication?.status).toBe("live");
    });

    it("createQueue and deleteQueue via service client", async () => {
      const name = uniqueQueue();
      const created = await svc.createQueue(name);
      expect(created._response.status).toBe(201);
      const del = await svc.deleteQueue(name);
      expect(del._response.status).toBe(204);
    });

    it("listQueues enumerates queues", async () => {
      const names = [uniqueQueue(), uniqueQueue(), uniqueQueue()];
      for (const n of names) await svc.getQueueClient(n).create();
      const seen: string[] = [];
      for await (const item of svc.listQueues()) {
        seen.push(item.name);
      }
      for (const n of names) expect(seen).toContain(n);
    });

    it("listQueues with prefix filters", async () => {
      const prefix = `pf${Date.now().toString(36)}`;
      const a = `${prefix}-aaa`;
      const b = `${prefix}-bbb`;
      const other = uniqueQueue();
      await svc.getQueueClient(a).create();
      await svc.getQueueClient(b).create();
      await svc.getQueueClient(other).create();
      const seen: string[] = [];
      for await (const item of svc.listQueues({ prefix })) {
        seen.push(item.name);
      }
      expect(seen.sort()).toEqual([a, b].sort());
    });

    it("listQueues includeMetadata returns metadata", async () => {
      const name = uniqueQueue();
      await svc.getQueueClient(name).create({ metadata: { color: "blue" } });
      let found: Record<string, string> | undefined;
      for await (const item of svc.listQueues({ includeMetadata: true })) {
        if (item.name === name) found = item.metadata;
      }
      expect(found).toBeDefined();
      expect(found?.color).toBe("blue");
    });

    it("listQueues paginates via byPage", async () => {
      const names = [uniqueQueue(), uniqueQueue(), uniqueQueue(), uniqueQueue()];
      for (const n of names) await svc.getQueueClient(n).create();
      let total = 0;
      for await (const page of svc.listQueues().byPage({ maxPageSize: 2 })) {
        total += page.queueItems?.length ?? 0;
      }
      expect(total).toBeGreaterThanOrEqual(4);
    });

    it("getQueueClient returns a QueueClient", () => {
      const qc = svc.getQueueClient(uniqueQueue());
      expect(qc).toBeInstanceOf(QueueClient);
    });

    it("getUserDelegationKey returns a signed key", async () => {
      const startsOn = new Date();
      const expiresOn = new Date(Date.now() + 3600 * 1000);
      const key = await svc.getUserDelegationKey(startsOn, expiresOn);
      expect(key.value).toBeTruthy();
      expect(key.signedService).toBe("q");
      expect(key.signedStartsOn).toBeInstanceOf(Date);
      expect(key.signedExpiresOn).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Queue-level operations
  // -----------------------------------------------------------------------
  describe("QueueClient lifecycle", () => {
    it("create a queue", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      const resp = await qc.create();
      expect(resp._response.status).toBe(201);
    });

    it("create with metadata", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create({ metadata: { env: "test", owner: "parlel" } });
      const props = await qc.getProperties();
      expect(props.metadata?.env).toBe("test");
      expect(props.metadata?.owner).toBe("parlel");
    });

    it("createIfNotExists is idempotent", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      const first = await qc.createIfNotExists();
      expect(first.succeeded).toBe(true);
      const second = await qc.createIfNotExists();
      expect(second.succeeded).toBe(false);
    });

    it("create twice with conflicting metadata fails", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create({ metadata: { a: "1" } });
      await expect(qc.create({ metadata: { a: "2" } })).rejects.toThrow();
    });

    it("exists returns true/false", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      expect(await qc.exists()).toBe(false);
      await qc.create();
      expect(await qc.exists()).toBe(true);
    });

    it("delete a queue", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      const resp = await qc.delete();
      expect(resp._response.status).toBe(204);
      expect(await qc.exists()).toBe(false);
    });

    it("deleteIfExists handles missing queues", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      const r1 = await qc.deleteIfExists();
      expect(r1.succeeded).toBe(false);
      await qc.create();
      const r2 = await qc.deleteIfExists();
      expect(r2.succeeded).toBe(true);
    });

    it("delete a missing queue throws QueueNotFound", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await expect(qc.delete()).rejects.toMatchObject({ statusCode: 404 });
    });

    it("getProperties on missing queue throws 404", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await expect(qc.getProperties()).rejects.toMatchObject({ statusCode: 404 });
    });

    it("getProperties returns approximateMessagesCount", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      await qc.sendMessage("a");
      await qc.sendMessage("b");
      const props = await qc.getProperties();
      expect(props.approximateMessagesCount).toBe(2);
    });

    it("setMetadata updates metadata", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      await qc.setMetadata({ stage: "prod" });
      const props = await qc.getProperties();
      expect(props.metadata?.stage).toBe("prod");
    });

    it("invalid queue name is rejected", async () => {
      const qc = svc.getQueueClient("Invalid_Name");
      await expect(qc.create()).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // -----------------------------------------------------------------------
  // Access policy (ACL)
  // -----------------------------------------------------------------------
  describe("access policy", () => {
    it("getAccessPolicy returns empty by default", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      const acl = await qc.getAccessPolicy();
      expect(acl.signedIdentifiers).toEqual([]);
    });

    it("setAccessPolicy then getAccessPolicy round-trips", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      const start = new Date("2024-01-01T00:00:00Z");
      const expiry = new Date("2024-12-31T00:00:00Z");
      await qc.setAccessPolicy([
        {
          id: "policy1",
          accessPolicy: {
            startsOn: start,
            expiresOn: expiry,
            permissions: "raup",
          },
        },
      ]);
      const acl = await qc.getAccessPolicy();
      expect(acl.signedIdentifiers.length).toBe(1);
      expect(acl.signedIdentifiers[0].id).toBe("policy1");
      expect(acl.signedIdentifiers[0].accessPolicy.permissions).toBe("raup");
    });

    it("setAccessPolicy on missing queue throws 404", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await expect(
        qc.setAccessPolicy([{ id: "x", accessPolicy: { permissions: "r" } }])
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // -----------------------------------------------------------------------
  // Messages: send / receive / peek / clear
  // -----------------------------------------------------------------------
  describe("messages", () => {
    async function freshQueue(): Promise<QueueClient> {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      return qc;
    }

    it("sendMessage returns id, popReceipt and times", async () => {
      const qc = await freshQueue();
      const r = await qc.sendMessage("hello world");
      expect(r.messageId).toBeTruthy();
      expect(r.popReceipt).toBeTruthy();
      expect(r.insertedOn).toBeInstanceOf(Date);
      expect(r.expiresOn).toBeInstanceOf(Date);
      expect(r.nextVisibleOn).toBeInstanceOf(Date);
    });

    it("receiveMessages returns sent message content", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("payload-1");
      const res = await qc.receiveMessages();
      expect(res.receivedMessageItems.length).toBe(1);
      expect(res.receivedMessageItems[0].messageText).toBe("payload-1");
      expect(res.receivedMessageItems[0].dequeueCount).toBe(1);
      expect(res.receivedMessageItems[0].popReceipt).toBeTruthy();
    });

    it("receiveMessages preserves FIFO order", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("m1");
      await qc.sendMessage("m2");
      await qc.sendMessage("m3");
      const res = await qc.receiveMessages({ numberOfMessages: 3 });
      expect(res.receivedMessageItems.map((m) => m.messageText)).toEqual([
        "m1",
        "m2",
        "m3",
      ]);
    });

    it("receiveMessages hides messages during visibility timeout", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("invisible-soon");
      const first = await qc.receiveMessages({ visibilityTimeout: 30 });
      expect(first.receivedMessageItems.length).toBe(1);
      // Immediately receiving again returns nothing because it's invisible.
      const second = await qc.receiveMessages();
      expect(second.receivedMessageItems.length).toBe(0);
    });

    it("receiveMessages with short visibility re-appears", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("reappear");
      await qc.receiveMessages({ visibilityTimeout: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      const again = await qc.receiveMessages();
      expect(again.receivedMessageItems.length).toBe(1);
      expect(again.receivedMessageItems[0].dequeueCount).toBe(2);
    });

    it("peekMessages does not change visibility", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("peek-me");
      const peek1 = await qc.peekMessages();
      expect(peek1.peekedMessageItems.length).toBe(1);
      expect(peek1.peekedMessageItems[0].messageText).toBe("peek-me");
      // Still receivable since peek doesn't hide it.
      const recv = await qc.receiveMessages();
      expect(recv.receivedMessageItems.length).toBe(1);
    });

    it("peekMessages supports numberOfMessages", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("p1");
      await qc.sendMessage("p2");
      const peek = await qc.peekMessages({ numberOfMessages: 5 });
      expect(peek.peekedMessageItems.length).toBe(2);
    });

    it("sendMessage with visibilityTimeout delays receive", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("delayed", { visibilityTimeout: 30 });
      const recv = await qc.receiveMessages();
      expect(recv.receivedMessageItems.length).toBe(0);
    });

    it("sendMessage respects messageTimeToLive", async () => {
      const qc = await freshQueue();
      const r = await qc.sendMessage("ttl-msg", { messageTimeToLive: 3600 });
      const diff = r.expiresOn.getTime() - r.insertedOn.getTime();
      // ~1 hour in ms (allow slack).
      expect(diff).toBeGreaterThan(3500 * 1000);
      expect(diff).toBeLessThan(3700 * 1000);
    });

    it("sendMessage with TTL -1 never expires", async () => {
      const qc = await freshQueue();
      const r = await qc.sendMessage("forever", { messageTimeToLive: -1 });
      expect(r.expiresOn.getUTCFullYear()).toBeGreaterThanOrEqual(9999);
    });

    it("clearMessages empties the queue", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("x");
      await qc.sendMessage("y");
      const clear = await qc.clearMessages();
      expect(clear._response.status).toBe(204);
      const props = await qc.getProperties();
      expect(props.approximateMessagesCount).toBe(0);
    });

    it("receiveMessages on empty queue returns empty list", async () => {
      const qc = await freshQueue();
      const res = await qc.receiveMessages();
      expect(res.receivedMessageItems).toEqual([]);
    });

    it("sendMessage to missing queue throws 404", async () => {
      const qc = svc.getQueueClient(uniqueQueue());
      await expect(qc.sendMessage("nope")).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("preserves base64-encoded message payloads", async () => {
      // The client (with default config) sends text as-is; verify round-trip.
      const qc = await freshQueue();
      const payload = JSON.stringify({ hello: "wörld", n: 42 });
      await qc.sendMessage(payload);
      const recv = await qc.receiveMessages();
      expect(recv.receivedMessageItems[0].messageText).toBe(payload);
    });
  });

  // -----------------------------------------------------------------------
  // MessageId: update / delete
  // -----------------------------------------------------------------------
  describe("update and delete by message id", () => {
    async function freshQueue(): Promise<QueueClient> {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      return qc;
    }

    it("deleteMessage removes a received message", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("to-delete");
      const recv = await qc.receiveMessages();
      const item = recv.receivedMessageItems[0];
      const del = await qc.deleteMessage(item.messageId, item.popReceipt);
      expect(del._response.status).toBe(204);
      // After deletion, wait out visibility — message should be gone.
      await new Promise((r) => setTimeout(r, 1100));
      const props = await qc.getProperties();
      expect(props.approximateMessagesCount).toBe(0);
    });

    it("deleteMessage with wrong popReceipt throws", async () => {
      const qc = await freshQueue();
      const sent = await qc.sendMessage("guard");
      await expect(
        qc.deleteMessage(sent.messageId, "wrong-pop-receipt")
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("deleteMessage on missing message throws 404", async () => {
      const qc = await freshQueue();
      await expect(
        qc.deleteMessage("00000000-0000-0000-0000-000000000000", "pr")
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("updateMessage changes text and returns new popReceipt", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("old-text");
      const recv = await qc.receiveMessages();
      const item = recv.receivedMessageItems[0];
      const upd = await qc.updateMessage(
        item.messageId,
        item.popReceipt,
        "new-text",
        1
      );
      expect(upd.popReceipt).toBeTruthy();
      expect(upd.popReceipt).not.toBe(item.popReceipt);
      expect(upd.nextVisibleOn).toBeInstanceOf(Date);
      // After visibility expires, the new text should be readable.
      await new Promise((r) => setTimeout(r, 1100));
      const recv2 = await qc.receiveMessages();
      expect(recv2.receivedMessageItems[0].messageText).toBe("new-text");
    });

    it("updateMessage can extend visibility without changing text", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("keep");
      const recv = await qc.receiveMessages({ visibilityTimeout: 1 });
      const item = recv.receivedMessageItems[0];
      await qc.updateMessage(item.messageId, item.popReceipt, "keep", 30);
      // Should still be invisible after the original 1s.
      await new Promise((r) => setTimeout(r, 1100));
      const recv2 = await qc.receiveMessages();
      expect(recv2.receivedMessageItems.length).toBe(0);
    });

    it("updateMessage with stale popReceipt throws", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("stale");
      const recv = await qc.receiveMessages();
      const item = recv.receivedMessageItems[0];
      await expect(
        qc.updateMessage(item.messageId, "stale-receipt", "x", 10)
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // -----------------------------------------------------------------------
  // Raw error shapes
  // -----------------------------------------------------------------------
  describe("error shapes", () => {
    async function freshQueue(): Promise<QueueClient> {
      const qc = svc.getQueueClient(uniqueQueue());
      await qc.create();
      return qc;
    }

    it("returns an XML <Error> body with x-ms-error-code", async () => {
      const res = await fetch(`${ENDPOINT}/${uniqueQueue()}?comp=metadata`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-ms-error-code")).toBe("QueueNotFound");
      const text = await res.text();
      expect(text).toContain("<Code>QueueNotFound</Code>");
      expect(text).toContain("<Message>");
    });

    it("sets x-ms-version and x-ms-request-id headers", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/${ACCOUNT}?comp=properties`);
      expect(res.headers.get("x-ms-version")).toBeTruthy();
      expect(res.headers.get("x-ms-request-id")).toBeTruthy();
    });

    it("invalid queue name returns OutOfRangeInput with 400", async () => {
      const qc = svc.getQueueClient("Invalid_Name");
      try {
        await qc.create();
        expect.fail("should have thrown");
      } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.details?.errorCode).toBe("OutOfRangeInput");
      }
    });

    it("error envelope includes x-ms-error-code header and Code/Message in body", async () => {
      const res = await fetch(`${ENDPOINT}/${uniqueQueue()}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: "<QueueMessage><MessageText>test</MessageText></QueueMessage>",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-ms-error-code")).toBe("QueueNotFound");
      const text = await res.text();
      expect(text).toContain("<?xml version=\"1.0\" encoding=\"utf-8\"?>");
      expect(text).toContain("<Error>");
      expect(text).toContain("<Code>QueueNotFound</Code>");
      expect(text).toContain("<Message>");
      expect(text).toContain("</Error>");
    });

    it("missing popreceipt returns MissingRequiredQueryParameter with extra fields", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("x");
      const recv = await qc.receiveMessages();
      const item = recv.receivedMessageItems[0];
      // Hit the raw endpoint without popreceipt
      const res = await fetch(
        `${ENDPOINT}/${qc.name}/messages/${item.messageId}?visibilitytimeout=10`,
        { method: "PUT" }
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("x-ms-error-code")).toBe("MissingRequiredQueryParameter");
      const text = await res.text();
      expect(text).toContain("<QueryParameterName>popreceipt</QueryParameterName>");
    });

    it("popreceipt mismatch on existing message returns 400 PopReceiptMismatch", async () => {
      const qc = await freshQueue();
      await qc.sendMessage("guard");
      const recv = await qc.receiveMessages();
      const item = recv.receivedMessageItems[0];
      const res = await fetch(
        `${ENDPOINT}/${qc.name}/messages/${item.messageId}?popreceipt=wrong&visibilitytimeout=10`,
        { method: "PUT" }
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("x-ms-error-code")).toBe("PopReceiptMismatch");
    });

    it("deleteMessage on missing message returns 404 MessageNotFound", async () => {
      const qc = await freshQueue();
      const res = await fetch(
        `${ENDPOINT}/${qc.name}/messages/00000000-0000-0000-0000-000000000000?popreceipt=any`,
        { method: "DELETE" }
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("x-ms-error-code")).toBe("MessageNotFound");
    });

    it("method not allowed on messages returns 405", async () => {
      const qc = await freshQueue();
      const res = await fetch(`${ENDPOINT}/${qc.name}/messages`, { method: "PATCH" });
      expect(res.status).toBe(405);
      expect(res.headers.get("x-ms-error-code")).toBe("UnsupportedHttpVerb");
    });

    it("numofmessages out of range returns 400 with parameter details", async () => {
      const qc = await freshQueue();
      const res = await fetch(`${ENDPOINT}/${qc.name}/messages?numofmessages=0`);
      expect(res.status).toBe(400);
      expect(res.headers.get("x-ms-error-code")).toBe("OutOfRangeQueryParameterValue");
      const text = await res.text();
      expect(text).toContain("<QueryParameterName>numofmessages</QueryParameterName>");
      expect(text).toContain("<MinimumAllowed>1</MinimumAllowed>");
    });
  });
});
