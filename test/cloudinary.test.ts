import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudinaryServer } from "../services/cloudinary/src/server.js";

const PORT = 14838;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CLOUD = "parlel";
const BASIC = "Basic " + Buffer.from("apikey:apisecret").toString("base64");

type Json = Record<string, any>;

async function form(path: string, params: Record<string, string>, headers: Json = {}) {
  const body = new URLSearchParams(params).toString();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function get(path: string, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("Cloudinary Service", () => {
  let server: CloudinaryServer;

  beforeAll(async () => {
    server = new CloudinaryServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await get("/");
      expect(root.body.name).toBe("cloudinary");
      const health = await get("/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("upload (urlencoded)", () => {
    it("uploads with upload_preset (unsigned) and returns the resource shape", async () => {
      const r = await form(`/v1_1/${CLOUD}/image/upload`, {
        file: "https://example.com/cat.jpg",
        upload_preset: "ml_default",
        public_id: "cat",
      });
      expect(r.status).toBe(200);
      expect(r.body.public_id).toBe("cat");
      expect(r.body.format).toBe("jpg");
      expect(typeof r.body.version).toBe("number");
      expect(r.body.url).toContain(`/${CLOUD}/image/upload/`);
      expect(r.body.secure_url).toMatch(/^https:\/\//);
      expect(typeof r.body.bytes).toBe("number");
      expect(typeof r.body.width).toBe("number");
      expect(typeof r.body.height).toBe("number");
    });

    it("uploads with a signature", async () => {
      const r = await form(`/v1_1/${CLOUD}/image/upload`, {
        file: "data:image/png;base64,iVBOR",
        api_key: "parlel",
        timestamp: "123",
        signature: "abc123",
        public_id: "signed",
      });
      expect(r.status).toBe(200);
      expect(r.body.public_id).toBe("signed");
    });

    it("rejects unauthenticated upload (no preset/signature/auth)", async () => {
      const r = await form(`/v1_1/${CLOUD}/image/upload`, { file: "x.jpg" });
      expect(r.status).toBe(401);
    });

    it("auto-generates a public_id when omitted", async () => {
      const r = await form(`/v1_1/${CLOUD}/image/upload`, { file: "x.png", upload_preset: "ml" });
      expect(r.status).toBe(200);
      expect(typeof r.body.public_id).toBe("string");
      expect(r.body.public_id.length).toBeGreaterThan(0);
    });
  });

  describe("admin resources", () => {
    it("401 without basic auth", async () => {
      const r = await get(`/v1_1/${CLOUD}/resources/image`);
      expect(r.status).toBe(401);
    });

    it("lists uploaded resources with basic auth", async () => {
      await form(`/v1_1/${CLOUD}/image/upload`, { file: "a.jpg", upload_preset: "ml", public_id: "a" });
      await form(`/v1_1/${CLOUD}/image/upload`, { file: "b.jpg", upload_preset: "ml", public_id: "b" });
      const r = await get(`/v1_1/${CLOUD}/resources/image`, { Authorization: BASIC });
      expect(r.status).toBe(200);
      expect(r.body.resources.length).toBe(2);
      expect(r.body.resources.map((x: Json) => x.public_id).sort()).toEqual(["a", "b"]);
    });

    it("retrieves a single resource", async () => {
      await form(`/v1_1/${CLOUD}/image/upload`, { file: "s.jpg", upload_preset: "ml", public_id: "single" });
      const r = await get(`/v1_1/${CLOUD}/resources/image/upload/single`, { Authorization: BASIC });
      expect(r.status).toBe(200);
      expect(r.body.public_id).toBe("single");
    });
  });

  describe("destroy", () => {
    it("destroys an uploaded resource", async () => {
      await form(`/v1_1/${CLOUD}/image/upload`, { file: "d.jpg", upload_preset: "ml", public_id: "doomed" });
      const del = await form(`/v1_1/${CLOUD}/image/destroy`, { public_id: "doomed", api_key: "parlel" });
      expect(del.status).toBe(200);
      expect(del.body.result).toBe("ok");
      const list = await get(`/v1_1/${CLOUD}/resources/image`, { Authorization: BASIC });
      expect(list.body.resources.length).toBe(0);
    });

    it("returns not found for unknown public_id", async () => {
      const del = await form(`/v1_1/${CLOUD}/image/destroy`, { public_id: "ghost", api_key: "parlel" });
      expect(del.body.result).toBe("not found");
    });

    it("401 destroy without auth", async () => {
      const del = await form(`/v1_1/${CLOUD}/image/destroy`, { public_id: "x" });
      expect(del.status).toBe(401);
    });
  });

  describe("reset", () => {
    it("clears resources", async () => {
      await form(`/v1_1/${CLOUD}/image/upload`, { file: "r.jpg", upload_preset: "ml", public_id: "r" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const list = await get(`/v1_1/${CLOUD}/resources/image`, { Authorization: BASIC });
      expect(list.body.resources.length).toBe(0);
    });
  });
});
