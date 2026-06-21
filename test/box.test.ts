import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BoxServer } from "../services/box/src/server.js";

const PORT = 14837;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelTestToken" };

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

async function uploadMultipart(name: string, content: string, parentId = "0") {
  const boundary = "----parlelBoundary123";
  const attributes = JSON.stringify({ name, parent: { id: parentId } });
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="attributes"\r\n\r\n` +
    `${attributes}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  const response = await fetch(`${BASE_URL}/2.0/files/content`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

describe("Box Service", () => {
  let server: BoxServer;

  beforeAll(async () => {
    server = new BoxServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("box");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 without bearer", async () => {
      const r = await fetch(`${BASE_URL}/2.0/users/me`);
      expect(r.status).toBe(401);
    });
    it("users/me ok", async () => {
      const r = await api("GET", "/2.0/users/me");
      expect(r.status).toBe(200);
      expect(r.body.type).toBe("user");
    });
  });

  describe("folders", () => {
    it("creates and gets a folder", async () => {
      const created = await api("POST", "/2.0/folders", { name: "docs", parent: { id: "0" } });
      expect(created.status).toBe(201);
      expect(created.body.type).toBe("folder");
      const got = await api("GET", `/2.0/folders/${created.body.id}`);
      expect(got.body.name).toBe("docs");
    });

    it("rejects folder without name", async () => {
      const r = await api("POST", "/2.0/folders", {});
      expect(r.status).toBe(400);
    });

    it("lists folder items", async () => {
      const folder = await api("POST", "/2.0/folders", { name: "media" });
      await uploadMultipart("a.txt", "a", folder.body.id);
      const items = await api("GET", `/2.0/folders/${folder.body.id}/items`);
      expect(items.body.total_count).toBe(1);
      expect(items.body.entries[0].name).toBe("a.txt");
    });

    it("deletes a folder", async () => {
      const folder = await api("POST", "/2.0/folders", { name: "tmp" });
      const del = await api("DELETE", `/2.0/folders/${folder.body.id}`);
      expect(del.status).toBe(204);
      const got = await api("GET", `/2.0/folders/${folder.body.id}`);
      expect(got.status).toBe(404);
    });
  });

  describe("files upload/download round-trip", () => {
    it("uploads via multipart and returns entries wrapper", async () => {
      const up = await uploadMultipart("hello.txt", "hello box");
      expect(up.status).toBe(201);
      expect(up.body.total_count).toBe(1);
      const entry = up.body.entries[0];
      expect(entry.type).toBe("file");
      expect(entry.name).toBe("hello.txt");
      expect(entry.size).toBe(Buffer.byteLength("hello box"));
    });

    it("downloads the exact bytes", async () => {
      const up = await uploadMultipart("round.txt", "round-trip-content");
      const id = up.body.entries[0].id;
      const response = await fetch(`${BASE_URL}/2.0/files/${id}/content`, { headers: AUTH });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("round-trip-content");
    });

    it("gets file metadata", async () => {
      const up = await uploadMultipart("meta.txt", "x");
      const id = up.body.entries[0].id;
      const got = await api("GET", `/2.0/files/${id}`);
      expect(got.body.name).toBe("meta.txt");
    });

    it("deletes a file", async () => {
      const up = await uploadMultipart("del.txt", "x");
      const id = up.body.entries[0].id;
      const del = await api("DELETE", `/2.0/files/${id}`);
      expect(del.status).toBe(204);
      const got = await api("GET", `/2.0/files/${id}`);
      expect(got.status).toBe(404);
    });

    it("404 for missing file", async () => {
      const got = await api("GET", "/2.0/files/999999");
      expect(got.status).toBe(404);
    });
  });

  describe("reset", () => {
    it("clears files", async () => {
      const up = await uploadMultipart("r.txt", "x");
      await api("POST", "/__parlel/reset");
      const got = await api("GET", `/2.0/files/${up.body.entries[0].id}`);
      expect(got.status).toBe(404);
    });
  });
});
