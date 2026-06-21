import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { JenkinsServer } from "../services/jenkins/src/server.js";

const PORT = 14877;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("parlel:apiToken123").toString("base64");
const AUTH = { Authorization: BASIC };

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

describe("Jenkins Service", () => {
  let server: JenkinsServer;

  beforeAll(async () => {
    server = new JenkinsServer(PORT);
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
      expect(root.body.name).toBe("jenkins");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing basic auth with 401", async () => {
      const res = await fetch(`${BASE_URL}/api/json`);
      expect(res.status).toBe(401);
    });

    it("accepts basic (user:apiToken) auth", async () => {
      const result = await api("GET", "/api/json");
      expect(result.status).toBe(200);
      expect(result.body._class).toBeTruthy();
    });
  });

  describe("Crumb issuer", () => {
    it("returns crumb and crumbRequestField", async () => {
      const result = await api("GET", "/crumbIssuer/api/json");
      expect(result.status).toBe(200);
      expect(result.body.crumb).toBeTruthy();
      expect(result.body.crumbRequestField).toBe("Jenkins-Crumb");
    });
  });

  describe("Jobs", () => {
    it("lists jobs at /api/json", async () => {
      const result = await api("GET", "/api/json");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body.jobs)).toBe(true);
      expect(result.body.jobs.length).toBeGreaterThanOrEqual(1);
    });

    it("creates a job via POST /createItem?name=", async () => {
      const result = await api("POST", "/createItem?name=new-pipeline");
      expect(result.status).toBe(200);
      const got = await api("GET", "/job/new-pipeline/api/json");
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("new-pipeline");
    });

    it("rejects duplicate job creation", async () => {
      await api("POST", "/createItem?name=dup");
      const result = await api("POST", "/createItem?name=dup");
      expect(result.status).toBe(400);
    });

    it("gets a job by name", async () => {
      const result = await api("GET", "/job/parlel-demo/api/json");
      expect(result.status).toBe(200);
      expect(result.body.name).toBe("parlel-demo");
      expect(result.body.buildable).toBe(true);
    });

    it("returns 404 for unknown job", async () => {
      const result = await api("GET", "/job/nope/api/json");
      expect(result.status).toBe(404);
    });
  });

  describe("Builds", () => {
    it("triggers a build returning 201 with Location header", async () => {
      const res = await fetch(`${BASE_URL}/job/parlel-demo/build`, {
        method: "POST",
        headers: AUTH,
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("location")).toBeTruthy();
    });

    it("retrieves lastBuild after a build", async () => {
      await fetch(`${BASE_URL}/job/parlel-demo/build`, { method: "POST", headers: AUTH });
      const last = await api("GET", "/job/parlel-demo/lastBuild/api/json");
      expect(last.status).toBe(200);
      expect(last.body.number).toBe(1);
      expect(last.body.result).toBe("SUCCESS");
    });

    it("increments build number across triggers", async () => {
      await fetch(`${BASE_URL}/job/parlel-demo/build`, { method: "POST", headers: AUTH });
      await fetch(`${BASE_URL}/job/parlel-demo/build`, { method: "POST", headers: AUTH });
      const last = await api("GET", "/job/parlel-demo/lastBuild/api/json");
      expect(last.body.number).toBe(2);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/createItem?name=temp");
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const got = await api("GET", "/job/temp/api/json");
      expect(got.status).toBe(404);
    });
  });
});
