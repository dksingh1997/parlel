import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SecretsManagerClient,
  // secret lifecycle
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  RestoreSecretCommand,
  UpdateSecretCommand,
  // values
  GetSecretValueCommand,
  PutSecretValueCommand,
  BatchGetSecretValueCommand,
  // listing
  ListSecretsCommand,
  ListSecretVersionIdsCommand,
  // staging
  UpdateSecretVersionStageCommand,
  // utility
  GetRandomPasswordCommand,
  // tagging
  TagResourceCommand,
  UntagResourceCommand,
  // rotation
  RotateSecretCommand,
  CancelRotateSecretCommand,
  // resource policies
  PutResourcePolicyCommand,
  GetResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  ValidateResourcePolicyCommand,
  // replication
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
  StopReplicationToReplicaCommand,
} from "@aws-sdk/client-secrets-manager";
import { SecretsmanagerServer } from "../services/secretsmanager/src/server.js";

const PORT = 14572;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new SecretsManagerClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
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

const td = new TextDecoder();
const te = new TextEncoder();

describe("Secrets Manager Service", () => {
  let server: SecretsmanagerServer;
  let sm: SecretsManagerClient;

  beforeAll(async () => {
    server = new SecretsmanagerServer(PORT);
    await server.start();
    sm = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    sm.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createSecret(name: string, value = "s3cr3t", extra: Record<string, unknown> = {}) {
    const res = await sm.send(
      new CreateSecretCommand({ Name: name, SecretString: value, ...extra }),
    );
    return res;
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses the default port 4572 by default", () => {
      const s = new SecretsmanagerServer();
      expect(s.port).toBe(4572);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("secretsmanager");
    });

    it("has resettable ephemeral state", async () => {
      await createSecret("reset-secret");
      expect(server.secrets.size).toBe(1);
      server.reset();
      expect(server.secrets.size).toBe(0);
    });

    it("supports POST /_parlel/reset", async () => {
      await createSecret("reset-secret-2");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.secrets.size).toBe(0);
    });

    it("rejects non-POST API requests", async () => {
      const res = await fetch(ENDPOINT, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });

  // -----------------------------------------------------------------------
  describe("CreateSecret", () => {
    it("creates a secret and returns ARN/Name/VersionId", async () => {
      const res = await createSecret("my-secret");
      expect(res.Name).toBe("my-secret");
      expect(res.ARN).toContain("arn:aws:secretsmanager:us-east-1:000000000000:secret:my-secret-");
      expect(res.VersionId).toBeDefined();
    });

    it("creates a binary secret", async () => {
      const res = await sm.send(
        new CreateSecretCommand({
          Name: "bin-secret",
          SecretBinary: te.encode("binary-data"),
        }),
      );
      expect(res.Name).toBe("bin-secret");
      const got = await sm.send(new GetSecretValueCommand({ SecretId: "bin-secret" }));
      expect(td.decode(got.SecretBinary)).toBe("binary-data");
    });

    it("stores tags", async () => {
      await createSecret("tagged-secret", "v", {
        Tags: [{ Key: "env", Value: "test" }],
      });
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "tagged-secret" }));
      expect(desc.Tags).toContainEqual({ Key: "env", Value: "test" });
    });

    it("stores description and KmsKeyId", async () => {
      await createSecret("described", "v", {
        Description: "hello",
        KmsKeyId: "alias/aws/secretsmanager",
      });
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "described" }));
      expect(desc.Description).toBe("hello");
      expect(desc.KmsKeyId).toBe("alias/aws/secretsmanager");
    });

    it("rejects duplicate names", async () => {
      await createSecret("dup");
      await expectError(createSecret("dup"), "ResourceExistsException");
    });

    it("rejects both SecretString and SecretBinary", async () => {
      await expectError(
        sm.send(
          new CreateSecretCommand({
            Name: "both",
            SecretString: "a",
            SecretBinary: te.encode("b"),
          }),
        ),
        "InvalidParameterException",
      );
    });

    it("is idempotent with a matching ClientRequestToken", async () => {
      const token = "11111111-1111-1111-1111-111111111111";
      const r1 = await sm.send(
        new CreateSecretCommand({ Name: "idem", SecretString: "v", ClientRequestToken: token }),
      );
      const r2 = await sm.send(
        new CreateSecretCommand({ Name: "idem", SecretString: "v", ClientRequestToken: token }),
      );
      expect(r1.VersionId).toBe(r2.VersionId);
    });

    it("returns AddReplicaRegions status", async () => {
      const res = await sm.send(
        new CreateSecretCommand({
          Name: "replicated",
          SecretString: "v",
          AddReplicaRegions: [{ Region: "us-west-2" }],
        }),
      );
      expect(res.ReplicationStatus?.[0].Region).toBe("us-west-2");
    });
  });

  // -----------------------------------------------------------------------
  describe("GetSecretValue", () => {
    it("returns the current secret string", async () => {
      await createSecret("getme", "topsecret");
      const res = await sm.send(new GetSecretValueCommand({ SecretId: "getme" }));
      expect(res.SecretString).toBe("topsecret");
      expect(res.VersionStages).toContain("AWSCURRENT");
      expect(res.CreatedDate).toBeInstanceOf(Date);
    });

    it("resolves by full ARN", async () => {
      const created = await createSecret("by-arn", "v");
      const res = await sm.send(new GetSecretValueCommand({ SecretId: created.ARN }));
      expect(res.SecretString).toBe("v");
    });

    it("gets a specific version by VersionId", async () => {
      const c = await createSecret("versioned", "v1");
      const put = await sm.send(
        new PutSecretValueCommand({ SecretId: "versioned", SecretString: "v2" }),
      );
      const old = await sm.send(
        new GetSecretValueCommand({ SecretId: "versioned", VersionId: c.VersionId }),
      );
      expect(old.SecretString).toBe("v1");
      const cur = await sm.send(
        new GetSecretValueCommand({ SecretId: "versioned", VersionId: put.VersionId }),
      );
      expect(cur.SecretString).toBe("v2");
    });

    it("gets by VersionStage", async () => {
      await createSecret("staged", "v1");
      await sm.send(new PutSecretValueCommand({ SecretId: "staged", SecretString: "v2" }));
      const prev = await sm.send(
        new GetSecretValueCommand({ SecretId: "staged", VersionStage: "AWSPREVIOUS" }),
      );
      expect(prev.SecretString).toBe("v1");
    });

    it("throws ResourceNotFound for missing secret", async () => {
      await expectError(
        sm.send(new GetSecretValueCommand({ SecretId: "nope" })),
        "ResourceNotFoundException",
      );
    });

    it("throws ResourceNotFound for missing version", async () => {
      await createSecret("exists");
      await expectError(
        sm.send(new GetSecretValueCommand({ SecretId: "exists", VersionId: "deadbeef" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("PutSecretValue", () => {
    it("adds a new version and rotates AWSCURRENT/AWSPREVIOUS", async () => {
      const c = await createSecret("put-test", "v1");
      const put = await sm.send(
        new PutSecretValueCommand({ SecretId: "put-test", SecretString: "v2" }),
      );
      expect(put.VersionStages).toContain("AWSCURRENT");
      const cur = await sm.send(new GetSecretValueCommand({ SecretId: "put-test" }));
      expect(cur.SecretString).toBe("v2");
      expect(cur.VersionId).toBe(put.VersionId);
      const prev = await sm.send(
        new GetSecretValueCommand({ SecretId: "put-test", VersionStage: "AWSPREVIOUS" }),
      );
      expect(prev.SecretString).toBe("v1");
      expect(prev.VersionId).toBe(c.VersionId);
    });

    it("supports custom VersionStages", async () => {
      await createSecret("custom-stage", "v1");
      const put = await sm.send(
        new PutSecretValueCommand({
          SecretId: "custom-stage",
          SecretString: "pending-val",
          VersionStages: ["AWSPENDING"],
        }),
      );
      expect(put.VersionStages).toContain("AWSPENDING");
      const cur = await sm.send(new GetSecretValueCommand({ SecretId: "custom-stage" }));
      expect(cur.SecretString).toBe("v1"); // AWSCURRENT unchanged
    });

    it("puts binary values", async () => {
      await createSecret("put-bin", "v1");
      await sm.send(
        new PutSecretValueCommand({ SecretId: "put-bin", SecretBinary: te.encode("bytes!") }),
      );
      const got = await sm.send(new GetSecretValueCommand({ SecretId: "put-bin" }));
      expect(td.decode(got.SecretBinary)).toBe("bytes!");
    });

    it("rejects when neither value provided", async () => {
      await createSecret("put-empty");
      await expectError(
        sm.send(new PutSecretValueCommand({ SecretId: "put-empty" })),
        "InvalidParameterException",
      );
    });

    it("throws ResourceNotFound for missing secret", async () => {
      await expectError(
        sm.send(new PutSecretValueCommand({ SecretId: "ghost", SecretString: "v" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("UpdateSecret", () => {
    it("updates description and value", async () => {
      const c = await createSecret("upd", "v1");
      const res = await sm.send(
        new UpdateSecretCommand({
          SecretId: "upd",
          Description: "new desc",
          SecretString: "v2",
        }),
      );
      expect(res.VersionId).toBeDefined();
      expect(res.VersionId).not.toBe(c.VersionId);
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "upd" }));
      expect(desc.Description).toBe("new desc");
      const cur = await sm.send(new GetSecretValueCommand({ SecretId: "upd" }));
      expect(cur.SecretString).toBe("v2");
    });

    it("updates description only (no new version)", async () => {
      await createSecret("upd2", "v1");
      const res = await sm.send(
        new UpdateSecretCommand({ SecretId: "upd2", Description: "just desc" }),
      );
      expect(res.VersionId).toBeUndefined();
    });

    it("throws ResourceNotFound for missing secret", async () => {
      await expectError(
        sm.send(new UpdateSecretCommand({ SecretId: "missing", Description: "x" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("DescribeSecret", () => {
    it("returns metadata and VersionIdsToStages", async () => {
      const c = await createSecret("desc-test", "v", { Description: "d" });
      const res = await sm.send(new DescribeSecretCommand({ SecretId: "desc-test" }));
      expect(res.Name).toBe("desc-test");
      expect(res.ARN).toBe(c.ARN);
      expect(res.Description).toBe("d");
      expect(res.RotationEnabled).toBe(false);
      expect(res.CreatedDate).toBeInstanceOf(Date);
      expect(res.VersionIdsToStages?.[c.VersionId!]).toContain("AWSCURRENT");
    });

    it("shows DeletedDate after scheduled deletion", async () => {
      await createSecret("desc-del");
      await sm.send(new DeleteSecretCommand({ SecretId: "desc-del" }));
      const res = await sm.send(new DescribeSecretCommand({ SecretId: "desc-del" }));
      expect(res.DeletedDate).toBeInstanceOf(Date);
    });

    it("throws ResourceNotFound for missing secret", async () => {
      await expectError(
        sm.send(new DescribeSecretCommand({ SecretId: "no" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListSecrets", () => {
    it("lists all secrets", async () => {
      await createSecret("list-a");
      await createSecret("list-b");
      const res = await sm.send(new ListSecretsCommand({}));
      const names = res.SecretList?.map((s) => s.Name).sort();
      expect(names).toEqual(["list-a", "list-b"]);
    });

    it("excludes scheduled-for-deletion by default", async () => {
      await createSecret("list-keep");
      await createSecret("list-del");
      await sm.send(new DeleteSecretCommand({ SecretId: "list-del" }));
      const res = await sm.send(new ListSecretsCommand({}));
      const names = res.SecretList?.map((s) => s.Name);
      expect(names).toContain("list-keep");
      expect(names).not.toContain("list-del");
    });

    it("includes deleted with IncludePlannedDeletion", async () => {
      await createSecret("list-del2");
      await sm.send(new DeleteSecretCommand({ SecretId: "list-del2" }));
      const res = await sm.send(new ListSecretsCommand({ IncludePlannedDeletion: true }));
      const names = res.SecretList?.map((s) => s.Name);
      expect(names).toContain("list-del2");
    });

    it("filters by name", async () => {
      await createSecret("prod-db");
      await createSecret("dev-db");
      const res = await sm.send(
        new ListSecretsCommand({ Filters: [{ Key: "name", Values: ["prod"] }] }),
      );
      expect(res.SecretList?.map((s) => s.Name)).toEqual(["prod-db"]);
    });

    it("filters by tag-key", async () => {
      await createSecret("with-tag", "v", { Tags: [{ Key: "team", Value: "core" }] });
      await createSecret("no-tag");
      const res = await sm.send(
        new ListSecretsCommand({ Filters: [{ Key: "tag-key", Values: ["team"] }] }),
      );
      expect(res.SecretList?.map((s) => s.Name)).toEqual(["with-tag"]);
    });

    it("paginates with MaxResults and NextToken", async () => {
      for (let i = 0; i < 5; i += 1) await createSecret(`page-${i}`);
      const first = await sm.send(new ListSecretsCommand({ MaxResults: 2 }));
      expect(first.SecretList?.length).toBe(2);
      expect(first.NextToken).toBeDefined();
      const second = await sm.send(
        new ListSecretsCommand({ MaxResults: 2, NextToken: first.NextToken }),
      );
      expect(second.SecretList?.length).toBe(2);
    });

    it("sorts by name desc", async () => {
      await createSecret("s-a");
      await createSecret("s-b");
      await createSecret("s-c");
      const res = await sm.send(new ListSecretsCommand({ SortBy: "name", SortOrder: "desc" }));
      expect(res.SecretList?.map((s) => s.Name)).toEqual(["s-c", "s-b", "s-a"]);
    });
  });

  // -----------------------------------------------------------------------
  describe("ListSecretVersionIds", () => {
    it("lists versions", async () => {
      await createSecret("vlist", "v1");
      await sm.send(new PutSecretValueCommand({ SecretId: "vlist", SecretString: "v2" }));
      const res = await sm.send(new ListSecretVersionIdsCommand({ SecretId: "vlist" }));
      expect(res.Versions?.length).toBe(2);
      const stages = res.Versions?.flatMap((v) => v.VersionStages || []);
      expect(stages).toContain("AWSCURRENT");
      expect(stages).toContain("AWSPREVIOUS");
    });

    it("throws ResourceNotFound for missing secret", async () => {
      await expectError(
        sm.send(new ListSecretVersionIdsCommand({ SecretId: "absent" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("UpdateSecretVersionStage", () => {
    it("moves a custom stage to a version", async () => {
      const c = await createSecret("stage-move", "v1");
      const put = await sm.send(
        new PutSecretValueCommand({
          SecretId: "stage-move",
          SecretString: "v2",
          VersionStages: ["AWSPENDING"],
        }),
      );
      await sm.send(
        new UpdateSecretVersionStageCommand({
          SecretId: "stage-move",
          VersionStage: "AWSCURRENT",
          MoveToVersionId: put.VersionId,
          RemoveFromVersionId: c.VersionId,
        }),
      );
      const cur = await sm.send(new GetSecretValueCommand({ SecretId: "stage-move" }));
      expect(cur.SecretString).toBe("v2");
    });

    it("removes a stage", async () => {
      await createSecret("stage-rm", "v1");
      const put = await sm.send(
        new PutSecretValueCommand({
          SecretId: "stage-rm",
          SecretString: "x",
          VersionStages: ["CUSTOM"],
        }),
      );
      await sm.send(
        new UpdateSecretVersionStageCommand({
          SecretId: "stage-rm",
          VersionStage: "CUSTOM",
          RemoveFromVersionId: put.VersionId,
        }),
      );
      const res = await sm.send(new ListSecretVersionIdsCommand({ SecretId: "stage-rm" }));
      const stages = res.Versions?.flatMap((v) => v.VersionStages || []);
      expect(stages).not.toContain("CUSTOM");
    });

    it("rejects when neither move nor remove given", async () => {
      const c = await createSecret("stage-bad", "v1");
      await expectError(
        sm.send(
          new UpdateSecretVersionStageCommand({
            SecretId: "stage-bad",
            VersionStage: "AWSCURRENT",
          }),
        ),
        "InvalidParameterException",
      );
      expect(c.VersionId).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteSecret / RestoreSecret", () => {
    it("schedules deletion with default window", async () => {
      await createSecret("del-default");
      const res = await sm.send(new DeleteSecretCommand({ SecretId: "del-default" }));
      expect(res.Name).toBe("del-default");
      expect(res.DeletionDate).toBeInstanceOf(Date);
      await expectError(
        sm.send(new GetSecretValueCommand({ SecretId: "del-default" })),
        "ResourceNotFoundException",
      );
    });

    it("force deletes immediately", async () => {
      await createSecret("del-force");
      await sm.send(
        new DeleteSecretCommand({ SecretId: "del-force", ForceDeleteWithoutRecovery: true }),
      );
      expect(server.secrets.has("del-force")).toBe(false);
    });

    it("rejects force + recovery window together", async () => {
      await createSecret("del-conflict");
      await expectError(
        sm.send(
          new DeleteSecretCommand({
            SecretId: "del-conflict",
            ForceDeleteWithoutRecovery: true,
            RecoveryWindowInDays: 7,
          }),
        ),
        "InvalidParameterException",
      );
    });

    it("rejects out-of-range recovery window", async () => {
      await createSecret("del-range");
      await expectError(
        sm.send(new DeleteSecretCommand({ SecretId: "del-range", RecoveryWindowInDays: 3 })),
        "InvalidParameterException",
      );
    });

    it("restores a scheduled-for-deletion secret", async () => {
      await createSecret("restore-me", "v");
      await sm.send(new DeleteSecretCommand({ SecretId: "restore-me" }));
      const res = await sm.send(new RestoreSecretCommand({ SecretId: "restore-me" }));
      expect(res.Name).toBe("restore-me");
      const got = await sm.send(new GetSecretValueCommand({ SecretId: "restore-me" }));
      expect(got.SecretString).toBe("v");
    });
  });

  // -----------------------------------------------------------------------
  describe("BatchGetSecretValue", () => {
    it("returns values for an id list", async () => {
      await createSecret("batch-a", "av");
      await createSecret("batch-b", "bv");
      const res = await sm.send(
        new BatchGetSecretValueCommand({ SecretIdList: ["batch-a", "batch-b"] }),
      );
      const byName = Object.fromEntries(
        (res.SecretValues || []).map((v) => [v.Name, v.SecretString]),
      );
      expect(byName).toEqual({ "batch-a": "av", "batch-b": "bv" });
    });

    it("reports errors for missing ids", async () => {
      await createSecret("batch-real");
      const res = await sm.send(
        new BatchGetSecretValueCommand({ SecretIdList: ["batch-real", "batch-missing"] }),
      );
      expect(res.SecretValues?.length).toBe(1);
      expect(res.Errors?.[0].SecretId).toBe("batch-missing");
      expect(res.Errors?.[0].ErrorCode).toBe("ResourceNotFoundException");
    });

    it("returns values matching filters", async () => {
      await createSecret("filt-a", "v", { Tags: [{ Key: "grp", Value: "x" }] });
      await createSecret("filt-b", "v");
      const res = await sm.send(
        new BatchGetSecretValueCommand({ Filters: [{ Key: "tag-key", Values: ["grp"] }] }),
      );
      expect(res.SecretValues?.map((v) => v.Name)).toEqual(["filt-a"]);
    });

    it("rejects both list and filters", async () => {
      await expectError(
        sm.send(
          new BatchGetSecretValueCommand({
            SecretIdList: ["x"],
            Filters: [{ Key: "name", Values: ["x"] }],
          }),
        ),
        "InvalidParameterException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("GetRandomPassword", () => {
    it("returns a password of default length 32", async () => {
      const res = await sm.send(new GetRandomPasswordCommand({}));
      expect(res.RandomPassword?.length).toBe(32);
    });

    it("honors PasswordLength", async () => {
      const res = await sm.send(new GetRandomPasswordCommand({ PasswordLength: 12 }));
      expect(res.RandomPassword?.length).toBe(12);
    });

    it("excludes punctuation and numbers", async () => {
      const res = await sm.send(
        new GetRandomPasswordCommand({
          PasswordLength: 64,
          ExcludePunctuation: true,
          ExcludeNumbers: true,
        }),
      );
      expect(res.RandomPassword).toMatch(/^[A-Za-z]+$/);
    });

    it("excludes specific characters", async () => {
      const res = await sm.send(
        new GetRandomPasswordCommand({ PasswordLength: 100, ExcludeCharacters: "abcABC" }),
      );
      expect(res.RandomPassword).not.toMatch(/[abcABC]/);
    });

    it("rejects invalid length", async () => {
      await expectError(
        sm.send(new GetRandomPasswordCommand({ PasswordLength: 0 })),
        "InvalidParameterException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("TagResource / UntagResource", () => {
    it("adds tags", async () => {
      await createSecret("tag-test");
      await sm.send(
        new TagResourceCommand({
          SecretId: "tag-test",
          Tags: [
            { Key: "a", Value: "1" },
            { Key: "b", Value: "2" },
          ],
        }),
      );
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "tag-test" }));
      expect(desc.Tags).toContainEqual({ Key: "a", Value: "1" });
      expect(desc.Tags).toContainEqual({ Key: "b", Value: "2" });
    });

    it("removes tags by key", async () => {
      await createSecret("untag-test", "v", {
        Tags: [
          { Key: "x", Value: "1" },
          { Key: "y", Value: "2" },
        ],
      });
      await sm.send(new UntagResourceCommand({ SecretId: "untag-test", TagKeys: ["x"] }));
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "untag-test" }));
      const keys = desc.Tags?.map((t) => t.Key);
      expect(keys).not.toContain("x");
      expect(keys).toContain("y");
    });
  });

  // -----------------------------------------------------------------------
  describe("RotateSecret / CancelRotateSecret", () => {
    it("rotates and creates a new current version", async () => {
      const c = await createSecret("rot", "v1");
      const res = await sm.send(
        new RotateSecretCommand({
          SecretId: "rot",
          RotationLambdaARN: "arn:aws:lambda:us-east-1:000000000000:function:rotator",
          RotationRules: { AutomaticallyAfterDays: 30 },
        }),
      );
      expect(res.VersionId).toBeDefined();
      expect(res.VersionId).not.toBe(c.VersionId);
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "rot" }));
      expect(desc.RotationEnabled).toBe(true);
      expect(desc.RotationRules?.AutomaticallyAfterDays).toBe(30);
      expect(desc.NextRotationDate).toBeInstanceOf(Date);
    });

    it("cancels rotation", async () => {
      await createSecret("rot-cancel", "v1");
      await sm.send(
        new RotateSecretCommand({
          SecretId: "rot-cancel",
          RotationLambdaARN: "arn:aws:lambda:us-east-1:000000000000:function:r",
          RotationRules: { AutomaticallyAfterDays: 7 },
        }),
      );
      await sm.send(new CancelRotateSecretCommand({ SecretId: "rot-cancel" }));
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "rot-cancel" }));
      expect(desc.RotationEnabled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  describe("Resource policies", () => {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::000000000000:root" },
          Action: "secretsmanager:GetSecretValue",
          Resource: "*",
        },
      ],
    });

    it("puts and gets a resource policy", async () => {
      await createSecret("policy-test");
      await sm.send(
        new PutResourcePolicyCommand({ SecretId: "policy-test", ResourcePolicy: policy }),
      );
      const res = await sm.send(new GetResourcePolicyCommand({ SecretId: "policy-test" }));
      expect(res.ResourcePolicy).toBe(policy);
    });

    it("deletes a resource policy", async () => {
      await createSecret("policy-del");
      await sm.send(
        new PutResourcePolicyCommand({ SecretId: "policy-del", ResourcePolicy: policy }),
      );
      await sm.send(new DeleteResourcePolicyCommand({ SecretId: "policy-del" }));
      const res = await sm.send(new GetResourcePolicyCommand({ SecretId: "policy-del" }));
      expect(res.ResourcePolicy).toBeUndefined();
    });

    it("rejects malformed policy JSON", async () => {
      await createSecret("policy-bad");
      await expectError(
        sm.send(
          new PutResourcePolicyCommand({ SecretId: "policy-bad", ResourcePolicy: "not json" }),
        ),
        "MalformedPolicyDocumentException",
      );
    });

    it("validates a good policy", async () => {
      const res = await sm.send(new ValidateResourcePolicyCommand({ ResourcePolicy: policy }));
      expect(res.PolicyValidationPassed).toBe(true);
    });

    it("flags an invalid policy", async () => {
      const res = await sm.send(
        new ValidateResourcePolicyCommand({ ResourcePolicy: "{ bad json" }),
      );
      expect(res.PolicyValidationPassed).toBe(false);
      expect(res.ValidationErrors?.length).toBeGreaterThan(0);
    });

    it("blocks a public policy when BlockPublicPolicy is set", async () => {
      await createSecret("policy-public");
      const publicPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: "*", Action: "*", Resource: "*" }],
      });
      await expectError(
        sm.send(
          new PutResourcePolicyCommand({
            SecretId: "policy-public",
            ResourcePolicy: publicPolicy,
            BlockPublicPolicy: true,
          }),
        ),
        "PublicPolicyException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Replication", () => {
    it("replicates a secret to regions", async () => {
      await createSecret("repl-test");
      const res = await sm.send(
        new ReplicateSecretToRegionsCommand({
          SecretId: "repl-test",
          AddReplicaRegions: [{ Region: "eu-west-1" }, { Region: "ap-south-1" }],
        }),
      );
      const regions = res.ReplicationStatus?.map((r) => r.Region).sort();
      expect(regions).toEqual(["ap-south-1", "eu-west-1"]);
    });

    it("removes regions from replication", async () => {
      await createSecret("repl-rm", "v", { AddReplicaRegions: [{ Region: "eu-west-1" }] });
      const res = await sm.send(
        new RemoveRegionsFromReplicationCommand({
          SecretId: "repl-rm",
          RemoveReplicaRegions: ["eu-west-1"],
        }),
      );
      expect(res.ReplicationStatus?.length).toBe(0);
    });

    it("stops replication to a replica", async () => {
      await createSecret("repl-stop", "v", { AddReplicaRegions: [{ Region: "eu-west-1" }] });
      const res = await sm.send(new StopReplicationToReplicaCommand({ SecretId: "repl-stop" }));
      expect(res.ARN).toBeDefined();
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "repl-stop" }));
      expect(desc.ReplicationStatus).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  describe("End-to-end lifecycle", () => {
    it("create -> get -> update -> rotate -> delete -> restore", async () => {
      await createSecret("e2e", "v1", { Description: "lifecycle" });
      let got = await sm.send(new GetSecretValueCommand({ SecretId: "e2e" }));
      expect(got.SecretString).toBe("v1");

      await sm.send(new PutSecretValueCommand({ SecretId: "e2e", SecretString: "v2" }));
      got = await sm.send(new GetSecretValueCommand({ SecretId: "e2e" }));
      expect(got.SecretString).toBe("v2");

      await sm.send(
        new RotateSecretCommand({
          SecretId: "e2e",
          RotationLambdaARN: "arn:aws:lambda:us-east-1:000000000000:function:fn",
          RotationRules: { AutomaticallyAfterDays: 14 },
        }),
      );
      const desc = await sm.send(new DescribeSecretCommand({ SecretId: "e2e" }));
      expect(desc.RotationEnabled).toBe(true);

      await sm.send(new DeleteSecretCommand({ SecretId: "e2e" }));
      await expectError(
        sm.send(new GetSecretValueCommand({ SecretId: "e2e" })),
        "ResourceNotFoundException",
      );

      await sm.send(new RestoreSecretCommand({ SecretId: "e2e" }));
      got = await sm.send(new GetSecretValueCommand({ SecretId: "e2e" }));
      expect(got.SecretString).toBeDefined();
    });
  });
});
