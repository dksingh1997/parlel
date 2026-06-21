// parlel/eventhubs — a lightweight, dependency-free fake of Azure Event Hubs.
//
// Speaks the Azure Event Hubs REST API
// (https://learn.microsoft.com/rest/api/eventhub/) so that application code and
// AI agents can drive event hubs over plain HTTP with zero cost and zero side
// effects. Pure Node.js, no external npm dependencies. State is in-memory and
// ephemeral (resettable via reset() or POST /_parlel/reset).
//
// ---------------------------------------------------------------------------
// Wire-transport note
// ---------------------------------------------------------------------------
// The real `@azure/event-hubs` SDK speaks AMQP 1.0 for its data plane — a binary
// framing protocol that is intentionally out of scope for a tiny in-process
// fake. Instead we implement Azure's documented HTTP/REST surface plus a small
// JSON control plane that mirrors the SDK's logical operations 1:1:
//
//   Producer (EventHubProducerClient):
//     createBatch / sendBatch / send          -> publish events
//     send to a specific partition            -> ?partitionId / partitions/{id}
//     send by partitionKey                     -> BrokerProperties.PartitionKey
//     getEventHubProperties                    -> hub metadata + partitionIds
//     getPartitionIds                          -> partition id list
//     getPartitionProperties                   -> per-partition watermarks
//
//   Consumer (EventHubConsumerClient):
//     subscribe / receiveBatch                 -> read events from a partition
//       starting at an offset / sequenceNumber / enqueuedTime / earliest/latest
//     getEventHubProperties / getPartitionIds / getPartitionProperties
//
//   Management (Atom+XML — ARM/SB-style entity API):
//     PUT/GET/DELETE  /{hub}                                Create/Get/Delete hub
//     PUT/GET/DELETE  /{hub}/consumergroups/{group}        Consumer groups
//     GET             /{hub}/consumergroups                 List consumer groups
//     GET             /$Resources/EventHubs                 List hubs
//
// ---------------------------------------------------------------------------
// REST publish / consume endpoints (the documented Event Hubs REST API)
// ---------------------------------------------------------------------------
//   POST /{hub}/messages                              Send single event
//   POST /{hub}/messages?api-version=...              (with content-type batch) SendBatch
//   POST /{hub}/partitions/{id}/messages              Send to a partition
//   GET  /{hub}                                        Get hub (Atom) / metadata
//
// JSON control-plane helpers (ergonomic surface used by tests/agents — these
// model the SDK metadata + consume operations that have no public REST verb):
//   GET  /{hub}/properties                             getEventHubProperties (JSON)
//   GET  /{hub}/partitions                             getPartitionIds (JSON)
//   GET  /{hub}/partitions/{id}/properties             getPartitionProperties (JSON)
//   GET  /{hub}/partitions/{id}/events?...             receiveBatch from partition (JSON)
//   GET  /{hub}/consumergroups/{g}/partitions/{id}/events?...  receive via group
//
// Consume query params: fromOffset, fromSequenceNumber, fromEnqueuedTime,
//   position=earliest|latest, maxMessageCount, ownerLevel.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const ATOM_NS = "http://www.w3.org/2005/Atom";
const EH_NS = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
const DEFAULT_PARTITION_COUNT = 4;
const DEFAULT_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Error type — carries the HTTP status + an Event Hubs error code.
// ---------------------------------------------------------------------------
class EventHubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code; // textual code e.g. "MessagingEntityNotFound"
  }
}

const Errors = {
  notFound: (msg = "The messaging entity could not be found.") =>
    new EventHubError(404, "MessagingEntityNotFound", msg),
  conflict: (msg = "The messaging entity already exists.") =>
    new EventHubError(409, "MessagingEntityAlreadyExists", msg),
  badRequest: (msg = "The request is malformed.") =>
    new EventHubError(400, "BadRequest", msg),
  payloadTooLarge: (msg = "The received message (delivery) is larger than the maximum allowed size.") =>
    new EventHubError(413, "MessageSizeExceeded", msg),
  argumentOutOfRange: (msg = "The supplied partition is invalid.") =>
    new EventHubError(400, "ArgumentOutOfRange", msg),
};

// Max single event size, mirrors the real broker's 1 MB ceiling.
const MAX_EVENT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Minimal XML helpers (no external deps).
// ---------------------------------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlValue(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return undefined;
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

function parseIntOr(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
}

