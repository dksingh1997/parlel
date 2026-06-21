import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  KinesisClient,
  // stream lifecycle
  CreateStreamCommand,
  DeleteStreamCommand,
  ListStreamsCommand,
  DescribeStreamCommand,
  DescribeStreamSummaryCommand,
  DescribeLimitsCommand,
  DescribeAccountSettingsCommand,
  UpdateAccountSettingsCommand,
  UpdateMaxRecordSizeCommand,
  // retention
  IncreaseStreamRetentionPeriodCommand,
  DecreaseStreamRetentionPeriodCommand,
  // shards
  ListShardsCommand,
  GetShardIteratorCommand,
  MergeShardsCommand,
  SplitShardCommand,
  UpdateShardCountCommand,
  UpdateStreamModeCommand,
  UpdateStreamWarmThroughputCommand,
  // records
  PutRecordCommand,
  PutRecordsCommand,
  GetRecordsCommand,
  // tags
  AddTagsToStreamCommand,
  RemoveTagsFromStreamCommand,
  ListTagsForStreamCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
  // enhanced monitoring
  EnableEnhancedMonitoringCommand,
  DisableEnhancedMonitoringCommand,
  // encryption
  StartStreamEncryptionCommand,
  StopStreamEncryptionCommand,
  // consumers
  RegisterStreamConsumerCommand,
  DeregisterStreamConsumerCommand,
  DescribeStreamConsumerCommand,
  ListStreamConsumersCommand,
  // resource policies
  PutResourcePolicyCommand,
  GetResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  // enhanced fan-out streaming (intentionally unsupported over this transport)
  SubscribeToShardCommand,
} from "@aws-sdk/client-kinesis";
import { KinesisServer } from "../services/kinesis/src/server.js";

const PORT = 14576;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const enc = new TextEncoder();
const dec = new TextDecoder();

