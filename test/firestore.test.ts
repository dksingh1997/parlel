import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { FirestoreServer } from "../services/firestore/src/server.js";

// A lightweight, dependency-free fake of Google Cloud Firestore exercised
// through the real `@google-cloud/firestore` client over its HTTP/1.1 REST
// transport (preferRest). Mirrors the structure/style of tests/redis.test.ts
// and tests/postgres.test.ts.

const PORT = 14591;
const HOST = `127.0.0.1:${PORT}`;

// The Firestore client must see the emulator host before it is constructed.
process.env.FIRESTORE_EMULATOR_HOST = HOST;
process.env.GOOGLE_CLOUD_PROJECT = "parlel";
process.env.GCLOUD_PROJECT = "parlel";

// A real RSA key so the client-side JWT signing for credentials works without
// any network access. The parlel fake never validates the token.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

// Imported lazily after the env var is set.
let Firestore: any;
let FieldValue: any;
let FieldPath: any;
let GeoPoint: any;
let Timestamp: any;
let AggregateField: any;
let Filter: any;

let server: FirestoreServer;
let db: any;

function makeDb(): any {
  return new Firestore({
    projectId: "parlel",
    preferRest: true,
    credentials: {
      client_email: "parlel@parlel.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY_PEM,
    },
  });
}

// Raw HTTP helper for the internal endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resetServer(): Promise<void> {
  await rawRequest({ method: "POST", path: "/_parlel/reset" });
}

