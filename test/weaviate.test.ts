import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WeaviateServer } from "../services/weaviate/src/server.js";

const PORT = 14859;
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("Weaviate Service", () => {
  let server: WeaviateServer;

  beforeAll(async () => {
    server = new WeaviateServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("weaviate");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Schema", () => {
    it("creates and lists a class", async () => {
      const created = await api("POST", "/v1/schema", {
        class: "Article",
        vectorizer: "none",
        properties: [{ name: "title", dataType: ["text"] }],
      });
      expect(created.status).toBe(200);
      expect(created.body.class).toBe("Article");
      const list = await api("GET", "/v1/schema");
      expect(list.body.classes.length).toBe(1);
      const get = await api("GET", "/v1/schema/Article");
      expect(get.body.class).toBe("Article");
    });

    it("deletes a class", async () => {
      await api("POST", "/v1/schema", { class: "Tmp", vectorizer: "none" });
      const del = await api("DELETE", "/v1/schema/Tmp");
      expect(del.status).toBe(200);
      const get = await api("GET", "/v1/schema/Tmp");
      expect(get.status).toBe(404);
    });

    it("rejects class without a name", async () => {
      const r = await api("POST", "/v1/schema", {});
      expect(r.status).toBe(422);
    });
  });

  describe("Objects", () => {
    it("creates, retrieves and deletes an object with a vector", async () => {
      await api("POST", "/v1/schema", { class: "Doc", vectorizer: "none" });
      const created = await api("POST", "/v1/objects", {
        class: "Doc",
        properties: { title: "hello" },
        vector: [1, 0, 0],
      });
      expect(created.status).toBe(200);
      const id = created.body.id;
      expect(created.body.vector).toEqual([1, 0, 0]);

      const got = await api("GET", `/v1/objects/Doc/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.properties.title).toBe("hello");

      const del = await api("DELETE", `/v1/objects/Doc/${id}`);
      expect(del.status).toBe(204);
      const gone = await api("GET", `/v1/objects/Doc/${id}`);
      expect(gone.status).toBe(404);
    });
  });

  describe("GraphQL nearVector search (real cosine NN)", () => {
    beforeEach(async () => {
      await api("POST", "/v1/schema", { class: "Vec", vectorizer: "none" });
      // Three orthogonal-ish unit vectors.
      await api("POST", "/v1/objects", { class: "Vec", properties: { name: "x" }, vector: [1, 0, 0] });
      await api("POST", "/v1/objects", { class: "Vec", properties: { name: "y" }, vector: [0, 1, 0] });
      await api("POST", "/v1/objects", { class: "Vec", properties: { name: "z" }, vector: [0, 0, 1] });
    });

    it("returns nearest neighbor first by cosine distance", async () => {
      const query = `{ Get { Vec(nearVector: { vector: [0.9, 0.1, 0.0] }, limit: 3) { name _additional { id distance certainty } } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      expect(r.status).toBe(200);
      const rows = r.body.data.Get.Vec;
      expect(rows.length).toBe(3);
      // Closest to [0.9,0.1,0] is the "x" vector [1,0,0].
      expect(rows[0].name).toBe("x");
      // Distances must be ascending.
      expect(rows[0]._additional.distance).toBeLessThanOrEqual(rows[1]._additional.distance);
      expect(rows[1]._additional.distance).toBeLessThanOrEqual(rows[2]._additional.distance);
    });

    it("respects limit", async () => {
      const query = `{ Get { Vec(nearVector: { vector: [0, 1, 0] }, limit: 1) { name _additional { id distance } } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      const rows = r.body.data.Get.Vec;
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe("y");
    });

    it("returns certainty in [0,1]", async () => {
      const query = `{ Get { Vec(nearVector: { vector: [1, 0, 0] }, limit: 1) { name _additional { certainty } } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      const cert = r.body.data.Get.Vec[0]._additional.certainty;
      expect(cert).toBeGreaterThan(0.99);
      expect(cert).toBeLessThanOrEqual(1);
    });
  });

  describe("GraphQL where filter + bm25 keyword search", () => {
    beforeEach(async () => {
      await api("POST", "/__parlel/reset");
      await api("POST", "/v1/schema", { class: "Post", vectorizer: "none" });
      await api("POST", "/v1/objects", { class: "Post", properties: { title: "hello world", views: 5 }, vector: [1, 0] });
      await api("POST", "/v1/objects", { class: "Post", properties: { title: "goodbye world", views: 50 }, vector: [0, 1] });
      await api("POST", "/v1/objects", { class: "Post", properties: { title: "hello again", views: 1 }, vector: [1, 1] });
    });

    it("filters with where Equal", async () => {
      const query = `{ Get { Post(where: { path: ["title"], operator: Equal, valueText: "hello world" }) { title } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      expect(r.body.data.Get.Post.map((x: any) => x.title)).toEqual(["hello world"]);
    });

    it("filters with where GreaterThan on a number", async () => {
      const query = `{ Get { Post(where: { path: ["views"], operator: GreaterThan, valueInt: 10 }) { title views } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      expect(r.body.data.Get.Post.map((x: any) => x.title)).toEqual(["goodbye world"]);
    });

    it("filters with where And operands", async () => {
      const query = `{ Get { Post(where: { operator: And, operands: [ { path: ["title"], operator: Like, valueText: "hello*" }, { path: ["views"], operator: GreaterThanEqual, valueInt: 5 } ] }) { title } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      expect(r.body.data.Get.Post.map((x: any) => x.title)).toEqual(["hello world"]);
    });

    it("ranks bm25 keyword matches by term frequency", async () => {
      const query = `{ Get { Post(bm25: { query: "hello" }) { title _additional { score } } } }`;
      const r = await api("POST", "/v1/graphql", { query });
      const titles = r.body.data.Get.Post.map((x: any) => x.title);
      // both "hello" docs match; "goodbye world" does not
      expect(new Set(titles)).toEqual(new Set(["hello world", "hello again"]));
      expect(r.body.data.Get.Post[0]._additional.score).toBeDefined();
    });
  });

  describe("State", () => {
    it("resets via /__parlel/reset", async () => {
      await api("POST", "/v1/schema", { class: "Doc", vectorizer: "none" });
      await api("POST", "/v1/objects", { class: "Doc", properties: {}, vector: [1] });
      await api("POST", "/__parlel/reset");
      const list = await api("GET", "/__parlel/objects");
      expect(list.body.count).toBe(0);
    });
  });
});
