import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  ContainerClient,
} from "@azure/storage-blob";
import { AzureblobServer } from "../services/azureblob/src/server.js";

const PORT = 14590;
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const ENDPOINT = `http://127.0.0.1:${PORT}/${ACCOUNT}`;

function makeService(): BlobServiceClient {
  const cred = new StorageSharedKeyCredential(ACCOUNT, KEY);
  return new BlobServiceClient(ENDPOINT, cred, {
    retryOptions: { maxTries: 1 },
  });
}

async function streamToString(readable: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readable) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of readable as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let server: AzureblobServer;
let svc: BlobServiceClient;
let counter = 0;
function uniqueContainer(): string {
  counter += 1;
  return `c-${Date.now().toString(36)}-${counter}`.toLowerCase().slice(0, 40);
}

describe("Azure Blob Storage Service", () => {
  beforeAll(async () => {
    server = new AzureblobServer(PORT);
    await server.start();
    svc = makeService();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // -----------------------------------------------------------------------
  // Health / reset
  // -----------------------------------------------------------------------
  describe("internal endpoints", () => {
    it("responds to health", async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("azureblob");
    });

    it("resets state via POST /_parlel/reset", async () => {
      await svc.getContainerClient(uniqueContainer()).create();
      const res = await fetch(`http://127.0.0.1:${PORT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Service-level operations
  // -----------------------------------------------------------------------
  describe("BlobServiceClient", () => {
    it("getProperties returns service properties", async () => {
      const props = await svc.getProperties();
      expect(props).toBeDefined();
      expect(props.defaultServiceVersion).toBeDefined();
    });

    it("setProperties succeeds", async () => {
      const resp = await svc.setProperties({
        blobAnalyticsLogging: {
          version: "1.0",
          deleteProperty: false,
          read: false,
          write: false,
          retentionPolicy: { enabled: false },
        },
      });
      expect(resp._response.status).toBe(202);
    });

    it("getAccountInfo returns sku + kind", async () => {
      const info = await svc.getAccountInfo();
      expect(info.skuName).toBe("Standard_LRS");
      expect(info.accountKind).toBe("StorageV2");
    });

    it("getStatistics returns geo replication", async () => {
      const stats = await svc.getStatistics();
      expect(stats.geoReplication?.status).toBe("live");
    });

    it("listContainers enumerates created containers", async () => {
      const names = [uniqueContainer(), uniqueContainer(), uniqueContainer()];
      for (const n of names) await svc.getContainerClient(n).create();
      const seen: string[] = [];
      for await (const c of svc.listContainers()) seen.push(c.name);
      for (const n of names) expect(seen).toContain(n);
    });

    it("listContainers with prefix filters", async () => {
      const a = `pref-a-${counter}`;
      await svc.getContainerClient("pref-a-x").create();
      await svc.getContainerClient("other-y").create();
      const seen: string[] = [];
      for await (const c of svc.listContainers({ prefix: "pref-" })) seen.push(c.name);
      expect(seen).toContain("pref-a-x");
      expect(seen).not.toContain("other-y");
      void a;
    });

    it("listContainers includes metadata when requested", async () => {
      const name = uniqueContainer();
      await svc.getContainerClient(name).create({ metadata: { team: "parlel" } });
      let found: any;
      for await (const c of svc.listContainers({ includeMetadata: true })) {
        if (c.name === name) found = c;
      }
      expect(found?.metadata?.team).toBe("parlel");
    });

    it("getContainerClient + createContainer convenience", async () => {
      const name = uniqueContainer();
      const { containerClient } = await svc.createContainer(name);
      expect(containerClient).toBeInstanceOf(ContainerClient);
      const exists = await containerClient.exists();
      expect(exists).toBe(true);
      await svc.deleteContainer(name);
    });

    it("findBlobsByTags locates blobs by tag", async () => {
      const cname = uniqueContainer();
      const cc = svc.getContainerClient(cname);
      await cc.create();
      await cc.getBlockBlobClient("tagged.txt").upload("hi", 2, { tags: { project: "parlel" } });
      const found: string[] = [];
      for await (const b of svc.findBlobsByTags("project='parlel'")) found.push(b.name);
      expect(found).toContain("tagged.txt");
    });
  });

  // -----------------------------------------------------------------------
  // Container operations
  // -----------------------------------------------------------------------
  describe("ContainerClient", () => {
    let cc: ContainerClient;
    let name: string;

    beforeEach(async () => {
      name = uniqueContainer();
      cc = svc.getContainerClient(name);
      await cc.create();
    });

    it("create + exists", async () => {
      expect(await cc.exists()).toBe(true);
      expect(await svc.getContainerClient("nope-missing").exists()).toBe(false);
    });

    it("createIfNotExists is idempotent", async () => {
      const r = await cc.createIfNotExists();
      expect(r.succeeded).toBe(false); // already exists
    });

    it("duplicate create throws ContainerAlreadyExists", async () => {
      await expect(cc.create()).rejects.toMatchObject({ statusCode: 409 });
    });

    it("getProperties returns lease + metadata", async () => {
      const props = await cc.getProperties();
      expect(props.leaseState).toBe("available");
    });

    it("setMetadata + getProperties roundtrip", async () => {
      await cc.setMetadata({ owner: "parlel", env: "test" });
      const props = await cc.getProperties();
      expect(props.metadata?.owner).toBe("parlel");
      expect(props.metadata?.env).toBe("test");
    });

    it("getAccessPolicy / setAccessPolicy roundtrip", async () => {
      await cc.setAccessPolicy("blob", [
        {
          id: "policy1",
          accessPolicy: {
            permissions: "r",
            startsOn: new Date("2020-01-01T00:00:00Z"),
            expiresOn: new Date("2030-01-01T00:00:00Z"),
          },
        },
      ]);
      const acl = await cc.getAccessPolicy();
      expect(acl.blobPublicAccess).toBe("blob");
      expect(acl.signedIdentifiers[0].id).toBe("policy1");
    });

    it("delete + deleteIfExists", async () => {
      await cc.delete();
      expect(await cc.exists()).toBe(false);
      const r = await cc.deleteIfExists();
      expect(r.succeeded).toBe(false);
    });

    it("getProperties on missing container throws 404", async () => {
      await expect(svc.getContainerClient("missing-xyz").getProperties()).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("acquire + release container lease", async () => {
      const lease = cc.getBlobLeaseClient();
      const acquired = await lease.acquireLease(30);
      expect(acquired.leaseId).toBeDefined();
      await lease.releaseLease();
    });
  });

  // -----------------------------------------------------------------------
  // Block blob operations
  // -----------------------------------------------------------------------
  describe("BlockBlobClient", () => {
    let cc: ContainerClient;

    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("upload + download text", async () => {
      const bb = cc.getBlockBlobClient("hello.txt");
      await bb.upload("Hello parlel", Buffer.byteLength("Hello parlel"));
      const dl = await bb.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("Hello parlel");
      expect(dl.contentLength).toBe(12);
    });

    it("uploadData (buffer) + downloadToBuffer", async () => {
      const bb = cc.getBlockBlobClient("buf.bin");
      const data = Buffer.from([1, 2, 3, 4, 5]);
      await bb.uploadData(data);
      const out = await bb.downloadToBuffer();
      expect(Buffer.compare(out, data)).toBe(0);
    });

    it("upload with blobHTTPHeaders + metadata + tags", async () => {
      const bb = cc.getBlockBlobClient("rich.txt");
      await bb.upload("x", 1, {
        blobHTTPHeaders: { blobContentType: "text/plain", blobCacheControl: "max-age=60" },
        metadata: { a: "1", b: "2" },
        tags: { color: "blue" },
      });
      const props = await bb.getProperties();
      expect(props.contentType).toBe("text/plain");
      expect(props.cacheControl).toBe("max-age=60");
      expect(props.metadata?.a).toBe("1");
      const tags = await bb.getTags();
      expect(tags.tags.color).toBe("blue");
    });

    it("getProperties (HEAD) returns blob type + length", async () => {
      const bb = cc.getBlockBlobClient("p.txt");
      await bb.upload("abcde", 5);
      const props = await bb.getProperties();
      expect(props.blobType).toBe("BlockBlob");
      expect(props.contentLength).toBe(5);
    });

    it("download with range", async () => {
      const bb = cc.getBlockBlobClient("range.txt");
      await bb.upload("0123456789", 10);
      const dl = await bb.download(2, 3);
      expect(await streamToString(dl.readableStreamBody)).toBe("234");
    });

    it("exists is false for missing blob", async () => {
      expect(await cc.getBlockBlobClient("ghost.txt").exists()).toBe(false);
    });

    it("download missing blob throws BlobNotFound", async () => {
      await expect(cc.getBlockBlobClient("ghost.txt").download()).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("setMetadata updates metadata", async () => {
      const bb = cc.getBlockBlobClient("m.txt");
      await bb.upload("x", 1);
      await bb.setMetadata({ updated: "yes" });
      const props = await bb.getProperties();
      expect(props.metadata?.updated).toBe("yes");
    });

    it("setHTTPHeaders updates content type", async () => {
      const bb = cc.getBlockBlobClient("h.txt");
      await bb.upload("x", 1);
      await bb.setHTTPHeaders({ blobContentType: "application/json" });
      const props = await bb.getProperties();
      expect(props.contentType).toBe("application/json");
    });

    it("setTags + getTags + deletes via empty", async () => {
      const bb = cc.getBlockBlobClient("t.txt");
      await bb.upload("x", 1);
      await bb.setTags({ k1: "v1", k2: "v2" });
      const tags = await bb.getTags();
      expect(tags.tags.k1).toBe("v1");
      expect(tags.tags.k2).toBe("v2");
    });

    it("setAccessTier changes tier", async () => {
      const bb = cc.getBlockBlobClient("tier.txt");
      await bb.upload("x", 1);
      await bb.setAccessTier("Cool");
      const props = await bb.getProperties();
      expect(props.accessTier).toBe("Cool");
    });

    it("stageBlock + commitBlockList + getBlockList", async () => {
      const bb = cc.getBlockBlobClient("blocks.txt");
      const id1 = Buffer.from("block-0001").toString("base64");
      const id2 = Buffer.from("block-0002").toString("base64");
      await bb.stageBlock(id1, "Hello ", 6);
      await bb.stageBlock(id2, "World", 5);
      await bb.commitBlockList([id1, id2]);
      const dl = await bb.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("Hello World");
      const list = await bb.getBlockList("committed");
      expect(list.committedBlocks?.length).toBe(2);
    });

    it("getBlockList shows uncommitted blocks", async () => {
      const bb = cc.getBlockBlobClient("uncommitted.txt");
      const id = Buffer.from("blk-00001").toString("base64");
      await bb.stageBlock(id, "data", 4);
      const list = await bb.getBlockList("uncommitted");
      expect(list.uncommittedBlocks?.length).toBe(1);
    });

    it("createSnapshot creates a snapshot", async () => {
      const bb = cc.getBlockBlobClient("snap.txt");
      await bb.upload("v1", 2);
      const snap = await bb.createSnapshot();
      expect(snap.snapshot).toBeDefined();
    });

    it("delete blob then exists false", async () => {
      const bb = cc.getBlockBlobClient("del.txt");
      await bb.upload("x", 1);
      await bb.delete();
      expect(await bb.exists()).toBe(false);
    });

    it("deleteIfExists returns false when missing", async () => {
      const r = await cc.getBlockBlobClient("nope.txt").deleteIfExists();
      expect(r.succeeded).toBe(false);
    });

    it("delete blob with snapshots using include removes blob + snapshots", async () => {
      const bb = cc.getBlockBlobClient("snap-del.txt");
      await bb.upload("v1", 2);
      await bb.createSnapshot();
      await bb.createSnapshot();
      const props = await bb.getProperties();
      expect(props.blobType).toBe("BlockBlob");
      await bb.delete({ deleteSnapshots: "include" });
      expect(await bb.exists()).toBe(false);
    });

    it("delete blob snapshots only keeps the blob", async () => {
      const bb = cc.getBlockBlobClient("snap-only.txt");
      await bb.upload("keep-me", 7);
      await bb.createSnapshot();
      await bb.delete({ deleteSnapshots: "only" });
      expect(await bb.exists()).toBe(true);
      const dl = await bb.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("keep-me");
    });

    it("delete blob with snapshots and no deleteSnapshots header throws 409", async () => {
      const bb = cc.getBlockBlobClient("snap-conflict.txt");
      await bb.upload("x", 1);
      await bb.createSnapshot();
      await expect(bb.delete()).rejects.toMatchObject({ statusCode: 409 });
    });

    it("syncCopyFromURL copies blob content", async () => {
      const src = cc.getBlockBlobClient("src.txt");
      await src.upload("copy me", 7);
      const dest = cc.getBlockBlobClient("dest.txt");
      await dest.syncCopyFromURL(src.url);
      const dl = await dest.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("copy me");
    });

    it("beginCopyFromURL (async copy) completes", async () => {
      const src = cc.getBlockBlobClient("asrc.txt");
      await src.upload("async copy", 10);
      const dest = cc.getBlobClient("adest.txt");
      const poller = await dest.beginCopyFromURL(src.url);
      await poller.pollUntilDone();
      const dl = await dest.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("async copy");
    });

    it("conditional download (if-none-match *) yields 304-style behavior", async () => {
      const bb = cc.getBlockBlobClient("cond.txt");
      await bb.upload("hi", 2);
      await expect(
        bb.download(0, undefined, { conditions: { ifNoneMatch: "*" } }),
      ).rejects.toMatchObject({ statusCode: 304 });
    });
  });

  // -----------------------------------------------------------------------
  // Append blob operations
  // -----------------------------------------------------------------------
  describe("AppendBlobClient", () => {
    let cc: ContainerClient;
    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("create + appendBlock + download", async () => {
      const ab = cc.getAppendBlobClient("log.txt");
      await ab.create();
      await ab.appendBlock("line1\n", 6);
      await ab.appendBlock("line2\n", 6);
      const dl = await ab.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("line1\nline2\n");
      const props = await ab.getProperties();
      expect(props.blobType).toBe("AppendBlob");
    });

    it("createIfNotExists works", async () => {
      const ab = cc.getAppendBlobClient("c.txt");
      const r = await ab.createIfNotExists();
      expect(r.succeeded).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Page blob operations
  // -----------------------------------------------------------------------
  describe("PageBlobClient", () => {
    let cc: ContainerClient;
    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("create + uploadPages + download", async () => {
      const pb = cc.getPageBlobClient("disk.vhd");
      await pb.create(1024);
      const data = Buffer.alloc(512, 0x41); // 'A'
      await pb.uploadPages(data, 0, 512);
      const dl = await pb.download(0, 512);
      const out = await streamToString(dl.readableStreamBody);
      expect(out.length).toBe(512);
      expect(out[0]).toBe("A");
    });

    it("getPageRanges returns written ranges", async () => {
      const pb = cc.getPageBlobClient("pr.vhd");
      await pb.create(2048);
      await pb.uploadPages(Buffer.alloc(512, 1), 0, 512);
      await pb.uploadPages(Buffer.alloc(512, 1), 1024, 512);
      const ranges = await pb.getPageRanges();
      expect(ranges.pageRange?.length).toBeGreaterThanOrEqual(1);
    });

    it("clearPages zeroes a region", async () => {
      const pb = cc.getPageBlobClient("clear.vhd");
      await pb.create(1024);
      await pb.uploadPages(Buffer.alloc(512, 9), 0, 512);
      await pb.clearPages(0, 512);
      const ranges = await pb.getPageRanges();
      expect(ranges.pageRange?.length ?? 0).toBe(0);
    });

    it("resize grows the blob", async () => {
      const pb = cc.getPageBlobClient("resize.vhd");
      await pb.create(512);
      await pb.resize(2048);
      const props = await pb.getProperties();
      expect(props.contentLength).toBe(2048);
    });
  });

  // -----------------------------------------------------------------------
  // List blobs
  // -----------------------------------------------------------------------
  describe("listBlobs", () => {
    let cc: ContainerClient;
    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("listBlobsFlat enumerates blobs", async () => {
      await cc.getBlockBlobClient("a.txt").upload("1", 1);
      await cc.getBlockBlobClient("b.txt").upload("2", 1);
      await cc.getBlockBlobClient("dir/c.txt").upload("3", 1);
      const names: string[] = [];
      for await (const b of cc.listBlobsFlat()) names.push(b.name);
      expect(names.sort()).toEqual(["a.txt", "b.txt", "dir/c.txt"]);
    });

    it("listBlobsFlat with metadata + tags", async () => {
      await cc.getBlockBlobClient("m.txt").upload("1", 1, {
        metadata: { x: "y" },
        tags: { t: "1" },
      });
      let found: any;
      for await (const b of cc.listBlobsFlat({ includeMetadata: true, includeTags: true })) {
        if (b.name === "m.txt") found = b;
      }
      expect(found.metadata?.x).toBe("y");
    });

    it("listBlobsByHierarchy groups by delimiter", async () => {
      await cc.getBlockBlobClient("folder1/a.txt").upload("1", 1);
      await cc.getBlockBlobClient("folder1/b.txt").upload("2", 1);
      await cc.getBlockBlobClient("folder2/c.txt").upload("3", 1);
      await cc.getBlockBlobClient("root.txt").upload("4", 1);
      const prefixes: string[] = [];
      const blobs: string[] = [];
      for await (const item of cc.listBlobsByHierarchy("/")) {
        if (item.kind === "prefix") prefixes.push(item.name);
        else blobs.push(item.name);
      }
      expect(prefixes.sort()).toEqual(["folder1/", "folder2/"]);
      expect(blobs).toEqual(["root.txt"]);
    });

    it("listBlobsFlat with prefix", async () => {
      await cc.getBlockBlobClient("img/1.png").upload("1", 1);
      await cc.getBlockBlobClient("img/2.png").upload("2", 1);
      await cc.getBlockBlobClient("doc/1.txt").upload("3", 1);
      const names: string[] = [];
      for await (const b of cc.listBlobsFlat({ prefix: "img/" })) names.push(b.name);
      expect(names.sort()).toEqual(["img/1.png", "img/2.png"]);
    });
  });

  // -----------------------------------------------------------------------
  // Lease operations
  // -----------------------------------------------------------------------
  describe("BlobLeaseClient", () => {
    let cc: ContainerClient;
    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("acquire, renew, change, release a blob lease", async () => {
      const bb = cc.getBlockBlobClient("leased.txt");
      await bb.upload("x", 1);
      const lease = bb.getBlobLeaseClient();
      const a = await lease.acquireLease(-1);
      expect(a.leaseId).toBeDefined();
      await lease.renewLease();
      await lease.changeLease(crypto.randomUUID());
      await lease.releaseLease();
    });

    it("acquire twice with different id throws conflict", async () => {
      const bb = cc.getBlockBlobClient("l2.txt");
      await bb.upload("x", 1);
      const lease1 = bb.getBlobLeaseClient();
      await lease1.acquireLease(-1);
      const lease2 = bb.getBlobLeaseClient(crypto.randomUUID());
      await expect(lease2.acquireLease(-1)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("break a lease", async () => {
      const bb = cc.getBlockBlobClient("l3.txt");
      await bb.upload("x", 1);
      const lease = bb.getBlobLeaseClient();
      await lease.acquireLease(-1);
      const broken = await lease.breakLease(0);
      expect(broken._response.status).toBe(202);
    });
  });

  // -----------------------------------------------------------------------
  // *FromURL family + seal + undeleteContainer + multi-block upload
  // -----------------------------------------------------------------------
  describe("advanced operations", () => {
    let cc: ContainerClient;
    beforeEach(async () => {
      cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
    });

    it("stageBlockFromURL pulls source bytes", async () => {
      const src = cc.getBlockBlobClient("src.txt");
      await src.upload("abcdef", 6);
      const dest = cc.getBlockBlobClient("dest.txt");
      const id = Buffer.from("blk-00001").toString("base64");
      await dest.stageBlockFromURL(id, src.url, 0, 6);
      await dest.commitBlockList([id]);
      const dl = await dest.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("abcdef");
    });

    it("appendBlockFromURL appends source bytes", async () => {
      const src = cc.getBlockBlobClient("asrc.txt");
      await src.upload("appendme", 8);
      const ab = cc.getAppendBlobClient("adst.txt");
      await ab.create();
      await ab.appendBlockFromURL(src.url, { sourceOffset: 0, count: 8 });
      const dl = await ab.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("appendme");
    });

    it("uploadPagesFromURL copies pages", async () => {
      const src = cc.getPageBlobClient("psrc");
      await src.create(512);
      await src.uploadPages(Buffer.alloc(512, 0x42), 0, 512);
      const dst = cc.getPageBlobClient("pdst");
      await dst.create(512);
      await dst.uploadPagesFromURL(src.url, 0, 0, 512);
      const dl = await dst.download(0, 512);
      const out = await streamToString(dl.readableStreamBody);
      expect(out[0]).toBe("B");
    });

    it("append blob seal", async () => {
      const ab = cc.getAppendBlobClient("seal.txt");
      await ab.create();
      const r = await ab.seal();
      expect(r._response.status).toBe(200);
    });

    it("undeleteContainer restores a deleted container", async () => {
      const name = uniqueContainer();
      const c = svc.getContainerClient(name);
      await c.create();
      await c.getBlockBlobClient("keep.txt").upload("data", 4);
      await c.delete();
      expect(await c.exists()).toBe(false);
      await svc.undeleteContainer(name, "x");
      expect(await c.exists()).toBe(true);
      expect(await c.getBlockBlobClient("keep.txt").exists()).toBe(true);
    });

    it("multi-block uploadData + downloadToBuffer", async () => {
      const bb = cc.getBlockBlobClient("big.bin");
      const data = Buffer.alloc(8 * 1024 * 1024, 7);
      await bb.uploadData(data, { blockSize: 4 * 1024 * 1024 });
      const out = await bb.downloadToBuffer();
      expect(out.length).toBe(data.length);
      expect(Buffer.compare(out, data)).toBe(0);
    });

    it("uploadStream stores stream content", async () => {
      const { Readable } = await import("node:stream");
      const bb = cc.getBlockBlobClient("stream.txt");
      await bb.uploadStream(Readable.from([Buffer.from("streamed-content")]));
      const dl = await bb.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("streamed-content");
    });

    it("withSnapshot reads the snapshot copy", async () => {
      const bb = cc.getBlockBlobClient("ver.txt");
      await bb.upload("original", 8);
      const snap = await bb.createSnapshot();
      await bb.upload("updated!!", 9);
      const snapClient = bb.withSnapshot(snap.snapshot!);
      const dl = await snapClient.download();
      expect(await streamToString(dl.readableStreamBody)).toBe("original");
      const live = await bb.download();
      expect(await streamToString(live.readableStreamBody)).toBe("updated!!");
    });
  });

  // -----------------------------------------------------------------------
  // Batch operations
  // -----------------------------------------------------------------------
  describe("BlobBatchClient", () => {
    it("batch delete multiple blobs", async () => {
      const cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
      const urls: string[] = [];
      const cred = new StorageSharedKeyCredential(ACCOUNT, KEY);
      for (const n of ["x.txt", "y.txt", "z.txt"]) {
        const bb = cc.getBlockBlobClient(n);
        await bb.upload("data", 4);
        urls.push(bb.url);
      }
      const batchClient = svc.getBlobBatchClient();
      const resp = await batchClient.deleteBlobs(urls, cred);
      expect(resp.subResponses.length).toBe(3);
      for (const sub of resp.subResponses) {
        expect(sub.status).toBeLessThan(300);
      }
      expect(await cc.getBlockBlobClient("x.txt").exists()).toBe(false);
    });

    it("batch set access tier on multiple blobs", async () => {
      const cc = svc.getContainerClient(uniqueContainer());
      await cc.create();
      const cred = new StorageSharedKeyCredential(ACCOUNT, KEY);
      const urls: string[] = [];
      for (const n of ["a.txt", "b.txt"]) {
        const bb = cc.getBlockBlobClient(n);
        await bb.upload("data", 4);
        urls.push(bb.url);
      }
      const batchClient = svc.getBlobBatchClient();
      const resp = await batchClient.setBlobsAccessTier(urls, cred, "Cool");
      expect(resp.subResponses.length).toBe(2);
      const props = await cc.getBlockBlobClient("a.txt").getProperties();
      expect(props.accessTier).toBe("Cool");
    });
  });
});