describe("Firestore Service", () => {
  beforeAll(async () => {
    const mod: any = await import("@google-cloud/firestore");
    Firestore = mod.Firestore;
    FieldValue = mod.FieldValue;
    FieldPath = mod.FieldPath;
    GeoPoint = mod.GeoPoint;
    Timestamp = mod.Timestamp;
    AggregateField = mod.AggregateField;
    Filter = mod.Filter;

    server = new FirestoreServer(PORT, { projectId: "parlel" });
    await server.start();
    db = makeDb();
  }, 30000);

  afterAll(async () => {
    if (db && typeof db.terminate === "function") {
      try {
        await db.terminate();
      } catch {
        /* ignore */
      }
    }
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -------------------------------------------------------------------------
  describe("Server / health", () => {
    it("exposes the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("responds to the health endpoint", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("firestore");
    });

    it("resets in-memory state", async () => {
      await db.collection("reset").doc("a").set({ v: 1 });
      let res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).documents).toBeGreaterThan(0);
      await resetServer();
      res = await rawRequest({ path: "/_parlel/health" });
      expect(JSON.parse(res.body).documents).toBe(0);
    });

    it("returns 404 for unknown paths", async () => {
      const res = await rawRequest({ path: "/nope" });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("Document set / get (Commit + GetDocument)", () => {
    it("creates and reads a document", async () => {
      const ref = db.collection("users").doc("alice");
      await ref.set({ name: "Alice", age: 30 });
      const snap = await ref.get();
      expect(snap.exists).toBe(true);
      expect(snap.id).toBe("alice");
      expect(snap.data()).toEqual({ name: "Alice", age: 30 });
    });

    it("returns a non-existent snapshot for a missing document", async () => {
      const snap = await db.collection("users").doc("ghost").get();
      expect(snap.exists).toBe(false);
      expect(snap.data()).toBeUndefined();
    });

    it("overwrites on set without merge", async () => {
      const ref = db.collection("users").doc("bob");
      await ref.set({ a: 1, b: 2 });
      await ref.set({ b: 3 });
      expect((await ref.get()).data()).toEqual({ b: 3 });
    });

    it("merges on set with { merge: true }", async () => {
      const ref = db.collection("users").doc("carol");
      await ref.set({ a: 1, b: 2 });
      await ref.set({ b: 3, c: 4 }, { merge: true });
      expect((await ref.get()).data()).toEqual({ a: 1, b: 3, c: 4 });
    });

    it("merges specific fields with mergeFields", async () => {
      const ref = db.collection("users").doc("dave");
      await ref.set({ a: 1, b: 2, c: 3 });
      await ref.set({ a: 9, b: 9, c: 9 }, { mergeFields: ["a"] });
      expect((await ref.get()).data()).toEqual({ a: 9, b: 2, c: 3 });
    });

    it("exposes createTime and updateTime", async () => {
      const ref = db.collection("times").doc("t1");
      await ref.set({ v: 1 });
      const snap = await ref.get();
      expect(snap.createTime).toBeDefined();
      expect(snap.updateTime).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("create()", () => {
    it("creates a new document", async () => {
      const ref = db.collection("c").doc("new");
      await ref.create({ v: 1 });
      expect((await ref.get()).data()).toEqual({ v: 1 });
    });

    it("rejects creating an existing document", async () => {
      const ref = db.collection("c").doc("dup");
      await ref.create({ v: 1 });
      await expect(ref.create({ v: 2 })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe("add() (auto-id)", () => {
    it("creates a document with a generated id", async () => {
      const ref = await db.collection("auto").add({ v: 42 });
      expect(ref.id).toBeTruthy();
      expect((await ref.get()).data()).toEqual({ v: 42 });
    });

    it("generates distinct ids", async () => {
      const a = await db.collection("auto").add({ v: 1 });
      const b = await db.collection("auto").add({ v: 2 });
      expect(a.id).not.toBe(b.id);
    });
  });

  // -------------------------------------------------------------------------
  describe("update() (Commit with updateMask + preconditions)", () => {
    it("updates existing fields and adds new ones", async () => {
      const ref = db.collection("u").doc("x");
      await ref.set({ a: 1, b: 2 });
      await ref.update({ b: 20, c: 30 });
      expect((await ref.get()).data()).toEqual({ a: 1, b: 20, c: 30 });
    });

    it("rejects updating a non-existent document", async () => {
      await expect(db.collection("u").doc("missing").update({ a: 1 })).rejects.toThrow();
    });

    it("updates nested fields via dotted paths", async () => {
      const ref = db.collection("u").doc("nested");
      await ref.set({ profile: { name: "n", age: 1 } });
      await ref.update({ "profile.age": 2 });
      expect((await ref.get()).data()).toEqual({ profile: { name: "n", age: 2 } });
    });

    it("deletes a field with FieldValue.delete()", async () => {
      const ref = db.collection("u").doc("del");
      await ref.set({ a: 1, b: 2 });
      await ref.update({ b: FieldValue.delete() });
      expect((await ref.get()).data()).toEqual({ a: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("delete() (Commit delete)", () => {
    it("deletes a document", async () => {
      const ref = db.collection("d").doc("gone");
      await ref.set({ v: 1 });
      await ref.delete();
      expect((await ref.get()).exists).toBe(false);
    });

    it("is idempotent for missing documents", async () => {
      await expect(db.collection("d").doc("never").delete()).resolves.toBeDefined();
    });

    it("honors a precondition that fails", async () => {
      const ref = db.collection("d").doc("pre");
      await expect(ref.delete({ exists: true })).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe("Field transforms", () => {
    it("FieldValue.serverTimestamp() sets a timestamp", async () => {
      const ref = db.collection("tf").doc("ts");
      await ref.set({ created: FieldValue.serverTimestamp() });
      const v = (await ref.get()).data().created;
      expect(v instanceof Timestamp).toBe(true);
    });

    it("FieldValue.increment() on a new field", async () => {
      const ref = db.collection("tf").doc("inc1");
      await ref.set({ n: FieldValue.increment(5) });
      expect((await ref.get()).data().n).toBe(5);
    });

    it("FieldValue.increment() accumulates", async () => {
      const ref = db.collection("tf").doc("inc2");
      await ref.set({ n: 10 });
      await ref.update({ n: FieldValue.increment(3) });
      await ref.update({ n: FieldValue.increment(-1) });
      expect((await ref.get()).data().n).toBe(12);
    });

    it("FieldValue.arrayUnion() adds only missing elements", async () => {
      const ref = db.collection("tf").doc("au");
      await ref.set({ arr: [1, 2] });
      await ref.update({ arr: FieldValue.arrayUnion(2, 3) });
      expect((await ref.get()).data().arr).toEqual([1, 2, 3]);
    });

    it("FieldValue.arrayRemove() removes elements", async () => {
      const ref = db.collection("tf").doc("ar");
      await ref.set({ arr: [1, 2, 3, 2] });
      await ref.update({ arr: FieldValue.arrayRemove(2) });
      expect((await ref.get()).data().arr).toEqual([1, 3]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Rich value types", () => {
    it("round-trips all supported value types", async () => {
      const ref = db.collection("rich").doc("r1");
      await ref.set({
        str: "hello",
        int: 42,
        dbl: 3.14,
        bool: true,
        nil: null,
        arr: [1, "two", false],
        map: { a: { b: 5 } },
        geo: new GeoPoint(37.7, -122.4),
        ts: new Timestamp(1000, 500),
        bytes: Buffer.from("bytes!"),
        ref: db.collection("other").doc("o1"),
      });
      const d = (await ref.get()).data();
      expect(d.str).toBe("hello");
      expect(d.int).toBe(42);
      expect(d.dbl).toBeCloseTo(3.14);
      expect(d.bool).toBe(true);
      expect(d.nil).toBeNull();
      expect(d.arr).toEqual([1, "two", false]);
      expect(d.map).toEqual({ a: { b: 5 } });
      expect(d.geo.latitude).toBe(37.7);
      expect(d.geo.longitude).toBe(-122.4);
      expect(d.ts.seconds).toBe(1000);
      expect(d.bytes.toString()).toBe("bytes!");
      expect(d.ref.id).toBe("o1");
    });
  });

  // -------------------------------------------------------------------------
  describe("Queries (RunQuery)", () => {
    beforeEach(async () => {
      const batch = db.batch();
      batch.set(db.collection("cities").doc("sf"), { name: "SF", pop: 875, state: "CA" });
      batch.set(db.collection("cities").doc("la"), { name: "LA", pop: 3900, state: "CA" });
      batch.set(db.collection("cities").doc("ny"), { name: "NY", pop: 8400, state: "NY" });
      batch.set(db.collection("cities").doc("chi"), { name: "CHI", pop: 2700, state: "IL" });
      await batch.commit();
    });

    it("returns all documents in a collection", async () => {
      const qs = await db.collection("cities").get();
      expect(qs.size).toBe(4);
    });

    it("filters with ==", async () => {
      const qs = await db.collection("cities").where("state", "==", "CA").get();
      expect(qs.size).toBe(2);
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["la", "sf"]);
    });

    it("filters with >", async () => {
      const qs = await db.collection("cities").where("pop", ">", 3000).get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["la", "ny"]);
    });

    it("filters with >= and <=", async () => {
      const qs = await db
        .collection("cities")
        .where("pop", ">=", 875)
        .where("pop", "<=", 3000)
        .get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["chi", "sf"]);
    });

    it("filters with != ", async () => {
      const qs = await db.collection("cities").where("state", "!=", "CA").get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["chi", "ny"]);
    });

    it("filters with in", async () => {
      const qs = await db.collection("cities").where("state", "in", ["CA", "IL"]).get();
      expect(qs.size).toBe(3);
    });

    it("filters with not-in", async () => {
      const qs = await db.collection("cities").where("state", "not-in", ["CA"]).get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["chi", "ny"]);
    });

    it("filters with array-contains", async () => {
      await db.collection("tags").doc("a").set({ t: ["x", "y"] });
      await db.collection("tags").doc("b").set({ t: ["y", "z"] });
      const qs = await db.collection("tags").where("t", "array-contains", "x").get();
      expect(qs.docs.map((d: any) => d.id)).toEqual(["a"]);
    });

    it("filters with array-contains-any", async () => {
      await db.collection("tags2").doc("a").set({ t: ["x", "y"] });
      await db.collection("tags2").doc("b").set({ t: ["z"] });
      await db.collection("tags2").doc("c").set({ t: ["q"] });
      const qs = await db.collection("tags2").where("t", "array-contains-any", ["y", "z"]).get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["a", "b"]);
    });

    it("orders ascending", async () => {
      const qs = await db.collection("cities").orderBy("pop").get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([875, 2700, 3900, 8400]);
    });

    it("orders descending", async () => {
      const qs = await db.collection("cities").orderBy("pop", "desc").get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([8400, 3900, 2700, 875]);
    });

    it("limits results", async () => {
      const qs = await db.collection("cities").orderBy("pop").limit(2).get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([875, 2700]);
    });

    it("applies offset", async () => {
      const qs = await db.collection("cities").orderBy("pop").offset(1).get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([2700, 3900, 8400]);
    });

    it("supports startAfter cursor", async () => {
      const qs = await db.collection("cities").orderBy("pop").startAfter(2700).get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([3900, 8400]);
    });

    it("supports startAt + endAt cursors", async () => {
      const qs = await db
        .collection("cities")
        .orderBy("pop")
        .startAt(875)
        .endAt(3900)
        .get();
      expect(qs.docs.map((d: any) => d.data().pop)).toEqual([875, 2700, 3900]);
    });

    it("returns empty result set cleanly", async () => {
      const qs = await db.collection("cities").where("state", "==", "ZZ").get();
      expect(qs.empty).toBe(true);
      expect(qs.size).toBe(0);
    });

    it("supports OR composite filters", async () => {
      const qs = await db
        .collection("cities")
        .where(Filter.or(Filter.where("state", "==", "NY"), Filter.where("state", "==", "IL")))
        .get();
      expect(qs.docs.map((d: any) => d.id).sort()).toEqual(["chi", "ny"]);
    });

    it("supports select() projection", async () => {
      const qs = await db.collection("cities").select("name").get();
      expect(Object.keys(qs.docs[0].data())).toEqual(["name"]);
    });

    it("queries by documentId()", async () => {
      const qs = await db.collection("cities").where(FieldPath.documentId(), "==", "sf").get();
      expect(qs.size).toBe(1);
      expect(qs.docs[0].id).toBe("sf");
    });
  });

  // -------------------------------------------------------------------------
  describe("Aggregation queries (RunAggregationQuery)", () => {
    beforeEach(async () => {
      const batch = db.batch();
      batch.set(db.collection("agg").doc("a"), { n: 10 });
      batch.set(db.collection("agg").doc("b"), { n: 20 });
      batch.set(db.collection("agg").doc("c"), { n: 30 });
      await batch.commit();
    });

    it("count()", async () => {
      const res = await db.collection("agg").count().get();
      expect(res.data().count).toBe(3);
    });

    it("count() with a filter", async () => {
      const res = await db.collection("agg").where("n", ">", 15).count().get();
      expect(res.data().count).toBe(2);
    });

    it("sum() and average()", async () => {
      const res = await db
        .collection("agg")
        .aggregate({
          total: AggregateField.sum("n"),
          avg: AggregateField.average("n"),
        })
        .get();
      expect(res.data().total).toBe(60);
      expect(res.data().avg).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  describe("BatchGetDocuments (getAll)", () => {
    it("returns found and missing documents", async () => {
      await db.collection("bg").doc("present").set({ v: 1 });
      const [a, b] = await db.getAll(
        db.collection("bg").doc("present"),
        db.collection("bg").doc("absent"),
      );
      expect(a.exists).toBe(true);
      expect(a.data()).toEqual({ v: 1 });
      expect(b.exists).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("WriteBatch (Commit, multiple writes)", () => {
    it("applies set/update/delete atomically", async () => {
      await db.collection("wb").doc("keep").set({ v: 1 });
      const batch = db.batch();
      batch.set(db.collection("wb").doc("a"), { v: 1 });
      batch.set(db.collection("wb").doc("b"), { v: 2 });
      batch.update(db.collection("wb").doc("keep"), { v: 100 });
      batch.delete(db.collection("wb").doc("keep"));
      await batch.commit();
      expect((await db.collection("wb").doc("a").get()).data()).toEqual({ v: 1 });
      expect((await db.collection("wb").doc("b").get()).data()).toEqual({ v: 2 });
      expect((await db.collection("wb").doc("keep").get()).exists).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("BatchWrite (bulkWriter)", () => {
    it("writes many documents via BulkWriter", async () => {
      const writer = db.bulkWriter();
      for (let i = 0; i < 5; i += 1) {
        writer.set(db.collection("bulk").doc(`d${i}`), { i });
      }
      await writer.close();
      const qs = await db.collection("bulk").get();
      expect(qs.size).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  describe("Transactions (BeginTransaction / Commit / Rollback)", () => {
    it("reads and writes within a transaction", async () => {
      const ref = db.collection("acct").doc("a1");
      await ref.set({ balance: 100 });
      await db.runTransaction(async (t: any) => {
        const d = await t.get(ref);
        t.update(ref, { balance: d.data().balance + 50 });
      });
      expect((await ref.get()).data().balance).toBe(150);
    });

    it("rolls back when the transaction body throws", async () => {
      const ref = db.collection("acct").doc("a2");
      await ref.set({ balance: 1 });
      await expect(
        db.runTransaction(async (t: any) => {
          t.update(ref, { balance: 999 });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await ref.get()).data().balance).toBe(1);
    });

    it("supports transactional getAll", async () => {
      await db.collection("acct").doc("x").set({ v: 1 });
      await db.collection("acct").doc("y").set({ v: 2 });
      const sum = await db.runTransaction(async (t: any) => {
        const docs = await t.getAll(
          db.collection("acct").doc("x"),
          db.collection("acct").doc("y"),
        );
        return docs.reduce((acc: number, d: any) => acc + d.data().v, 0);
      });
      expect(sum).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("ListDocuments", () => {
    it("lists document references in a collection", async () => {
      const batch = db.batch();
      for (let i = 0; i < 3; i += 1) batch.set(db.collection("ld").doc(`d${i}`), { i });
      await batch.commit();
      const refs = await db.collection("ld").listDocuments();
      expect(refs.length).toBe(3);
      expect(refs.map((r: any) => r.id).sort()).toEqual(["d0", "d1", "d2"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("ListCollectionIds", () => {
    it("lists root collections", async () => {
      await db.collection("alpha").doc("x").set({ v: 1 });
      await db.collection("beta").doc("y").set({ v: 1 });
      const cols = await db.listCollections();
      expect(cols.map((c: any) => c.id).sort()).toEqual(["alpha", "beta"]);
    });

    it("lists subcollections of a document", async () => {
      const parent = db.collection("p").doc("doc");
      await parent.set({ v: 1 });
      await parent.collection("sub1").doc("a").set({ v: 1 });
      await parent.collection("sub2").doc("b").set({ v: 1 });
      const cols = await parent.listCollections();
      expect(cols.map((c: any) => c.id).sort()).toEqual(["sub1", "sub2"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Subcollections + collectionGroup", () => {
    it("reads and writes subcollection documents", async () => {
      const post = db.collection("users").doc("u1").collection("posts").doc("p1");
      await post.set({ title: "hi" });
      expect((await post.get()).data()).toEqual({ title: "hi" });
    });

    it("queries across a collection group", async () => {
      await db.collection("users").doc("u1").collection("posts").doc("p1").set({ t: 1 });
      await db.collection("users").doc("u2").collection("posts").doc("p2").set({ t: 2 });
      await db.collection("orgs").doc("o1").collection("posts").doc("p3").set({ t: 3 });
      const qs = await db.collectionGroup("posts").get();
      expect(qs.size).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("PartitionQuery (getPartitions)", () => {
    it("returns partitions that cover every document", async () => {
      const batch = db.batch();
      for (let i = 0; i < 8; i += 1) {
        batch.set(db.collection("u").doc(`u${i}`).collection("posts").doc("p"), { i });
      }
      await batch.commit();

      const partitions: any[] = [];
      for await (const p of db.collectionGroup("posts").getPartitions(3)) {
        partitions.push(p);
      }
      expect(partitions.length).toBeGreaterThanOrEqual(1);

      let total = 0;
      for (const part of partitions) {
        total += (await part.toQuery().get()).size;
      }
      expect(total).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  describe("Raw REST endpoints (wire-level)", () => {
    const base = "/v1/projects/parlel/databases/(default)/documents";

    it("CreateDocument via POST with documentId", async () => {
      const res = await rawRequest({
        method: "POST",
        path: `${base}/raw?documentId=r1`,
        body: JSON.stringify({ fields: { a: { integerValue: "1" } } }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).name.endsWith("/raw/r1")).toBe(true);
    });

    it("GetDocument via GET", async () => {
      await rawRequest({
        method: "POST",
        path: `${base}/raw?documentId=r2`,
        body: JSON.stringify({ fields: { a: { integerValue: "2" } } }),
      });
      const res = await rawRequest({ method: "GET", path: `${base}/raw/r2` });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).fields.a.integerValue).toBe("2");
    });

    it("UpdateDocument via PATCH with updateMask", async () => {
      await rawRequest({
        method: "POST",
        path: `${base}/raw?documentId=r3`,
        body: JSON.stringify({ fields: { a: { integerValue: "1" } } }),
      });
      const res = await rawRequest({
        method: "PATCH",
        path: `${base}/raw/r3?updateMask.fieldPaths=b`,
        body: JSON.stringify({ fields: { b: { stringValue: "x" } } }),
      });
      expect(res.status).toBe(200);
      const fields = JSON.parse(res.body).fields;
      expect(fields.a.integerValue).toBe("1");
      expect(fields.b.stringValue).toBe("x");
    });

    it("ListDocuments via GET", async () => {
      await rawRequest({
        method: "POST",
        path: `${base}/rawlist?documentId=l1`,
        body: JSON.stringify({ fields: {} }),
      });
      const res = await rawRequest({ method: "GET", path: `${base}/rawlist` });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).documents.length).toBe(1);
    });

    it("DeleteDocument via DELETE", async () => {
      await rawRequest({
        method: "POST",
        path: `${base}/raw?documentId=r4`,
        body: JSON.stringify({ fields: {} }),
      });
      const del = await rawRequest({ method: "DELETE", path: `${base}/raw/r4` });
      expect(del.status).toBe(200);
      const get = await rawRequest({ method: "GET", path: `${base}/raw/r4` });
      expect(get.status).toBe(404);
    });

    it("GetDocument 404 maps to NOT_FOUND status", async () => {
      const res = await rawRequest({ method: "GET", path: `${base}/raw/never` });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error.status).toBe("NOT_FOUND");
    });

    it("ListCollectionIds via POST", async () => {
      await rawRequest({
        method: "POST",
        path: `${base}/colA?documentId=x`,
        body: JSON.stringify({ fields: {} }),
      });
      const res = await rawRequest({
        method: "POST",
        path: `${base}:listCollectionIds`,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).collectionIds).toContain("colA");
    });
  });

  // -------------------------------------------------------------------------
  describe("Error handling", () => {
    it("update on a missing doc surfaces NOT_FOUND (code 5)", async () => {
      try {
        await db.collection("err").doc("missing").update({ a: 1 });
        throw new Error("should have thrown");
      } catch (e: any) {
        expect(e.code).toBe(5);
      }
    });

    it("create on an existing doc rejects", async () => {
      const ref = db.collection("err").doc("dup");
      await ref.create({ v: 1 });
      await expect(ref.create({ v: 2 })).rejects.toThrow();
    });

    it("rejects invalid JSON bodies at the wire level", async () => {
      const res = await rawRequest({
        method: "POST",
        path: "/v1/projects/parlel/databases/(default)/documents:commit",
        body: "{not json",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });

    it("returns 501 for unsupported listen", async () => {
      const res = await rawRequest({
        method: "POST",
        path: "/v1/projects/parlel/databases/(default)/documents:listen",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(501);
    });
  });

  // -------------------------------------------------------------------------
  describe("Direct programmatic API", () => {
    it("reset() clears documents", async () => {
      await db.collection("prog").doc("a").set({ v: 1 });
      expect(server.documents.size).toBeGreaterThan(0);
      server.reset();
      expect(server.documents.size).toBe(0);
    });

    it("databasePath() reflects project + database", () => {
      expect(server.databasePath()).toBe("projects/parlel/databases/(default)");
    });
  });
});
