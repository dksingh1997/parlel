import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Kafka, logLevel } from "kafkajs";
import { KafkaServer } from "../services/kafka/src/server.js";
import {
  KafkaProtocol,
  encodeRecordBatch,
  decodeRecordBatch,
} from "../services/kafka/src/protocol.js";
import { getFreePort } from "../src/test-helpers.js";

let PORT = 0;

describe("Kafka Service", () => {
  let server: KafkaServer;

  beforeAll(async () => {
    PORT = await getFreePort();
    server = new KafkaServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 500));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("should start and listen on port", () => {
      expect(server).toBeDefined();
      expect(server.port).toBe(PORT);
    });

    it("should have broker ID", () => {
      expect(server.brokerId).toBe(1);
    });

    it("should have topics map", () => {
      expect(server.topics).toBeDefined();
      expect(server.topics.size).toBe(0);
    });

    it("should have groups map", () => {
      expect(server.groups).toBeDefined();
      expect(server.groups.size).toBe(0);
    });
  });

  describe("Topics", () => {
    it("should create a topic", () => {
      server.topics.set("test-topic", {
        partitions: [{ records: [], offset: 0 }],
      });
      expect(server.topics.has("test-topic")).toBe(true);
      expect(server.topics.get("test-topic")?.partitions.length).toBe(1);
    });

    it("should create topic with multiple partitions", () => {
      server.topics.set("multi-part", {
        partitions: [
          { records: [], offset: 0 },
          { records: [], offset: 0 },
          { records: [], offset: 0 },
        ],
      });
      expect(server.topics.get("multi-part")?.partitions.length).toBe(3);
    });

    it("should delete a topic", () => {
      server.topics.set("del-topic", {
        partitions: [{ records: [], offset: 0 }],
      });
      server.topics.delete("del-topic");
      expect(server.topics.has("del-topic")).toBe(false);
    });

    it("should list topics", () => {
      server.topics.clear();
      server.topics.set("topic-a", { partitions: [{ records: [], offset: 0 }] });
      server.topics.set("topic-b", { partitions: [{ records: [], offset: 0 }] });
      expect(server.topics.size).toBe(2);
      expect(Array.from(server.topics.keys())).toContain("topic-a");
      expect(Array.from(server.topics.keys())).toContain("topic-b");
    });
  });

  describe("Messages", () => {
    it("should produce a message", () => {
      server.topics.clear();
      server.topics.set("produce-test", {
        partitions: [{ records: [], offset: 0 }],
      });

      const topic = server.topics.get("produce-test");
      const partition = topic?.partitions[0];
      if (partition) {
        partition.records.push({ offset: partition.offset, data: "test-message" });
        partition.offset++;
      }

      expect(partition?.records.length).toBe(1);
      expect(partition?.records[0].data).toBe("test-message");
      expect(partition?.records[0].offset).toBe(0);
    });

    it("should produce multiple messages", () => {
      server.topics.clear();
      server.topics.set("multi-msg", {
        partitions: [{ records: [], offset: 0 }],
      });

      const topic = server.topics.get("multi-msg");
      const partition = topic?.partitions[0];
      if (partition) {
        for (let i = 0; i < 5; i++) {
          partition.records.push({ offset: partition.offset, data: `msg-${i}` });
          partition.offset++;
        }
      }

      expect(partition?.records.length).toBe(5);
      expect(partition?.offset).toBe(5);
    });

    it("should fetch messages from offset", () => {
      server.topics.clear();
      server.topics.set("fetch-test", {
        partitions: [{ records: [], offset: 0 }],
      });

      const topic = server.topics.get("fetch-test");
      const partition = topic?.partitions[0];
      if (partition) {
        for (let i = 0; i < 5; i++) {
          partition.records.push({ offset: i, data: `msg-${i}` });
        }
        partition.offset = 5;
      }

      const fetchOffset = 2;
      const records = partition?.records.filter((r) => r.offset >= fetchOffset);
      expect(records?.length).toBe(3);
      expect(records?.[0].data).toBe("msg-2");
      expect(records?.[2].data).toBe("msg-4");
    });

    it("should handle empty fetch", () => {
      server.topics.clear();
      server.topics.set("empty-fetch", {
        partitions: [{ records: [], offset: 0 }],
      });

      const topic = server.topics.get("empty-fetch");
      const partition = topic?.partitions[0];
      const records = partition?.records.filter((r) => r.offset >= 0);
      expect(records?.length).toBe(0);
    });
  });

  describe("Partitions", () => {
    it("should distribute messages across partitions", () => {
      server.topics.clear();
      server.topics.set("part-test", {
        partitions: [
          { records: [], offset: 0 },
          { records: [], offset: 0 },
        ],
      });

      const topic = server.topics.get("part-test");
      if (topic) {
        for (let i = 0; i < 6; i++) {
          const partIdx = i % 2;
          const partition = topic.partitions[partIdx];
          partition.records.push({ offset: partition.offset, data: `msg-${i}` });
          partition.offset++;
        }
      }

      expect(topic?.partitions[0].records.length).toBe(3);
      expect(topic?.partitions[1].records.length).toBe(3);
    });

    it("should track offset per partition", () => {
      server.topics.clear();
      server.topics.set("offset-test", {
        partitions: [
          { records: [], offset: 0 },
          { records: [], offset: 0 },
        ],
      });

      const topic = server.topics.get("offset-test");
      if (topic) {
        topic.partitions[0].records.push({ offset: 0, data: "a" });
        topic.partitions[0].offset = 1;
        topic.partitions[1].records.push({ offset: 0, data: "b" });
        topic.partitions[1].records.push({ offset: 1, data: "c" });
        topic.partitions[1].offset = 2;
      }

      expect(topic?.partitions[0].offset).toBe(1);
      expect(topic?.partitions[1].offset).toBe(2);
    });
  });

  describe("Protocol", () => {
    it("should have API keys defined", () => {
      expect(KafkaProtocol.API_KEYS).toBeDefined();
      expect(KafkaProtocol.API_KEYS.ApiVersions).toBe(18);
      expect(KafkaProtocol.API_KEYS.Metadata).toBe(3);
      expect(KafkaProtocol.API_KEYS.Produce).toBe(0);
      expect(KafkaProtocol.API_KEYS.Fetch).toBe(1);
      expect(KafkaProtocol.API_KEYS.CreateTopics).toBe(19);
      expect(KafkaProtocol.API_KEYS.DeleteTopics).toBe(20);
    });

    it("advertises only pinned non-flexible versions", () => {
      expect(KafkaProtocol.API_VERSIONS).toBeDefined();
      const produce = KafkaProtocol.API_VERSIONS.find((v) => v.apiKey === 0);
      expect(produce?.minVersion).toBe(3);
      expect(produce?.maxVersion).toBe(3);
    });

    it("should encode a v0 response header (correlation id only)", () => {
      const header = KafkaProtocol.header(12345);
      expect(header.length).toBe(4);
      expect(header.readInt32BE(0)).toBe(12345);
    });

    it("should parse request", () => {
      const buf = Buffer.alloc(12);
      buf.writeInt16BE(3, 0);
      buf.writeInt16BE(1, 2);
      buf.writeInt32BE(12345, 4);
      buf.writeInt16BE(0, 8);
      buf.writeInt16BE(0, 10);

      const request = KafkaProtocol.parseRequest(buf);
      expect(request).toBeDefined();
      expect(request?.apiKey).toBe(3);
      expect(request?.correlationId).toBe(12345);
    });
  });

  describe("Cleanup", () => {
    it("should clear all topics", () => {
      server.topics.clear();
      server.topics.set("clear-1", { partitions: [{ records: [], offset: 0 }] });
      server.topics.set("clear-2", { partitions: [{ records: [], offset: 0 }] });
      expect(server.topics.size).toBe(2);
      server.topics.clear();
      expect(server.topics.size).toBe(0);
    });
  });
});

