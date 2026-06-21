import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as amqp from "amqplib";
import { RabbitMQServer } from "../services/rabbitmq/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

const PORT = 15672;

describe("RabbitMQ Service", () => {
  let server: RabbitMQServer;

  beforeAll(async () => {
    server = new RabbitMQServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 500));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("should start on port", () => {
      expect(server.port).toBe(PORT);
    });

    it("should have empty queues", () => {
      expect(server.queues.size).toBe(0);
    });

    it("should have empty exchanges", () => {
      expect(server.exchanges.size).toBe(0);
    });
  });

  describe("Queues", () => {
    it("should create a queue", () => {
      server.queues.set("test-queue", []);
      expect(server.queues.has("test-queue")).toBe(true);
    });

    it("should delete a queue", () => {
      server.queues.set("test-queue", []);
      server.queues.delete("test-queue");
      expect(server.queues.has("test-queue")).toBe(false);
    });

    it("should push messages", () => {
      server.queues.set("msg-queue", []);
      server.queues.get("msg-queue").push(Buffer.from("message1"));
      server.queues.get("msg-queue").push(Buffer.from("message2"));
      expect(server.queues.get("msg-queue").length).toBe(2);
    });

    it("should consume messages", () => {
      server.queues.set("consume-queue", [Buffer.from("msg1"), Buffer.from("msg2")]);
      const queue = server.queues.get("consume-queue");
      const msg = queue.shift();
      expect(msg.toString()).toBe("msg1");
      expect(queue.length).toBe(1);
    });
  });

  describe("Exchanges", () => {
    it("should create an exchange", () => {
      server.exchanges.set("test-exchange", { type: "direct", bindings: [] });
      expect(server.exchanges.has("test-exchange")).toBe(true);
    });

    it("should delete an exchange", () => {
      server.exchanges.set("test-exchange", { type: "direct", bindings: [] });
      server.exchanges.delete("test-exchange");
      expect(server.exchanges.has("test-exchange")).toBe(false);
    });
  });
});

// Real-client wire-protocol tests: a genuine amqplib connection must complete
// the AMQP 0-9-1 handshake and round-trip a message.
describe("RabbitMQ real amqplib client", () => {
  let server: RabbitMQServer;
  let port = 0;
  let url = "";

  beforeAll(async () => {
    port = await getFreePort();
    server = new RabbitMQServer(port);
    await server.start();
    url = `amqp://parlel:parlel@127.0.0.1:${port}`;
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  it("connects, declares, publishes and gets a message (pull)", async () => {
    const conn = await amqp.connect(url);
    const ch = await conn.createChannel();
    await ch.assertQueue("amqp-get-q", { durable: false });
    ch.sendToQueue("amqp-get-q", Buffer.from("hello-get"));
    const got = await ch.get("amqp-get-q", { noAck: true });
    expect(got).not.toBe(false);
    expect((got as amqp.GetMessage).content.toString()).toBe("hello-get");
    await conn.close();
  }, 15000);

  it("delivers to a push consumer", async () => {
    const conn = await amqp.connect(url);
    const ch = await conn.createChannel();
    await ch.assertQueue("amqp-push-q", { durable: false });
    const received = await new Promise<string>(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no delivery")), 8000);
      await ch.consume(
        "amqp-push-q",
        (msg) => {
          if (msg) {
            ch.ack(msg);
            clearTimeout(timer);
            resolve(msg.content.toString());
          }
        },
        { noAck: false },
      );
      ch.sendToQueue("amqp-push-q", Buffer.from("hello-push"));
    });
    expect(received).toBe("hello-push");
    await conn.close();
  }, 15000);
});
