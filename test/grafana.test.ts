import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GrafanaServer } from "../services/grafana/src/server.js";

const PORT = 14879;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelTestToken" };

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

describe("Grafana Service", () => {
  let server: GrafanaServer;

  beforeAll(async () => {
    server = new GrafanaServer(PORT);
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

    it("returns parlel root and /health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.status).toBe(200);
      expect(root.body.name).toBe("grafana");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("serves both /health and /api/health (collision kept distinct)", async () => {
      const infra = await api("GET", "/health");
      const grafanaHealth = await api("GET", "/api/health", undefined, {});
      expect(infra.body).toEqual({ status: "ok" });
      expect(grafanaHealth.status).toBe(200);
      expect(grafanaHealth.body.database).toBe("ok");
      expect(grafanaHealth.body.version).toBeTruthy();
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer on /api/org with 401", async () => {
      const res = await fetch(`${BASE_URL}/api/org`);
      expect(res.status).toBe(401);
    });

    it("/api/health does not require auth", async () => {
      const res = await fetch(`${BASE_URL}/api/health`);
      expect(res.status).toBe(200);
    });

    it("accepts bearer auth on /api/org", async () => {
      const result = await api("GET", "/api/org");
      expect(result.status).toBe(200);
      expect(result.body.name).toBeTruthy();
    });
  });

  describe("Dashboards", () => {
    it("upserts a dashboard returning {id,uid,url,status,version,slug}", async () => {
      const result = await api("POST", "/api/dashboards/db", {
        dashboard: { title: "Parlel Metrics", panels: [] },
        overwrite: false,
      });
      expect(result.status).toBe(200);
      expect(result.body.status).toBe("success");
      expect(result.body.id).toBeTruthy();
      expect(result.body.uid).toBeTruthy();
      expect(result.body.version).toBe(1);
      expect(result.body.slug).toBe("parlel-metrics");
      expect(result.body.url).toContain("/d/");
    });

    it("retrieves a dashboard by uid", async () => {
      const created = await api("POST", "/api/dashboards/db", {
        dashboard: { title: "My Board" },
      });
      const got = await api("GET", `/api/dashboards/uid/${created.body.uid}`);
      expect(got.status).toBe(200);
      expect(got.body.dashboard.title).toBe("My Board");
      expect(got.body.meta.slug).toBe("my-board");
    });

    it("bumps version on re-upsert with same uid", async () => {
      const created = await api("POST", "/api/dashboards/db", {
        dashboard: { title: "Versioned" },
      });
      const uid = created.body.uid;
      const updated = await api("POST", "/api/dashboards/db", {
        dashboard: { uid, title: "Versioned v2" },
        overwrite: true,
      });
      expect(updated.body.version).toBe(2);
    });

    it("returns 404 for unknown dashboard uid", async () => {
      const result = await api("GET", "/api/dashboards/uid/nope");
      expect(result.status).toBe(404);
    });
  });

  describe("Datasources", () => {
    it("lists seeded datasources", async () => {
      const result = await api("GET", "/api/datasources");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a datasource", async () => {
      const result = await api("POST", "/api/datasources", {
        name: "Loki",
        type: "loki",
        url: "http://127.0.0.1:3100",
        access: "proxy",
      });
      expect(result.status).toBe(200);
      expect(result.body.datasource.name).toBe("Loki");
      const got = await api("GET", `/api/datasources/${result.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.type).toBe("loki");
    });
  });

  describe("Org", () => {
    it("returns the current org", async () => {
      const result = await api("GET", "/api/org");
      expect(result.status).toBe(200);
      expect(result.body.id).toBe(1);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      const created = await api("POST", "/api/dashboards/db", { dashboard: { title: "Temp" } });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const gone = await api("GET", `/api/dashboards/uid/${created.body.uid}`);
      expect(gone.status).toBe(404);
    });
  });
});