function durOr(v, dflt) {
  return v === undefined || v === "" ? dflt : v;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------
export class EventhubsServer {
  constructor(port = 4595, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.namespace = options.namespace || "parlel";
    this.defaultPartitionCount = options.partitionCount || DEFAULT_PARTITION_COUNT;
    this.server = null;
    this.reset();
  }

  reset() {
    // hubs: Map<name, HubEntity>
    this.hubs = new Map();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          if (error instanceof EventHubError) {
            this.sendError(res, error.status, error.code, error.message);
          } else {
            this.sendError(res, 500, "InternalServerError", error.message || "internal error");
          }
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  // -------------------------------------------------------------------------
  // Response helpers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
    res.end(body);
  }

  sendXml(res, status, xml, extraHeaders = {}) {
    res.writeHead(status, {
      "Content-Type": "application/atom+xml;type=entry;charset=utf-8",
      ...extraHeaders,
    });
    res.end(xml);
  }

  sendError(res, status, code, message) {
    // Azure returns an XML <Error><Code>..</Code><Detail>..</Detail></Error>.
    const xml =
      `<Error><Code>${status}</Code>` +
      `<Detail>${xmlEscape(code)}: ${xmlEscape(message || "")}</Detail></Error>`;
    res.writeHead(status, { "Content-Type": "application/xml;charset=utf-8" });
    res.end(xml);
  }

  sendEmpty(res, status, extraHeaders = {}) {
    res.writeHead(status, extraHeaders);
    res.end();
  }

  // -------------------------------------------------------------------------
  // Entity factories
  // -------------------------------------------------------------------------
  makeHub(name, props = {}) {
    const partitionCount = parseIntOr(props.partitionCount, this.defaultPartitionCount);
    const hub = {
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageRetentionInDays: parseIntOr(props.messageRetentionInDays, DEFAULT_RETENTION_DAYS),
      partitionCount,
      status: props.status || "Active",
      // partitions: Array<Partition>
      partitions: [],
      // consumerGroups: Map<name, ConsumerGroup>
      consumerGroups: new Map(),
    };
    for (let i = 0; i < partitionCount; i++) {
      hub.partitions.push(this.makePartition(String(i)));
    }
    // Every hub always has a $Default consumer group.
    hub.consumerGroups.set("$Default", this.makeConsumerGroup("$Default"));
    return hub;
  }

  makePartition(id) {
    return {
      id,
      // events stored in enqueue order; offset == array index for simplicity,
      // sequenceNumber is monotonic per-partition starting at 0.
      events: [],
      nextSequenceNumber: 0,
    };
  }

  makeConsumerGroup(name, props = {}) {
    return {
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userMetadata: props.userMetadata || "",
    };
  }

  requireHub(name) {
    const hub = this.hubs.get(name);
    if (!hub) throw Errors.notFound(`The Event Hub '${name}' could not be found.`);
    return hub;
  }

  requirePartition(hub, partitionId) {
    const p = hub.partitions.find((x) => x.id === String(partitionId));
    if (!p) {
      throw Errors.argumentOutOfRange(
        `The specified partition '${partitionId}' is invalid for Event Hub '${hub.name}'.`,
      );
    }
    return p;
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = decodeURIComponent(url.pathname);
    const q = url.searchParams;

    // Internal parlel endpoints.
    if (pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "eventhubs",
        hubs: this.hubs.size,
      });
    }
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/_parlel/dump" && method === "GET") {
      return this.sendJson(res, 200, {
        hubs: [...this.hubs.values()].map((h) => ({
          name: h.name,
          partitionCount: h.partitionCount,
          consumerGroups: [...h.consumerGroups.keys()],
          partitions: h.partitions.map((p) => ({ id: p.id, count: p.events.length })),
        })),
      });
    }

    const segments = pathname.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      return this.sendJson(res, 200, { service: "parlel/eventhubs", namespace: this.namespace });
    }

    // ---- $Resources listing ----
    if (segments[0] === "$Resources") {
      if (method !== "GET") throw Errors.badRequest("Only GET supported on $Resources");
      if (segments[1] === "EventHubs") return this.listHubs(res);
      throw Errors.notFound("Unknown resource collection");
    }

    const hubName = segments[0];

    // ---- /{hub}/messages  (REST publish) ----
    if (segments.length === 2 && segments[1] === "messages" && method === "POST") {
      const body = await this.readBody(req);
      return this.sendEvent(req, res, hubName, null, body, q);
    }

    // ---- /{hub}/partitions/{id}/messages (REST publish to partition) ----
    if (
      segments.length === 4 &&
      segments[1] === "partitions" &&
      segments[3] === "messages" &&
      method === "POST"
    ) {
      const body = await this.readBody(req);
      return this.sendEvent(req, res, hubName, segments[2], body, q);
    }

    // ---- /{hub}/properties (JSON metadata: getEventHubProperties) ----
    if (segments.length === 2 && segments[1] === "properties" && method === "GET") {
      return this.getHubPropertiesJson(res, hubName);
    }

    // ---- /{hub}/partitions (JSON: getPartitionIds) ----
    if (segments.length === 2 && segments[1] === "partitions" && method === "GET") {
      return this.getPartitionIdsJson(res, hubName);
    }

    // ---- /{hub}/partitions/{id}/properties (JSON: getPartitionProperties) ----
    if (
      segments.length === 4 &&
      segments[1] === "partitions" &&
      segments[3] === "properties" &&
      method === "GET"
    ) {
      return this.getPartitionPropertiesJson(res, hubName, segments[2]);
    }

    // ---- /{hub}/partitions/{id}/events (JSON: receiveBatch) ----
    if (
      segments.length === 4 &&
      segments[1] === "partitions" &&
      segments[3] === "events" &&
      method === "GET"
    ) {
      return this.receiveEvents(res, hubName, "$Default", segments[2], q);
    }

    // ---- /{hub}/consumergroups/{g}/partitions/{id}/events (receive via group) ----
    if (
      segments.length === 6 &&
      segments[1] === "consumergroups" &&
      segments[3] === "partitions" &&
      segments[5] === "events" &&
      method === "GET"
    ) {
      return this.receiveEvents(res, hubName, segments[2], segments[4], q);
    }

    // ---- consumer group listing: /{hub}/consumergroups (GET, no name) ----
    if (segments.length === 2 && segments[1] === "consumergroups" && method === "GET") {
      return this.listConsumerGroups(res, hubName);
    }

    // ---- consumer group routes: /{hub}/consumergroups/{group} ----
    if (segments.length === 3 && segments[1] === "consumergroups") {
      const group = segments[2];
      const body = (await this.readBody(req)).toString("utf8");
      if (method === "PUT") return this.createConsumerGroup(res, hubName, group, body);
      if (method === "GET") return this.getConsumerGroup(res, hubName, group);
      if (method === "DELETE") return this.deleteConsumerGroup(res, hubName, group);
      throw Errors.badRequest("Unsupported method on consumer group");
    }

    // ---- Event Hub management routes: /{hub} ----
    if (segments.length === 1) {
      const body = (await this.readBody(req)).toString("utf8");
      if (method === "PUT") return this.createHub(res, hubName, body);
      if (method === "GET") return this.getHub(res, hubName);
      if (method === "DELETE") return this.deleteHub(res, hubName);
      throw Errors.badRequest("Unsupported method on Event Hub");
    }

    throw Errors.notFound("Unrecognized path");
  }

  // =========================================================================
  // Management: Event Hub create / get / delete / list
  // =========================================================================
  createHub(res, name, body) {
    if (this.hubs.has(name)) throw Errors.conflict();
    const props = this.parseHubProps(body);
    const hub = this.makeHub(name, props);
    this.hubs.set(name, hub);
    return this.sendXml(res, 201, this.hubEntryXml(hub));
  }

  getHub(res, name) {
    const hub = this.requireHub(name);
    return this.sendXml(res, 200, this.hubEntryXml(hub));
  }

  deleteHub(res, name) {
    if (!this.hubs.delete(name)) throw Errors.notFound();
    return this.sendEmpty(res, 200);
  }

  listHubs(res) {
    const entries = [...this.hubs.values()].map((h) => this.hubEntryXml(h, true)).join("");
    return this.sendXml(res, 200, this.feedXml("EventHubs", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  parseHubProps(body) {
    if (!body) return {};
    return {
      messageRetentionInDays: xmlValue(body, "MessageRetentionInDays"),
      partitionCount: xmlValue(body, "PartitionCount"),
      status: xmlValue(body, "Status"),
    };
  }

  // =========================================================================
  // Management: consumer groups
  // =========================================================================
  createConsumerGroup(res, hubName, groupName, body) {
    const hub = this.requireHub(hubName);
    if (hub.consumerGroups.has(groupName)) throw Errors.conflict();
    const props = {
      userMetadata: body ? xmlValue(body, "UserMetadata") : undefined,
    };
    const group = this.makeConsumerGroup(groupName, props);
    hub.consumerGroups.set(groupName, group);
    return this.sendXml(res, 201, this.consumerGroupEntryXml(hubName, group));
  }

  getConsumerGroup(res, hubName, groupName) {
    const hub = this.requireHub(hubName);
    const group = hub.consumerGroups.get(groupName);
    if (!group) throw Errors.notFound("The consumer group could not be found.");
    return this.sendXml(res, 200, this.consumerGroupEntryXml(hubName, group));
  }

  deleteConsumerGroup(res, hubName, groupName) {
    const hub = this.requireHub(hubName);
    if (groupName === "$Default") {
      throw Errors.badRequest("The $Default consumer group cannot be deleted.");
    }
    if (!hub.consumerGroups.delete(groupName)) throw Errors.notFound();
    return this.sendEmpty(res, 200);
  }

  listConsumerGroups(res, hubName) {
    const hub = this.requireHub(hubName);
    const entries = [...hub.consumerGroups.values()]
      .map((g) => this.consumerGroupEntryXml(hubName, g, true))
      .join("");
    return this.sendXml(res, 200, this.feedXml("ConsumerGroups", entries), {
      "Content-Type": "application/atom+xml;type=feed;charset=utf-8",
    });
  }

  // =========================================================================
  // Metadata (JSON control plane mirroring the SDK)
  // =========================================================================
  getHubPropertiesJson(res, hubName) {
    const hub = this.requireHub(hubName);
    return this.sendJson(res, 200, {
      name: hub.name,
      createdOn: hub.createdAt,
      partitionIds: hub.partitions.map((p) => p.id),
    });
  }

  getPartitionIdsJson(res, hubName) {
    const hub = this.requireHub(hubName);
    return this.sendJson(res, 200, {
      partitionIds: hub.partitions.map((p) => p.id),
    });
  }

  getPartitionPropertiesJson(res, hubName, partitionId) {
    const hub = this.requireHub(hubName);
    const p = this.requirePartition(hub, partitionId);
    const isEmpty = p.events.length === 0;
    const last = isEmpty ? null : p.events[p.events.length - 1];
    return this.sendJson(res, 200, {
      eventHubName: hub.name,
      partitionId: p.id,
      beginningSequenceNumber: isEmpty ? 0 : p.events[0].sequenceNumber,
      lastEnqueuedSequenceNumber: isEmpty ? -1 : last.sequenceNumber,
      lastEnqueuedOffset: isEmpty ? "-1" : String(last.offset),
      lastEnqueuedOnUtc: isEmpty ? null : last.enqueuedTime,
      isEmpty,
    });
  }

  // =========================================================================
  // Publish (REST send)
  // =========================================================================
  sendEvent(req, res, hubName, partitionId, body, q) {
    const hub = this.requireHub(hubName);

    const contentType = (req.headers["content-type"] || "").toLowerCase();
    const isBatch = contentType.includes("vnd.microsoft.servicebus.json");

    // BrokerProperties header may carry PartitionKey + per-message metadata.
    let brokerProps = {};
    const bpHeader = req.headers["brokerproperties"];
    if (bpHeader) {
      try {
        brokerProps = JSON.parse(Array.isArray(bpHeader) ? bpHeader[0] : bpHeader);
      } catch {
        throw Errors.badRequest("Invalid BrokerProperties header JSON");
      }
    }

    // Partition selection precedence: explicit partitionId path/query >
    // partitionKey hash. Cannot set both an explicit id and a partition key.
    const queryPartition = q.get("partitionId");
    const explicitPartition =
      partitionId !== null && partitionId !== undefined ? partitionId : queryPartition;
    const partitionKey = brokerProps.PartitionKey || q.get("partitionKey") || undefined;

    if (explicitPartition !== null && explicitPartition !== undefined && partitionKey) {
      throw Errors.badRequest(
        "A partitionId and a partitionKey cannot both be specified on a send.",
      );
    }

    const customProps = this.extractCustomProps(req.headers);

    if (isBatch) {
      let arr;
      try {
        arr = JSON.parse(body.toString("utf8"));
      } catch {
        throw Errors.badRequest("Invalid batch JSON");
      }
      if (!Array.isArray(arr)) throw Errors.badRequest("Batch body must be an array");
      // Whole batch lands in a single partition (real EH semantics).
      const partition = this.choosePartition(hub, explicitPartition, partitionKey);
      for (const item of arr) {
        const itemProps = item.BrokerProperties || {};
        const userProps = item.UserProperties || {};
        const data =
          item.Body !== undefined
            ? Buffer.from(typeof item.Body === "string" ? item.Body : JSON.stringify(item.Body))
            : Buffer.alloc(0);
        this.enqueueEvent(partition, itemProps, userProps, data, partitionKey);
      }
      return this.sendEmpty(res, 201, {
        "BrokerProperties": JSON.stringify({ PartitionId: partition.id }),
      });
    }

    if (body.length > MAX_EVENT_BYTES) throw Errors.payloadTooLarge();

    const partition = this.choosePartition(hub, explicitPartition, partitionKey);
    const ev = this.enqueueEvent(partition, brokerProps, customProps, body, partitionKey);
    return this.sendEmpty(res, 201, {
      "BrokerProperties": JSON.stringify({
        PartitionId: partition.id,
        SequenceNumber: ev.sequenceNumber,
        Offset: String(ev.offset),
        EnqueuedTimeUtc: ev.enqueuedTime,
      }),
    });
  }

  choosePartition(hub, explicitPartition, partitionKey) {
    if (explicitPartition !== null && explicitPartition !== undefined) {
      return this.requirePartition(hub, explicitPartition);
    }
    if (partitionKey) {
      const idx = this.hashKey(partitionKey, hub.partitions.length);
      return hub.partitions[idx];
    }
    // round-robin-ish: pick the least-loaded partition for spread.
    let min = hub.partitions[0];
    for (const p of hub.partitions) {
      if (p.events.length < min.events.length) min = p;
    }
    return min;
  }

  hashKey(key, n) {
    // Simple deterministic hash so the same key always maps to the same
    // partition (mirrors EH partition-key affinity).
    let h = 0;
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % n;
  }

  enqueueEvent(partition, brokerProps, customProps, dataBuf, partitionKey) {
    const seq = partition.nextSequenceNumber;
    partition.nextSequenceNumber += 1;
    const offset = partition.events.length; // simple monotonic offset
    const ev = {
      sequenceNumber: seq,
      offset,
      partitionKey: partitionKey || brokerProps.PartitionKey || null,
      enqueuedTime: new Date().toISOString(),
      body: Buffer.isBuffer(dataBuf) ? dataBuf : Buffer.from(String(dataBuf || "")),
      properties: { ...customProps },
      systemProperties: {
        "x-opt-sequence-number": seq,
        "x-opt-offset": String(offset),
        "x-opt-enqueued-time": Date.now(),
        ...(partitionKey ? { "x-opt-partition-key": partitionKey } : {}),
      },
      messageId: brokerProps.MessageId || randomUUID(),
      correlationId: brokerProps.CorrelationId,
      contentType: brokerProps.ContentType,
    };
    partition.events.push(ev);
    return ev;
  }

  extractCustomProps(headers) {
    const standard = new Set([
      "host", "content-type", "content-length", "brokerproperties",
      "authorization", "connection", "accept", "accept-encoding",
      "user-agent", "date", "transfer-encoding", "expect",
    ]);
    const props = {};
    for (const [k, v] of Object.entries(headers)) {
      if (standard.has(k.toLowerCase())) continue;
      if (k.toLowerCase().startsWith("x-")) continue;
      let val = Array.isArray(v) ? v[0] : v;
      if (typeof val === "string" && /^".*"$/.test(val)) val = val.slice(1, -1);
      props[k] = val;
    }
    return props;
  }

  // =========================================================================
  // Consume (receiveBatch from a partition)
  // =========================================================================
  receiveEvents(res, hubName, groupName, partitionId, q) {
    const hub = this.requireHub(hubName);
    const group = hub.consumerGroups.get(groupName);
    if (!group) throw Errors.notFound("The consumer group could not be found.");
    const p = this.requirePartition(hub, partitionId);

    const maxCount = parseIntOr(q.get("maxMessageCount"), 100);
    if (maxCount <= 0) throw Errors.badRequest("maxMessageCount must be positive");

    // Determine starting index based on the requested position.
    let startIdx = this.resolveStartIndex(p, q);

    const slice = p.events.slice(startIdx, startIdx + maxCount);
    const events = slice.map((ev) => this.serializeEvent(ev));
    return this.sendJson(res, 200, {
      partitionId: p.id,
      consumerGroup: groupName,
      events,
      count: events.length,
      lastEnqueuedSequenceNumber:
        p.events.length === 0 ? -1 : p.events[p.events.length - 1].sequenceNumber,
    });
  }

  resolveStartIndex(p, q) {
    const position = (q.get("position") || "").toLowerCase();
    const fromOffset = q.get("fromOffset");
    const fromSeq = q.get("fromSequenceNumber");
    const fromTime = q.get("fromEnqueuedTime");
    const inclusive = (q.get("inclusive") || "false").toLowerCase() === "true";

    if (position === "latest" || position === "@latest") {
      return p.events.length; // only new events (none currently)
    }
    if (position === "earliest" || position === "@earliest" || position === "") {
      // default earliest unless a specific marker is given below
    }

    if (fromSeq !== null && fromSeq !== undefined) {
      const target = parseInt(fromSeq, 10);
      let idx = p.events.findIndex((e) => e.sequenceNumber > target);
      if (inclusive) {
        const inc = p.events.findIndex((e) => e.sequenceNumber >= target);
        idx = inc;
      }
      return idx === -1 ? p.events.length : idx;
    }
    if (fromOffset !== null && fromOffset !== undefined) {
      const target = parseInt(fromOffset, 10);
      let idx = p.events.findIndex((e) => e.offset > target);
      if (inclusive) {
        idx = p.events.findIndex((e) => e.offset >= target);
      }
      return idx === -1 ? p.events.length : idx;
    }
    if (fromTime !== null && fromTime !== undefined) {
      const t = isNaN(Number(fromTime)) ? Date.parse(fromTime) : Number(fromTime);
      const idx = p.events.findIndex((e) => Date.parse(e.enqueuedTime) >= t);
      return idx === -1 ? p.events.length : idx;
    }
    // default: earliest
    return 0;
  }

  serializeEvent(ev) {
    let bodyStr = ev.body.toString("utf8");
    let parsedBody = bodyStr;
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      // leave as string
    }
    return {
      body: parsedBody,
      bodyAsString: bodyStr,
      sequenceNumber: ev.sequenceNumber,
      offset: String(ev.offset),
      partitionKey: ev.partitionKey,
      enqueuedTimeUtc: ev.enqueuedTime,
      messageId: ev.messageId,
      correlationId: ev.correlationId,
      contentType: ev.contentType,
      properties: ev.properties,
      systemProperties: ev.systemProperties,
    };
  }

  // =========================================================================
  // XML serializers
  // =========================================================================
  feedXml(title, entries) {
    return (
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<feed xmlns="${ATOM_NS}"><title type="text">${title}</title>` +
      `<updated>${new Date().toISOString()}</updated>${entries}</feed>`
    );
  }

  wrapEntry(title, contentXml, asFeedEntry) {
    const now = new Date().toISOString();
    const inner =
      `<title type="text">${xmlEscape(title)}</title>` +
      `<updated>${now}</updated>` +
      `<content type="application/xml">${contentXml}</content>`;
    if (asFeedEntry) {
      return `<entry xmlns="${ATOM_NS}">${inner}</entry>`;
    }
    return `<?xml version="1.0" encoding="utf-8"?><entry xmlns="${ATOM_NS}">${inner}</entry>`;
  }

  hubEntryXml(hub, asFeedEntry = false) {
    const d =
      `<EventHubDescription xmlns="${EH_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      `<MessageRetentionInDays>${hub.messageRetentionInDays}</MessageRetentionInDays>` +
      `<Status>${hub.status}</Status>` +
      `<CreatedAt>${hub.createdAt}</CreatedAt>` +
      `<UpdatedAt>${hub.updatedAt}</UpdatedAt>` +
      `<PartitionCount>${hub.partitionCount}</PartitionCount>` +
      `<PartitionIds xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">` +
      hub.partitions.map((p) => `<a:string>${p.id}</a:string>`).join("") +
      `</PartitionIds>` +
      `<EntityAvailabilityStatus>Available</EntityAvailabilityStatus>` +
      `</EventHubDescription>`;
    return this.wrapEntry(hub.name, d, asFeedEntry);
  }

  consumerGroupEntryXml(hubName, group, asFeedEntry = false) {
    const d =
      `<ConsumerGroupDescription xmlns="${EH_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
      `<CreatedAt>${group.createdAt}</CreatedAt>` +
      `<UpdatedAt>${group.updatedAt}</UpdatedAt>` +
      `<UserMetadata>${xmlEscape(group.userMetadata || "")}</UserMetadata>` +
      `<Name>${xmlEscape(group.name)}</Name>` +
      `</ConsumerGroupDescription>`;
    return this.wrapEntry(group.name, d, asFeedEntry);
  }
}

export default EventhubsServer;