function makeClient() {
  return new KinesisClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
    maxAttempts: 1,
  });
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected error ${code} but call succeeded`);
  } catch (err: any) {
    const name = err?.name || err?.Code || err?.code || "";
    const combined = `${name} ${err?.message || ""}`;
    expect(combined).toContain(code);
    return err;
  }
}

describe("Kinesis Service", () => {
  let server: KinesisServer;
  let kinesis: KinesisClient;

  beforeAll(async () => {
    server = new KinesisServer(PORT);
    await server.start();
    kinesis = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    kinesis.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createStream(name: string, shardCount = 1) {
    await kinesis.send(new CreateStreamCommand({ StreamName: name, ShardCount: shardCount }));
    return name;
  }

  async function firstShardId(name: string): Promise<string> {
    const res = await kinesis.send(new ListShardsCommand({ StreamName: name }));
    return res.Shards![0].ShardId!;
  }

  async function iteratorFor(name: string, type = "TRIM_HORIZON"): Promise<string> {
    const shardId = await firstShardId(name);
    const res = await kinesis.send(
      new GetShardIteratorCommand({ StreamName: name, ShardId: shardId, ShardIteratorType: type as any }),
    );
    return res.ShardIterator!;
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("kinesis");
    });

    it("supports an internal reset endpoint", async () => {
      await createStream("reset-me");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const list = await kinesis.send(new ListStreamsCommand({}));
      expect(list.StreamNames).not.toContain("reset-me");
    });
  });

  // -----------------------------------------------------------------------
  describe("Stream lifecycle", () => {
    it("creates and describes a stream", async () => {
      await createStream("s1", 2);
      const desc = await kinesis.send(new DescribeStreamCommand({ StreamName: "s1" }));
      expect(desc.StreamDescription!.StreamName).toBe("s1");
      expect(desc.StreamDescription!.StreamStatus).toBe("ACTIVE");
      expect(desc.StreamDescription!.Shards!.length).toBe(2);
      expect(desc.StreamDescription!.StreamARN).toContain("stream/s1");
      expect(desc.StreamDescription!.RetentionPeriodHours).toBe(24);
    });

    it("creates an ON_DEMAND stream without ShardCount", async () => {
      await kinesis.send(
        new CreateStreamCommand({ StreamName: "od", StreamModeDetails: { StreamMode: "ON_DEMAND" } }),
      );
      const sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "od" }));
      expect(sum.StreamDescriptionSummary!.StreamModeDetails!.StreamMode).toBe("ON_DEMAND");
      expect(sum.StreamDescriptionSummary!.OpenShardCount).toBeGreaterThan(0);
    });

    it("rejects duplicate stream creation with ResourceInUseException", async () => {
      await createStream("dup");
      await expectError(
        kinesis.send(new CreateStreamCommand({ StreamName: "dup", ShardCount: 1 })),
        "ResourceInUseException",
      );
    });

    it("rejects invalid stream names", async () => {
      await expectError(
        kinesis.send(new CreateStreamCommand({ StreamName: "bad name!", ShardCount: 1 })),
        "InvalidArgumentException",
      );
    });

    it("rejects PROVISIONED stream without ShardCount", async () => {
      await expectError(
        kinesis.send(new CreateStreamCommand({ StreamName: "noshards" } as any)),
        "InvalidArgumentException",
      );
    });

    it("deletes a stream", async () => {
      await createStream("delete-me");
      await kinesis.send(new DeleteStreamCommand({ StreamName: "delete-me" }));
      await expectError(
        kinesis.send(new DescribeStreamCommand({ StreamName: "delete-me" })),
        "ResourceNotFoundException",
      );
    });

    it("describe of missing stream throws ResourceNotFoundException", async () => {
      await expectError(
        kinesis.send(new DescribeStreamCommand({ StreamName: "ghost" })),
        "ResourceNotFoundException",
      );
    });

    it("lists streams with summaries", async () => {
      await createStream("a-stream");
      await createStream("b-stream");
      const res = await kinesis.send(new ListStreamsCommand({}));
      expect(res.StreamNames).toContain("a-stream");
      expect(res.StreamNames).toContain("b-stream");
      expect(res.StreamSummaries!.length).toBe(2);
      expect(res.HasMoreStreams).toBe(false);
    });

    it("paginates ListStreams with Limit + NextToken", async () => {
      for (const n of ["p1", "p2", "p3"]) await createStream(n);
      const page1 = await kinesis.send(new ListStreamsCommand({ Limit: 2 }));
      expect(page1.StreamNames!.length).toBe(2);
      expect(page1.HasMoreStreams).toBe(true);
      const page2 = await kinesis.send(new ListStreamsCommand({ Limit: 2, NextToken: page1.NextToken }));
      expect(page2.StreamNames!.length).toBe(1);
    });

    it("describes account-level limits", async () => {
      await createStream("limit-stream", 3);
      const res = await kinesis.send(new DescribeLimitsCommand({}));
      expect(res.ShardLimit).toBeGreaterThan(0);
      expect(res.OpenShardCount).toBeGreaterThanOrEqual(3);
    });

    it("describes and updates account settings", async () => {
      const before = await kinesis.send(new DescribeAccountSettingsCommand({}));
      expect(before.MinimumThroughputBillingCommitment).toBeDefined();
      expect(before.MinimumThroughputBillingCommitment!.Status).toBe("DISABLED");
      const updated = await kinesis.send(
        new UpdateAccountSettingsCommand({ MinimumThroughputBillingCommitment: { Status: "ENABLED" } }),
      );
      expect(updated.MinimumThroughputBillingCommitment!.Status).toBe("ENABLED");
      const after = await kinesis.send(new DescribeAccountSettingsCommand({}));
      expect(after.MinimumThroughputBillingCommitment!.Status).toBe("ENABLED");
    });

    it("updates max record size", async () => {
      await createStream("maxrec");
      // Output shape is empty per the SDK schema; success (no throw) is the assertion.
      await kinesis.send(
        new UpdateMaxRecordSizeCommand({ StreamARN: server.streamArn("maxrec"), MaxRecordSizeInKiB: 2048 }),
      );
    });

    it("rejects max record size out of range", async () => {
      await createStream("maxrec2");
      await expectError(
        kinesis.send(
          new UpdateMaxRecordSizeCommand({ StreamARN: server.streamArn("maxrec2"), MaxRecordSizeInKiB: 1 }),
        ),
        "ValidationException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Retention", () => {
    it("increases and decreases retention period", async () => {
      await createStream("ret");
      await kinesis.send(
        new IncreaseStreamRetentionPeriodCommand({ StreamName: "ret", RetentionPeriodHours: 48 }),
      );
      let sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "ret" }));
      expect(sum.StreamDescriptionSummary!.RetentionPeriodHours).toBe(48);

      await kinesis.send(
        new DecreaseStreamRetentionPeriodCommand({ StreamName: "ret", RetentionPeriodHours: 24 }),
      );
      sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "ret" }));
      expect(sum.StreamDescriptionSummary!.RetentionPeriodHours).toBe(24);
    });

    it("rejects increasing retention below current", async () => {
      await createStream("ret2");
      await expectError(
        kinesis.send(
          new IncreaseStreamRetentionPeriodCommand({ StreamName: "ret2", RetentionPeriodHours: 12 }),
        ),
        "InvalidArgumentException",
      );
    });

    it("rejects decreasing retention below 24 hours", async () => {
      await createStream("ret3");
      await kinesis.send(
        new IncreaseStreamRetentionPeriodCommand({ StreamName: "ret3", RetentionPeriodHours: 48 }),
      );
      await expectError(
        kinesis.send(
          new DecreaseStreamRetentionPeriodCommand({ StreamName: "ret3", RetentionPeriodHours: 12 }),
        ),
        "InvalidArgumentException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Records (put / get)", () => {
    it("puts a single record and reads it back with byte fidelity", async () => {
      await createStream("rec");
      const put = await kinesis.send(
        new PutRecordCommand({ StreamName: "rec", PartitionKey: "pk1", Data: enc.encode("hello-kinesis") }),
      );
      expect(put.ShardId).toBeDefined();
      expect(put.SequenceNumber).toBeDefined();

      const it = await iteratorFor("rec");
      const got = await kinesis.send(new GetRecordsCommand({ ShardIterator: it }));
      expect(got.Records!.length).toBe(1);
      expect(dec.decode(got.Records![0].Data)).toBe("hello-kinesis");
      expect(got.Records![0].PartitionKey).toBe("pk1");
      expect(got.Records![0].SequenceNumber).toBe(put.SequenceNumber);
      expect(got.MillisBehindLatest).toBe(0);
    });

    it("preserves binary data exactly", async () => {
      await createStream("bin");
      const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 64]);
      await kinesis.send(new PutRecordCommand({ StreamName: "bin", PartitionKey: "k", Data: bytes }));
      const it = await iteratorFor("bin");
      const got = await kinesis.send(new GetRecordsCommand({ ShardIterator: it }));
      expect(Array.from(got.Records![0].Data!)).toEqual(Array.from(bytes));
    });

    it("puts a batch with PutRecords", async () => {
      await createStream("batch");
      const res = await kinesis.send(
        new PutRecordsCommand({
          StreamName: "batch",
          Records: [
            { PartitionKey: "a", Data: enc.encode("one") },
            { PartitionKey: "b", Data: enc.encode("two") },
            { PartitionKey: "c", Data: enc.encode("three") },
          ],
        }),
      );
      expect(res.FailedRecordCount).toBe(0);
      expect(res.Records!.length).toBe(3);
      expect(res.Records!.every((r) => r.SequenceNumber)).toBe(true);
    });

    it("reports per-record failures in PutRecords", async () => {
      await createStream("batchfail");
      const res = await kinesis.send(
        new PutRecordsCommand({
          StreamName: "batchfail",
          Records: [
            { PartitionKey: "ok", Data: enc.encode("good") },
            // missing partition key -> failure
            { PartitionKey: "", Data: enc.encode("bad") } as any,
          ],
        }),
      );
      expect(res.FailedRecordCount).toBe(1);
      const failed = res.Records!.find((r) => r.ErrorCode);
      expect(failed!.ErrorCode).toBe("InvalidArgumentException");
    });

    it("rejects PutRecord without PartitionKey", async () => {
      await createStream("nopk");
      await expectError(
        kinesis.send(new PutRecordCommand({ StreamName: "nopk", Data: enc.encode("x") } as any)),
        "InvalidArgumentException",
      );
    });

    it("rejects PutRecords with empty list", async () => {
      await createStream("emptybatch");
      await expectError(
        kinesis.send(new PutRecordsCommand({ StreamName: "emptybatch", Records: [] })),
        "InvalidArgumentException",
      );
    });

    it("honors ExplicitHashKey routing to a specific shard", async () => {
      await createStream("ehk", 2);
      const shards = await kinesis.send(new ListShardsCommand({ StreamName: "ehk" }));
      const target = shards.Shards![1];
      const put = await kinesis.send(
        new PutRecordCommand({
          StreamName: "ehk",
          PartitionKey: "anything",
          ExplicitHashKey: target.HashKeyRange!.StartingHashKey,
          Data: enc.encode("routed"),
        }),
      );
      expect(put.ShardId).toBe(target.ShardId);
    });

    it("LATEST iterator only returns records put after iterator creation", async () => {
      await createStream("latest");
      await kinesis.send(new PutRecordCommand({ StreamName: "latest", PartitionKey: "k", Data: enc.encode("old") }));
      const it = await iteratorFor("latest", "LATEST");
      const empty = await kinesis.send(new GetRecordsCommand({ ShardIterator: it }));
      expect(empty.Records!.length).toBe(0);
      await kinesis.send(new PutRecordCommand({ StreamName: "latest", PartitionKey: "k", Data: enc.encode("new") }));
      const after = await kinesis.send(new GetRecordsCommand({ ShardIterator: empty.NextShardIterator! }));
      expect(after.Records!.length).toBe(1);
      expect(dec.decode(after.Records![0].Data)).toBe("new");
    });

    it("AT_SEQUENCE_NUMBER and AFTER_SEQUENCE_NUMBER iterators", async () => {
      await createStream("seq");
      const shardId = await firstShardId("seq");
      const p1 = await kinesis.send(new PutRecordCommand({ StreamName: "seq", PartitionKey: "k", Data: enc.encode("r1") }));
      await kinesis.send(new PutRecordCommand({ StreamName: "seq", PartitionKey: "k", Data: enc.encode("r2") }));

      const atIt = await kinesis.send(
        new GetShardIteratorCommand({
          StreamName: "seq",
          ShardId: shardId,
          ShardIteratorType: "AT_SEQUENCE_NUMBER",
          StartingSequenceNumber: p1.SequenceNumber,
        }),
      );
      const atRes = await kinesis.send(new GetRecordsCommand({ ShardIterator: atIt.ShardIterator! }));
      expect(dec.decode(atRes.Records![0].Data)).toBe("r1");

      const afterIt = await kinesis.send(
        new GetShardIteratorCommand({
          StreamName: "seq",
          ShardId: shardId,
          ShardIteratorType: "AFTER_SEQUENCE_NUMBER",
          StartingSequenceNumber: p1.SequenceNumber,
        }),
      );
      const afterRes = await kinesis.send(new GetRecordsCommand({ ShardIterator: afterIt.ShardIterator! }));
      expect(afterRes.Records!.length).toBe(1);
      expect(dec.decode(afterRes.Records![0].Data)).toBe("r2");
    });

    it("respects GetRecords Limit and advances the iterator", async () => {
      await createStream("paged");
      for (let i = 0; i < 5; i++) {
        await kinesis.send(new PutRecordCommand({ StreamName: "paged", PartitionKey: "k", Data: enc.encode(`r${i}`) }));
      }
      let it = await iteratorFor("paged");
      const first = await kinesis.send(new GetRecordsCommand({ ShardIterator: it, Limit: 2 }));
      expect(first.Records!.length).toBe(2);
      const second = await kinesis.send(new GetRecordsCommand({ ShardIterator: first.NextShardIterator!, Limit: 2 }));
      expect(second.Records!.length).toBe(2);
      const third = await kinesis.send(new GetRecordsCommand({ ShardIterator: second.NextShardIterator! }));
      expect(third.Records!.length).toBe(1);
    });

    it("rejects GetRecords with invalid iterator", async () => {
      await expectError(
        kinesis.send(new GetRecordsCommand({ ShardIterator: "not-a-real-iterator" })),
        "InvalidArgumentException",
      );
    });

    it("GetShardIterator for missing shard throws ResourceNotFoundException", async () => {
      await createStream("noshard");
      await expectError(
        kinesis.send(
          new GetShardIteratorCommand({
            StreamName: "noshard",
            ShardId: "shardId-999999999999",
            ShardIteratorType: "TRIM_HORIZON",
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Shards", () => {
    it("lists shards", async () => {
      await createStream("shards", 3);
      const res = await kinesis.send(new ListShardsCommand({ StreamName: "shards" }));
      expect(res.Shards!.length).toBe(3);
      expect(res.Shards![0].HashKeyRange).toBeDefined();
      expect(res.Shards![0].SequenceNumberRange).toBeDefined();
    });

    it("paginates ListShards", async () => {
      await createStream("manyshards", 3);
      const page1 = await kinesis.send(new ListShardsCommand({ StreamName: "manyshards", MaxResults: 2 }));
      expect(page1.Shards!.length).toBe(2);
      expect(page1.NextToken).toBeDefined();
      const page2 = await kinesis.send(new ListShardsCommand({ NextToken: page1.NextToken }));
      expect(page2.Shards!.length).toBe(1);
    });

    it("splits a shard into two children", async () => {
      await createStream("split", 1);
      const shards = await kinesis.send(new ListShardsCommand({ StreamName: "split" }));
      const parent = shards.Shards![0];
      const start = BigInt(parent.HashKeyRange!.StartingHashKey!);
      const end = BigInt(parent.HashKeyRange!.EndingHashKey!);
      const mid = (start + end) / 2n;
      await kinesis.send(
        new SplitShardCommand({ StreamName: "split", ShardToSplit: parent.ShardId, NewStartingHashKey: mid.toString() }),
      );
      const after = await kinesis.send(new ListShardsCommand({ StreamName: "split" }));
      // parent (now closed) + 2 children
      expect(after.Shards!.length).toBe(3);
      const children = after.Shards!.filter((s) => s.ParentShardId === parent.ShardId);
      expect(children.length).toBe(2);
    });

    it("merges two adjacent shards", async () => {
      await createStream("merge", 2);
      const shards = await kinesis.send(new ListShardsCommand({ StreamName: "merge" }));
      const [s0, s1] = shards.Shards!;
      await kinesis.send(
        new MergeShardsCommand({ StreamName: "merge", ShardToMerge: s0.ShardId, AdjacentShardToMerge: s1.ShardId }),
      );
      const after = await kinesis.send(new ListShardsCommand({ StreamName: "merge" }));
      // 2 closed parents + 1 child
      expect(after.Shards!.length).toBe(3);
      const child = after.Shards!.find((s) => s.ParentShardId && s.AdjacentParentShardId);
      expect(child).toBeDefined();
    });

    it("updates shard count", async () => {
      await createStream("scale", 2);
      const res = await kinesis.send(
        new UpdateShardCountCommand({ StreamName: "scale", TargetShardCount: 4, ScalingType: "UNIFORM_SCALING" }),
      );
      expect(res.CurrentShardCount).toBe(2);
      expect(res.TargetShardCount).toBe(4);
      const open = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "scale" }));
      expect(open.StreamDescriptionSummary!.OpenShardCount).toBe(4);
    });

    it("updates stream mode", async () => {
      await createStream("modeswap", 1);
      await kinesis.send(
        new UpdateStreamModeCommand({
          StreamARN: server.streamArn("modeswap"),
          StreamModeDetails: { StreamMode: "ON_DEMAND" },
        }),
      );
      const sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "modeswap" }));
      expect(sum.StreamDescriptionSummary!.StreamModeDetails!.StreamMode).toBe("ON_DEMAND");
    });

    it("updates stream warm throughput", async () => {
      await createStream("warm", 1);
      const res = await kinesis.send(
        new UpdateStreamWarmThroughputCommand({
          StreamARN: server.streamArn("warm"),
          WarmThroughputMiBps: 32,
        }),
      );
      expect(res.StreamName).toBe("warm");
      expect(res.WarmThroughput!.TargetMiBps).toBe(32);
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    it("adds, lists, and removes stream tags", async () => {
      await createStream("tagged");
      await kinesis.send(new AddTagsToStreamCommand({ StreamName: "tagged", Tags: { env: "test", team: "parlel" } }));
      let res = await kinesis.send(new ListTagsForStreamCommand({ StreamName: "tagged" }));
      expect(res.Tags!.length).toBe(2);
      await kinesis.send(new RemoveTagsFromStreamCommand({ StreamName: "tagged", TagKeys: ["env"] }));
      res = await kinesis.send(new ListTagsForStreamCommand({ StreamName: "tagged" }));
      expect(res.Tags!.length).toBe(1);
      expect(res.Tags![0].Key).toBe("team");
    });

    it("tags a resource via the generic Tag/Untag/List API", async () => {
      await createStream("restag");
      const arn = server.streamArn("restag");
      await kinesis.send(new TagResourceCommand({ ResourceARN: arn, Tags: { a: "1", b: "2" } }));
      let res = await kinesis.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
      expect(res.Tags!.length).toBe(2);
      await kinesis.send(new UntagResourceCommand({ ResourceARN: arn, TagKeys: ["a"] }));
      res = await kinesis.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
      expect(res.Tags!.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Enhanced monitoring", () => {
    it("enables and disables shard-level metrics", async () => {
      await createStream("mon");
      const en = await kinesis.send(
        new EnableEnhancedMonitoringCommand({ StreamName: "mon", ShardLevelMetrics: ["IncomingBytes", "OutgoingBytes"] }),
      );
      expect(en.DesiredShardLevelMetrics).toContain("IncomingBytes");
      const dis = await kinesis.send(
        new DisableEnhancedMonitoringCommand({ StreamName: "mon", ShardLevelMetrics: ["IncomingBytes"] }),
      );
      expect(dis.DesiredShardLevelMetrics).not.toContain("IncomingBytes");
      expect(dis.DesiredShardLevelMetrics).toContain("OutgoingBytes");
    });

    it("supports the ALL metric shortcut", async () => {
      await createStream("monall");
      const en = await kinesis.send(
        new EnableEnhancedMonitoringCommand({ StreamName: "monall", ShardLevelMetrics: ["ALL"] }),
      );
      expect(en.DesiredShardLevelMetrics!.length).toBeGreaterThan(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Encryption", () => {
    it("starts and stops stream encryption", async () => {
      await createStream("crypt");
      await kinesis.send(
        new StartStreamEncryptionCommand({ StreamName: "crypt", EncryptionType: "KMS", KeyId: "alias/aws/kinesis" }),
      );
      let sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "crypt" }));
      expect(sum.StreamDescriptionSummary!.EncryptionType).toBe("KMS");
      expect(sum.StreamDescriptionSummary!.KeyId).toBe("alias/aws/kinesis");

      await kinesis.send(new StopStreamEncryptionCommand({ StreamName: "crypt", EncryptionType: "KMS", KeyId: "alias/aws/kinesis" }));
      sum = await kinesis.send(new DescribeStreamSummaryCommand({ StreamName: "crypt" }));
      expect(sum.StreamDescriptionSummary!.EncryptionType).toBe("NONE");
    });
  });

  // -----------------------------------------------------------------------
  describe("Consumers (enhanced fan-out)", () => {
    it("registers, describes, lists, and deregisters a consumer", async () => {
      await createStream("fanout");
      const arn = server.streamArn("fanout");
      const reg = await kinesis.send(
        new RegisterStreamConsumerCommand({ StreamARN: arn, ConsumerName: "c1" }),
      );
      expect(reg.Consumer!.ConsumerName).toBe("c1");
      expect(reg.Consumer!.ConsumerStatus).toBe("ACTIVE");
      const consumerArn = reg.Consumer!.ConsumerARN!;

      const desc = await kinesis.send(new DescribeStreamConsumerCommand({ ConsumerARN: consumerArn }));
      expect(desc.ConsumerDescription!.ConsumerName).toBe("c1");

      const list = await kinesis.send(new ListStreamConsumersCommand({ StreamARN: arn }));
      expect(list.Consumers!.length).toBe(1);

      await kinesis.send(new DeregisterStreamConsumerCommand({ ConsumerARN: consumerArn }));
      const list2 = await kinesis.send(new ListStreamConsumersCommand({ StreamARN: arn }));
      expect(list2.Consumers!.length).toBe(0);
    });

    it("rejects duplicate consumer registration", async () => {
      await createStream("fanout2");
      const arn = server.streamArn("fanout2");
      await kinesis.send(new RegisterStreamConsumerCommand({ StreamARN: arn, ConsumerName: "dupc" }));
      await expectError(
        kinesis.send(new RegisterStreamConsumerCommand({ StreamARN: arn, ConsumerName: "dupc" })),
        "ResourceInUseException",
      );
    });

    it("describe missing consumer throws ResourceNotFoundException", async () => {
      await createStream("fanout3");
      await expectError(
        kinesis.send(
          new DescribeStreamConsumerCommand({ StreamARN: server.streamArn("fanout3"), ConsumerName: "ghost" }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Resource policies", () => {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "kinesis:GetRecords", Resource: "*" }],
    });

    it("puts, gets, and deletes a resource policy", async () => {
      await createStream("policy");
      const arn = server.streamArn("policy");
      await kinesis.send(new PutResourcePolicyCommand({ ResourceARN: arn, Policy: policy }));
      const got = await kinesis.send(new GetResourcePolicyCommand({ ResourceARN: arn }));
      expect(got.Policy).toBe(policy);
      await kinesis.send(new DeleteResourcePolicyCommand({ ResourceARN: arn }));
      await expectError(
        kinesis.send(new GetResourcePolicyCommand({ ResourceARN: arn })),
        "ResourceNotFoundException",
      );
    });

    it("rejects policy put on a missing stream", async () => {
      await expectError(
        kinesis.send(
          new PutResourcePolicyCommand({ ResourceARN: server.streamArn("nope"), Policy: policy }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("SubscribeToShard (intentionally unsupported)", () => {
    it("returns InvalidArgumentException because event streams need HTTP/2 fan-out", async () => {
      await createStream("subshard");
      const arn = server.streamArn("subshard");
      const reg = await kinesis.send(
        new RegisterStreamConsumerCommand({ StreamARN: arn, ConsumerName: "subc" }),
      );
      const shardId = await firstShardId("subshard");
      await expectError(
        kinesis.send(
          new SubscribeToShardCommand({
            ConsumerARN: reg.Consumer!.ConsumerARN,
            ShardId: shardId,
            StartingPosition: { Type: "TRIM_HORIZON" },
          }),
        ),
        "InvalidArgumentException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("StreamARN-based addressing", () => {
    it("supports operations via StreamARN instead of StreamName", async () => {
      await createStream("arned");
      const arn = server.streamArn("arned");
      const desc = await kinesis.send(new DescribeStreamCommand({ StreamARN: arn }));
      expect(desc.StreamDescription!.StreamName).toBe("arned");
      const put = await kinesis.send(
        new PutRecordCommand({ StreamARN: arn, PartitionKey: "k", Data: enc.encode("via-arn") }),
      );
      expect(put.SequenceNumber).toBeDefined();
    });
  });
});
