import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DropboxServer } from "../services/dropbox/src/server.js";

const PORT = 14836;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelTestToken" };

type Json = Record<string, any>;

async function rpc(path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Dropbox Service", () => {
  let server: DropboxServer;

  beforeAll(async () => {
    server = new DropboxServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await (await fetch(`${BASE_URL}/`)).json();
      const health = await (await fetch(`${BASE_URL}/health`)).json();
      expect(root.name).toBe("dropbox");
      expect(health).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("rejects missing bearer with 401", async () => {
      const response = await fetch(`${BASE_URL}/2/users/get_current_account`, { method: "POST" });
      expect(response.status).toBe(401);
    });

    it("accepts bearer", async () => {
      const res = await rpc("/2/users/get_current_account");
      expect(res.status).toBe(200);
      expect(res.body.account_id).toBeTruthy();
    });
  });

  describe("upload + download round-trip", () => {
    async function upload(path: string, content: string) {
      const response = await fetch(`${BASE_URL}/2/files/upload`, {
        method: "POST",
        headers: {
          ...AUTH,
          "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite" }),
          "Content-Type": "application/octet-stream",
        },
        body: content,
      });
      const meta = await response.json();
      return { status: response.status, meta };
    }

    it("uploads content and returns file metadata", async () => {
      const { status, meta } = await upload("/hello.txt", "hello parlel");
      expect(status).toBe(200);
      expect(meta[".tag"]).toBe("file");
      expect(meta.name).toBe("hello.txt");
      expect(meta.path_display).toBe("/hello.txt");
      expect(meta.size).toBe(Buffer.byteLength("hello parlel"));
      expect(meta.id).toMatch(/^id:/);
    });

    it("downloads the exact content uploaded", async () => {
      await upload("/round.txt", "binary-ish content 123");
      const response = await fetch(`${BASE_URL}/2/files/download`, {
        method: "POST",
        headers: { ...AUTH, "Dropbox-API-Arg": JSON.stringify({ path: "/round.txt" }) },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe("binary-ish content 123");
      expect(response.headers.get("dropbox-api-result")).toBeTruthy();
    });

    it("download of missing file returns 409 path not_found", async () => {
      const response = await fetch(`${BASE_URL}/2/files/download`, {
        method: "POST",
        headers: { ...AUTH, "Dropbox-API-Arg": JSON.stringify({ path: "/nope.txt" }) },
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error[".tag"]).toBe("path");
    });
  });

  describe("metadata, list, delete", () => {
    async function upload(path: string, content: string) {
      await fetch(`${BASE_URL}/2/files/upload`, {
        method: "POST",
        headers: { ...AUTH, "Dropbox-API-Arg": JSON.stringify({ path }) },
        body: content,
      });
    }

    it("get_metadata returns the file record", async () => {
      await upload("/meta.txt", "x");
      const res = await rpc("/2/files/get_metadata", { path: "/meta.txt" });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("meta.txt");
    });

    it("get_metadata 409 for missing", async () => {
      const res = await rpc("/2/files/get_metadata", { path: "/missing.txt" });
      expect(res.status).toBe(409);
    });

    it("list_folder returns top-level entries", async () => {
      await upload("/a.txt", "a");
      await upload("/b.txt", "b");
      await upload("/sub/c.txt", "c");
      const res = await rpc("/2/files/list_folder", { path: "" });
      expect(res.status).toBe(200);
      const names = res.body.entries.map((e: Json) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt"]);
      expect(res.body.has_more).toBe(false);
    });

    it("list_folder of a subfolder", async () => {
      await upload("/sub/c.txt", "c");
      const res = await rpc("/2/files/list_folder", { path: "/sub" });
      expect(res.body.entries.map((e: Json) => e.name)).toEqual(["c.txt"]);
    });

    it("delete_v2 removes a file", async () => {
      await upload("/del.txt", "x");
      const del = await rpc("/2/files/delete_v2", { path: "/del.txt" });
      expect(del.status).toBe(200);
      expect(del.body.metadata.name).toBe("del.txt");
      const after = await rpc("/2/files/get_metadata", { path: "/del.txt" });
      expect(after.status).toBe(409);
    });

    it("delete_v2 409 for missing", async () => {
      const del = await rpc("/2/files/delete_v2", { path: "/ghost.txt" });
      expect(del.status).toBe(409);
    });
  });

  describe("reset", () => {
    it("clears state", async () => {
      await fetch(`${BASE_URL}/2/files/upload`, {
        method: "POST",
        headers: { ...AUTH, "Dropbox-API-Arg": JSON.stringify({ path: "/r.txt" }) },
        body: "x",
      });
      await rpc("/__parlel/reset");
      const res = await rpc("/2/files/get_metadata", { path: "/r.txt" });
      expect(res.status).toBe(409);
    });
  });
});
