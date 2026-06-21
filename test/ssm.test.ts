import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SSMClient,
  // parameter CRUD
  PutParameterCommand,
  GetParameterCommand,
  GetParametersCommand,
  GetParametersByPathCommand,
  DeleteParameterCommand,
  DeleteParametersCommand,
  DescribeParametersCommand,
  GetParameterHistoryCommand,
  // version labels
  LabelParameterVersionCommand,
  UnlabelParameterVersionCommand,
  // tagging
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ListTagsForResourceCommand,
  // resource policies
  PutResourcePolicyCommand,
  GetResourcePoliciesCommand,
  DeleteResourcePolicyCommand,
  // service settings
  GetServiceSettingCommand,
  UpdateServiceSettingCommand,
  ResetServiceSettingCommand,
} from "@aws-sdk/client-ssm";
import { SsmServer } from "../services/ssm/src/server.js";

const PORT = 14578;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new SSMClient({
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

describe("SSM Parameter Store Service", () => {
  let server: SsmServer;
  let ssm: SSMClient;

  beforeAll(async () => {
    server = new SsmServer(PORT);
    await server.start();
    ssm = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    ssm.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function putParam(name: string, value: string, extra: Record<string, unknown> = {}) {
    return ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "String", ...extra }));
  }

  // =======================================================================
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses default port 4578 by default", () => {
      const s = new SsmServer();
      expect(s.port).toBe(4578);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("ssm");
    });

    it("has resettable ephemeral state", async () => {
      await putParam("/reset/test", "v");
      expect(server.parameters.size).toBe(1);
      server.reset();
      expect(server.parameters.size).toBe(0);
    });

    it("supports POST /_parlel/reset", async () => {
      await putParam("/reset/test2", "v");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.parameters.size).toBe(0);
    });

    it("rejects non-POST API requests", async () => {
      const res = await fetch(ENDPOINT, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });

  // =======================================================================
  describe("PutParameter", () => {
    it("creates a String parameter and returns Version 1", async () => {
      const res = await putParam("/app/db/host", "localhost");
      expect(res.Version).toBe(1);
      expect(res.Tier).toBe("Standard");
    });

    it("creates a SecureString parameter with default key", async () => {
      await ssm.send(new PutParameterCommand({ Name: "/app/secret", Value: "shh", Type: "SecureString" }));
      const got = await ssm.send(new GetParameterCommand({ Name: "/app/secret" }));
      expect(got.Parameter?.Type).toBe("SecureString");
      expect(got.Parameter?.Value).toBe("shh");
    });

    it("creates a StringList parameter", async () => {
      await ssm.send(new PutParameterCommand({ Name: "/app/list", Value: "a,b,c", Type: "StringList" }));
      const got = await ssm.send(new GetParameterCommand({ Name: "/app/list" }));
      expect(got.Parameter?.Type).toBe("StringList");
      expect(got.Parameter?.Value).toBe("a,b,c");
    });

    it("supports a flat (non-hierarchical) name", async () => {
      const res = await putParam("flatname", "v");
      expect(res.Version).toBe(1);
    });

    it("rejects creation without a Type", async () => {
      await expectError(
        ssm.send(new PutParameterCommand({ Name: "/no/type", Value: "v" })),
        "ValidationException",
      );
    });

    it("rejects an invalid Type", async () => {
      await expectError(
        ssm.send(new PutParameterCommand({ Name: "/bad/type", Value: "v", Type: "Nope" as any })),
        "ValidationException",
      );
    });

    it("rejects names with reserved aws/ssm prefixes", async () => {
      await expectError(putParam("/aws/foo", "v"), "ValidationException");
      await expectError(putParam("/ssm/foo", "v"), "ValidationException");
    });

    it("rejects duplicate creation without Overwrite", async () => {
      await putParam("/dup", "v1");
      await expectError(putParam("/dup", "v2"), "ParameterAlreadyExists");
    });

    it("overwrites and increments version", async () => {
      await putParam("/over", "v1");
      const res = await ssm.send(
        new PutParameterCommand({ Name: "/over", Value: "v2", Type: "String", Overwrite: true }),
      );
      expect(res.Version).toBe(2);
      const got = await ssm.send(new GetParameterCommand({ Name: "/over" }));
      expect(got.Parameter?.Value).toBe("v2");
      expect(got.Parameter?.Version).toBe(2);
    });

    it("stores tags on creation", async () => {
      await putParam("/tagged", "v", { Tags: [{ Key: "env", Value: "test" }] });
      const tags = await ssm.send(
        new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: "/tagged" }),
      );
      expect(tags.TagList).toContainEqual({ Key: "env", Value: "test" });
    });

    it("rejects Tags together with Overwrite", async () => {
      await putParam("/tagover", "v");
      await expectError(
        ssm.send(
          new PutParameterCommand({
            Name: "/tagover",
            Value: "v2",
            Type: "String",
            Overwrite: true,
            Tags: [{ Key: "a", Value: "b" }],
          }),
        ),
        "ValidationException",
      );
    });

    it("enforces AllowedPattern", async () => {
      await expectError(
        ssm.send(
          new PutParameterCommand({
            Name: "/pattern",
            Value: "abc",
            Type: "String",
            AllowedPattern: "^[0-9]+$",
          }),
        ),
        "ParameterPatternMismatchException",
      );
      const ok = await ssm.send(
        new PutParameterCommand({
          Name: "/pattern2",
          Value: "12345",
          Type: "String",
          AllowedPattern: "^[0-9]+$",
        }),
      );
      expect(ok.Version).toBe(1);
    });

    it("supports the Advanced tier for large values", async () => {
      const big = "x".repeat(5000);
      const res = await ssm.send(
        new PutParameterCommand({ Name: "/big", Value: big, Type: "String", Tier: "Advanced" }),
      );
      expect(res.Tier).toBe("Advanced");
    });

    it("rejects values exceeding the standard tier limit", async () => {
      const big = "x".repeat(5000);
      await expectError(
        ssm.send(new PutParameterCommand({ Name: "/toobig", Value: big, Type: "String" })),
        "ValidationException",
      );
    });

    it("Intelligent-Tiering promotes large values to Advanced", async () => {
      const big = "x".repeat(5000);
      const res = await ssm.send(
        new PutParameterCommand({
          Name: "/intel",
          Value: big,
          Type: "String",
          Tier: "Intelligent-Tiering",
        }),
      );
      expect(res.Tier).toBe("Advanced");
    });

    it("stores a Description and DataType", async () => {
      await putParam("/described", "v", { Description: "a param", DataType: "text" });
      const meta = await ssm.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: "Name", Option: "Equals", Values: ["/described"] }],
        }),
      );
      expect(meta.Parameters?.[0].Description).toBe("a param");
    });
  });

  // =======================================================================
  describe("GetParameter", () => {
    it("returns a parameter with ARN", async () => {
      await putParam("/get/me", "hello");
      const res = await ssm.send(new GetParameterCommand({ Name: "/get/me" }));
      expect(res.Parameter?.Value).toBe("hello");
      expect(res.Parameter?.ARN).toContain("arn:aws:ssm:us-east-1:000000000000:parameter/get/me");
      expect(res.Parameter?.Version).toBe(1);
      expect(res.Parameter?.DataType).toBe("text");
    });

    it("throws ParameterNotFound for missing parameter", async () => {
      await expectError(ssm.send(new GetParameterCommand({ Name: "/missing" })), "ParameterNotFound");
    });

    it("resolves a specific version via name:version selector", async () => {
      await putParam("/sel", "v1");
      await ssm.send(new PutParameterCommand({ Name: "/sel", Value: "v2", Type: "String", Overwrite: true }));
      const res = await ssm.send(new GetParameterCommand({ Name: "/sel:1" }));
      expect(res.Parameter?.Value).toBe("v1");
      expect(res.Parameter?.Version).toBe(1);
    });

    it("throws ParameterVersionNotFound for an unknown version selector", async () => {
      await putParam("/sel2", "v1");
      await expectError(ssm.send(new GetParameterCommand({ Name: "/sel2:99" })), "ParameterVersionNotFound");
    });

    it("resolves via WithDecryption (no-op for fake)", async () => {
      await ssm.send(new PutParameterCommand({ Name: "/secure", Value: "s", Type: "SecureString" }));
      const res = await ssm.send(new GetParameterCommand({ Name: "/secure", WithDecryption: true }));
      expect(res.Parameter?.Value).toBe("s");
    });
  });

  // =======================================================================
  describe("GetParameters", () => {
    it("returns multiple parameters and reports invalid ones", async () => {
      await putParam("/multi/a", "1");
      await putParam("/multi/b", "2");
      const res = await ssm.send(new GetParametersCommand({ Names: ["/multi/a", "/multi/b", "/multi/missing"] }));
      expect(res.Parameters?.length).toBe(2);
      expect(res.InvalidParameters).toContain("/multi/missing");
    });

    it("rejects an empty Names list", async () => {
      await expectError(ssm.send(new GetParametersCommand({ Names: [] })), "ValidationException");
    });

    it("resolves selectors in batch", async () => {
      await putParam("/bsel", "v1");
      await ssm.send(new PutParameterCommand({ Name: "/bsel", Value: "v2", Type: "String", Overwrite: true }));
      const res = await ssm.send(new GetParametersCommand({ Names: ["/bsel:1"] }));
      expect(res.Parameters?.[0].Value).toBe("v1");
    });
  });

  // =======================================================================
  describe("GetParametersByPath", () => {
    beforeEach(async () => {
      await putParam("/svc/db/host", "h");
      await putParam("/svc/db/port", "5432");
      await putParam("/svc/cache/host", "c");
      await putParam("/svc/top", "t");
    });

    it("returns one level when not recursive", async () => {
      const res = await ssm.send(new GetParametersByPathCommand({ Path: "/svc" }));
      const names = (res.Parameters || []).map((p) => p.Name).sort();
      expect(names).toEqual(["/svc/top"]);
    });

    it("returns nested params when recursive", async () => {
      const res = await ssm.send(new GetParametersByPathCommand({ Path: "/svc", Recursive: true }));
      const names = (res.Parameters || []).map((p) => p.Name).sort();
      expect(names).toEqual(["/svc/cache/host", "/svc/db/host", "/svc/db/port", "/svc/top"]);
    });

    it("returns one sub-level for /svc/db", async () => {
      const res = await ssm.send(new GetParametersByPathCommand({ Path: "/svc/db" }));
      const names = (res.Parameters || []).map((p) => p.Name).sort();
      expect(names).toEqual(["/svc/db/host", "/svc/db/port"]);
    });

    it("filters by Type via ParameterFilters", async () => {
      await ssm.send(new PutParameterCommand({ Name: "/svc/db/secure", Value: "s", Type: "SecureString" }));
      const res = await ssm.send(
        new GetParametersByPathCommand({
          Path: "/svc",
          Recursive: true,
          ParameterFilters: [{ Key: "Type", Values: ["SecureString"] }],
        }),
      );
      expect(res.Parameters?.length).toBe(1);
      expect(res.Parameters?.[0].Name).toBe("/svc/db/secure");
    });

    it("rejects a path that does not start with /", async () => {
      await expectError(ssm.send(new GetParametersByPathCommand({ Path: "svc" })), "ValidationException");
    });

    it("paginates with MaxResults / NextToken", async () => {
      const first = await ssm.send(
        new GetParametersByPathCommand({ Path: "/svc", Recursive: true, MaxResults: 2 }),
      );
      expect(first.Parameters?.length).toBe(2);
      expect(first.NextToken).toBeDefined();
      const second = await ssm.send(
        new GetParametersByPathCommand({
          Path: "/svc",
          Recursive: true,
          MaxResults: 2,
          NextToken: first.NextToken,
        }),
      );
      expect(second.Parameters?.length).toBe(2);
    });
  });

  // =======================================================================
  describe("DescribeParameters", () => {
    it("lists parameter metadata (no values)", async () => {
      await putParam("/desc/a", "1", { Description: "desc-a" });
      const res = await ssm.send(new DescribeParametersCommand({}));
      expect(res.Parameters?.length).toBe(1);
      const meta: any = res.Parameters?.[0];
      expect(meta.Name).toBe("/desc/a");
      expect(meta.Value).toBeUndefined();
      expect(meta.Description).toBe("desc-a");
      expect(meta.Version).toBe(1);
    });

    it("filters by legacy Filters (Type)", async () => {
      await putParam("/d/s", "v");
      await ssm.send(new PutParameterCommand({ Name: "/d/sec", Value: "v", Type: "SecureString" }));
      const res = await ssm.send(
        new DescribeParametersCommand({ Filters: [{ Key: "Type", Values: ["SecureString"] }] }),
      );
      expect(res.Parameters?.length).toBe(1);
      expect(res.Parameters?.[0].Name).toBe("/d/sec");
    });

    it("filters by tag via ParameterFilters", async () => {
      await putParam("/d/tagged", "v", { Tags: [{ Key: "team", Value: "core" }] });
      await putParam("/d/untagged", "v");
      const res = await ssm.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: "tag:team", Values: ["core"] }],
        }),
      );
      expect(res.Parameters?.length).toBe(1);
      expect(res.Parameters?.[0].Name).toBe("/d/tagged");
    });

    it("paginates results", async () => {
      for (let i = 0; i < 5; i++) await putParam(`/page/${i}`, "v");
      const first = await ssm.send(new DescribeParametersCommand({ MaxResults: 2 }));
      expect(first.Parameters?.length).toBe(2);
      expect(first.NextToken).toBeDefined();
    });
  });

  // =======================================================================
  describe("GetParameterHistory", () => {
    it("returns all versions in order", async () => {
      await putParam("/hist", "v1");
      await ssm.send(new PutParameterCommand({ Name: "/hist", Value: "v2", Type: "String", Overwrite: true }));
      await ssm.send(new PutParameterCommand({ Name: "/hist", Value: "v3", Type: "String", Overwrite: true }));
      const res = await ssm.send(new GetParameterHistoryCommand({ Name: "/hist" }));
      expect(res.Parameters?.length).toBe(3);
      expect(res.Parameters?.map((p) => p.Value)).toEqual(["v1", "v2", "v3"]);
      expect(res.Parameters?.map((p) => p.Version)).toEqual([1, 2, 3]);
    });

    it("throws ParameterNotFound for missing parameter", async () => {
      await expectError(ssm.send(new GetParameterHistoryCommand({ Name: "/nope" })), "ParameterNotFound");
    });

    it("includes labels in history", async () => {
      await putParam("/histlabel", "v1");
      await ssm.send(new LabelParameterVersionCommand({ Name: "/histlabel", Labels: ["prod"] }));
      const res = await ssm.send(new GetParameterHistoryCommand({ Name: "/histlabel" }));
      expect(res.Parameters?.[0].Labels).toContain("prod");
    });
  });

  // =======================================================================
  describe("DeleteParameter / DeleteParameters", () => {
    it("deletes a single parameter", async () => {
      await putParam("/del/one", "v");
      await ssm.send(new DeleteParameterCommand({ Name: "/del/one" }));
      await expectError(ssm.send(new GetParameterCommand({ Name: "/del/one" })), "ParameterNotFound");
    });

    it("throws ParameterNotFound when deleting a missing parameter", async () => {
      await expectError(ssm.send(new DeleteParameterCommand({ Name: "/del/missing" })), "ParameterNotFound");
    });

    it("batch deletes and reports invalid", async () => {
      await putParam("/del/a", "v");
      await putParam("/del/b", "v");
      const res = await ssm.send(
        new DeleteParametersCommand({ Names: ["/del/a", "/del/b", "/del/missing"] }),
      );
      expect(res.DeletedParameters?.sort()).toEqual(["/del/a", "/del/b"]);
      expect(res.InvalidParameters).toContain("/del/missing");
    });
  });

  // =======================================================================
  describe("LabelParameterVersion / UnlabelParameterVersion", () => {
    it("labels the current version and resolves by label", async () => {
      await putParam("/lab", "v1");
      const res = await ssm.send(new LabelParameterVersionCommand({ Name: "/lab", Labels: ["prod"] }));
      expect(res.ParameterVersion).toBe(1);
      expect(res.InvalidLabels?.length ?? 0).toBe(0);
      const got = await ssm.send(new GetParameterCommand({ Name: "/lab:prod" }));
      expect(got.Parameter?.Value).toBe("v1");
    });

    it("moves a label between versions", async () => {
      await putParam("/movelab", "v1");
      await ssm.send(new LabelParameterVersionCommand({ Name: "/movelab", Labels: ["live"] }));
      await ssm.send(new PutParameterCommand({ Name: "/movelab", Value: "v2", Type: "String", Overwrite: true }));
      await ssm.send(
        new LabelParameterVersionCommand({ Name: "/movelab", ParameterVersion: 2, Labels: ["live"] }),
      );
      const got = await ssm.send(new GetParameterCommand({ Name: "/movelab:live" }));
      expect(got.Parameter?.Version).toBe(2);
    });

    it("reports invalid labels (numeric prefix)", async () => {
      await putParam("/lab2", "v1");
      const res = await ssm.send(new LabelParameterVersionCommand({ Name: "/lab2", Labels: ["123bad"] }));
      expect(res.InvalidLabels).toContain("123bad");
    });

    it("throws for a missing parameter version", async () => {
      await putParam("/lab3", "v1");
      await expectError(
        ssm.send(new LabelParameterVersionCommand({ Name: "/lab3", ParameterVersion: 99, Labels: ["x"] })),
        "ParameterVersionNotFound",
      );
    });

    it("unlabels a version", async () => {
      await putParam("/unlab", "v1");
      await ssm.send(new LabelParameterVersionCommand({ Name: "/unlab", Labels: ["temp"] }));
      const res = await ssm.send(
        new UnlabelParameterVersionCommand({ Name: "/unlab", ParameterVersion: 1, Labels: ["temp"] }),
      );
      expect(res.RemovedLabels).toContain("temp");
      await expectError(ssm.send(new GetParameterCommand({ Name: "/unlab:temp" })), "ParameterNotFound");
    });

    it("reports invalid labels on unlabel", async () => {
      await putParam("/unlab2", "v1");
      const res = await ssm.send(
        new UnlabelParameterVersionCommand({ Name: "/unlab2", ParameterVersion: 1, Labels: ["nope"] }),
      );
      expect(res.InvalidLabels).toContain("nope");
    });
  });

  // =======================================================================
  describe("Tagging", () => {
    it("adds, lists and removes tags", async () => {
      await putParam("/tag/res", "v");
      await ssm.send(
        new AddTagsToResourceCommand({
          ResourceType: "Parameter",
          ResourceId: "/tag/res",
          Tags: [
            { Key: "env", Value: "prod" },
            { Key: "team", Value: "core" },
          ],
        }),
      );
      let list = await ssm.send(
        new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: "/tag/res" }),
      );
      expect(list.TagList?.length).toBe(2);

      await ssm.send(
        new RemoveTagsFromResourceCommand({
          ResourceType: "Parameter",
          ResourceId: "/tag/res",
          TagKeys: ["env"],
        }),
      );
      list = await ssm.send(
        new ListTagsForResourceCommand({ ResourceType: "Parameter", ResourceId: "/tag/res" }),
      );
      expect(list.TagList).toEqual([{ Key: "team", Value: "core" }]);
    });

    it("throws InvalidResourceId for an unknown parameter", async () => {
      await expectError(
        ssm.send(
          new AddTagsToResourceCommand({
            ResourceType: "Parameter",
            ResourceId: "/no/such",
            Tags: [{ Key: "a", Value: "b" }],
          }),
        ),
        "InvalidResourceId",
      );
    });
  });

  // =======================================================================
  describe("Resource policies", () => {
    const arn = "arn:aws:ssm:us-east-1:000000000000:parameter/policy/param";
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "ssm:GetParameter", Resource: "*" }],
    });

    it("puts, gets and deletes a resource policy", async () => {
      const put = await ssm.send(new PutResourcePolicyCommand({ ResourceArn: arn, Policy: policy }));
      expect(put.PolicyId).toBeDefined();
      expect(put.PolicyHash).toBeDefined();

      const got = await ssm.send(new GetResourcePoliciesCommand({ ResourceArn: arn }));
      expect(got.Policies?.length).toBe(1);
      expect(got.Policies?.[0].PolicyId).toBe(put.PolicyId);

      await ssm.send(new DeleteResourcePolicyCommand({ ResourceArn: arn, PolicyId: put.PolicyId! }));
      const after = await ssm.send(new GetResourcePoliciesCommand({ ResourceArn: arn }));
      expect(after.Policies?.length ?? 0).toBe(0);
    });

    it("rejects malformed policy JSON", async () => {
      await expectError(
        ssm.send(new PutResourcePolicyCommand({ ResourceArn: arn, Policy: "{not json" })),
        "MalformedResourcePolicyDocumentException",
      );
    });

    it("throws when deleting an unknown policy", async () => {
      await expectError(
        ssm.send(new DeleteResourcePolicyCommand({ ResourceArn: arn, PolicyId: "nope" })),
        "ResourcePolicyNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("Service settings", () => {
    const settingId = "/ssm/parameter-store/high-throughput-enabled";

    it("returns a default setting", async () => {
      const res = await ssm.send(new GetServiceSettingCommand({ SettingId: settingId }));
      expect(res.ServiceSetting?.SettingValue).toBe("false");
      expect(res.ServiceSetting?.Status).toBe("Default");
    });

    it("updates a setting then reads it as Customized", async () => {
      await ssm.send(new UpdateServiceSettingCommand({ SettingId: settingId, SettingValue: "true" }));
      const res = await ssm.send(new GetServiceSettingCommand({ SettingId: settingId }));
      expect(res.ServiceSetting?.SettingValue).toBe("true");
      expect(res.ServiceSetting?.Status).toBe("Customized");
    });

    it("resets a setting back to default", async () => {
      await ssm.send(new UpdateServiceSettingCommand({ SettingId: settingId, SettingValue: "true" }));
      await ssm.send(new ResetServiceSettingCommand({ SettingId: settingId }));
      const res = await ssm.send(new GetServiceSettingCommand({ SettingId: settingId }));
      expect(res.ServiceSetting?.SettingValue).toBe("false");
      expect(res.ServiceSetting?.Status).toBe("Default");
    });
  });

  // =======================================================================
  describe("End-to-end config workflow", () => {
    it("supports a realistic config lifecycle", async () => {
      // Seed a hierarchy.
      await putParam("/prod/api/url", "https://api.example.com");
      await ssm.send(new PutParameterCommand({ Name: "/prod/api/key", Value: "abc123", Type: "SecureString" }));
      await putParam("/prod/db/url", "postgres://db", { Description: "primary db" });

      // Fetch the whole tree.
      const tree = await ssm.send(new GetParametersByPathCommand({ Path: "/prod", Recursive: true }));
      expect(tree.Parameters?.length).toBe(3);

      // Rotate the secret.
      await ssm.send(new PutParameterCommand({ Name: "/prod/api/key", Value: "def456", Type: "SecureString", Overwrite: true }));
      const rotated = await ssm.send(new GetParameterCommand({ Name: "/prod/api/key", WithDecryption: true }));
      expect(rotated.Parameter?.Value).toBe("def456");
      expect(rotated.Parameter?.Version).toBe(2);

      // Pin a label and roll back read.
      await ssm.send(new LabelParameterVersionCommand({ Name: "/prod/api/key", ParameterVersion: 1, Labels: ["last-known-good"] }));
      const lkg = await ssm.send(new GetParameterCommand({ Name: "/prod/api/key:last-known-good", WithDecryption: true }));
      expect(lkg.Parameter?.Value).toBe("abc123");

      // History shows both versions.
      const hist = await ssm.send(new GetParameterHistoryCommand({ Name: "/prod/api/key" }));
      expect(hist.Parameters?.length).toBe(2);
    });
  });
});
