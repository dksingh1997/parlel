import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MuxServer } from "../services/mux/src/server.js";

const PORT = 14839;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = "Basic " + Buffer.from("tokenid:tokensecret").toString("base64");
const AUTH = { Authorization: BASIC };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Mux Service", () => {
  let server: MuxServer;

  beforeAll(async () => {
    server = new MuxServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("mux");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 without basic auth", async () => {
      const r = await fetch(`${BASE_URL}/video/v1/assets`);
      expect(r.status).toBe(401);
    });
  });

  describe("assets", () => {
    it("creates an asset (ready) with a data envelope and playback ids", async () => {
      const r = await api("POST", "/video/v1/assets", {
        input: [{ url: "https://example.com/video.mp4" }],
        playback_policy: ["public"],
      });
      expect(r.status).toBe(201);
      expect(r.body.data.id).toBeTruthy();
      expect(r.body.data.status).toBe("ready");
      expect(Array.isArray(r.body.data.playback_ids)).toBe(true);
      expect(r.body.data.playback_ids[0].policy).toBe("public");
      expect(r.body.data.playback_ids[0].id).toBeTruthy();
    });

    it("gets an asset by id", async () => {
      const created = await api("POST", "/video/v1/assets", { input: "u" });
      const id = created.body.data.id;
      const got = await api("GET", `/video/v1/assets/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.id).toBe(id);
    });

    it("lists assets", async () => {
      await api("POST", "/video/v1/assets", { input: "a" });
      await api("POST", "/video/v1/assets", { input: "b" });
      const list = await api("GET", "/video/v1/assets");
      expect(list.body.data.length).toBe(2);
    });

    it("gets playback-ids for an asset", async () => {
      const created = await api("POST", "/video/v1/assets", { input: "u", playback_policy: ["signed"] });
      const id = created.body.data.id;
      const pb = await api("GET", `/video/v1/assets/${id}/playback-ids`);
      expect(pb.status).toBe(200);
      expect(pb.body.data[0].policy).toBe("signed");
    });

    it("adds a playback id", async () => {
      const created = await api("POST", "/video/v1/assets", { input: "u" });
      const id = created.body.data.id;
      const added = await api("POST", `/video/v1/assets/${id}/playback-ids`, { policy: "signed" });
      expect(added.status).toBe(201);
      expect(added.body.data.policy).toBe("signed");
    });

    it("deletes an asset", async () => {
      const created = await api("POST", "/video/v1/assets", { input: "u" });
      const id = created.body.data.id;
      const del = await api("DELETE", `/video/v1/assets/${id}`);
      expect(del.status).toBe(204);
      const got = await api("GET", `/video/v1/assets/${id}`);
      expect(got.status).toBe(404);
    });

    it("404 for unknown asset", async () => {
      const got = await api("GET", "/video/v1/assets/does-not-exist");
      expect(got.status).toBe(404);
    });
  });

  describe("uploads", () => {
    it("creates a direct upload", async () => {
      const r = await api("POST", "/video/v1/uploads", {
        new_asset_settings: { playback_policy: ["public"] },
        cors_origin: "*",
      });
      expect(r.status).toBe(201);
      expect(r.body.data.id).toBeTruthy();
      expect(r.body.data.url).toMatch(/^https:\/\//);
      expect(r.body.data.status).toBe("waiting");
    });

    it("retrieves an upload", async () => {
      const created = await api("POST", "/video/v1/uploads", {});
      const id = created.body.data.id;
      const got = await api("GET", `/video/v1/uploads/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.id).toBe(id);
    });
  });

  describe("reset", () => {
    it("clears assets", async () => {
      const created = await api("POST", "/video/v1/assets", { input: "u" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const got = await api("GET", `/video/v1/assets/${created.body.data.id}`);
      expect(got.status).toBe(404);
    });
  });
});
