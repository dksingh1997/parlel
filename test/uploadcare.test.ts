import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { UploadcareServer } from "../services/uploadcare/src/server.js";

const PORT = 14840;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REST_AUTH = { Authorization: "Uploadcare.Simple parlel:secret" };

type Json = Record<string, any>;

async function get(path: string, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function del(path: string, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { method: "DELETE", headers });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function uploadFile(name: string, content: string, pubKey = "parlel") {
  const boundary = "----ucBoundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="UPLOADCARE_PUB_KEY"\r\n\r\n${pubKey}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: text/plain\r\n\r\n${content}\r\n` +
    `--${boundary}--\r\n`;
  const response = await fetch(`${BASE_URL}/base/`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

describe("Uploadcare Service", () => {
  let server: UploadcareServer;

  beforeAll(async () => {
    server = new UploadcareServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await get("/");
      expect(root.body.name).toBe("uploadcare");
      const health = await get("/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("upload API", () => {
    it("uploads a file and returns { file: uuid }", async () => {
      const up = await uploadFile("hi.txt", "hello uploadcare");
      expect(up.status).toBe(200);
      expect(typeof up.body.file).toBe("string");
      expect(up.body.file).toMatch(/^[0-9a-f]{8}-/);
    });

    it("rejects upload without pub key", async () => {
      const up = await uploadFile("x.txt", "x", "");
      expect(up.status).toBe(401);
    });
  });

  describe("REST API", () => {
    it("401 without Uploadcare.Simple auth", async () => {
      const r = await get("/files/");
      expect(r.status).toBe(401);
    });

    it("lists files with the {results,total} wrapper", async () => {
      await uploadFile("a.txt", "a");
      await uploadFile("b.txt", "b");
      const r = await get("/files/", REST_AUTH);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(2);
      expect(Array.isArray(r.body.results)).toBe(true);
      expect(r.body).toHaveProperty("next");
      expect(r.body).toHaveProperty("previous");
    });

    it("retrieves a single file by uuid", async () => {
      const up = await uploadFile("single.txt", "abc");
      const r = await get(`/files/${up.body.file}/`, REST_AUTH);
      expect(r.status).toBe(200);
      expect(r.body.uuid).toBe(up.body.file);
      expect(r.body.original_filename).toBe("single.txt");
      expect(r.body.size).toBe(Buffer.byteLength("abc"));
      expect(r.body.is_ready).toBe(true);
    });

    it("404 for unknown uuid", async () => {
      const r = await get("/files/00000000-0000-0000-0000-000000000000/", REST_AUTH);
      expect(r.status).toBe(404);
    });

    it("deletes via /files/:uuid/storage/", async () => {
      const up = await uploadFile("del.txt", "x");
      const d = await del(`/files/${up.body.file}/storage/`, REST_AUTH);
      expect(d.status).toBe(200);
      const after = await get(`/files/${up.body.file}/`, REST_AUTH);
      expect(after.status).toBe(404);
    });
  });

  describe("reset", () => {
    it("clears files", async () => {
      await uploadFile("r.txt", "x");
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await get("/files/", REST_AUTH);
      expect(r.body.total).toBe(0);
    });
  });
});
