import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  S3Client,
  // bucket ops
  CreateBucketCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
  HeadBucketCommand,
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  GetBucketAclCommand,
  PutBucketAclCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  GetBucketEncryptionCommand,
  PutBucketEncryptionCommand,
  DeleteBucketEncryptionCommand,
  GetBucketWebsiteCommand,
  PutBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  // object ops
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  GetObjectAclCommand,
  PutObjectAclCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  DeleteObjectTaggingCommand,
  GetObjectAttributesCommand,
  // multipart
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import { request as httpRequest } from "node:http";
import { S3Server } from "../services/s3/src/server.js";

function rawRequest(opts: { method?: string; path: string; host?: string; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.host ? { Host: opts.host } : {},
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

const PORT = 14566;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new S3Client({
    region: "us-east-1",
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
  });
}

async function streamToString(stream: any): Promise<string> {
  if (!stream) return "";
  if (typeof stream.transformToString === "function") return stream.transformToString();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  if (typeof stream.transformToByteArray === "function") {
    return Buffer.from(await stream.transformToByteArray());
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("S3 Service", () => {
  let server: S3Server;
  let s3: S3Client;

  beforeAll(async () => {
    server = new S3Server(PORT);
    await server.start();
    s3 = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    s3.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("s3");
    });

    it("has resettable ephemeral state", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "reset-bucket" }));
      expect(server.buckets.size).toBe(1);
      server.reset();
      expect(server.buckets.size).toBe(0);
    });

    it("resets via the internal reset endpoint", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "reset-http" }));
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.buckets.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("Bucket operations", () => {
    it("CreateBucket + ListBuckets", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "alpha" }));
      await s3.send(new CreateBucketCommand({ Bucket: "beta" }));
      const out = await s3.send(new ListBucketsCommand({}));
      const names = (out.Buckets || []).map((b) => b.Name).sort();
      expect(names).toEqual(["alpha", "beta"]);
      expect(out.Owner?.DisplayName).toBe("parlel");
    });

    it("HeadBucket succeeds for existing bucket", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "headme" }));
      const out = await s3.send(new HeadBucketCommand({ Bucket: "headme" }));
      expect(out.$metadata.httpStatusCode).toBe(200);
    });

    it("HeadBucket 404 for missing bucket", async () => {
      await expect(s3.send(new HeadBucketCommand({ Bucket: "ghost" }))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
    });

    it("CreateBucket rejects invalid bucket name", async () => {
      await expect(
        s3.send(new CreateBucketCommand({ Bucket: "AB" })),
      ).rejects.toMatchObject({ name: expect.any(String) });
    });

    it("CreateBucket re-create in us-east-1 is idempotent (200 OK)", async () => {
      // Real S3: re-creating a bucket you own in us-east-1 returns 200 OK
      // (legacy compatibility, resets ACLs) rather than an error.
      // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html
      await s3.send(new CreateBucketCommand({ Bucket: "dupe" }));
      const out = await s3.send(new CreateBucketCommand({ Bucket: "dupe" }));
      expect(out.$metadata.httpStatusCode).toBe(200);
    });

    it("CreateBucket re-create returns BucketAlreadyOwnedByYou outside us-east-1", async () => {
      // A server configured for a non-us-east-1 region returns 409.
      const other = new S3Server(PORT + 1, { region: "us-west-2" });
      await other.start();
      try {
        const c = new S3Client({
          region: "us-west-2",
          endpoint: `http://127.0.0.1:${PORT + 1}`,
          forcePathStyle: true,
          credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
        });
        await c.send(new CreateBucketCommand({ Bucket: "dupe2" }));
        await expect(c.send(new CreateBucketCommand({ Bucket: "dupe2" }))).rejects.toMatchObject({
          name: "BucketAlreadyOwnedByYou",
        });
        c.destroy();
      } finally {
        await other.stop();
      }
    });

    it("DeleteBucket removes an empty bucket", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "tempb" }));
      await s3.send(new DeleteBucketCommand({ Bucket: "tempb" }));
      expect(server.buckets.has("tempb")).toBe(false);
    });

    it("DeleteBucket on non-empty bucket => BucketNotEmpty", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "fullb" }));
      await s3.send(new PutObjectCommand({ Bucket: "fullb", Key: "k", Body: "x" }));
      await expect(s3.send(new DeleteBucketCommand({ Bucket: "fullb" }))).rejects.toMatchObject({
        name: "BucketNotEmpty",
      });
    });

    it("DeleteBucket missing bucket => NoSuchBucket", async () => {
      await expect(s3.send(new DeleteBucketCommand({ Bucket: "nope" }))).rejects.toMatchObject({
        name: "NoSuchBucket",
      });
    });

    it("GetBucketLocation returns region constraint", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "loc" }));
      const out = await s3.send(new GetBucketLocationCommand({ Bucket: "loc" }));
      // us-east-1 => undefined/null LocationConstraint
      expect(out.LocationConstraint === undefined || out.LocationConstraint === "").toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  describe("Object operations", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "objs" }));
    });

    it("PutObject + GetObject round-trips body and ETag", async () => {
      const put = await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "hello.txt", Body: "hello world" }));
      expect(put.ETag).toBeTruthy();
      const get = await s3.send(new GetObjectCommand({ Bucket: "objs", Key: "hello.txt" }));
      expect(await streamToString(get.Body)).toBe("hello world");
      expect(get.ETag).toBe(put.ETag);
      expect(get.ContentLength).toBe(11);
    });

    it("PutObject stores binary body intact", async () => {
      const data = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "bin", Body: data }));
      const get = await s3.send(new GetObjectCommand({ Bucket: "objs", Key: "bin" }));
      const buf = await streamToBuffer(get.Body);
      expect(Buffer.compare(buf, data)).toBe(0);
    });

    it("PutObject stores content-type and user metadata", async () => {
      await s3.send(new PutObjectCommand({
        Bucket: "objs",
        Key: "meta",
        Body: "x",
        ContentType: "text/plain",
        Metadata: { author: "parlel", team: "core" },
      }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: "objs", Key: "meta" }));
      expect(head.ContentType).toBe("text/plain");
      expect(head.Metadata?.author).toBe("parlel");
      expect(head.Metadata?.team).toBe("core");
    });

    it("GetObject on missing key => NoSuchKey", async () => {
      await expect(s3.send(new GetObjectCommand({ Bucket: "objs", Key: "missing" }))).rejects.toMatchObject({
        name: "NoSuchKey",
      });
    });

    it("GetObject on missing bucket => NoSuchBucket", async () => {
      await expect(s3.send(new GetObjectCommand({ Bucket: "ghostb", Key: "k" }))).rejects.toMatchObject({
        name: "NoSuchBucket",
      });
    });

    it("HeadObject returns metadata, 404 for missing", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "h", Body: "abc" }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: "objs", Key: "h" }));
      expect(head.ContentLength).toBe(3);
      await expect(s3.send(new HeadObjectCommand({ Bucket: "objs", Key: "nope" }))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 404 },
      });
    });

    it("GetObject supports Range requests", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "range", Body: "0123456789" }));
      const out = await s3.send(new GetObjectCommand({ Bucket: "objs", Key: "range", Range: "bytes=2-5" }));
      expect(await streamToString(out.Body)).toBe("2345");
      expect(out.ContentRange).toContain("bytes 2-5/10");
    });

    it("GetObject supports suffix Range", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "range2", Body: "0123456789" }));
      const out = await s3.send(new GetObjectCommand({ Bucket: "objs", Key: "range2", Range: "bytes=-3" }));
      expect(await streamToString(out.Body)).toBe("789");
    });

    it("DeleteObject removes the key", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "del", Body: "x" }));
      await s3.send(new DeleteObjectCommand({ Bucket: "objs", Key: "del" }));
      await expect(s3.send(new GetObjectCommand({ Bucket: "objs", Key: "del" }))).rejects.toMatchObject({
        name: "NoSuchKey",
      });
    });

    it("DeleteObject is idempotent on missing key", async () => {
      const out = await s3.send(new DeleteObjectCommand({ Bucket: "objs", Key: "never" }));
      expect(out.$metadata.httpStatusCode).toBe(204);
    });

    it("CopyObject duplicates data and metadata", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "src", Body: "copy me", ContentType: "text/x" }));
      const copy = await s3.send(new CopyObjectCommand({
        Bucket: "objs",
        Key: "dst",
        CopySource: "/objs/src",
      }));
      expect(copy.CopyObjectResult?.ETag).toBeTruthy();
      const get = await s3.send(new GetObjectCommand({ Bucket: "objs", Key: "dst" }));
      expect(await streamToString(get.Body)).toBe("copy me");
      expect(get.ContentType).toBe("text/x");
    });

    it("CopyObject with REPLACE directive overrides metadata", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "objs", Key: "src2", Body: "data", ContentType: "text/a" }));
      await s3.send(new CopyObjectCommand({
        Bucket: "objs",
        Key: "dst2",
        CopySource: "/objs/src2",
        MetadataDirective: "REPLACE",
        ContentType: "text/b",
        Metadata: { x: "1" },
      }));
      const head = await s3.send(new HeadObjectCommand({ Bucket: "objs", Key: "dst2" }));
      expect(head.ContentType).toBe("text/b");
      expect(head.Metadata?.x).toBe("1");
    });

    it("CopyObject from missing source => NoSuchKey", async () => {
      await expect(s3.send(new CopyObjectCommand({
        Bucket: "objs", Key: "z", CopySource: "/objs/doesnotexist",
      }))).rejects.toMatchObject({ name: "NoSuchKey" });
    });

    it("PutObject validates Content-MD5", async () => {
      const res = await fetch(`${ENDPOINT}/objs/badmd5`, {
        method: "PUT",
        headers: { "Content-MD5": Buffer.from("00000000000000000000000000000000", "hex").toString("base64") },
        body: "actual content",
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("BadDigest");
    });
  });

  // -----------------------------------------------------------------------
  describe("Conditional requests", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "cond" }));
      await s3.send(new PutObjectCommand({ Bucket: "cond", Key: "c", Body: "conditional" }));
    });

    it("GetObject IfNoneMatch matching ETag => 304", async () => {
      const head = await s3.send(new HeadObjectCommand({ Bucket: "cond", Key: "c" }));
      await expect(s3.send(new GetObjectCommand({ Bucket: "cond", Key: "c", IfNoneMatch: head.ETag }))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 304 },
      });
    });

    it("GetObject IfMatch wrong ETag => 412", async () => {
      await expect(s3.send(new GetObjectCommand({ Bucket: "cond", Key: "c", IfMatch: '"deadbeef"' }))).rejects.toMatchObject({
        $metadata: { httpStatusCode: 412 },
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Listing", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "list" }));
      for (const k of ["a.txt", "b.txt", "folder/c.txt", "folder/d.txt", "folder/sub/e.txt"]) {
        await s3.send(new PutObjectCommand({ Bucket: "list", Key: k, Body: k }));
      }
    });

    it("ListObjectsV2 lists all keys", async () => {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: "list" }));
      const keys = (out.Contents || []).map((c) => c.Key).sort();
      expect(keys).toEqual(["a.txt", "b.txt", "folder/c.txt", "folder/d.txt", "folder/sub/e.txt"]);
      expect(out.KeyCount).toBe(5);
    });

    it("ListObjectsV2 with prefix", async () => {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: "list", Prefix: "folder/" }));
      const keys = (out.Contents || []).map((c) => c.Key).sort();
      expect(keys).toEqual(["folder/c.txt", "folder/d.txt", "folder/sub/e.txt"]);
    });

    it("ListObjectsV2 with delimiter returns CommonPrefixes", async () => {
      const out = await s3.send(new ListObjectsV2Command({ Bucket: "list", Delimiter: "/" }));
      const keys = (out.Contents || []).map((c) => c.Key).sort();
      const prefixes = (out.CommonPrefixes || []).map((p) => p.Prefix);
      expect(keys).toEqual(["a.txt", "b.txt"]);
      expect(prefixes).toEqual(["folder/"]);
    });

    it("ListObjectsV2 pagination via MaxKeys + ContinuationToken", async () => {
      const first = await s3.send(new ListObjectsV2Command({ Bucket: "list", MaxKeys: 2 }));
      expect(first.Contents?.length).toBe(2);
      expect(first.IsTruncated).toBe(true);
      expect(first.NextContinuationToken).toBeTruthy();
      const second = await s3.send(new ListObjectsV2Command({
        Bucket: "list", MaxKeys: 2, ContinuationToken: first.NextContinuationToken,
      }));
      expect(second.Contents?.length).toBe(2);
    });

    it("ListObjects (v1) lists keys with Marker pagination", async () => {
      const out = await s3.send(new ListObjectsCommand({ Bucket: "list", MaxKeys: 2 }));
      expect(out.Contents?.length).toBe(2);
      expect(out.IsTruncated).toBe(true);
      const next = await s3.send(new ListObjectsCommand({ Bucket: "list", Marker: out.NextMarker }));
      expect((next.Contents || []).length).toBeGreaterThan(0);
    });

    it("ListObjectsV2 on missing bucket => NoSuchBucket", async () => {
      await expect(s3.send(new ListObjectsV2Command({ Bucket: "nobucket" }))).rejects.toMatchObject({
        name: "NoSuchBucket",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Batch delete", () => {
    it("DeleteObjects removes multiple keys", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "batch" }));
      for (const k of ["x", "y", "z"]) {
        await s3.send(new PutObjectCommand({ Bucket: "batch", Key: k, Body: k }));
      }
      const out = await s3.send(new DeleteObjectsCommand({
        Bucket: "batch",
        Delete: { Objects: [{ Key: "x" }, { Key: "y" }] },
      }));
      expect((out.Deleted || []).map((d) => d.Key).sort()).toEqual(["x", "y"]);
      const list = await s3.send(new ListObjectsV2Command({ Bucket: "batch" }));
      expect((list.Contents || []).map((c) => c.Key)).toEqual(["z"]);
    });

    it("DeleteObjects with empty/malformed body => MalformedXML (400)", async () => {
      // Real S3 requires at least one <Object>; an empty <Delete> body is
      // rejected with 400 MalformedXML.
      // https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
      await s3.send(new CreateBucketCommand({ Bucket: "batchbad" }));
      const res = await fetch(`${ENDPOINT}/batchbad?delete`, {
        method: "POST",
        body: "<Delete></Delete>",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("<Code>MalformedXML</Code>");
    });
  });

  // -----------------------------------------------------------------------
  describe("Versioning", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "ver" }));
    });

    it("GetBucketVersioning empty by default", async () => {
      const out = await s3.send(new GetBucketVersioningCommand({ Bucket: "ver" }));
      expect(out.Status).toBeUndefined();
    });

    it("PutBucketVersioning enables versioning", async () => {
      await s3.send(new PutBucketVersioningCommand({ Bucket: "ver", VersioningConfiguration: { Status: "Enabled" } }));
      const out = await s3.send(new GetBucketVersioningCommand({ Bucket: "ver" }));
      expect(out.Status).toBe("Enabled");
    });

    it("Versioned PutObject creates distinct versions", async () => {
      await s3.send(new PutBucketVersioningCommand({ Bucket: "ver", VersioningConfiguration: { Status: "Enabled" } }));
      const v1 = await s3.send(new PutObjectCommand({ Bucket: "ver", Key: "k", Body: "v1" }));
      const v2 = await s3.send(new PutObjectCommand({ Bucket: "ver", Key: "k", Body: "v2" }));
      expect(v1.VersionId).toBeTruthy();
      expect(v2.VersionId).toBeTruthy();
      expect(v1.VersionId).not.toBe(v2.VersionId);

      const latest = await s3.send(new GetObjectCommand({ Bucket: "ver", Key: "k" }));
      expect(await streamToString(latest.Body)).toBe("v2");

      const old = await s3.send(new GetObjectCommand({ Bucket: "ver", Key: "k", VersionId: v1.VersionId }));
      expect(await streamToString(old.Body)).toBe("v1");
    });

    it("ListObjectVersions enumerates versions and delete markers", async () => {
      await s3.send(new PutBucketVersioningCommand({ Bucket: "ver", VersioningConfiguration: { Status: "Enabled" } }));
      await s3.send(new PutObjectCommand({ Bucket: "ver", Key: "k", Body: "a" }));
      await s3.send(new PutObjectCommand({ Bucket: "ver", Key: "k", Body: "b" }));
      await s3.send(new DeleteObjectCommand({ Bucket: "ver", Key: "k" }));
      const out = await s3.send(new ListObjectVersionsCommand({ Bucket: "ver" }));
      expect((out.Versions || []).length).toBe(2);
      expect((out.DeleteMarkers || []).length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Multipart uploads", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "mpu" }));
    });

    it("full multipart lifecycle: create, upload parts, complete", async () => {
      const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "big", ContentType: "text/plain" }));
      const uploadId = create.UploadId!;
      expect(uploadId).toBeTruthy();

      const part1Body = "A".repeat(5 * 1024 * 1024); // 5MB
      const part2Body = "B".repeat(1024);
      const p1 = await s3.send(new UploadPartCommand({ Bucket: "mpu", Key: "big", UploadId: uploadId, PartNumber: 1, Body: part1Body }));
      const p2 = await s3.send(new UploadPartCommand({ Bucket: "mpu", Key: "big", UploadId: uploadId, PartNumber: 2, Body: part2Body }));

      const complete = await s3.send(new CompleteMultipartUploadCommand({
        Bucket: "mpu", Key: "big", UploadId: uploadId,
        MultipartUpload: { Parts: [
          { PartNumber: 1, ETag: p1.ETag },
          { PartNumber: 2, ETag: p2.ETag },
        ] },
      }));
      expect(complete.ETag).toContain("-2");

      const get = await s3.send(new GetObjectCommand({ Bucket: "mpu", Key: "big" }));
      const body = await streamToString(get.Body);
      expect(body.length).toBe(part1Body.length + part2Body.length);
      expect(get.ContentType).toBe("text/plain");
    });

    it("ListParts returns uploaded parts", async () => {
      const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "lp" }));
      const uploadId = create.UploadId!;
      await s3.send(new UploadPartCommand({ Bucket: "mpu", Key: "lp", UploadId: uploadId, PartNumber: 1, Body: "part1" }));
      await s3.send(new UploadPartCommand({ Bucket: "mpu", Key: "lp", UploadId: uploadId, PartNumber: 2, Body: "part2" }));
      const out = await s3.send(new ListPartsCommand({ Bucket: "mpu", Key: "lp", UploadId: uploadId }));
      expect((out.Parts || []).length).toBe(2);
      expect(out.Parts?.[0].PartNumber).toBe(1);
    });

    it("ListMultipartUploads enumerates in-progress uploads", async () => {
      await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "u1" }));
      await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "u2" }));
      const out = await s3.send(new ListMultipartUploadsCommand({ Bucket: "mpu" }));
      expect((out.Uploads || []).length).toBe(2);
    });

    it("AbortMultipartUpload discards the upload", async () => {
      const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "ab" }));
      const uploadId = create.UploadId!;
      await s3.send(new AbortMultipartUploadCommand({ Bucket: "mpu", Key: "ab", UploadId: uploadId }));
      await expect(s3.send(new ListPartsCommand({ Bucket: "mpu", Key: "ab", UploadId: uploadId }))).rejects.toMatchObject({
        name: "NoSuchUpload",
      });
    });

    it("UploadPart to missing upload => NoSuchUpload", async () => {
      await expect(s3.send(new UploadPartCommand({
        Bucket: "mpu", Key: "x", UploadId: "nonexistent", PartNumber: 1, Body: "x",
      }))).rejects.toMatchObject({ name: "NoSuchUpload" });
    });

    it("CompleteMultipartUpload with missing part => InvalidPart", async () => {
      const create = await s3.send(new CreateMultipartUploadCommand({ Bucket: "mpu", Key: "ip" }));
      const uploadId = create.UploadId!;
      await s3.send(new UploadPartCommand({ Bucket: "mpu", Key: "ip", UploadId: uploadId, PartNumber: 1, Body: "p1" }));
      await expect(s3.send(new CompleteMultipartUploadCommand({
        Bucket: "mpu", Key: "ip", UploadId: uploadId,
        MultipartUpload: { Parts: [{ PartNumber: 5, ETag: '"abc"' }] },
      }))).rejects.toMatchObject({ name: "InvalidPart" });
    });
  });

  // -----------------------------------------------------------------------
  describe("Object tagging", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "otag" }));
      await s3.send(new PutObjectCommand({ Bucket: "otag", Key: "t", Body: "x" }));
    });

    it("PutObjectTagging + GetObjectTagging", async () => {
      await s3.send(new PutObjectTaggingCommand({
        Bucket: "otag", Key: "t",
        Tagging: { TagSet: [{ Key: "env", Value: "test" }, { Key: "team", Value: "core" }] },
      }));
      const out = await s3.send(new GetObjectTaggingCommand({ Bucket: "otag", Key: "t" }));
      const tags = Object.fromEntries((out.TagSet || []).map((t) => [t.Key, t.Value]));
      expect(tags).toEqual({ env: "test", team: "core" });
    });

    it("DeleteObjectTagging clears tags", async () => {
      await s3.send(new PutObjectTaggingCommand({
        Bucket: "otag", Key: "t", Tagging: { TagSet: [{ Key: "a", Value: "b" }] },
      }));
      await s3.send(new DeleteObjectTaggingCommand({ Bucket: "otag", Key: "t" }));
      const out = await s3.send(new GetObjectTaggingCommand({ Bucket: "otag", Key: "t" }));
      expect(out.TagSet || []).toEqual([]);
    });

    it("PutObject with x-amz-tagging header retrievable", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "otag", Key: "tagged", Body: "x", Tagging: "a=1&b=2" }));
      const out = await s3.send(new GetObjectTaggingCommand({ Bucket: "otag", Key: "tagged" }));
      const tags = Object.fromEntries((out.TagSet || []).map((t) => [t.Key, t.Value]));
      expect(tags).toEqual({ a: "1", b: "2" });
    });
  });

  // -----------------------------------------------------------------------
  describe("ACL operations", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "acl" }));
      await s3.send(new PutObjectCommand({ Bucket: "acl", Key: "a", Body: "x" }));
    });

    it("GetBucketAcl returns owner + grants", async () => {
      const out = await s3.send(new GetBucketAclCommand({ Bucket: "acl" }));
      expect(out.Owner?.DisplayName).toBe("parlel");
      expect((out.Grants || []).length).toBeGreaterThan(0);
    });

    it("PutBucketAcl succeeds", async () => {
      const out = await s3.send(new PutBucketAclCommand({ Bucket: "acl", ACL: "private" }));
      expect(out.$metadata.httpStatusCode).toBe(200);
    });

    it("GetObjectAcl returns FULL_CONTROL grant", async () => {
      const out = await s3.send(new GetObjectAclCommand({ Bucket: "acl", Key: "a" }));
      expect(out.Grants?.[0].Permission).toBe("FULL_CONTROL");
    });

    it("PutObjectAcl succeeds", async () => {
      const out = await s3.send(new PutObjectAclCommand({ Bucket: "acl", Key: "a", ACL: "private" }));
      expect(out.$metadata.httpStatusCode).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  describe("Object attributes", () => {
    it("GetObjectAttributes returns size + storage class", async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "attr" }));
      await s3.send(new PutObjectCommand({ Bucket: "attr", Key: "a", Body: "1234567890" }));
      const out = await s3.send(new GetObjectAttributesCommand({
        Bucket: "attr", Key: "a", ObjectAttributes: ["ObjectSize", "StorageClass", "ETag"],
      }));
      expect(out.ObjectSize).toBe(10);
      expect(out.StorageClass).toBe("STANDARD");
    });
  });

  // -----------------------------------------------------------------------
  describe("Bucket tagging", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "btag" }));
    });

    it("PutBucketTagging + GetBucketTagging", async () => {
      await s3.send(new PutBucketTaggingCommand({
        Bucket: "btag", Tagging: { TagSet: [{ Key: "cost", Value: "eng" }] },
      }));
      const out = await s3.send(new GetBucketTaggingCommand({ Bucket: "btag" }));
      expect(out.TagSet?.[0]).toEqual({ Key: "cost", Value: "eng" });
    });

    it("GetBucketTagging with no tags => NoSuchTagSet", async () => {
      await expect(s3.send(new GetBucketTaggingCommand({ Bucket: "btag" }))).rejects.toMatchObject({
        name: "NoSuchTagSet",
      });
    });

    it("DeleteBucketTagging clears tags", async () => {
      await s3.send(new PutBucketTaggingCommand({ Bucket: "btag", Tagging: { TagSet: [{ Key: "a", Value: "b" }] } }));
      await s3.send(new DeleteBucketTaggingCommand({ Bucket: "btag" }));
      await expect(s3.send(new GetBucketTaggingCommand({ Bucket: "btag" }))).rejects.toMatchObject({
        name: "NoSuchTagSet",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Bucket CORS", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "cors" }));
    });

    it("PutBucketCors + GetBucketCors", async () => {
      await s3.send(new PutBucketCorsCommand({
        Bucket: "cors",
        CORSConfiguration: { CORSRules: [{ AllowedMethods: ["GET"], AllowedOrigins: ["*"] }] },
      }));
      const out = await s3.send(new GetBucketCorsCommand({ Bucket: "cors" }));
      expect(out.CORSRules?.[0].AllowedMethods).toContain("GET");
    });

    it("GetBucketCors when unset => NoSuchCORSConfiguration", async () => {
      await expect(s3.send(new GetBucketCorsCommand({ Bucket: "cors" }))).rejects.toMatchObject({
        name: "NoSuchCORSConfiguration",
      });
    });

    it("DeleteBucketCors removes config", async () => {
      await s3.send(new PutBucketCorsCommand({
        Bucket: "cors", CORSConfiguration: { CORSRules: [{ AllowedMethods: ["GET"], AllowedOrigins: ["*"] }] },
      }));
      await s3.send(new DeleteBucketCorsCommand({ Bucket: "cors" }));
      await expect(s3.send(new GetBucketCorsCommand({ Bucket: "cors" }))).rejects.toMatchObject({
        name: "NoSuchCORSConfiguration",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Bucket policy", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "pol" }));
    });

    it("PutBucketPolicy + GetBucketPolicy", async () => {
      const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] });
      await s3.send(new PutBucketPolicyCommand({ Bucket: "pol", Policy: policy }));
      const out = await s3.send(new GetBucketPolicyCommand({ Bucket: "pol" }));
      expect(out.Policy).toBe(policy);
    });

    it("GetBucketPolicy when unset => NoSuchBucketPolicy", async () => {
      await expect(s3.send(new GetBucketPolicyCommand({ Bucket: "pol" }))).rejects.toMatchObject({
        name: "NoSuchBucketPolicy",
      });
    });

    it("DeleteBucketPolicy removes policy", async () => {
      await s3.send(new PutBucketPolicyCommand({ Bucket: "pol", Policy: "{}" }));
      await s3.send(new DeleteBucketPolicyCommand({ Bucket: "pol" }));
      await expect(s3.send(new GetBucketPolicyCommand({ Bucket: "pol" }))).rejects.toMatchObject({
        name: "NoSuchBucketPolicy",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Bucket lifecycle / encryption / website", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "cfg" }));
    });

    it("Lifecycle config round-trips", async () => {
      await s3.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: "cfg",
        LifecycleConfiguration: { Rules: [{ ID: "expire", Status: "Enabled", Expiration: { Days: 30 }, Filter: { Prefix: "logs/" } }] },
      }));
      const out = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: "cfg" }));
      expect(out.Rules?.[0].ID).toBe("expire");
      await s3.send(new DeleteBucketLifecycleCommand({ Bucket: "cfg" }));
      await expect(s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: "cfg" }))).rejects.toMatchObject({
        name: "NoSuchLifecycleConfiguration",
      });
    });

    it("Encryption config round-trips", async () => {
      await s3.send(new PutBucketEncryptionCommand({
        Bucket: "cfg",
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
      }));
      const out = await s3.send(new GetBucketEncryptionCommand({ Bucket: "cfg" }));
      expect(out.ServerSideEncryptionConfiguration?.Rules?.[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("AES256");
      await s3.send(new DeleteBucketEncryptionCommand({ Bucket: "cfg" }));
      await expect(s3.send(new GetBucketEncryptionCommand({ Bucket: "cfg" }))).rejects.toMatchObject({
        name: expect.stringContaining("ServerSideEncryptionConfigurationNotFound"),
      });
    });

    it("Website config round-trips", async () => {
      await s3.send(new PutBucketWebsiteCommand({
        Bucket: "cfg",
        WebsiteConfiguration: { IndexDocument: { Suffix: "index.html" }, ErrorDocument: { Key: "error.html" } },
      }));
      const out = await s3.send(new GetBucketWebsiteCommand({ Bucket: "cfg" }));
      expect(out.IndexDocument?.Suffix).toBe("index.html");
      await s3.send(new DeleteBucketWebsiteCommand({ Bucket: "cfg" }));
      await expect(s3.send(new GetBucketWebsiteCommand({ Bucket: "cfg" }))).rejects.toMatchObject({
        name: "NoSuchWebsiteConfiguration",
      });
    });
  });

  // -----------------------------------------------------------------------
  describe("Addressing + unsupported features (raw protocol)", () => {
    beforeEach(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: "raw" }));
    });

    it("supports virtual-hosted-style addressing via Host header", async () => {
      await s3.send(new PutObjectCommand({ Bucket: "raw", Key: "vh.txt", Body: "vhost" }));
      const res = await rawRequest({ path: "/vh.txt", host: "raw.s3.amazonaws.com" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("vhost");
    });

    it("returns NotImplemented for unsupported bucket sub-resources", async () => {
      for (const q of ["replication", "logging", "notification", "object-lock"]) {
        const res = await fetch(`${ENDPOINT}/raw?${q}`);
        expect(res.status).toBe(501);
        expect(await res.text()).toContain("NotImplemented");
      }
    });

    it("returns proper S3 XML error envelope for missing key", async () => {
      const res = await fetch(`${ENDPOINT}/raw/no-such-key`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain("<Code>NoSuchKey</Code>");
      expect(text).toContain("<Message>");
    });

    it("error envelope includes RequestId + HostId matching response headers", async () => {
      // Real S3 error bodies carry RequestId/HostId that match the
      // x-amz-request-id / x-amz-id-2 headers.
      // https://docs.aws.amazon.com/AmazonS3/latest/API/ErrorResponses.html
      const res = await fetch(`${ENDPOINT}/raw/missing-too`);
      expect(res.status).toBe(404);
      const text = await res.text();
      const reqId = res.headers.get("x-amz-request-id");
      const hostId = res.headers.get("x-amz-id-2");
      expect(reqId).toBeTruthy();
      expect(hostId).toBeTruthy();
      expect(text).toContain(`<RequestId>${reqId}</RequestId>`);
      expect(text).toContain(`<HostId>${hostId}</HostId>`);
    });

    it("ListBuckets via raw GET / returns XML", async () => {
      const res = await fetch(`${ENDPOINT}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("ListAllMyBucketsResult");
    });
  });
});
