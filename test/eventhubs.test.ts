import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { request as httpRequest } from "node:http";
import { EventhubsServer } from "../services/eventhubs/src/server.js";

// A lightweight, dependency-free fake of Azure Event Hubs exercised through its
// documented HTTP/REST wire protocol (Atom-based management for hubs +
// consumer groups, the REST publish endpoint for events, and a JSON control
// plane mirroring the @azure/event-hubs SDK metadata + consume operations).
// Mirrors the structure/style of tests/redis.test.ts and tests/postgres.test.ts.

const PORT = 14595;
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

function json(res: RawResponse): any {
  return JSON.parse(res.body);
}

// Atom XML payload helpers (Event Hubs management entity bodies).
function hubXml(props: Record<string, string | number | boolean> = {}): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<EventHubDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">` +
    `${inner}</EventHubDescription></content></entry>`
  );
}
function cgXml(props: Record<string, string | number | boolean> = {}): string {
  const inner = Object.entries(props)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join("");
  return (
    `<entry xmlns="http://www.w3.org/2005/Atom"><content type="application/xml">` +
    `<ConsumerGroupDescription xmlns="http://schemas.microsoft.com/netservices/2010/10/servicebus/connect">` +
    `${inner}</ConsumerGroupDescription></content></entry>`
  );
}

const ATOM = { "Content-Type": "application/atom+xml;type=entry;charset=utf-8" };
const JSONCT = { "Content-Type": "application/json" };
const BATCHCT = { "Content-Type": "application/vnd.microsoft.servicebus.json" };