describe("Kafka RecordBatch v2 codec", () => {
  it("round-trips records (key + value)", () => {
    const recs = [
      { key: null, value: Buffer.from("alpha") },
      { key: Buffer.from("k"), value: Buffer.from("beta") },
    ];
    const buf = encodeRecordBatch(recs, 0);
    const back = decodeRecordBatch(buf);
    expect(back.length).toBe(2);
    expect(back[0].value?.toString()).toBe("alpha");
    expect(back[1].key?.toString()).toBe("k");
    expect(back[1].value?.toString()).toBe("beta");
  });
});

// Real-client wire-protocol test: a genuine kafkajs producer + consumer-group
// consumer must create a topic, produce, and consume the message back.
describe("Kafka real kafkajs client", () => {
  let server: KafkaServer;
  let port = 0;

  beforeAll(async () => {
    port = await getFreePort();
    server = new KafkaServer(port);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  it("produces and consumes a message end-to-end", async () => {
    const kafka = new Kafka({
      brokers: [`127.0.0.1:${port}`],
      logLevel: logLevel.NOTHING,
      retry: { retries: 3 },
    });

    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: "vitest-topic",
      messages: [{ value: "hello-vitest" }],
    });
    await producer.disconnect();

    const consumer = kafka.consumer({ groupId: "vitest-group" });
    await consumer.connect();
    await consumer.subscribe({ topic: "vitest-topic", fromBeginning: true });
    const got = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message")), 15000);
      consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timer);
          resolve(message.value?.toString() ?? "");
        },
      });
    });
    expect(got).toBe("hello-vitest");
    await consumer.disconnect();
  }, 30000);
});
