import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SharepointServer } from "../services/sharepoint/src/server.js";

const PORT = 14798;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.graphtoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

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

describe("SharePoint Service", () => {
  let server: SharepointServer;

  beforeAll(async () => {
    server = new SharepointServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("sharepoint");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with Graph 401", async () => {
      const res = await api("GET", "/v1.0/sites/root", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("InvalidAuthenticationToken");
    });
  });

  describe("Sites", () => {
    it("GET /v1.0/sites/root returns site with webUrl", async () => {
      const res = await api("GET", "/v1.0/sites/root");
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      expect(res.body.name).toBeTruthy();
      expect(res.body.webUrl).toMatch(/sharepoint\.com/);
    });

    it("404 for unknown site", async () => {
      const res = await api("GET", "/v1.0/sites/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("itemNotFound");
    });
  });

  describe("Lists & items", () => {
    it("creates, lists and gets a list", async () => {
      const created = await api("POST", "/v1.0/sites/root/lists", { displayName: "Tasks" });
      expect(created.status).toBe(201);
      expect(created.body.displayName).toBe("Tasks");
      const listId = created.body.id;

      const list = await api("GET", "/v1.0/sites/root/lists");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body.value)).toBe(true);
      expect(list.body.value.some((l: Json) => l.id === listId)).toBe(true);

      const got = await api("GET", `/v1.0/sites/root/lists/${listId}`);
      expect(got.status).toBe(200);
      expect(got.body.displayName).toBe("Tasks");
    });

    it("rejects list creation without displayName", async () => {
      const res = await api("POST", "/v1.0/sites/root/lists", {});
      expect(res.status).toBe(400);
    });

    it("creates and lists items in a list", async () => {
      const created = await api("POST", "/v1.0/sites/root/lists", { displayName: "Inventory" });
      const listId = created.body.id;
      const item = await api("POST", `/v1.0/sites/root/lists/${listId}/items`, {
        fields: { Title: "Widget", Quantity: 10 },
      });
      expect(item.status).toBe(201);
      expect(item.body.id).toBeTruthy();
      expect(item.body.fields.Title).toBe("Widget");

      const items = await api("GET", `/v1.0/sites/root/lists/${listId}/items`);
      expect(items.status).toBe(200);
      expect(items.body.value.length).toBe(1);
    });
  });

  describe("Drive children", () => {
    it("GET /v1.0/sites/root/drive/root/children returns value array", async () => {
      const res = await api("GET", "/v1.0/sites/root/drive/root/children");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.value)).toBe(true);
      expect(res.body.value.length).toBeGreaterThanOrEqual(1);
      expect(res.body.value[0].name).toBeTruthy();
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/v1.0/sites/root/lists", { displayName: "Temp" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const lists = await api("GET", "/v1.0/sites/root/lists");
      expect(lists.body.value.length).toBe(0);
    });
  });
});
