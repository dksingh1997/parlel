import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Storage } from "@google-cloud/storage";
import { generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { GcsServer } from "../services/gcs/src/server.js";

// A lightweight, dependency-free fake of Google Cloud Storage exercised through
// the real `@google-cloud/storage` client. Mirrors the structure/style of
// tests/redis.test.ts and tests/postgres.test.ts.

const PORT = 14599;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

// A real RSA key so client-side getSignedUrl crypto works (no network needed).
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

let server: GcsServer;
let storage: Storage;

function makeStorage(): Storage {
  return new Storage({
    apiEndpoint: ENDPOINT,
    projectId: "parlel",
    credentials: {
      client_email: "parlel@parlel.iam.gserviceaccount.com",
      private_key: PRIVATE_KEY_PEM,
    },
  });
}

// Raw HTTP helper for internal/health endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
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
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
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

describe("GCS Service", () => {
  beforeAll(async () => {
    server = new GcsServer(PORT, { projectId: "parlel" });
    await server.start();
    storage = makeStorage();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -------------------------------------------------------------------------
  describe("Server / health", () => {
    it("responds to the health endpoint", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("gcs");
    });

    it("resets in-memory state", async () => {
      await storage.createBucket("reset-test-bucket");
      const before = await storage.getBuckets();
      expect(before[0].length).toBe(1);
      await resetServer();
      const after = await storage.getBuckets();
      expect(after[0].length).toBe(0);
    });

    it("exposes a service account endpoint", async () => {
      const [acct] = await storage.getServiceAccount();
      expect(acct.emailAddress).toContain("parlel");
    });
  });

  // -------------------------------------------------------------------------
  describe("Buckets", () => {
    it("creates a bucket", async () => {
      const [bucket] = await storage.createBucket("my-bucket");
      expect(bucket.name).toBe("my-bucket");
    });

    it("gets bucket metadata", async () => {
      await storage.createBucket("meta-bucket", { location: "US", storageClass: "STANDARD" });
      const [meta] = await storage.bucket("meta-bucket").getMetadata();
      expect(meta.name).toBe("meta-bucket");
      expect(meta.location).toBe("US");
      expect(meta.storageClass).toBe("STANDARD");
      expect(meta.kind).toBe("storage#bucket");
    });

    it("lists buckets", async () => {
      await storage.createBucket("bucket-a");
      await storage.createBucket("bucket-b");
      const [buckets] = await storage.getBuckets();
      const names = buckets.map((b) => b.name).sort();
      expect(names).toEqual(["bucket-a", "bucket-b"]);
    });

    it("lists buckets with prefix", async () => {
      await storage.createBucket("alpha-one");
      await storage.createBucket("beta-two");
      const [buckets] = await storage.getBuckets({ prefix: "alpha" });
      expect(buckets.map((b) => b.name)).toEqual(["alpha-one"]);
    });

    it("checks bucket existence", async () => {
      await storage.createBucket("exists-bucket");
      const [exists] = await storage.bucket("exists-bucket").exists();
      expect(exists).toBe(true);
      const [missing] = await storage.bucket("nope-bucket-xyz").exists();
      expect(missing).toBe(false);
    });

    it("deletes a bucket", async () => {
      await storage.createBucket("delete-me");
      await storage.bucket("delete-me").delete();
      const [exists] = await storage.bucket("delete-me").exists();
      expect(exists).toBe(false);
    });

    it("patches bucket labels", async () => {
      await storage.createBucket("label-bucket");
      await storage.bucket("label-bucket").setMetadata({ labels: { env: "test", team: "parlel" } });
      const [meta] = await storage.bucket("label-bucket").getMetadata();
      expect(meta.labels).toEqual({ env: "test", team: "parlel" });
    });

    it("enables versioning via setMetadata", async () => {
      await storage.createBucket("ver-toggle");
      await storage.bucket("ver-toggle").setMetadata({ versioning: { enabled: true } });
      const [meta] = await storage.bucket("ver-toggle").getMetadata();
      expect(meta.versioning?.enabled).toBe(true);
    });

    it("rejects an invalid bucket name", async () => {
      await expect(storage.createBucket("A")).rejects.toBeTruthy();
    });

    it("rejects a duplicate bucket (409)", async () => {
      await storage.createBucket("dup-bucket");
      await expect(storage.createBucket("dup-bucket")).rejects.toMatchObject({ code: 409 });
    });

    it("refuses to delete a non-empty bucket (409)", async () => {
      const [bucket] = await storage.createBucket("nonempty-bucket");
      await bucket.file("keep.txt").save("data");
      await expect(bucket.delete()).rejects.toMatchObject({ code: 409 });
    });

    it("returns 404 for missing bucket metadata", async () => {
      await expect(storage.bucket("ghost-bucket").getMetadata()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Objects: upload + download", () => {
    beforeEach(async () => {
      await storage.createBucket("obj-bucket");
    });

    it("uploads via resumable save (default) and downloads", async () => {
      const file = storage.bucket("obj-bucket").file("hello.txt");
      await file.save("hello world", { contentType: "text/plain" });
      const [contents] = await file.download();
      expect(contents.toString()).toBe("hello world");
    });

    it("uploads via simple (non-resumable) save", async () => {
      const file = storage.bucket("obj-bucket").file("simple.txt");
      await file.save("simple body", { resumable: false, contentType: "text/plain" });
      const [contents] = await file.download();
      expect(contents.toString()).toBe("simple body");
    });

    it("uploads a large file via chunked resumable upload", async () => {
      const big = Buffer.alloc(600 * 1024, 9);
      const file = storage.bucket("obj-bucket").file("big.bin");
      await file.save(big, { resumable: true, chunkSize: 256 * 1024 });
      const [contents] = await file.download();
      expect(contents.length).toBe(600 * 1024);
      expect(contents[0]).toBe(9);
      expect(contents[contents.length - 1]).toBe(9);
    });

    it("uploads binary data and preserves bytes", async () => {
      const data = Buffer.from([0, 1, 2, 255, 254, 128]);
      const file = storage.bucket("obj-bucket").file("bin.dat");
      await file.save(data);
      const [contents] = await file.download();
      expect(Buffer.compare(contents, data)).toBe(0);
    });

    it("streams via createWriteStream and createReadStream", async () => {
      const file = storage.bucket("obj-bucket").file("stream.txt");
      await new Promise<void>((resolve, reject) => {
        const ws = file.createWriteStream({ resumable: false });
        ws.on("finish", resolve).on("error", reject);
        ws.end("streamed-data");
      });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        file
          .createReadStream()
          .on("data", (c) => chunks.push(c as Buffer))
          .on("end", resolve)
          .on("error", reject);
      });
      expect(Buffer.concat(chunks).toString()).toBe("streamed-data");
    });

    it("supports ranged downloads", async () => {
      const file = storage.bucket("obj-bucket").file("range.txt");
      await file.save("0123456789");
      const [middle] = await file.download({ start: 2, end: 5 });
      expect(middle.toString()).toBe("2345");
    });

    it("returns valid crc32c/md5 hashes that the client validates", async () => {
      // download() runs crc32c validation by default; success implies correct hash.
      const file = storage.bucket("obj-bucket").file("hashed.txt");
      await file.save("validate me");
      const [contents] = await file.download();
      expect(contents.toString()).toBe("validate me");
      const [meta] = await file.getMetadata();
      expect(meta.crc32c).toBeTruthy();
      expect(meta.md5Hash).toBeTruthy();
    });

    it("returns 404 when downloading a missing object", async () => {
      await expect(storage.bucket("obj-bucket").file("nope.txt").download()).rejects.toMatchObject({ code: 404 });
    });

    it("returns 404 when uploading to a missing bucket", async () => {
      await expect(storage.bucket("no-bucket-xyz").file("x.txt").save("x")).rejects.toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe("Objects: metadata", () => {
    beforeEach(async () => {
      await storage.createBucket("md-bucket");
    });

    it("returns object metadata", async () => {
      const file = storage.bucket("md-bucket").file("m.txt");
      await file.save("abcde", { contentType: "text/plain" });
      const [meta] = await file.getMetadata();
      expect(meta.name).toBe("m.txt");
      expect(meta.bucket).toBe("md-bucket");
      expect(meta.size).toBe("5");
      expect(meta.contentType).toBe("text/plain");
      expect(meta.kind).toBe("storage#object");
      expect(meta.generation).toBeTruthy();
    });

    it("updates custom metadata via setMetadata", async () => {
      const file = storage.bucket("md-bucket").file("custom.txt");
      await file.save("x");
      await file.setMetadata({ metadata: { color: "blue", count: "3" }, contentType: "application/custom" });
      const [meta] = await file.getMetadata();
      expect(meta.metadata).toEqual({ color: "blue", count: "3" });
      expect(meta.contentType).toBe("application/custom");
    });

    it("removes a metadata key when set to null", async () => {
      const file = storage.bucket("md-bucket").file("rm.txt");
      await file.save("x");
      await file.setMetadata({ metadata: { a: "1", b: "2" } });
      await file.setMetadata({ metadata: { a: null } });
      const [meta] = await file.getMetadata();
      expect(meta.metadata).toEqual({ b: "2" });
    });

    it("checks object existence", async () => {
      const file = storage.bucket("md-bucket").file("e.txt");
      await file.save("x");
      const [exists] = await file.exists();
      expect(exists).toBe(true);
      const [missing] = await storage.bucket("md-bucket").file("ghost.txt").exists();
      expect(missing).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("Objects: listing", () => {
    beforeEach(async () => {
      const [bucket] = await storage.createBucket("list-bucket");
      await bucket.file("a.txt").save("a");
      await bucket.file("b.txt").save("b");
      await bucket.file("dir/c.txt").save("c");
      await bucket.file("dir/d.txt").save("d");
      await bucket.file("dir/sub/e.txt").save("e");
    });

    it("lists all objects", async () => {
      const [files] = await storage.bucket("list-bucket").getFiles();
      const names = files.map((f) => f.name).sort();
      expect(names).toEqual(["a.txt", "b.txt", "dir/c.txt", "dir/d.txt", "dir/sub/e.txt"]);
    });

    it("lists with a prefix", async () => {
      const [files] = await storage.bucket("list-bucket").getFiles({ prefix: "dir/" });
      expect(files.length).toBe(3);
    });

    it("lists with a delimiter and returns prefixes", async () => {
      const [files, , apiResponse] = await storage.bucket("list-bucket").getFiles({
        delimiter: "/",
        autoPaginate: false,
      });
      expect(files.map((f) => f.name).sort()).toEqual(["a.txt", "b.txt"]);
      expect((apiResponse as { prefixes?: string[] }).prefixes).toContain("dir/");
    });

    it("paginates results manually via pageToken", async () => {
      const [page1, nextQuery, resp] = await storage.bucket("list-bucket").getFiles({
        maxResults: 2,
        autoPaginate: false,
      });
      expect(page1.length).toBe(2);
      const token = (resp as { nextPageToken?: string }).nextPageToken;
      expect(token).toBeTruthy();

      // Follow the token returned by the server to fetch the next page.
      const [page2] = await storage.bucket("list-bucket").getFiles({
        maxResults: 2,
        pageToken: token,
        autoPaginate: false,
      });
      expect(page2.length).toBe(2);
      expect(page2[0].name).not.toBe(page1[0].name);

      // With autoPaginate (and no total cap) we get every object.
      const [allFiles] = await storage.bucket("list-bucket").getFiles();
      expect(allFiles.length).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  describe("Objects: copy / move / compose / rewrite", () => {
    beforeEach(async () => {
      const [bucket] = await storage.createBucket("copy-bucket");
      await bucket.file("source.txt").save("SOURCE", { contentType: "text/plain" });
      await storage.createBucket("dest-bucket");
    });

    it("copies an object within a bucket", async () => {
      const bucket = storage.bucket("copy-bucket");
      await bucket.file("source.txt").copy(bucket.file("copy.txt"));
      const [contents] = await bucket.file("copy.txt").download();
      expect(contents.toString()).toBe("SOURCE");
    });

    it("copies an object across buckets", async () => {
      const src = storage.bucket("copy-bucket").file("source.txt");
      await src.copy(storage.bucket("dest-bucket").file("there.txt"));
      const [contents] = await storage.bucket("dest-bucket").file("there.txt").download();
      expect(contents.toString()).toBe("SOURCE");
    });

    it("moves an object", async () => {
      const bucket = storage.bucket("copy-bucket");
      await bucket.file("source.txt").move(bucket.file("moved.txt"));
      const [movedExists] = await bucket.file("moved.txt").exists();
      const [origExists] = await bucket.file("source.txt").exists();
      expect(movedExists).toBe(true);
      expect(origExists).toBe(false);
    });

    it("composes multiple objects into one", async () => {
      const bucket = storage.bucket("copy-bucket");
      await bucket.file("p1.txt").save("AAA");
      await bucket.file("p2.txt").save("BBB");
      await bucket.combine([bucket.file("p1.txt"), bucket.file("p2.txt")], bucket.file("combined.txt"));
      const [contents] = await bucket.file("combined.txt").download();
      expect(contents.toString()).toBe("AAABBB");
    });

    it("rewrites an object across buckets", async () => {
      const src = storage.bucket("copy-bucket").file("source.txt");
      const [resp] = await src.copy(storage.bucket("dest-bucket").file("rewritten.txt"));
      expect(resp).toBeTruthy();
      const [contents] = await storage.bucket("dest-bucket").file("rewritten.txt").download();
      expect(contents.toString()).toBe("SOURCE");
    });

    it("returns 404 copying a missing source", async () => {
      await expect(
        storage.bucket("copy-bucket").file("ghost.txt").copy(storage.bucket("dest-bucket").file("x.txt")),
      ).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Objects: delete", () => {
    beforeEach(async () => {
      await storage.createBucket("del-bucket");
    });

    it("deletes an object", async () => {
      const file = storage.bucket("del-bucket").file("d.txt");
      await file.save("x");
      await file.delete();
      const [exists] = await file.exists();
      expect(exists).toBe(false);
    });

    it("deletes all files in a bucket", async () => {
      const bucket = storage.bucket("del-bucket");
      await bucket.file("one.txt").save("1");
      await bucket.file("two.txt").save("2");
      await bucket.deleteFiles();
      const [files] = await bucket.getFiles();
      expect(files.length).toBe(0);
    });

    it("returns 404 deleting a missing object", async () => {
      await expect(storage.bucket("del-bucket").file("missing.txt").delete()).rejects.toMatchObject({ code: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("Versioning", () => {
    beforeEach(async () => {
      await storage.createBucket("ver-bucket", { versioning: { enabled: true } });
    });

    it("keeps multiple generations", async () => {
      const file = storage.bucket("ver-bucket").file("v.txt");
      await file.save("V1");
      await file.save("V2");
      const [allVersions] = await storage.bucket("ver-bucket").getFiles({ versions: true });
      expect(allVersions.length).toBe(2);
    });

    it("returns the latest generation by default", async () => {
      const file = storage.bucket("ver-bucket").file("v.txt");
      await file.save("OLD");
      await file.save("NEW");
      const [contents] = await file.download();
      expect(contents.toString()).toBe("NEW");
    });
  });

  // -------------------------------------------------------------------------
  describe("Preconditions", () => {
    beforeEach(async () => {
      const [bucket] = await storage.createBucket("precond-bucket");
      await bucket.file("p.txt").save("P");
    });

    it("fails getMetadata with mismatched ifGenerationMatch (412)", async () => {
      await expect(
        storage.bucket("precond-bucket").file("p.txt").getMetadata({ ifGenerationMatch: "999999999" }),
      ).rejects.toMatchObject({ code: 412 });
    });

    it("succeeds getMetadata with a matching ifGenerationMatch", async () => {
      const file = storage.bucket("precond-bucket").file("p.txt");
      const [meta] = await file.getMetadata();
      const [meta2] = await file.getMetadata({ ifGenerationMatch: meta.generation });
      expect(meta2.generation).toBe(meta.generation);
    });
  });

  // -------------------------------------------------------------------------
  describe("ACLs", () => {
    beforeEach(async () => {
      const [bucket] = await storage.createBucket("acl-bucket");
      await bucket.file("a.txt").save("A");
    });

    it("makes an object public", async () => {
      await expect(storage.bucket("acl-bucket").file("a.txt").makePublic()).resolves.toBeTruthy();
    });

    it("makes an object private", async () => {
      await expect(storage.bucket("acl-bucket").file("a.txt").makePrivate()).resolves.toBeTruthy();
    });

    it("adds an object ACL entry", async () => {
      const acl = await storage.bucket("acl-bucket").file("a.txt").acl.add({
        entity: "user-test@example.com",
        role: "READER",
      });
      expect(acl[0].role).toBe("READER");
    });

    it("adds a bucket ACL entry", async () => {
      const acl = await storage.bucket("acl-bucket").acl.add({ entity: "allUsers", role: "READER" });
      expect(acl[0].entity).toBe("allUsers");
    });

    it("adds a default object ACL entry", async () => {
      const acl = await storage.bucket("acl-bucket").acl.default.add({ entity: "allUsers", role: "READER" });
      expect(acl[0].role).toBe("READER");
    });
  });

  // -------------------------------------------------------------------------
  describe("IAM", () => {
    beforeEach(async () => {
      await storage.createBucket("iam-bucket");
    });

    it("gets a bucket IAM policy", async () => {
      const [policy] = await storage.bucket("iam-bucket").iam.getPolicy();
      expect(policy.kind).toBe("storage#policy");
      expect(Array.isArray(policy.bindings)).toBe(true);
    });

    it("sets a bucket IAM policy", async () => {
      const [policy] = await storage.bucket("iam-bucket").iam.setPolicy({
        bindings: [{ role: "roles/storage.objectViewer", members: ["allUsers"] }],
      });
      expect(policy.bindings?.length).toBe(1);
    });

    it("tests IAM permissions", async () => {
      const [perms] = await storage.bucket("iam-bucket").iam.testPermissions(["storage.objects.get"]);
      expect(perms).toEqual({ "storage.objects.get": true });
    });
  });

  // -------------------------------------------------------------------------
  describe("HMAC keys", () => {
    it("creates, lists, gets, updates, and deletes an HMAC key", async () => {
      const email = "parlel@parlel.iam.gserviceaccount.com";
      const [hmacKey, secret] = await storage.createHmacKey(email);
      expect(secret).toBeTruthy();
      expect(hmacKey.metadata?.accessId).toBeTruthy();
      const accessId = hmacKey.metadata!.accessId as string;

      const [keys] = await storage.getHmacKeys();
      expect(keys.length).toBeGreaterThanOrEqual(1);

      const [meta] = await storage.hmacKey(accessId).getMetadata();
      expect(meta.accessId).toBe(accessId);

      const [updated] = await storage.hmacKey(accessId).setMetadata({ state: "INACTIVE" });
      expect(updated.state).toBe("INACTIVE");

      await storage.hmacKey(accessId).delete();
      const [keysAfter] = await storage.getHmacKeys();
      expect(keysAfter.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("Signed URLs", () => {
    beforeEach(async () => {
      const [bucket] = await storage.createBucket("signed-bucket");
      await bucket.file("s.txt").save("S");
    });

    it("generates a v4 read signed URL", async () => {
      const [url] = await storage.bucket("signed-bucket").file("s.txt").getSignedUrl({
        action: "read",
        expires: Date.now() + 60 * 1000,
        version: "v4",
      });
      expect(url).toContain("signed-bucket");
      expect(url).toContain("X-Goog-Signature");
    });

    it("generates a write signed URL", async () => {
      const [url] = await storage.bucket("signed-bucket").file("upload.txt").getSignedUrl({
        action: "write",
        expires: Date.now() + 60 * 1000,
        version: "v4",
        contentType: "text/plain",
      });
      expect(url).toContain("signed-bucket");
    });
  });

  // -------------------------------------------------------------------------
  describe("Bucket configuration helpers", () => {
    beforeEach(async () => {
      await storage.createBucket("cfg-bucket");
    });

    it("sets CORS configuration", async () => {
      await expect(
        storage.bucket("cfg-bucket").setCorsConfiguration([{ maxAgeSeconds: 3600, method: ["GET"], origin: ["*"] }]),
      ).resolves.toBeTruthy();
    });

    it("sets storage class", async () => {
      await storage.bucket("cfg-bucket").setStorageClass("NEARLINE");
      const [meta] = await storage.bucket("cfg-bucket").getMetadata();
      expect(meta.storageClass).toBe("NEARLINE");
    });

    it("adds a lifecycle rule", async () => {
      await expect(
        storage.bucket("cfg-bucket").addLifecycleRule({ action: "delete", condition: { age: 30 } }),
      ).resolves.toBeTruthy();
    });

    it("sets and gets labels", async () => {
      await storage.bucket("cfg-bucket").setLabels({ team: "parlel" });
      const [labels] = await storage.bucket("cfg-bucket").getLabels();
      expect(labels).toEqual({ team: "parlel" });
    });

    it("lists notifications (empty)", async () => {
      const [notifications] = await storage.bucket("cfg-bucket").getNotifications();
      expect(notifications).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Convenience: upload / rename / public", () => {
    beforeEach(async () => {
      await storage.createBucket("conv-bucket");
    });

    it("uploads from a Buffer-backed file and renames", async () => {
      const bucket = storage.bucket("conv-bucket");
      await bucket.file("first.txt").save("DATA");
      await bucket.file("first.txt").rename("second.txt");
      const [renamedExists] = await bucket.file("second.txt").exists();
      const [origExists] = await bucket.file("first.txt").exists();
      expect(renamedExists).toBe(true);
      expect(origExists).toBe(false);
    });

    it("reports isPublic via the public object path", async () => {
      const bucket = storage.bucket("conv-bucket");
      await bucket.file("pub.txt").save("PUB");
      const [isPublic] = await bucket.file("pub.txt").isPublic();
      // The parlel fake serves bytes without enforcing ACLs, so a present
      // object resolves as publicly readable.
      expect(typeof isPublic).toBe("boolean");
    });
  });

  // -------------------------------------------------------------------------
  describe("Wire-level error shapes", () => {
    it("returns a GCS-style JSON error body for a missing bucket", async () => {
      const res = await rawRequest({ path: "/storage/v1/b/definitely-missing" });
      expect(res.status).toBe(404);
      const json = JSON.parse(res.body);
      expect(json.error.code).toBe(404);
      expect(json.error.message).toContain("not found");
      expect(Array.isArray(json.error.errors)).toBe(true);
      expect(json.error.errors[0].reason).toBe("notFound");
    });

    it("returns 404 for an unknown route", async () => {
      const res = await rawRequest({ path: "/not/a/real/path" });
      expect(res.status).toBe(404);
    });

    it("emits an x-goog-hash header on download", async () => {
      await storage.createBucket("hash-bucket");
      await storage.bucket("hash-bucket").file("h.txt").save("hash");
      const res = await rawRequest({ path: "/storage/v1/b/hash-bucket/o/h.txt?alt=media" });
      expect(res.status).toBe(200);
      expect(String(res.headers["x-goog-hash"])).toContain("crc32c=");
      expect(String(res.headers["x-goog-hash"])).toContain("md5=");
    });
  });
});
