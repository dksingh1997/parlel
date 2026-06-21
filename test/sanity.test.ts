import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SanityServer } from "../services/sanity/src/server.js";

const PORT = 14842;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: "Bearer parlelToken" };
const DATASET = "production";
const V = "/v2021-10-21";

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

function q(groq: string) {
  return `${V}/data/query/${DATASET}?query=${encodeURIComponent(groq)}`;
}

async function createDoc(doc: Json) {
  return api("POST", `${V}/data/mutate/${DATASET}`, { mutations: [{ create: doc }] });
}

describe("Sanity Service", () => {
  let server: SanityServer;

  beforeAll(async () => {
    server = new SanityServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("lifecycle", () => {
    it("port + root + health", async () => {
      expect(server.port).toBe(PORT);
      const root = await api("GET", "/");
      expect(root.body.name).toBe("sanity");
      const health = await api("GET", "/health");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("auth", () => {
    it("401 without bearer", async () => {
      const r = await fetch(`${BASE_URL}${q("*")}`);
      expect(r.status).toBe(401);
    });
  });

  describe("mutations", () => {
    it("creates a document and returns transactionId + results", async () => {
      const r = await createDoc({ _type: "post", title: "Hello" });
      expect(r.status).toBe(200);
      expect(typeof r.body.transactionId).toBe("string");
      expect(r.body.results[0].operation).toBe("create");
      expect(r.body.results[0].id).toBeTruthy();
    });

    it("creates with explicit _id", async () => {
      const r = await createDoc({ _id: "post-1", _type: "post", title: "Fixed" });
      expect(r.body.results[0].id).toBe("post-1");
    });

    it("patches a document", async () => {
      await createDoc({ _id: "p", _type: "post", title: "v1" });
      const r = await api("POST", `${V}/data/mutate/${DATASET}?returnDocuments=true`, {
        mutations: [{ patch: { id: "p", set: { title: "v2" } } }],
      });
      expect(r.status).toBe(200);
      expect(r.body.results[0].operation).toBe("update");
      expect(r.body.documents[0].title).toBe("v2");
    });

    it("deletes a document", async () => {
      await createDoc({ _id: "d", _type: "post", title: "x" });
      const r = await api("POST", `${V}/data/mutate/${DATASET}`, { mutations: [{ delete: { id: "d" } }] });
      expect(r.body.results[0].operation).toBe("delete");
      const doc = await api("GET", `${V}/data/doc/${DATASET}/d`);
      expect(doc.body.documents.length).toBe(0);
    });
  });

  describe("GROQ query", () => {
    it("returns all docs for *", async () => {
      await createDoc({ _type: "post", title: "a" });
      await createDoc({ _type: "author", name: "b" });
      const r = await api("GET", q("*"));
      expect(r.status).toBe(200);
      expect(r.body.query).toBe("*");
      expect(typeof r.body.ms).toBe("number");
      expect(r.body.result.length).toBe(2);
    });

    it('filters by _type with *[_type == "post"]', async () => {
      await createDoc({ _type: "post", title: "a" });
      await createDoc({ _type: "post", title: "b" });
      await createDoc({ _type: "author", name: "c" });
      const r = await api("GET", q('*[_type == "post"]'));
      expect(r.body.result.length).toBe(2);
      expect(r.body.result.every((d: Json) => d._type === "post")).toBe(true);
    });

    it("supports [0] to pick the first match", async () => {
      await createDoc({ _id: "first", _type: "post", title: "a" });
      const r = await api("GET", q('*[_type == "post"][0]'));
      expect(r.body.result._id).toBe("first");
    });

    it("400 for unsupported GROQ", async () => {
      const r = await api("GET", q("count(*)"));
      expect(r.status).toBe(400);
    });
  });

  describe("get doc by id", () => {
    it("returns the doc in a documents array", async () => {
      await createDoc({ _id: "byid", _type: "post", title: "x" });
      const r = await api("GET", `${V}/data/doc/${DATASET}/byid`);
      expect(r.status).toBe(200);
      expect(r.body.documents[0]._id).toBe("byid");
    });
  });

  describe("reset", () => {
    it("clears docs", async () => {
      await createDoc({ _type: "post", title: "x" });
      await fetch(`${BASE_URL}/__parlel/reset`, { method: "POST" });
      const r = await api("GET", q("*"));
      expect(r.body.result.length).toBe(0);
    });
  });
});
