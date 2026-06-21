import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { request as httpRequest } from "node:http";
import { ServicebusServer } from "../services/servicebus/src/server.js";

// A lightweight, dependency-free fake of Azure Service Bus exercised through its
// documented HTTP/REST wire protocol (the same shape the Service Bus REST API
// uses for management Atom entities and brokered-message runtime operations).
// Mirrors the structure/style of tests/redis.test.ts and tests/postgres.test.ts.

const PORT = 14592;
const HOST = "127.0.0.1";

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(opts: {
  method?: string;
  path: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function bp(res: RawResponse): any {
  const h = res.headers["brokerproperties"];
  if (!h) return {};
  return JSON.parse(Array.isArray(h) ? h[0] : h);
}

// Atom XML payload helpers (Service Bus management entity bodies).
function queueXml(props: Record<string, string | number | boolean> = {}): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<QueueDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">` +
    `${inner}</QueueDescription></content></entry>`
  );
}
function topicXml(props: Record<string, string | number | boolean> = {}): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<TopicDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">` +
    `${inner}</TopicDescription></content></entry>`
  );
}
function subXml(props: Record<string, string | number | boolean> = {}): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<SubscriptionDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">` +
    `${inner}</SubscriptionDescription></content></entry>`
  );
}
function sqlRuleXml(expr: string, action?: string): string {
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<RuleDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect" ` +
    `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
    `<Filter i:type="SqlFilter"><SqlExpression>${expr}</SqlExpression></Filter>` +
    (action
      ? `<Action i:type="SqlRuleAction"><SqlExpression>${action}</SqlExpression></Action>`
      : `<Action i:type="EmptyRuleAction"/>`) +
    `</RuleDescription></content></entry>`
  );
}
function correlationRuleXml(correlationId: string, label?: string): string {
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<RuleDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect" ` +
    `xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
    `<Filter i:type="CorrelationFilter"><CorrelationId>${correlationId}</CorrelationId>` +
    (label ? `<Label>${label}</Label>` : "") +
    `</Filter><Action i:type="EmptyRuleAction"/>` +
    `</RuleDescription></content></entry>`
  );
}

const ATOM = { "Content-Type": "application/atom+xml;type=entry;charset=utf-8" };

describe("Service Bus Service", () => {
  let server: ServicebusServer;

  beforeAll(async () => {
    server = new ServicebusServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 300));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await raw({ method: "POST", path: "/_parlel/reset" });
  });

  // -----------------------------------------------------------------------
  describe("Server", () => {
    it("should start on port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have empty queues initially", () => {
      expect(server.queues.size).toBe(0);
    });

    it("should have empty topics initially", () => {
      expect(server.topics.size).toBe(0);
    });

    it("health endpoint returns ok", async () => {
      const res = await raw({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("servicebus");
    });

    it("reset endpoint clears state", async () => {
      await raw({ method: "PUT", path: "/q-reset", body: queueXml(), headers: ATOM });
      expect(server.queues.size).toBe(1);
      const res = await raw({ method: "POST", path: "/_parlel/reset" });
      expect(res.status).toBe(200);
      expect(server.queues.size).toBe(0);
    });

    it("dump endpoint returns state", async () => {
      await raw({ method: "PUT", path: "/q-dump", body: queueXml(), headers: ATOM });
      const res = await raw({ path: "/_parlel/dump" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.queues).toContain("q-dump");
    });
  });

  // -----------------------------------------------------------------------
  describe("Queue management", () => {
    it("CreateQueue returns 201 with QueueDescription", async () => {
      const res = await raw({ method: "PUT", path: "/myqueue", body: queueXml(), headers: ATOM });
      expect(res.status).toBe(201);
      expect(res.body).toContain("QueueDescription");
      expect(res.body).toContain("<MaxDeliveryCount>10</MaxDeliveryCount>");
    });

    it("CreateQueue honors custom properties", async () => {
      const res = await raw({
        method: "PUT",
        path: "/customq",
        body: queueXml({ MaxDeliveryCount: 5, LockDuration: "PT1M", RequiresSession: true }),
        headers: ATOM,
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("<MaxDeliveryCount>5</MaxDeliveryCount>");
      expect(res.body).toContain("<LockDuration>PT1M</LockDuration>");
      expect(res.body).toContain("<RequiresSession>true</RequiresSession>");
    });

    it("CreateQueue conflict returns 409", async () => {
      await raw({ method: "PUT", path: "/dupq", body: queueXml(), headers: ATOM });
      const res = await raw({ method: "PUT", path: "/dupq", body: queueXml(), headers: ATOM });
      expect(res.status).toBe(409);
      expect(res.body).toContain("MessagingEntityAlreadyExists");
    });

    it("GetQueue returns 200", async () => {
      await raw({ method: "PUT", path: "/getq", body: queueXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/getq" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("QueueDescription");
    });

    it("GetQueue missing returns 404", async () => {
      const res = await raw({ method: "GET", path: "/nope" });
      expect(res.status).toBe(404);
      expect(res.body).toContain("MessagingEntityNotFound");
    });

    it("DeleteQueue returns 200", async () => {
      await raw({ method: "PUT", path: "/delq", body: queueXml(), headers: ATOM });
      const res = await raw({ method: "DELETE", path: "/delq" });
      expect(res.status).toBe(200);
      const after = await raw({ method: "GET", path: "/delq" });
      expect(after.status).toBe(404);
    });

    it("DeleteQueue missing returns 404", async () => {
      const res = await raw({ method: "DELETE", path: "/ghost" });
      expect(res.status).toBe(404);
    });

    it("ListQueues returns a feed", async () => {
      await raw({ method: "PUT", path: "/lq1", body: queueXml(), headers: ATOM });
      await raw({ method: "PUT", path: "/lq2", body: queueXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/$Resources/Queues" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<feed");
      expect(res.body).toContain("lq1");
      expect(res.body).toContain("lq2");
    });
  });

  // -----------------------------------------------------------------------
  describe("Topic management", () => {
    it("CreateTopic returns 201 with TopicDescription", async () => {
      const res = await raw({ method: "PUT", path: "/mytopic", body: topicXml(), headers: ATOM });
      expect(res.status).toBe(201);
      expect(res.body).toContain("TopicDescription");
    });

    it("CreateTopic conflict returns 409", async () => {
      await raw({ method: "PUT", path: "/dupt", body: topicXml(), headers: ATOM });
      const res = await raw({ method: "PUT", path: "/dupt", body: topicXml(), headers: ATOM });
      expect(res.status).toBe(409);
    });

    it("GetTopic returns 200", async () => {
      await raw({ method: "PUT", path: "/gett", body: topicXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/gett" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("TopicDescription");
    });

    it("DeleteTopic returns 200", async () => {
      await raw({ method: "PUT", path: "/delt", body: topicXml(), headers: ATOM });
      const res = await raw({ method: "DELETE", path: "/delt" });
      expect(res.status).toBe(200);
    });

    it("ListTopics returns a feed", async () => {
      await raw({ method: "PUT", path: "/lt1", body: topicXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/$Resources/Topics" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("lt1");
    });
  });

  // -----------------------------------------------------------------------
  describe("Subscription management", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/subtopic", body: topicXml(), headers: ATOM });
    });

    it("CreateSubscription returns 201", async () => {
      const res = await raw({
        method: "PUT",
        path: "/subtopic/subscriptions/sub1",
        body: subXml(),
        headers: ATOM,
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("SubscriptionDescription");
    });

    it("CreateSubscription on missing topic returns 404", async () => {
      const res = await raw({
        method: "PUT",
        path: "/notopic/subscriptions/s",
        body: subXml(),
        headers: ATOM,
      });
      expect(res.status).toBe(404);
    });

    it("CreateSubscription conflict returns 409", async () => {
      await raw({ method: "PUT", path: "/subtopic/subscriptions/s", body: subXml(), headers: ATOM });
      const res = await raw({
        method: "PUT",
        path: "/subtopic/subscriptions/s",
        body: subXml(),
        headers: ATOM,
      });
      expect(res.status).toBe(409);
    });

    it("GetSubscription returns 200", async () => {
      await raw({ method: "PUT", path: "/subtopic/subscriptions/gs", body: subXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/subtopic/subscriptions/gs" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("SubscriptionDescription");
    });

    it("DeleteSubscription returns 200", async () => {
      await raw({ method: "PUT", path: "/subtopic/subscriptions/ds", body: subXml(), headers: ATOM });
      const res = await raw({ method: "DELETE", path: "/subtopic/subscriptions/ds" });
      expect(res.status).toBe(200);
    });

    it("ListSubscriptions returns a feed", async () => {
      await raw({ method: "PUT", path: "/subtopic/subscriptions/a", body: subXml(), headers: ATOM });
      await raw({ method: "PUT", path: "/subtopic/subscriptions/b", body: subXml(), headers: ATOM });
      const res = await raw({ method: "GET", path: "/subtopic/subscriptions" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<feed");
      expect(res.body).toContain("<title type=\"text\">a</title>");
      expect(res.body).toContain("<title type=\"text\">b</title>");
    });
  });

  // -----------------------------------------------------------------------
  describe("Rule management", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/ruletopic", body: topicXml(), headers: ATOM });
      await raw({ method: "PUT", path: "/ruletopic/subscriptions/rs", body: subXml(), headers: ATOM });
    });

    it("subscription has a $Default rule", async () => {
      const res = await raw({ method: "GET", path: "/ruletopic/subscriptions/rs/rules/$Default" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("RuleDescription");
    });

    it("CreateRule (SQL) returns 201", async () => {
      const res = await raw({
        method: "PUT",
        path: "/ruletopic/subscriptions/rs/rules/sqlrule",
        body: sqlRuleXml("color = 'blue'"),
        headers: ATOM,
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("SqlFilter");
      expect(res.body).toContain("color = 'blue'");
    });

    it("CreateRule (Correlation) returns 201", async () => {
      const res = await raw({
        method: "PUT",
        path: "/ruletopic/subscriptions/rs/rules/corr",
        body: correlationRuleXml("order-123", "lbl"),
        headers: ATOM,
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("CorrelationFilter");
      expect(res.body).toContain("order-123");
    });

    it("CreateRule with action", async () => {
      const res = await raw({
        method: "PUT",
        path: "/ruletopic/subscriptions/rs/rules/act",
        body: sqlRuleXml("1=1", "SET label = 'x'"),
        headers: ATOM,
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("SqlRuleAction");
    });

    it("GetRule returns 200", async () => {
      await raw({
        method: "PUT",
        path: "/ruletopic/subscriptions/rs/rules/gr",
        body: sqlRuleXml("a = 1"),
        headers: ATOM,
      });
      const res = await raw({ method: "GET", path: "/ruletopic/subscriptions/rs/rules/gr" });
      expect(res.status).toBe(200);
    });

    it("ListRules returns a feed with $Default", async () => {
      const res = await raw({ method: "GET", path: "/ruletopic/subscriptions/rs/rules" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("$Default");
    });

    it("DeleteRule returns 200", async () => {
      await raw({
        method: "PUT",
        path: "/ruletopic/subscriptions/rs/rules/dr",
        body: sqlRuleXml("a = 1"),
        headers: ATOM,
      });
      const res = await raw({ method: "DELETE", path: "/ruletopic/subscriptions/rs/rules/dr" });
      expect(res.status).toBe(200);
    });

    it("DeleteRule missing returns 404", async () => {
      const res = await raw({ method: "DELETE", path: "/ruletopic/subscriptions/rs/rules/none" });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  describe("Queue messaging — send + receive", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/mq", body: queueXml(), headers: ATOM });
    });

    it("Send returns 201 with sequence number", async () => {
      const res = await raw({
        method: "POST",
        path: "/mq/messages",
        body: "hello world",
        headers: { "Content-Type": "text/plain" },
      });
      expect(res.status).toBe(201);
      expect(bp(res).SequenceNumber).toBeGreaterThan(0);
    });

    it("Send to missing entity returns 404", async () => {
      const res = await raw({ method: "POST", path: "/missing/messages", body: "x" });
      expect(res.status).toBe(404);
    });

    it("Send with BrokerProperties + custom props", async () => {
      const res = await raw({
        method: "POST",
        path: "/mq/messages",
        body: "payload",
        headers: {
          "Content-Type": "application/json",
          BrokerProperties: JSON.stringify({ MessageId: "m1", Label: "greeting", CorrelationId: "c1" }),
          priority: '"high"',
        },
      });
      expect(res.status).toBe(201);
    });

    it("PeekLock receive returns 201 with body + LockToken", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "msg-a", headers: { "Content-Type": "text/plain" } });
      const res = await raw({ method: "POST", path: "/mq/messages/head?timeout=5" });
      expect(res.status).toBe(201);
      expect(res.body).toBe("msg-a");
      const props = bp(res);
      expect(props.LockToken).toBeTruthy();
      expect(props.DeliveryCount).toBe(1);
    });

    it("PeekLock on empty queue returns 204", async () => {
      const res = await raw({ method: "POST", path: "/mq/messages/head?timeout=1" });
      expect(res.status).toBe(204);
    });

    it("Complete (DELETE locked message) returns 200 and removes it", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "to-complete", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/mq/messages/head" });
      const props = bp(recv);
      const del = await raw({
        method: "DELETE",
        path: `/mq/messages/${props.SequenceNumber}/${props.LockToken}`,
      });
      expect(del.status).toBe(200);
      // queue should now be empty
      const empty = await raw({ method: "POST", path: "/mq/messages/head?timeout=1" });
      expect(empty.status).toBe(204);
    });

    it("Complete with bad lock token returns 410", async () => {
      const del = await raw({ method: "DELETE", path: "/mq/messages/1/00000000-0000-0000-0000-000000000000" });
      expect(del.status).toBe(410);
    });

    it("Abandon (PUT) unlocks and returns message to queue", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "ab", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/mq/messages/head" });
      const props = bp(recv);
      const ab = await raw({
        method: "PUT",
        path: `/mq/messages/${props.SequenceNumber}/${props.LockToken}`,
      });
      expect(ab.status).toBe(200);
      // message should be receivable again with incremented delivery count
      const recv2 = await raw({ method: "POST", path: "/mq/messages/head" });
      expect(recv2.status).toBe(201);
      expect(bp(recv2).DeliveryCount).toBe(2);
    });

    it("RenewLock (POST) extends the lock", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "rl", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/mq/messages/head" });
      const props = bp(recv);
      const renew = await raw({
        method: "POST",
        path: `/mq/messages/${props.SequenceNumber}/${props.LockToken}`,
      });
      expect(renew.status).toBe(200);
      expect(bp(renew).LockedUntilUtc).toBeTruthy();
    });

    it("ReceiveAndDelete (DELETE head) returns 200 + body and removes message", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "rd", headers: { "Content-Type": "text/plain" } });
      const res = await raw({ method: "DELETE", path: "/mq/messages/head?timeout=5" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("rd");
      const empty = await raw({ method: "DELETE", path: "/mq/messages/head?timeout=1" });
      expect(empty.status).toBe(204);
    });

    it("FIFO ordering preserved", async () => {
      await raw({ method: "POST", path: "/mq/messages", body: "first", headers: { "Content-Type": "text/plain" } });
      await raw({ method: "POST", path: "/mq/messages", body: "second", headers: { "Content-Type": "text/plain" } });
      const r1 = await raw({ method: "DELETE", path: "/mq/messages/head" });
      const r2 = await raw({ method: "DELETE", path: "/mq/messages/head" });
      expect(r1.body).toBe("first");
      expect(r2.body).toBe("second");
    });

    it("custom properties round-trip on receive", async () => {
      await raw({
        method: "POST",
        path: "/mq/messages",
        body: "p",
        headers: { "Content-Type": "text/plain", region: '"us-east"' },
      });
      const recv = await raw({ method: "DELETE", path: "/mq/messages/head" });
      expect(recv.headers["region"]).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  describe("Batch send", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/bq", body: queueXml(), headers: ATOM });
    });

    it("SendBatch enqueues all messages", async () => {
      const batch = JSON.stringify([
        { Body: "b1", BrokerProperties: { Label: "one" } },
        { Body: "b2", BrokerProperties: { Label: "two" } },
        { Body: "b3" },
      ]);
      const res = await raw({
        method: "POST",
        path: "/bq/messages",
        body: batch,
        headers: { "Content-Type": "application/vnd.microsoft.servicebus.json" },
      });
      expect(res.status).toBe(201);
      const r1 = await raw({ method: "DELETE", path: "/bq/messages/head" });
      const r2 = await raw({ method: "DELETE", path: "/bq/messages/head" });
      const r3 = await raw({ method: "DELETE", path: "/bq/messages/head" });
      expect([r1.body, r2.body, r3.body]).toEqual(["b1", "b2", "b3"]);
    });
  });

  // -----------------------------------------------------------------------
  describe("Dead-lettering", () => {
    beforeEach(async () => {
      await raw({
        method: "PUT",
        path: "/dlq",
        body: queueXml({ MaxDeliveryCount: 1 }),
        headers: ATOM,
      });
    });

    it("message moves to DLQ after exceeding max delivery", async () => {
      await raw({ method: "POST", path: "/dlq/messages", body: "poison", headers: { "Content-Type": "text/plain" } });
      // receive (deliveryCount=1) then abandon -> exceeds maxDeliveryCount=1
      const recv = await raw({ method: "POST", path: "/dlq/messages/head" });
      const props = bp(recv);
      await raw({ method: "PUT", path: `/dlq/messages/${props.SequenceNumber}/${props.LockToken}` });
      // active queue empty now
      const empty = await raw({ method: "POST", path: "/dlq/messages/head?timeout=1" });
      expect(empty.status).toBe(204);
      // DLQ has the message
      const dl = await raw({ method: "DELETE", path: "/dlq/$DeadLetterQueue/messages/head" });
      expect(dl.status).toBe(200);
      expect(dl.body).toBe("poison");
    });

    it("explicit deadLetter disposition moves message to DLQ", async () => {
      await raw({ method: "POST", path: "/dlq/messages", body: "bad", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/dlq/messages/head" });
      const props = bp(recv);
      const dlt = await raw({
        method: "PUT",
        path: `/dlq/messages/${props.SequenceNumber}/${props.LockToken}`,
        headers: { disposition: "deadletter", deadletterreason: "ManualReject" },
      });
      expect(dlt.status).toBe(200);
      const active = await raw({ method: "POST", path: "/dlq/messages/head?timeout=1" });
      expect(active.status).toBe(204);
      const dl = await raw({ method: "DELETE", path: "/dlq/$DeadLetterQueue/messages/head" });
      expect(dl.status).toBe(200);
      expect(dl.body).toBe("bad");
    });
  });

  // -----------------------------------------------------------------------
  describe("Deferred messages", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/dfq", body: queueXml(), headers: ATOM });
    });

    it("defer then receive by sequence number", async () => {
      await raw({ method: "POST", path: "/dfq/messages", body: "deferred", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/dfq/messages/head" });
      const props = bp(recv);
      const def = await raw({
        method: "PUT",
        path: `/dfq/messages/${props.SequenceNumber}/${props.LockToken}`,
        headers: { disposition: "defer" },
      });
      expect(def.status).toBe(200);
      // not in the active stream anymore
      const empty = await raw({ method: "POST", path: "/dfq/messages/head?timeout=1" });
      expect(empty.status).toBe(204);
      // retrievable by sequence number
      const got = await raw({ method: "POST", path: `/dfq/messages/${props.SequenceNumber}` });
      expect(got.status).toBe(201);
      expect(got.body).toBe("deferred");
    });

    it("receiving an unknown deferred sequence returns 204", async () => {
      const got = await raw({ method: "POST", path: "/dfq/messages/999999" });
      expect(got.status).toBe(204);
    });
  });

  // -----------------------------------------------------------------------
  describe("Scheduled messages", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/sq", body: queueXml(), headers: ATOM });
    });

    it("future-scheduled message is not immediately receivable", async () => {
      const future = new Date(Date.now() + 60000).toISOString();
      await raw({
        method: "POST",
        path: "/sq/messages",
        body: "later",
        headers: {
          "Content-Type": "text/plain",
          BrokerProperties: JSON.stringify({ ScheduledEnqueueTimeUtc: future }),
        },
      });
      const res = await raw({ method: "POST", path: "/sq/messages/head?timeout=1" });
      expect(res.status).toBe(204);
    });

    it("past-scheduled message is immediately receivable", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      await raw({
        method: "POST",
        path: "/sq/messages",
        body: "now",
        headers: {
          "Content-Type": "text/plain",
          BrokerProperties: JSON.stringify({ ScheduledEnqueueTimeUtc: past }),
        },
      });
      const res = await raw({ method: "DELETE", path: "/sq/messages/head?timeout=1" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("now");
    });
  });

  // -----------------------------------------------------------------------
  describe("Topic / subscription fan-out + filtering", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/ft", body: topicXml(), headers: ATOM });
      await raw({ method: "PUT", path: "/ft/subscriptions/all", body: subXml(), headers: ATOM });
    });

    it("message published to topic is delivered to default subscription", async () => {
      await raw({ method: "POST", path: "/ft/messages", body: "broadcast", headers: { "Content-Type": "text/plain" } });
      const res = await raw({ method: "DELETE", path: "/ft/subscriptions/all/messages/head" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("broadcast");
    });

    it("fan-out to multiple subscriptions", async () => {
      await raw({ method: "PUT", path: "/ft/subscriptions/second", body: subXml(), headers: ATOM });
      await raw({ method: "POST", path: "/ft/messages", body: "fan", headers: { "Content-Type": "text/plain" } });
      const r1 = await raw({ method: "DELETE", path: "/ft/subscriptions/all/messages/head" });
      const r2 = await raw({ method: "DELETE", path: "/ft/subscriptions/second/messages/head" });
      expect(r1.body).toBe("fan");
      expect(r2.body).toBe("fan");
    });

    it("SQL filter selects matching messages only", async () => {
      // subscription with a SQL rule color='blue'; remove the default true filter
      await raw({ method: "PUT", path: "/ft/subscriptions/blue", body: subXml(), headers: ATOM });
      await raw({ method: "DELETE", path: "/ft/subscriptions/blue/rules/$Default" });
      await raw({
        method: "PUT",
        path: "/ft/subscriptions/blue/rules/onlyblue",
        body: sqlRuleXml("color = 'blue'"),
        headers: ATOM,
      });
      // publish a blue and a red message
      await raw({
        method: "POST",
        path: "/ft/messages",
        body: "blue-msg",
        headers: { "Content-Type": "text/plain", color: '"blue"' },
      });
      await raw({
        method: "POST",
        path: "/ft/messages",
        body: "red-msg",
        headers: { "Content-Type": "text/plain", color: '"red"' },
      });
      const r1 = await raw({ method: "DELETE", path: "/ft/subscriptions/blue/messages/head" });
      expect(r1.body).toBe("blue-msg");
      const r2 = await raw({ method: "DELETE", path: "/ft/subscriptions/blue/messages/head?timeout=1" });
      expect(r2.status).toBe(204);
    });

    it("Correlation filter matches CorrelationId", async () => {
      await raw({ method: "PUT", path: "/ft/subscriptions/corr", body: subXml(), headers: ATOM });
      await raw({ method: "DELETE", path: "/ft/subscriptions/corr/rules/$Default" });
      await raw({
        method: "PUT",
        path: "/ft/subscriptions/corr/rules/c",
        body: correlationRuleXml("ord-9"),
        headers: ATOM,
      });
      await raw({
        method: "POST",
        path: "/ft/messages",
        body: "match",
        headers: { "Content-Type": "text/plain", BrokerProperties: JSON.stringify({ CorrelationId: "ord-9" }) },
      });
      await raw({
        method: "POST",
        path: "/ft/messages",
        body: "nomatch",
        headers: { "Content-Type": "text/plain", BrokerProperties: JSON.stringify({ CorrelationId: "other" }) },
      });
      const r1 = await raw({ method: "DELETE", path: "/ft/subscriptions/corr/messages/head" });
      expect(r1.body).toBe("match");
      const r2 = await raw({ method: "DELETE", path: "/ft/subscriptions/corr/messages/head?timeout=1" });
      expect(r2.status).toBe(204);
    });

    it("subscription peek-lock + complete", async () => {
      await raw({ method: "POST", path: "/ft/messages", body: "pl", headers: { "Content-Type": "text/plain" } });
      const recv = await raw({ method: "POST", path: "/ft/subscriptions/all/messages/head" });
      expect(recv.status).toBe(201);
      const props = bp(recv);
      const del = await raw({
        method: "DELETE",
        path: `/ft/subscriptions/all/messages/${props.SequenceNumber}/${props.LockToken}`,
      });
      expect(del.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  describe("Edge cases", () => {
    it("unknown path returns 404", async () => {
      const res = await raw({ method: "GET", path: "/a/b/c/d/e/f" });
      expect(res.status).toBe(404);
    });

    it("unknown $Resources collection returns 404", async () => {
      const res = await raw({ method: "GET", path: "/$Resources/Widgets" });
      expect(res.status).toBe(404);
    });

    it("sending to a subscription path is rejected", async () => {
      await raw({ method: "PUT", path: "/et", body: topicXml(), headers: ATOM });
      await raw({ method: "PUT", path: "/et/subscriptions/s", body: subXml(), headers: ATOM });
      const res = await raw({ method: "POST", path: "/et/subscriptions/s/messages", body: "x" });
      expect(res.status).toBe(400);
    });

    it("empty body create defaults to a queue", async () => {
      const res = await raw({ method: "PUT", path: "/emptyq", headers: ATOM });
      expect(res.status).toBe(201);
      expect(res.body).toContain("QueueDescription");
    });
  });
});
