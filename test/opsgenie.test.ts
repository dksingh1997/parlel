import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OpsgenieServer } from "../services/opsgenie/src/server.js";

const PORT = 14880;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "GenieKey parlelTestKey" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Opsgenie Service", () => {
  let server: OpsgenieServer;

  beforeAll(async () => {
    server = new OpsgenieServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("opsgenie");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing GenieKey with 401", async () => {
      const res = await fetch(`${BASE_URL}/v2/alerts`);
      expect(res.status).toBe(401);
    });

    it("accepts GenieKey auth", async () => {
      const result = await api("GET", "/v2/alerts");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.data)).toBe(true);
    });
  });

  describe("Alerts", () => {
    it("creates an alert returning {result,took,requestId}", async () => {
      const result = await api("POST", "/v2/alerts", { message: "Disk full on prod-1" });
      expect(result.status).toBe(202);
      expect(result.body.result).toBe("Request will be processed");
      expect(result.body).toHaveProperty("took");
      expect(result.body).toHaveProperty("requestId");
    });

    it("rejects an alert without a message (422)", async () => {
      const result = await api("POST", "/v2/alerts", {});
      expect(result.status).toBe(422);
    });

    it("lists created alerts in {data,paging,took,requestId} envelope", async () => {
      await api("POST", "/v2/alerts", { message: "Alert A" });
      await api("POST", "/v2/alerts", { message: "Alert B" });
      const list = await api("GET", "/v2/alerts");
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBe(2);
      expect(list.body).toHaveProperty("paging");
      expect(list.body).toHaveProperty("took");
      expect(list.body).toHaveProperty("requestId");
    });

    it("retrieves an alert by id, then acknowledges and closes it", async () => {
      await api("POST", "/v2/alerts", { message: "Lifecycle alert", priority: "P1" });
      const list = await api("GET", "/v2/alerts");
      const id = list.body.data[0].id;

      const got = await api("GET", `/v2/alerts/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.message).toBe("Lifecycle alert");
      expect(got.body.data.status).toBe("open");

      const ack = await api("POST", `/v2/alerts/${id}/acknowledge`, {});
      expect(ack.status).toBe(202);
      const afterAck = await api("GET", `/v2/alerts/${id}`);
      expect(afterAck.body.data.acknowledged).toBe(true);

      const close = await api("POST", `/v2/alerts/${id}/close`, {});
      expect(close.status).toBe(202);
      const afterClose = await api("GET", `/v2/alerts/${id}`);
      expect(afterClose.body.data.status).toBe("closed");
    });

    it("returns 404 for unknown alert", async () => {
      const result = await api("GET", "/v2/alerts/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("Heartbeats", () => {
    it("lists heartbeats", async () => {
      const result = await api("GET", "/v2/heartbeats");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.data)).toBe(true);
      expect(result.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v2/alerts", { message: "Temp" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const list = await api("GET", "/v2/alerts");
      expect(list.body.data.length).toBe(0);
    });
  });
});
