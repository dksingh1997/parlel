import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FirecrawlServer } from "../services/firecrawl/src/server.js";

const PORT = 14885;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer fc-parlelTestKey" };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
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

describe("Firecrawl Service", () => {
  let server: FirecrawlServer;

  beforeAll(async () => {
    server = new FirecrawlServer(PORT);
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
      expect(root.body.name).toBe("firecrawl");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer with 401", async () => {
      const res = await fetch(`${BASE_URL}/v1/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://parlel.dev" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Scrape", () => {
    it("scrapes a URL returning {success,data:{markdown,html,metadata}}", async () => {
      const result = await api("POST", "/v1/scrape", { url: "https://parlel.dev/about" });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(typeof result.body.data.markdown).toBe("string");
      expect(typeof result.body.data.html).toBe("string");
      expect(result.body.data.metadata.title).toBeTruthy();
      expect(result.body.data.metadata.sourceURL).toBe("https://parlel.dev/about");
    });

    it("produces deterministic output for the same URL", async () => {
      const a = await api("POST", "/v1/scrape", { url: "https://parlel.dev/pricing" });
      const b = await api("POST", "/v1/scrape", { url: "https://parlel.dev/pricing" });
      expect(a.body.data.markdown).toBe(b.body.data.markdown);
      expect(a.body.data.metadata.title).toBe(b.body.data.metadata.title);
    });

    it("derives title from the URL path", async () => {
      const result = await api("POST", "/v1/scrape", { url: "https://parlel.dev/getting-started" });
      expect(result.body.data.metadata.title).toContain("Getting Started");
    });

    it("rejects scrape without url (400)", async () => {
      const result = await api("POST", "/v1/scrape", {});
      expect(result.status).toBe(400);
    });
  });

  describe("Crawl", () => {
    it("starts a crawl returning {success,id,url}", async () => {
      const result = await api("POST", "/v1/crawl", { url: "https://parlel.dev", limit: 3 });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(result.body.id).toBeTruthy();
      expect(result.body.url).toContain("/v1/crawl/");
    });

    it("fetches crawl status with completed data", async () => {
      const started = await api("POST", "/v1/crawl", { url: "https://parlel.dev", limit: 2 });
      const status = await api("GET", `/v1/crawl/${started.body.id}`);
      expect(status.status).toBe(200);
      expect(status.body.success).toBe(true);
      expect(status.body.status).toBe("completed");
      expect(Array.isArray(status.body.data)).toBe(true);
      expect(status.body.data.length).toBe(2);
    });

    it("returns 404 for unknown crawl", async () => {
      const result = await api("GET", "/v1/crawl/does-not-exist");
      expect(result.status).toBe(404);
    });
  });

  describe("Map", () => {
    it("maps a site returning {success,links:[]}", async () => {
      const result = await api("POST", "/v1/map", { url: "https://parlel.dev" });
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(Array.isArray(result.body.links)).toBe(true);
      expect(result.body.links.length).toBeGreaterThan(0);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      const started = await api("POST", "/v1/crawl", { url: "https://parlel.dev" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const status = await api("GET", `/v1/crawl/${started.body.id}`);
      expect(status.status).toBe(404);
    });
  });
});
