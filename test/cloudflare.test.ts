import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudflareServer } from "../services/cloudflare/src/server.js";

const PORT = 14772;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer cf_parlelTestKey" };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Cloudflare Service", () => {
  let server: CloudflareServer;

  beforeAll(async () => {
    server = new CloudflareServer(PORT);
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
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("cloudflare");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing auth with 401", async () => {
      const res = await fetch(`${BASE_URL}/client/v4/user`);
      expect(res.status).toBe(401);
    });

    it("accepts Bearer auth", async () => {
      const res = await api("GET", "/client/v4/user");
      expect(res.status).toBe(200);
    });

    it("accepts X-Auth-Key / X-Auth-Email", async () => {
      const res = await api("GET", "/client/v4/user", undefined, {
        "X-Auth-Key": "abc",
        "X-Auth-Email": "parlel-user@parlel.dev",
      });
      expect(res.status).toBe(200);
    });
  });

  describe("Envelope", () => {
    it("wraps responses in the Cloudflare envelope", async () => {
      const res = await api("GET", "/client/v4/user");
      expect(res.body.success).toBe(true);
      expect(res.body.errors).toEqual([]);
      expect(res.body.messages).toEqual([]);
      expect(res.body.result.email).toBe("parlel-user@parlel.dev");
    });
  });

  describe("Zones", () => {
    it("lists zones with result_info", async () => {
      const res = await api("GET", "/client/v4/zones");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.result)).toBe(true);
      expect(res.body.result_info.count).toBeGreaterThanOrEqual(1);
    });

    it("creates a zone", async () => {
      const res = await api("POST", "/client/v4/zones", { name: "example.com" });
      expect(res.status).toBe(200);
      expect(res.body.result.name).toBe("example.com");
      expect(res.body.result.id).toBeTruthy();
    });

    it("rejects zone without name", async () => {
      const res = await api("POST", "/client/v4/zones", {});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("gets a zone by id", async () => {
      const created = await api("POST", "/client/v4/zones", { name: "lookup.com" });
      const id = created.body.result.id;
      const got = await api("GET", `/client/v4/zones/${id}`);
      expect(got.body.result.name).toBe("lookup.com");
    });
  });

  describe("DNS records", () => {
    it("creates, lists, updates and deletes a DNS record", async () => {
      const zones = await api("GET", "/client/v4/zones");
      const zoneId = zones.body.result[0].id;

      const created = await api("POST", `/client/v4/zones/${zoneId}/dns_records`, {
        type: "A",
        name: "www.parlel.dev",
        content: "192.0.2.1",
        ttl: 3600,
      });
      expect(created.status).toBe(200);
      expect(created.body.result.type).toBe("A");
      expect(created.body.result.content).toBe("192.0.2.1");
      const recId = created.body.result.id;

      const list = await api("GET", `/client/v4/zones/${zoneId}/dns_records`);
      expect(list.body.result.length).toBe(1);

      const updated = await api("PUT", `/client/v4/zones/${zoneId}/dns_records/${recId}`, {
        type: "A",
        name: "www.parlel.dev",
        content: "192.0.2.2",
      });
      expect(updated.body.result.content).toBe("192.0.2.2");

      const deleted = await api("DELETE", `/client/v4/zones/${zoneId}/dns_records/${recId}`);
      expect(deleted.body.success).toBe(true);
      expect(deleted.body.result.id).toBe(recId);
    });

    it("rejects DNS record missing required fields", async () => {
      const zones = await api("GET", "/client/v4/zones");
      const zoneId = zones.body.result[0].id;
      const res = await api("POST", `/client/v4/zones/${zoneId}/dns_records`, { type: "A" });
      expect(res.status).toBe(400);
    });
  });
});