describe("Event Hubs Service", () => {
  let server: EventhubsServer;

  beforeAll(async () => {
    server = new EventhubsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 200));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await raw({ method: "POST", path: "/_parlel/reset" });
  });

  // -----------------------------------------------------------------------
  // Internal parlel endpoints
  // -----------------------------------------------------------------------
  describe("Internal (parlel) endpoints", () => {
    it("health check reports ok", async () => {
      const res = await raw({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const body = json(res);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("eventhubs");
      expect(typeof body.hubs).toBe("number");
    });

    it("reset clears all state", async () => {
      await raw({ method: "PUT", path: "/h1", headers: ATOM, body: hubXml() });
      let dump = json(await raw({ path: "/_parlel/dump" }));
      expect(dump.hubs.length).toBe(1);
      await raw({ method: "POST", path: "/_parlel/reset" });
      dump = json(await raw({ path: "/_parlel/dump" }));
      expect(dump.hubs.length).toBe(0);
    });

    it("dump shows hubs, partitions and consumer groups", async () => {
      await raw({ method: "PUT", path: "/h1", headers: ATOM, body: hubXml({ PartitionCount: 2 }) });
      const dump = json(await raw({ path: "/_parlel/dump" }));
      expect(dump.hubs[0].name).toBe("h1");
      expect(dump.hubs[0].partitionCount).toBe(2);
      expect(dump.hubs[0].consumerGroups).toContain("$Default");
      expect(dump.hubs[0].partitions.length).toBe(2);
    });

    it("root returns service identity", async () => {
      const res = await raw({ path: "/" });
      expect(res.status).toBe(200);
      expect(json(res).service).toBe("parlel/eventhubs");
    });
  });

  // -----------------------------------------------------------------------
  // Event Hub management
  // -----------------------------------------------------------------------
  describe("Event Hub management", () => {
    it("creates a hub with default partitions (201)", async () => {
      const res = await raw({ method: "PUT", path: "/orders", headers: ATOM, body: hubXml() });
      expect(res.status).toBe(201);
      expect(res.body).toContain("<EventHubDescription");
      expect(res.body).toContain("<PartitionCount>4</PartitionCount>");
    });

    it("creates a hub with a custom partition count + retention", async () => {
      const res = await raw({
        method: "PUT",
        path: "/big",
        headers: ATOM,
        body: hubXml({ PartitionCount: 8, MessageRetentionInDays: 3 }),
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("<PartitionCount>8</PartitionCount>");
      expect(res.body).toContain("<MessageRetentionInDays>3</MessageRetentionInDays>");
      expect(res.body).toContain("<a:string>7</a:string>");
    });

    it("gets a hub (200)", async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml() });
      const res = await raw({ path: "/h" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<EventHubDescription");
    });

    it("returns 404 for missing hub", async () => {
      const res = await raw({ path: "/nope" });
      expect(res.status).toBe(404);
      expect(res.body).toContain("MessagingEntityNotFound");
    });

    it("returns 409 on duplicate create", async () => {
      await raw({ method: "PUT", path: "/dup", headers: ATOM, body: hubXml() });
      const res = await raw({ method: "PUT", path: "/dup", headers: ATOM, body: hubXml() });
      expect(res.status).toBe(409);
      expect(res.body).toContain("MessagingEntityAlreadyExists");
    });

    it("deletes a hub (200) then 404", async () => {
      await raw({ method: "PUT", path: "/temp", headers: ATOM, body: hubXml() });
      const del = await raw({ method: "DELETE", path: "/temp" });
      expect(del.status).toBe(200);
      const del2 = await raw({ method: "DELETE", path: "/temp" });
      expect(del2.status).toBe(404);
    });

    it("lists hubs via $Resources/EventHubs", async () => {
      await raw({ method: "PUT", path: "/a", headers: ATOM, body: hubXml() });
      await raw({ method: "PUT", path: "/b", headers: ATOM, body: hubXml() });
      const res = await raw({ path: "/$Resources/EventHubs" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<feed");
      expect(res.body).toContain("<title type=\"text\">a</title>");
      expect(res.body).toContain("<title type=\"text\">b</title>");
    });

    it("rejects unsupported method on hub", async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml() });
      const res = await raw({ method: "PATCH", path: "/h" });
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Consumer groups
  // -----------------------------------------------------------------------
  describe("Consumer groups", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml() });
    });

    it("hub always has a $Default consumer group", async () => {
      const res = await raw({ path: "/h/consumergroups/$Default" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("$Default");
    });

    it("creates a consumer group (201)", async () => {
      const res = await raw({
        method: "PUT",
        path: "/h/consumergroups/workers",
        headers: ATOM,
        body: cgXml({ UserMetadata: "team-a" }),
      });
      expect(res.status).toBe(201);
      expect(res.body).toContain("<ConsumerGroupDescription");
      expect(res.body).toContain("team-a");
    });

    it("gets a consumer group (200)", async () => {
      await raw({ method: "PUT", path: "/h/consumergroups/g", headers: ATOM, body: cgXml() });
      const res = await raw({ path: "/h/consumergroups/g" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("<Name>g</Name>");
    });

    it("returns 404 for missing consumer group", async () => {
      const res = await raw({ path: "/h/consumergroups/ghost" });
      expect(res.status).toBe(404);
    });

    it("returns 409 on duplicate consumer group", async () => {
      await raw({ method: "PUT", path: "/h/consumergroups/g", headers: ATOM, body: cgXml() });
      const res = await raw({
        method: "PUT",
        path: "/h/consumergroups/g",
        headers: ATOM,
        body: cgXml(),
      });
      expect(res.status).toBe(409);
    });

    it("deletes a consumer group (200) then 404", async () => {
      await raw({ method: "PUT", path: "/h/consumergroups/g", headers: ATOM, body: cgXml() });
      const del = await raw({ method: "DELETE", path: "/h/consumergroups/g" });
      expect(del.status).toBe(200);
      const get = await raw({ path: "/h/consumergroups/g" });
      expect(get.status).toBe(404);
    });

    it("refuses to delete $Default consumer group (400)", async () => {
      const res = await raw({ method: "DELETE", path: "/h/consumergroups/$Default" });
      expect(res.status).toBe(400);
    });

    it("lists consumer groups", async () => {
      await raw({ method: "PUT", path: "/h/consumergroups/g1", headers: ATOM, body: cgXml() });
      await raw({ method: "PUT", path: "/h/consumergroups/g2", headers: ATOM, body: cgXml() });
      const res = await raw({ path: "/h/consumergroups" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("$Default");
      expect(res.body).toContain("g1");
      expect(res.body).toContain("g2");
    });

    it("404 when creating a group on a missing hub", async () => {
      const res = await raw({
        method: "PUT",
        path: "/ghosthub/consumergroups/g",
        headers: ATOM,
        body: cgXml(),
      });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata (getEventHubProperties / getPartitionIds / getPartitionProperties)
  // -----------------------------------------------------------------------
  describe("Metadata", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml({ PartitionCount: 3 }) });
    });

    it("getEventHubProperties returns name, createdOn, partitionIds", async () => {
      const res = await raw({ path: "/h/properties" });
      expect(res.status).toBe(200);
      const p = json(res);
      expect(p.name).toBe("h");
      expect(p.partitionIds).toEqual(["0", "1", "2"]);
      expect(typeof p.createdOn).toBe("string");
    });

    it("getPartitionIds returns ids", async () => {
      const res = await raw({ path: "/h/partitions" });
      expect(res.status).toBe(200);
      expect(json(res).partitionIds).toEqual(["0", "1", "2"]);
    });

    it("getPartitionProperties returns watermarks for empty partition", async () => {
      const res = await raw({ path: "/h/partitions/0/properties" });
      expect(res.status).toBe(200);
      const p = json(res);
      expect(p.partitionId).toBe("0");
      expect(p.isEmpty).toBe(true);
      expect(p.lastEnqueuedSequenceNumber).toBe(-1);
      expect(p.beginningSequenceNumber).toBe(0);
    });

    it("getPartitionProperties reflects enqueued events", async () => {
      await raw({
        method: "POST",
        path: "/h/partitions/0/messages",
        headers: JSONCT,
        body: JSON.stringify({ a: 1 }),
      });
      const res = await raw({ path: "/h/partitions/0/properties" });
      const p = json(res);
      expect(p.isEmpty).toBe(false);
      expect(p.lastEnqueuedSequenceNumber).toBe(0);
      expect(p.lastEnqueuedOffset).toBe("0");
      expect(typeof p.lastEnqueuedOnUtc).toBe("string");
    });

    it("getPartitionProperties 400 for invalid partition", async () => {
      const res = await raw({ path: "/h/partitions/99/properties" });
      expect(res.status).toBe(400);
      expect(res.body).toContain("ArgumentOutOfRange");
    });

    it("metadata 404 on missing hub", async () => {
      const res = await raw({ path: "/ghost/properties" });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Publishing events (REST send)
  // -----------------------------------------------------------------------
  describe("Publishing events", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml({ PartitionCount: 4 }) });
    });

    it("sends a single event (201) and returns BrokerProperties", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/messages",
        headers: JSONCT,
        body: JSON.stringify({ hello: "world" }),
      });
      expect(res.status).toBe(201);
      const props = bp(res);
      expect(props.PartitionId).toBeDefined();
      expect(props.SequenceNumber).toBe(0);
      expect(props.Offset).toBe("0");
      expect(typeof props.EnqueuedTimeUtc).toBe("string");
    });

    it("sends to a specific partition via path", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/partitions/2/messages",
        headers: JSONCT,
        body: JSON.stringify({ x: 1 }),
      });
      expect(res.status).toBe(201);
      expect(bp(res).PartitionId).toBe("2");
    });

    it("sends to a specific partition via query param", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/messages?partitionId=1",
        headers: JSONCT,
        body: JSON.stringify({ x: 1 }),
      });
      expect(res.status).toBe(201);
      expect(bp(res).PartitionId).toBe("1");
    });

    it("routes by partition key consistently", async () => {
      const r1 = await raw({
        method: "POST",
        path: "/h/messages",
        headers: { ...JSONCT, BrokerProperties: JSON.stringify({ PartitionKey: "user-42" }) },
        body: JSON.stringify({ n: 1 }),
      });
      const r2 = await raw({
        method: "POST",
        path: "/h/messages",
        headers: { ...JSONCT, BrokerProperties: JSON.stringify({ PartitionKey: "user-42" }) },
        body: JSON.stringify({ n: 2 }),
      });
      expect(bp(r1).PartitionId).toBe(bp(r2).PartitionId);
    });

    it("rejects partitionId + partitionKey together (400)", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/messages?partitionId=0",
        headers: { ...JSONCT, BrokerProperties: JSON.stringify({ PartitionKey: "k" }) },
        body: JSON.stringify({ n: 1 }),
      });
      expect(res.status).toBe(400);
    });

    it("400 for invalid partition on send", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/partitions/77/messages",
        headers: JSONCT,
        body: JSON.stringify({ n: 1 }),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("ArgumentOutOfRange");
    });

    it("404 when sending to a missing hub", async () => {
      const res = await raw({
        method: "POST",
        path: "/ghost/messages",
        headers: JSONCT,
        body: JSON.stringify({ n: 1 }),
      });
      expect(res.status).toBe(404);
    });

    it("sends a batch of events to one partition", async () => {
      const batch = [
        { Body: { id: 1 }, UserProperties: { type: "a" } },
        { Body: { id: 2 }, UserProperties: { type: "b" } },
        { Body: "raw-string" },
      ];
      const res = await raw({
        method: "POST",
        path: "/h/partitions/0/messages",
        headers: BATCHCT,
        body: JSON.stringify(batch),
      });
      expect(res.status).toBe(201);
      const props = await raw({ path: "/h/partitions/0/properties" });
      expect(json(props).lastEnqueuedSequenceNumber).toBe(2);
    });

    it("rejects invalid batch JSON (400)", async () => {
      const res = await raw({
        method: "POST",
        path: "/h/messages",
        headers: BATCHCT,
        body: "{not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects an oversized event (413)", async () => {
      const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
      const res = await raw({
        method: "POST",
        path: "/h/messages",
        headers: JSONCT,
        body: big,
      });
      expect(res.status).toBe(413);
      expect(res.body).toContain("MessageSizeExceeded");
    });

    it("captures custom application properties", async () => {
      await raw({
        method: "POST",
        path: "/h/partitions/0/messages",
        headers: { ...JSONCT, priority: '"high"', tenant: '"acme"' },
        body: JSON.stringify({ ok: true }),
      });
      const recv = json(await raw({ path: "/h/partitions/0/events" }));
      expect(recv.events[0].properties.priority).toBe("high");
      expect(recv.events[0].properties.tenant).toBe("acme");
    });

    it("round-trips EventData system properties (messageId/correlationId/contentType)", async () => {
      await raw({
        method: "POST",
        path: "/h/partitions/0/messages",
        headers: {
          ...JSONCT,
          BrokerProperties: JSON.stringify({
            MessageId: "msg-1",
            CorrelationId: "corr-1",
            ContentType: "application/json",
          }),
        },
        body: JSON.stringify({ ok: true }),
      });
      const recv = json(await raw({ path: "/h/partitions/0/events" }));
      const ev = recv.events[0];
      expect(ev.messageId).toBe("msg-1");
      expect(ev.correlationId).toBe("corr-1");
      expect(ev.contentType).toBe("application/json");
    });
  });

  // -----------------------------------------------------------------------
  // Consuming events (receiveBatch)
  // -----------------------------------------------------------------------
  describe("Consuming events", () => {
    beforeEach(async () => {
      await raw({ method: "PUT", path: "/h", headers: ATOM, body: hubXml({ PartitionCount: 2 }) });
      for (let i = 0; i < 5; i++) {
        await raw({
          method: "POST",
          path: "/h/partitions/0/messages",
          headers: JSONCT,
          body: JSON.stringify({ n: i }),
        });
      }
    });

    it("receives all events from a partition (earliest by default)", async () => {
      const res = await raw({ path: "/h/partitions/0/events" });
      expect(res.status).toBe(200);
      const data = json(res);
      expect(data.count).toBe(5);
      expect(data.events.map((e: any) => e.body.n)).toEqual([0, 1, 2, 3, 4]);
      expect(data.events[0].sequenceNumber).toBe(0);
      expect(data.lastEnqueuedSequenceNumber).toBe(4);
    });

    it("respects maxMessageCount", async () => {
      const res = await raw({ path: "/h/partitions/0/events?maxMessageCount=2" });
      expect(json(res).count).toBe(2);
    });

    it("reads from a sequence number (exclusive)", async () => {
      const res = await raw({ path: "/h/partitions/0/events?fromSequenceNumber=1" });
      const data = json(res);
      expect(data.events.map((e: any) => e.body.n)).toEqual([2, 3, 4]);
    });

    it("reads from a sequence number (inclusive)", async () => {
      const res = await raw({ path: "/h/partitions/0/events?fromSequenceNumber=1&inclusive=true" });
      const data = json(res);
      expect(data.events.map((e: any) => e.body.n)).toEqual([1, 2, 3, 4]);
    });

    it("reads from an offset (exclusive)", async () => {
      const res = await raw({ path: "/h/partitions/0/events?fromOffset=2" });
      const data = json(res);
      expect(data.events.map((e: any) => e.body.n)).toEqual([3, 4]);
    });

    it("position=latest yields no historical events", async () => {
      const res = await raw({ path: "/h/partitions/0/events?position=latest" });
      expect(json(res).count).toBe(0);
    });

    it("position=earliest yields all events", async () => {
      const res = await raw({ path: "/h/partitions/0/events?position=earliest" });
      expect(json(res).count).toBe(5);
    });

    it("reads from an enqueued time", async () => {
      const res = await raw({
        path: `/h/partitions/0/events?fromEnqueuedTime=${Date.now() - 60000}`,
      });
      expect(json(res).count).toBe(5);
    });

    it("empty partition returns zero events", async () => {
      const res = await raw({ path: "/h/partitions/1/events" });
      expect(json(res).count).toBe(0);
    });

    it("consumes via a named consumer group", async () => {
      await raw({ method: "PUT", path: "/h/consumergroups/workers", headers: ATOM, body: cgXml() });
      const res = await raw({ path: "/h/consumergroups/workers/partitions/0/events" });
      expect(res.status).toBe(200);
      expect(json(res).consumerGroup).toBe("workers");
      expect(json(res).count).toBe(5);
    });

    it("404 consuming via a missing consumer group", async () => {
      const res = await raw({ path: "/h/consumergroups/ghost/partitions/0/events" });
      expect(res.status).toBe(404);
    });

    it("400 for invalid partition on consume", async () => {
      const res = await raw({ path: "/h/partitions/99/events" });
      expect(res.status).toBe(400);
    });

    it("exposes system properties and offset on events", async () => {
      const res = await raw({ path: "/h/partitions/0/events?maxMessageCount=1" });
      const ev = json(res).events[0];
      expect(ev.offset).toBe("0");
      expect(ev.systemProperties["x-opt-sequence-number"]).toBe(0);
      expect(ev.systemProperties["x-opt-offset"]).toBe("0");
    });

    it("preserves string bodies", async () => {
      await raw({
        method: "POST",
        path: "/h/partitions/1/messages",
        headers: JSONCT,
        body: "plain text payload",
      });
      const res = await raw({ path: "/h/partitions/1/events" });
      const ev = json(res).events[0];
      expect(ev.bodyAsString).toBe("plain text payload");
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end round trip
  // -----------------------------------------------------------------------
  describe("End-to-end", () => {
    it("create hub -> send -> metadata -> consume -> delete", async () => {
      await raw({ method: "PUT", path: "/flow", headers: ATOM, body: hubXml({ PartitionCount: 1 }) });
      for (let i = 0; i < 3; i++) {
        const r = await raw({
          method: "POST",
          path: "/flow/messages",
          headers: { ...JSONCT, BrokerProperties: JSON.stringify({ PartitionKey: "same" }) },
          body: JSON.stringify({ seq: i }),
        });
        expect(r.status).toBe(201);
      }
      const meta = json(await raw({ path: "/flow/properties" }));
      expect(meta.partitionIds).toEqual(["0"]);

      const part = json(await raw({ path: "/flow/partitions/0/properties" }));
      expect(part.lastEnqueuedSequenceNumber).toBe(2);

      const consumed = json(await raw({ path: "/flow/partitions/0/events" }));
      expect(consumed.events.map((e: any) => e.body.seq)).toEqual([0, 1, 2]);
      expect(consumed.events.every((e: any) => e.partitionKey === "same")).toBe(true);

      const del = await raw({ method: "DELETE", path: "/flow" });
      expect(del.status).toBe(200);
    });
  });
});
