import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AlgoliaServer } from "../services/algolia/src/server.js";

const PORT = 14884;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = {
  "X-Algolia-API-Key": "parlelTestKey",
  "X-Algolia-Application-Id": "PARLELAPP",
};

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

const INDEX = "products";

describe("Algolia Service", () => {
  let server: AlgoliaServer;

  beforeAll(async () => {
    server = new AlgoliaServer(PORT);
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
      expect(root.body.name).toBe("algolia");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing api key/app id with 403", async () => {
      const res = await fetch(`${BASE_URL}/1/indexes/${INDEX}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "x" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns Algolia-style error envelope for missing auth", async () => {
      const res = await fetch(`${BASE_URL}/1/indexes/${INDEX}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "x" }),
      });
      const body = await res.json();
      expect(body).toHaveProperty("message", "Invalid Application-ID or API key");
      expect(body).not.toHaveProperty("status");
    });

    it("accepts key + app id headers", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "" });
      expect(result.status).toBe(200);
    });
  });

  describe("Indexing", () => {
    it("adds an object returning {objectID,taskID,createdAt}", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}`, { name: "Blue Shoes", price: 50 });
      expect(result.status).toBe(201);
      expect(result.body.objectID).toBeTruthy();
      expect(result.body.taskID).toBeTruthy();
      expect(result.body.createdAt).toBeTruthy();
    });

    it("retrieves an object by objectID", async () => {
      const added = await api("POST", `/1/indexes/${INDEX}`, { name: "Red Hat", objectID: "hat-1" });
      const got = await api("GET", `/1/indexes/${INDEX}/hat-1`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("Red Hat");
    });

    it("returns 404 with message for non-existent object", async () => {
      const got = await api("GET", `/1/indexes/${INDEX}/nonexistent`);
      expect(got.status).toBe(404);
      expect(got.body).toHaveProperty("message", "ObjectID does not exist");
      expect(got.body).not.toHaveProperty("status");
    });

    it("deletes an object", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Temp", objectID: "temp-1" });
      const del = await api("DELETE", `/1/indexes/${INDEX}/temp-1`);
      expect(del.status).toBe(200);
      expect(del.body.taskID).toBeTruthy();
      expect(del.body.deletedAt).toBeTruthy();
      const gone = await api("GET", `/1/indexes/${INDEX}/temp-1`);
      expect(gone.status).toBe(404);
    });

    it("PUT adds or replaces an object", async () => {
      const put1 = await api("PUT", `/1/indexes/${INDEX}/obj-1`, { name: "First" });
      expect(put1.status).toBe(200);
      expect(put1.body.objectID).toBe("obj-1");
      expect(put1.body.taskID).toBeTruthy();
      expect(put1.body.updatedAt).toBeTruthy();

      const got = await api("GET", `/1/indexes/${INDEX}/obj-1`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("First");

      const put2 = await api("PUT", `/1/indexes/${INDEX}/obj-1`, { name: "Replaced" });
      expect(put2.status).toBe(200);
      const got2 = await api("GET", `/1/indexes/${INDEX}/obj-1`);
      expect(got2.body.name).toBe("Replaced");
    });

    it("PUT rejects objectID mismatch between body and URL", async () => {
      const result = await api("PUT", `/1/indexes/${INDEX}/url-id`, { name: "X", objectID: "body-id" });
      expect(result.status).toBe(400);
      expect(result.body).toHaveProperty("message");
    });

    it("batches add/update/delete operations", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "addObject", body: { name: "Batch One", objectID: "b1" } },
          { action: "addObject", body: { name: "Batch Two", objectID: "b2" } },
        ],
      });
      expect(result.status).toBe(200);
      expect(result.body.objectIDs).toEqual(["b1", "b2"]);
      const got = await api("GET", `/1/indexes/${INDEX}/b1`);
      expect(got.body.name).toBe("Batch One");
    });

    it("batch updateObject replaces an object", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Original", objectID: "upd-1" });
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "updateObject", body: { name: "Updated", objectID: "upd-1" } },
        ],
      });
      expect(result.status).toBe(200);
      expect(result.body.objectIDs).toEqual(["upd-1"]);
      const got = await api("GET", `/1/indexes/${INDEX}/upd-1`);
      expect(got.body.name).toBe("Updated");
    });

    it("batch partialUpdateObject merges attributes", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Item", price: 10, objectID: "pu-1" });
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "partialUpdateObject", body: { price: 20, objectID: "pu-1" } },
        ],
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/pu-1`);
      expect(got.body.name).toBe("Item");
      expect(got.body.price).toBe(20);
    });

    it("batch partialUpdateObject creates if not exists", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "partialUpdateObject", body: { name: "New", objectID: "punc-1" } },
        ],
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/punc-1`);
      expect(got.status).toBe(200);
      expect(got.body.name).toBe("New");
    });

    it("batch partialUpdateObjectNoCreate skips non-existent", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "partialUpdateObjectNoCreate", body: { name: "Ghost", objectID: "noexist" } },
        ],
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/noexist`);
      expect(got.status).toBe(404);
    });

    it("batch partialUpdateObjectNoCreate updates existing", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Orig", objectID: "punc-2" });
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "partialUpdateObjectNoCreate", body: { name: "Modified", objectID: "punc-2" } },
        ],
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/punc-2`);
      expect(got.body.name).toBe("Modified");
    });

    it("batch deleteObject removes objects", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Del", objectID: "del-1" });
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "deleteObject", body: { objectID: "del-1" } },
        ],
      });
      expect(result.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/del-1`);
      expect(got.status).toBe(404);
    });

    it("batch clear removes all records from index", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "A", objectID: "c1" });
      await api("POST", `/1/indexes/${INDEX}`, { name: "B", objectID: "c2" });
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "clear", body: {} },
        ],
      });
      expect(result.status).toBe(200);
      const search = await api("POST", `/1/indexes/${INDEX}/query`, { query: "" });
      expect(search.body.nbHits).toBe(0);
    });

    it("returns 400 for invalid batch body", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/batch`, { invalid: true });
      expect(result.status).toBe(400);
      expect(result.body).toHaveProperty("message");
      expect(result.body).not.toHaveProperty("status");
    });
  });

  describe("Delete index", () => {
    it("deletes an entire index", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "Item", objectID: "i1" });
      const del = await api("DELETE", `/1/indexes/${INDEX}`);
      expect(del.status).toBe(200);
      expect(del.body.taskID).toBeTruthy();
      expect(del.body.deletedAt).toBeTruthy();
      const search = await api("POST", `/1/indexes/${INDEX}/query`, { query: "" });
      expect(search.body.nbHits).toBe(0);
    });

    it("returns 200 when deleting non-existent index", async () => {
      const del = await api("DELETE", `/1/indexes/nonexistent`);
      expect(del.status).toBe(200);
      expect(del.body.taskID).toBeTruthy();
    });
  });

  describe("Search (real substring/token match)", () => {
    beforeEach(async () => {
      await api("POST", `/1/indexes/${INDEX}/batch`, {
        requests: [
          { action: "addObject", body: { name: "Blue Running Shoes", category: "footwear", objectID: "p1" } },
          { action: "addObject", body: { name: "Red Leather Boots", category: "footwear", objectID: "p2" } },
          { action: "addObject", body: { name: "Green Wool Hat", category: "accessories", objectID: "p3" } },
        ],
      });
    });

    it("returns the full Algolia search envelope", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "shoes" });
      expect(result.status).toBe(200);
      expect(result.body).toHaveProperty("hits");
      expect(result.body).toHaveProperty("nbHits");
      expect(result.body).toHaveProperty("page");
      expect(result.body).toHaveProperty("nbPages");
      expect(result.body).toHaveProperty("hitsPerPage");
      expect(result.body).toHaveProperty("query");
      expect(result.body).toHaveProperty("params");
      expect(result.body).toHaveProperty("processingTimeMS");
      expect(result.body).toHaveProperty("exhaustiveNbHits");
    });

    it("matches a single-token query", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "shoes" });
      expect(result.body.nbHits).toBe(1);
      expect(result.body.hits[0].objectID).toBe("p1");
    });

    it("matches across multiple records by shared token", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "footwear" });
      expect(result.body.nbHits).toBe(2);
      const ids = result.body.hits.map((h: any) => h.objectID).sort();
      expect(ids).toEqual(["p1", "p2"]);
    });

    it("requires all tokens to match (AND semantics)", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "red boots" });
      expect(result.body.nbHits).toBe(1);
      expect(result.body.hits[0].objectID).toBe("p2");
    });

    it("returns zero hits for non-matching query", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "umbrella" });
      expect(result.body.nbHits).toBe(0);
      expect(result.body.hits.length).toBe(0);
    });

    it("empty query returns all records", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "" });
      expect(result.body.nbHits).toBe(3);
    });

    it("respects hitsPerPage and page parameters", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "", hitsPerPage: 2, page: 0 });
      expect(result.body.hitsPerPage).toBe(2);
      expect(result.body.hits.length).toBe(2);
      expect(result.body.nbPages).toBe(2);
      expect(result.body.page).toBe(0);

      const page2 = await api("POST", `/1/indexes/${INDEX}/query`, { query: "", hitsPerPage: 2, page: 1 });
      expect(page2.body.hits.length).toBe(1);
      expect(page2.body.page).toBe(1);
    });

    it("includes _highlightResult in hits", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}/query`, { query: "shoes" });
      expect(result.body.hits[0]).toHaveProperty("_highlightResult");
      expect(result.body.hits[0]._highlightResult).toHaveProperty("name");
    });
  });

  describe("Error responses", () => {
    it("returns 404 for unknown routes", async () => {
      const result = await api("GET", "/1/unknown/path");
      expect(result.status).toBe(404);
      expect(result.body).toHaveProperty("message");
      expect(result.body).not.toHaveProperty("status");
    });

    it("returns 400 for invalid JSON body", async () => {
      const res = await fetch(`${BASE_URL}/1/indexes/${INDEX}`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("message", "Invalid JSON body");
      expect(body).not.toHaveProperty("status");
    });

    it("returns 400 for non-object body on addObject", async () => {
      const result = await api("POST", `/1/indexes/${INDEX}`, "string-body" as any);
      expect(result.status).toBe(400);
      expect(result.body).toHaveProperty("message");
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", `/1/indexes/${INDEX}`, { name: "X", objectID: "x" });
      const reset = await api("POST", "/__parlel/reset");
      expect(reset.status).toBe(200);
      const got = await api("GET", `/1/indexes/${INDEX}/x`);
      expect(got.status).toBe(404);
    });
  });
});
