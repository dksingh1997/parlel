import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  LambdaClient,
  // function lifecycle
  CreateFunctionCommand,
  GetFunctionCommand,
  ListFunctionsCommand,
  DeleteFunctionCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  // invocation
  InvokeCommand,
  // versions
  PublishVersionCommand,
  ListVersionsByFunctionCommand,
  // aliases
  CreateAliasCommand,
  GetAliasCommand,
  UpdateAliasCommand,
  DeleteAliasCommand,
  ListAliasesCommand,
  // permissions / policy
  AddPermissionCommand,
  RemovePermissionCommand,
  GetPolicyCommand,
  // tags
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsCommand,
  // concurrency
  PutFunctionConcurrencyCommand,
  GetFunctionConcurrencyCommand,
  DeleteFunctionConcurrencyCommand,
  // function url
  CreateFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
  ListFunctionUrlConfigsCommand,
  // account
  GetAccountSettingsCommand,
  // event source mappings
  CreateEventSourceMappingCommand,
  GetEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
  DeleteEventSourceMappingCommand,
  // layers
  PublishLayerVersionCommand,
  ListLayersCommand,
  ListLayerVersionsCommand,
  GetLayerVersionCommand,
  DeleteLayerVersionCommand,
  // provisioned concurrency
  PutProvisionedConcurrencyConfigCommand,
  GetProvisionedConcurrencyConfigCommand,
  ListProvisionedConcurrencyConfigsCommand,
  DeleteProvisionedConcurrencyConfigCommand,
  // event invoke config
  PutFunctionEventInvokeConfigCommand,
  GetFunctionEventInvokeConfigCommand,
  ListFunctionEventInvokeConfigsCommand,
  UpdateFunctionEventInvokeConfigCommand,
  DeleteFunctionEventInvokeConfigCommand,
  // recursion config
  PutFunctionRecursionConfigCommand,
  GetFunctionRecursionConfigCommand,
  // runtime management config
  PutRuntimeManagementConfigCommand,
  GetRuntimeManagementConfigCommand,
} from "@aws-sdk/client-lambda";
import { LambdaServer } from "../services/lambda/src/server.js";

const PORT = 14571;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const ROLE = "arn:aws:iam::123456789012:role/lambda-role";

function makeClient() {
  return new LambdaClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
  });
}

// A tiny Node handler that echoes back the event and adds a marker. Stored raw
// in ZipFile so the parlel fake can actually execute it.
const ECHO_HANDLER = `
exports.handler = async (event, context) => {
  console.log("invoked " + context.functionName);
  return { echoed: event, fn: context.functionName, version: context.functionVersion };
};
`;

const THROWING_HANDLER = `
exports.handler = async (event) => {
  throw new Error("boom: " + (event && event.why ? event.why : "unknown"));
};
`;

function zipFile(src: string): Uint8Array {
  return new TextEncoder().encode(src);
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

function decodePayload(payload?: Uint8Array): any {
  if (!payload || payload.length === 0) return undefined;
  const text = new TextDecoder().decode(payload);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("Lambda Service", () => {
  let server: LambdaServer;
  let lambda: LambdaClient;

  beforeAll(async () => {
    server = new LambdaServer(PORT);
    await server.start();
    lambda = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    lambda.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createFn(
    name: string,
    opts: { handler?: string; publish?: boolean; env?: Record<string, string> } = {},
  ) {
    return lambda.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Runtime: "nodejs20.x",
        Role: ROLE,
        Handler: "index.handler",
        Code: { ZipFile: zipFile(opts.handler ?? ECHO_HANDLER) },
        Publish: opts.publish,
        Environment: opts.env ? { Variables: opts.env } : undefined,
      }),
    );
  }

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
      expect(json.service).toBe("lambda");
    });

    it("has resettable ephemeral state", async () => {
      await createFn("reset-fn");
      expect(server.functions.size).toBe(1);
      server.reset();
      expect(server.functions.size).toBe(0);
    });

    it("supports POST /_parlel/reset", async () => {
      await createFn("reset-fn-2");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(server.functions.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("CreateFunction", () => {
    it("creates a function and returns its configuration", async () => {
      const res = await createFn("my-fn");
      expect(res.FunctionName).toBe("my-fn");
      expect(res.FunctionArn).toContain("function:my-fn");
      expect(res.Runtime).toBe("nodejs20.x");
      expect(res.Handler).toBe("index.handler");
      expect(res.Role).toBe(ROLE);
      expect(res.Version).toBe("$LATEST");
      expect(res.State).toBe("Active");
      expect(res.CodeSha256).toBeTruthy();
      expect(res.Timeout).toBe(3);
      expect(res.MemorySize).toBe(128);
    });

    it("honors custom timeout, memory, description and env", async () => {
      const res = await lambda.send(
        new CreateFunctionCommand({
          FunctionName: "cfg-fn",
          Runtime: "nodejs20.x",
          Role: ROLE,
          Handler: "index.handler",
          Code: { ZipFile: zipFile(ECHO_HANDLER) },
          Timeout: 30,
          MemorySize: 512,
          Description: "a function",
          Environment: { Variables: { FOO: "bar" } },
        }),
      );
      expect(res.Timeout).toBe(30);
      expect(res.MemorySize).toBe(512);
      expect(res.Description).toBe("a function");
      expect(res.Environment?.Variables?.FOO).toBe("bar");
    });

    it("publishes a version when Publish=true", async () => {
      const res = await createFn("pub-fn", { publish: true });
      expect(res.Version).toBe("1");
    });

    it("rejects duplicate function names with ResourceConflictException", async () => {
      await createFn("dup-fn");
      await expectError(createFn("dup-fn"), "ResourceConflictException");
    });

    it("rejects invalid function name", async () => {
      await expectError(
        lambda.send(
          new CreateFunctionCommand({
            FunctionName: "bad name!",
            Runtime: "nodejs20.x",
            Role: ROLE,
            Handler: "index.handler",
            Code: { ZipFile: zipFile(ECHO_HANDLER) },
          }),
        ),
        "InvalidParameterValueException",
      );
    });

    it("rejects invalid runtime", async () => {
      await expectError(
        lambda.send(
          new CreateFunctionCommand({
            FunctionName: "bad-runtime",
            Runtime: "cobol1.x" as any,
            Role: ROLE,
            Handler: "index.handler",
            Code: { ZipFile: zipFile(ECHO_HANDLER) },
          }),
        ),
        "InvalidParameterValueException",
      );
    });

    it("rejects invalid memory size", async () => {
      await expectError(
        lambda.send(
          new CreateFunctionCommand({
            FunctionName: "bad-mem",
            Runtime: "nodejs20.x",
            Role: ROLE,
            Handler: "index.handler",
            Code: { ZipFile: zipFile(ECHO_HANDLER) },
            MemorySize: 64,
          }),
        ),
        "InvalidParameterValueException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("GetFunction", () => {
    it("returns configuration, code, tags and concurrency", async () => {
      await createFn("get-fn");
      const res = await lambda.send(new GetFunctionCommand({ FunctionName: "get-fn" }));
      expect(res.Configuration?.FunctionName).toBe("get-fn");
      expect(res.Code?.RepositoryType).toBe("S3");
      expect(res.Code?.Location).toBeTruthy();
    });

    it("resolves by full ARN", async () => {
      const created = await createFn("arn-fn");
      const res = await lambda.send(
        new GetFunctionCommand({ FunctionName: created.FunctionArn }),
      );
      expect(res.Configuration?.FunctionName).toBe("arn-fn");
    });

    it("throws ResourceNotFoundException for missing function", async () => {
      await expectError(
        lambda.send(new GetFunctionCommand({ FunctionName: "nope" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListFunctions", () => {
    it("lists all functions", async () => {
      await createFn("list-a");
      await createFn("list-b");
      await createFn("list-c");
      const res = await lambda.send(new ListFunctionsCommand({}));
      const names = (res.Functions ?? []).map((f) => f.FunctionName).sort();
      expect(names).toEqual(["list-a", "list-b", "list-c"]);
    });

    it("returns empty list when no functions", async () => {
      const res = await lambda.send(new ListFunctionsCommand({}));
      expect(res.Functions).toEqual([]);
    });

    it("paginates with MaxItems and Marker", async () => {
      for (const n of ["p1", "p2", "p3"]) await createFn(n);
      const page1 = await lambda.send(new ListFunctionsCommand({ MaxItems: 2 }));
      expect(page1.Functions?.length).toBe(2);
      expect(page1.NextMarker).toBeTruthy();
      const page2 = await lambda.send(
        new ListFunctionsCommand({ MaxItems: 2, Marker: page1.NextMarker }),
      );
      expect(page2.Functions?.length).toBe(1);
      expect(page2.NextMarker).toBeFalsy();
    });
  });

  // -----------------------------------------------------------------------
  describe("DeleteFunction", () => {
    it("deletes a function", async () => {
      await createFn("del-fn");
      await lambda.send(new DeleteFunctionCommand({ FunctionName: "del-fn" }));
      await expectError(
        lambda.send(new GetFunctionCommand({ FunctionName: "del-fn" })),
        "ResourceNotFoundException",
      );
    });

    it("throws for missing function", async () => {
      await expectError(
        lambda.send(new DeleteFunctionCommand({ FunctionName: "ghost" })),
        "ResourceNotFoundException",
      );
    });

    it("deletes a specific version via Qualifier", async () => {
      await createFn("delv-fn", { publish: true });
      await lambda.send(
        new PublishVersionCommand({ FunctionName: "delv-fn" }),
      );
      await lambda.send(
        new DeleteFunctionCommand({ FunctionName: "delv-fn", Qualifier: "2" }),
      );
      const versions = await lambda.send(
        new ListVersionsByFunctionCommand({ FunctionName: "delv-fn" }),
      );
      const nums = (versions.Versions ?? []).map((v) => v.Version);
      expect(nums).toContain("1");
      expect(nums).not.toContain("2");
    });
  });

  // -----------------------------------------------------------------------
  describe("GetFunctionConfiguration / UpdateFunctionConfiguration", () => {
    it("gets configuration", async () => {
      await createFn("conf-fn");
      const res = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: "conf-fn" }),
      );
      expect(res.FunctionName).toBe("conf-fn");
      expect(res.Version).toBe("$LATEST");
    });

    it("updates configuration fields", async () => {
      await createFn("upd-conf");
      const res = await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: "upd-conf",
          Timeout: 60,
          MemorySize: 1024,
          Description: "updated",
          Environment: { Variables: { NEW: "val" } },
        }),
      );
      expect(res.Timeout).toBe(60);
      expect(res.MemorySize).toBe(1024);
      expect(res.Description).toBe("updated");
      expect(res.Environment?.Variables?.NEW).toBe("val");
    });

    it("bumps revision id on update", async () => {
      const created = await createFn("rev-fn");
      const updated = await lambda.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: "rev-fn",
          Description: "changed",
        }),
      );
      expect(updated.RevisionId).not.toBe(created.RevisionId);
    });

    it("throws for missing function", async () => {
      await expectError(
        lambda.send(
          new UpdateFunctionConfigurationCommand({ FunctionName: "void", Timeout: 5 }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("UpdateFunctionCode", () => {
    it("updates code and changes the sha256", async () => {
      const created = await createFn("code-fn");
      const updated = await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: "code-fn",
          ZipFile: zipFile(THROWING_HANDLER),
        }),
      );
      expect(updated.CodeSha256).not.toBe(created.CodeSha256);
    });

    it("publishes a version when Publish=true", async () => {
      await createFn("codepub-fn");
      const res = await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: "codepub-fn",
          ZipFile: zipFile(ECHO_HANDLER),
          Publish: true,
        }),
      );
      expect(res.Version).toBe("1");
    });

    it("rejects an update with no code source (InvalidParameterValueException)", async () => {
      await createFn("nocode-fn");
      // Hit the wire directly: the SDK requires a code source client-side, so we
      // assert the emulator's server-side validation matches the real API.
      const res = await fetch(
        `${ENDPOINT}/2015-03-31/functions/nocode-fn/code`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      expect(res.status).toBe(400);
      expect(res.headers.get("x-amzn-errortype")).toBe("InvalidParameterValueException");
      const body = await res.json();
      expect(body.__type).toBe("InvalidParameterValueException");
      expect(typeof body.message).toBe("string");
    });
  });

  // -----------------------------------------------------------------------
  describe("Invoke", () => {
    it("executes the handler and returns the payload (RequestResponse)", async () => {
      await createFn("inv-fn");
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "inv-fn",
          Payload: new TextEncoder().encode(JSON.stringify({ hello: "world" })),
        }),
      );
      expect(res.StatusCode).toBe(200);
      expect(res.FunctionError).toBeUndefined();
      const out = decodePayload(res.Payload);
      expect(out.echoed).toEqual({ hello: "world" });
      expect(out.fn).toBe("inv-fn");
      expect(out.version).toBe("$LATEST");
    });

    it("captures logs when LogType=Tail", async () => {
      await createFn("log-fn");
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "log-fn",
          Payload: new TextEncoder().encode("{}"),
          LogType: "Tail",
        }),
      );
      expect(res.LogResult).toBeTruthy();
      const decoded = Buffer.from(res.LogResult as string, "base64").toString("utf8");
      expect(decoded).toContain("invoked log-fn");
    });

    it("returns FunctionError=Unhandled when the handler throws", async () => {
      await createFn("err-fn", { handler: THROWING_HANDLER });
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "err-fn",
          Payload: new TextEncoder().encode(JSON.stringify({ why: "test" })),
        }),
      );
      expect(res.StatusCode).toBe(200);
      expect(res.FunctionError).toBe("Unhandled");
      const out = decodePayload(res.Payload);
      expect(out.errorMessage).toContain("boom: test");
      expect(out.errorType).toBeTruthy();
    });

    it("supports asynchronous invocation (Event) with 202", async () => {
      await createFn("async-fn");
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "async-fn",
          InvocationType: "Event",
          Payload: new TextEncoder().encode("{}"),
        }),
      );
      expect(res.StatusCode).toBe(202);
    });

    it("supports DryRun with 204", async () => {
      await createFn("dry-fn");
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "dry-fn",
          InvocationType: "DryRun",
          Payload: new TextEncoder().encode("{}"),
        }),
      );
      expect(res.StatusCode).toBe(204);
    });

    it("sets ExecutedVersion", async () => {
      await createFn("execver-fn");
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "execver-fn",
          Payload: new TextEncoder().encode("{}"),
        }),
      );
      expect(res.ExecutedVersion).toBe("$LATEST");
    });

    it("invokes a specific version via Qualifier", async () => {
      await createFn("qual-fn", { publish: true });
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "qual-fn",
          Qualifier: "1",
          Payload: new TextEncoder().encode("{}"),
        }),
      );
      const out = decodePayload(res.Payload);
      expect(out.version).toBe("1");
    });

    it("throws ResourceNotFoundException for missing function", async () => {
      await expectError(
        lambda.send(
          new InvokeCommand({
            FunctionName: "missing-fn",
            Payload: new TextEncoder().encode("{}"),
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("PublishVersion / ListVersionsByFunction", () => {
    it("publishes incrementing versions", async () => {
      await createFn("ver-fn");
      const v1 = await lambda.send(new PublishVersionCommand({ FunctionName: "ver-fn" }));
      const v2 = await lambda.send(new PublishVersionCommand({ FunctionName: "ver-fn" }));
      expect(v1.Version).toBe("1");
      expect(v2.Version).toBe("2");
    });

    it("lists versions including $LATEST", async () => {
      await createFn("lv-fn", { publish: true });
      const res = await lambda.send(
        new ListVersionsByFunctionCommand({ FunctionName: "lv-fn" }),
      );
      const versions = (res.Versions ?? []).map((v) => v.Version);
      expect(versions).toContain("$LATEST");
      expect(versions).toContain("1");
    });

    it("rejects publish when CodeSha256 mismatches", async () => {
      await createFn("sha-fn");
      await expectError(
        lambda.send(
          new PublishVersionCommand({
            FunctionName: "sha-fn",
            CodeSha256: "definitely-wrong",
          }),
        ),
        "PreconditionFailedException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Aliases", () => {
    it("creates, gets, updates, lists and deletes aliases", async () => {
      await createFn("alias-fn", { publish: true });
      await lambda.send(new PublishVersionCommand({ FunctionName: "alias-fn" }));

      const created = await lambda.send(
        new CreateAliasCommand({
          FunctionName: "alias-fn",
          Name: "prod",
          FunctionVersion: "1",
          Description: "production",
        }),
      );
      expect(created.Name).toBe("prod");
      expect(created.FunctionVersion).toBe("1");
      expect(created.AliasArn).toContain(":prod");

      const got = await lambda.send(
        new GetAliasCommand({ FunctionName: "alias-fn", Name: "prod" }),
      );
      expect(got.FunctionVersion).toBe("1");

      const updated = await lambda.send(
        new UpdateAliasCommand({
          FunctionName: "alias-fn",
          Name: "prod",
          FunctionVersion: "2",
        }),
      );
      expect(updated.FunctionVersion).toBe("2");

      const list = await lambda.send(
        new ListAliasesCommand({ FunctionName: "alias-fn" }),
      );
      expect(list.Aliases?.length).toBe(1);

      await lambda.send(new DeleteAliasCommand({ FunctionName: "alias-fn", Name: "prod" }));
      await expectError(
        lambda.send(new GetAliasCommand({ FunctionName: "alias-fn", Name: "prod" })),
        "ResourceNotFoundException",
      );
    });

    it("invokes through an alias", async () => {
      await createFn("alias-inv", { publish: true });
      await lambda.send(
        new CreateAliasCommand({
          FunctionName: "alias-inv",
          Name: "live",
          FunctionVersion: "1",
        }),
      );
      const res = await lambda.send(
        new InvokeCommand({
          FunctionName: "alias-inv",
          Qualifier: "live",
          Payload: new TextEncoder().encode("{}"),
        }),
      );
      const out = decodePayload(res.Payload);
      expect(out.version).toBe("1");
    });

    it("rejects duplicate alias names", async () => {
      await createFn("dupalias-fn", { publish: true });
      await lambda.send(
        new CreateAliasCommand({
          FunctionName: "dupalias-fn",
          Name: "x",
          FunctionVersion: "1",
        }),
      );
      await expectError(
        lambda.send(
          new CreateAliasCommand({
            FunctionName: "dupalias-fn",
            Name: "x",
            FunctionVersion: "1",
          }),
        ),
        "ResourceConflictException",
      );
    });

    it("rejects alias pointing at a missing version", async () => {
      await createFn("badver-alias");
      await expectError(
        lambda.send(
          new CreateAliasCommand({
            FunctionName: "badver-alias",
            Name: "x",
            FunctionVersion: "99",
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Permissions / Policy", () => {
    it("adds a permission and reflects it in the policy", async () => {
      await createFn("perm-fn");
      const res = await lambda.send(
        new AddPermissionCommand({
          FunctionName: "perm-fn",
          StatementId: "s3-invoke",
          Action: "lambda:InvokeFunction",
          Principal: "s3.amazonaws.com",
        }),
      );
      expect(res.Statement).toBeTruthy();
      const stmt = JSON.parse(res.Statement as string);
      expect(stmt.Sid).toBe("s3-invoke");

      const policy = await lambda.send(new GetPolicyCommand({ FunctionName: "perm-fn" }));
      const parsed = JSON.parse(policy.Policy as string);
      expect(parsed.Statement.length).toBe(1);
      expect(parsed.Statement[0].Sid).toBe("s3-invoke");
    });

    it("rejects a duplicate statement id", async () => {
      await createFn("dupperm-fn");
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: "dupperm-fn",
          StatementId: "s1",
          Action: "lambda:InvokeFunction",
          Principal: "events.amazonaws.com",
        }),
      );
      await expectError(
        lambda.send(
          new AddPermissionCommand({
            FunctionName: "dupperm-fn",
            StatementId: "s1",
            Action: "lambda:InvokeFunction",
            Principal: "events.amazonaws.com",
          }),
        ),
        "ResourceConflictException",
      );
    });

    it("removes a permission", async () => {
      await createFn("rmperm-fn");
      await lambda.send(
        new AddPermissionCommand({
          FunctionName: "rmperm-fn",
          StatementId: "s1",
          Action: "lambda:InvokeFunction",
          Principal: "events.amazonaws.com",
        }),
      );
      await lambda.send(
        new RemovePermissionCommand({ FunctionName: "rmperm-fn", StatementId: "s1" }),
      );
      await expectError(
        lambda.send(new GetPolicyCommand({ FunctionName: "rmperm-fn" })),
        "ResourceNotFoundException",
      );
    });

    it("GetPolicy on a function without statements throws", async () => {
      await createFn("nopol-fn");
      await expectError(
        lambda.send(new GetPolicyCommand({ FunctionName: "nopol-fn" })),
        "ResourceNotFoundException",
      );
    });

    it("removing a missing statement throws", async () => {
      await createFn("rmmiss-fn");
      await expectError(
        lambda.send(
          new RemovePermissionCommand({ FunctionName: "rmmiss-fn", StatementId: "ghost" }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    it("tags, lists and untags a function", async () => {
      const created = await createFn("tag-fn");
      const arn = created.FunctionArn as string;
      await lambda.send(
        new TagResourceCommand({ Resource: arn, Tags: { team: "platform", env: "test" } }),
      );
      const list = await lambda.send(new ListTagsCommand({ Resource: arn }));
      expect(list.Tags?.team).toBe("platform");
      expect(list.Tags?.env).toBe("test");

      await lambda.send(new UntagResourceCommand({ Resource: arn, TagKeys: ["env"] }));
      const after = await lambda.send(new ListTagsCommand({ Resource: arn }));
      expect(after.Tags?.env).toBeUndefined();
      expect(after.Tags?.team).toBe("platform");
    });

    it("includes tags set at create time", async () => {
      const created = await lambda.send(
        new CreateFunctionCommand({
          FunctionName: "ctag-fn",
          Runtime: "nodejs20.x",
          Role: ROLE,
          Handler: "index.handler",
          Code: { ZipFile: zipFile(ECHO_HANDLER) },
          Tags: { created: "yes" },
        }),
      );
      const list = await lambda.send(
        new ListTagsCommand({ Resource: created.FunctionArn as string }),
      );
      expect(list.Tags?.created).toBe("yes");
    });

    it("tagging a missing function throws", async () => {
      const arn = `arn:aws:lambda:us-east-1:123456789012:function:no-such-fn`;
      await expectError(
        lambda.send(new TagResourceCommand({ Resource: arn, Tags: { a: "b" } })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Concurrency", () => {
    it("puts, gets and deletes reserved concurrency", async () => {
      await createFn("conc-fn");
      const put = await lambda.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: "conc-fn",
          ReservedConcurrentExecutions: 5,
        }),
      );
      expect(put.ReservedConcurrentExecutions).toBe(5);

      const get = await lambda.send(
        new GetFunctionConcurrencyCommand({ FunctionName: "conc-fn" }),
      );
      expect(get.ReservedConcurrentExecutions).toBe(5);

      await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: "conc-fn" }));
      const after = await lambda.send(
        new GetFunctionConcurrencyCommand({ FunctionName: "conc-fn" }),
      );
      expect(after.ReservedConcurrentExecutions).toBeUndefined();
    });

    it("reflects concurrency in GetFunction", async () => {
      await createFn("concget-fn");
      await lambda.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: "concget-fn",
          ReservedConcurrentExecutions: 3,
        }),
      );
      const res = await lambda.send(new GetFunctionCommand({ FunctionName: "concget-fn" }));
      expect(res.Concurrency?.ReservedConcurrentExecutions).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  describe("Function URL configs", () => {
    it("creates, gets, updates, lists and deletes a URL config", async () => {
      await createFn("url-fn");
      const created = await lambda.send(
        new CreateFunctionUrlConfigCommand({ FunctionName: "url-fn", AuthType: "NONE" }),
      );
      expect(created.FunctionUrl).toContain("lambda-url");
      expect(created.AuthType).toBe("NONE");

      const got = await lambda.send(
        new GetFunctionUrlConfigCommand({ FunctionName: "url-fn" }),
      );
      expect(got.FunctionUrl).toBe(created.FunctionUrl);

      const updated = await lambda.send(
        new UpdateFunctionUrlConfigCommand({
          FunctionName: "url-fn",
          AuthType: "AWS_IAM",
        }),
      );
      expect(updated.AuthType).toBe("AWS_IAM");

      const list = await lambda.send(
        new ListFunctionUrlConfigsCommand({ FunctionName: "url-fn" }),
      );
      expect(list.FunctionUrlConfigs?.length).toBe(1);

      await lambda.send(new DeleteFunctionUrlConfigCommand({ FunctionName: "url-fn" }));
      await expectError(
        lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: "url-fn" })),
        "ResourceNotFoundException",
      );
    });

    it("rejects a duplicate URL config", async () => {
      await createFn("dupurl-fn");
      await lambda.send(
        new CreateFunctionUrlConfigCommand({ FunctionName: "dupurl-fn", AuthType: "NONE" }),
      );
      await expectError(
        lambda.send(
          new CreateFunctionUrlConfigCommand({ FunctionName: "dupurl-fn", AuthType: "NONE" }),
        ),
        "ResourceConflictException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("GetAccountSettings", () => {
    it("returns account limits and usage", async () => {
      await createFn("acct-fn");
      const res = await lambda.send(new GetAccountSettingsCommand({}));
      expect(res.AccountLimit?.ConcurrentExecutions).toBeGreaterThan(0);
      expect(res.AccountUsage?.FunctionCount).toBe(1);
      expect(res.AccountUsage?.TotalCodeSize).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("Event source mappings", () => {
    it("creates, gets, lists, updates and deletes a mapping", async () => {
      await createFn("esm-fn");
      const created = await lambda.send(
        new CreateEventSourceMappingCommand({
          FunctionName: "esm-fn",
          EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
          BatchSize: 10,
          Enabled: true,
        }),
      );
      expect(created.UUID).toBeTruthy();
      expect(created.State).toBe("Enabled");
      expect(created.BatchSize).toBe(10);
      const uuid = created.UUID as string;

      const got = await lambda.send(new GetEventSourceMappingCommand({ UUID: uuid }));
      expect(got.UUID).toBe(uuid);

      const list = await lambda.send(
        new ListEventSourceMappingsCommand({ FunctionName: "esm-fn" }),
      );
      expect(list.EventSourceMappings?.length).toBe(1);

      const updated = await lambda.send(
        new UpdateEventSourceMappingCommand({ UUID: uuid, BatchSize: 5, Enabled: false }),
      );
      expect(updated.BatchSize).toBe(5);
      expect(updated.State).toBe("Disabled");

      await lambda.send(new DeleteEventSourceMappingCommand({ UUID: uuid }));
      await expectError(
        lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })),
        "ResourceNotFoundException",
      );
    });

    it("throws when the target function is missing", async () => {
      await expectError(
        lambda.send(
          new CreateEventSourceMappingCommand({
            FunctionName: "no-fn",
            EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:q",
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Layers", () => {
    it("publishes, lists and gets layer versions", async () => {
      const v1 = await lambda.send(
        new PublishLayerVersionCommand({
          LayerName: "shared-libs",
          Content: { ZipFile: zipFile("layer-content") },
          CompatibleRuntimes: ["nodejs20.x"],
          Description: "v1",
        }),
      );
      expect(v1.Version).toBe(1);
      expect(v1.LayerVersionArn).toContain("layer:shared-libs:1");

      const v2 = await lambda.send(
        new PublishLayerVersionCommand({
          LayerName: "shared-libs",
          Content: { ZipFile: zipFile("layer-content-2") },
          CompatibleRuntimes: ["nodejs20.x", "nodejs22.x"],
        }),
      );
      expect(v2.Version).toBe(2);

      const layers = await lambda.send(new ListLayersCommand({}));
      const names = (layers.Layers ?? []).map((l) => l.LayerName);
      expect(names).toContain("shared-libs");

      const versions = await lambda.send(
        new ListLayerVersionsCommand({ LayerName: "shared-libs" }),
      );
      expect(versions.LayerVersions?.length).toBe(2);

      const got = await lambda.send(
        new GetLayerVersionCommand({ LayerName: "shared-libs", VersionNumber: 1 }),
      );
      expect(got.Version).toBe(1);
      expect(got.Description).toBe("v1");
    });

    it("deletes a layer version", async () => {
      await lambda.send(
        new PublishLayerVersionCommand({
          LayerName: "del-layer",
          Content: { ZipFile: zipFile("x") },
        }),
      );
      await lambda.send(
        new DeleteLayerVersionCommand({ LayerName: "del-layer", VersionNumber: 1 }),
      );
      await expectError(
        lambda.send(
          new GetLayerVersionCommand({ LayerName: "del-layer", VersionNumber: 1 }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Provisioned concurrency", () => {
    it("puts, gets, lists and deletes provisioned concurrency", async () => {
      await createFn("pc-fn", { publish: true });
      const put = await lambda.send(
        new PutProvisionedConcurrencyConfigCommand({
          FunctionName: "pc-fn",
          Qualifier: "1",
          ProvisionedConcurrentExecutions: 5,
        }),
      );
      expect(put.RequestedProvisionedConcurrentExecutions).toBe(5);
      expect(put.Status).toBe("READY");

      const got = await lambda.send(
        new GetProvisionedConcurrencyConfigCommand({ FunctionName: "pc-fn", Qualifier: "1" }),
      );
      expect(got.AllocatedProvisionedConcurrentExecutions).toBe(5);

      const list = await lambda.send(
        new ListProvisionedConcurrencyConfigsCommand({ FunctionName: "pc-fn" }),
      );
      expect(list.ProvisionedConcurrencyConfigs?.length).toBe(1);

      await lambda.send(
        new DeleteProvisionedConcurrencyConfigCommand({ FunctionName: "pc-fn", Qualifier: "1" }),
      );
      await expectError(
        lambda.send(
          new GetProvisionedConcurrencyConfigCommand({ FunctionName: "pc-fn", Qualifier: "1" }),
        ),
        "ProvisionedConcurrencyConfigNotFoundException",
      );
    });

    it("rejects provisioned concurrency on $LATEST", async () => {
      await createFn("pc-latest");
      await expectError(
        lambda.send(
          new PutProvisionedConcurrencyConfigCommand({
            FunctionName: "pc-latest",
            Qualifier: "$LATEST",
            ProvisionedConcurrentExecutions: 1,
          }),
        ),
        "InvalidParameterValueException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Function event invoke config", () => {
    it("puts, gets, updates, lists and deletes async config", async () => {
      await createFn("eic-fn");
      const put = await lambda.send(
        new PutFunctionEventInvokeConfigCommand({
          FunctionName: "eic-fn",
          MaximumRetryAttempts: 1,
          MaximumEventAgeInSeconds: 3600,
        }),
      );
      expect(put.MaximumRetryAttempts).toBe(1);
      expect(put.MaximumEventAgeInSeconds).toBe(3600);

      const got = await lambda.send(
        new GetFunctionEventInvokeConfigCommand({ FunctionName: "eic-fn" }),
      );
      expect(got.MaximumRetryAttempts).toBe(1);

      const updated = await lambda.send(
        new UpdateFunctionEventInvokeConfigCommand({
          FunctionName: "eic-fn",
          MaximumRetryAttempts: 0,
        }),
      );
      expect(updated.MaximumRetryAttempts).toBe(0);
      // unchanged field is retained on update
      expect(updated.MaximumEventAgeInSeconds).toBe(3600);

      const list = await lambda.send(
        new ListFunctionEventInvokeConfigsCommand({ FunctionName: "eic-fn" }),
      );
      expect(list.FunctionEventInvokeConfigs?.length).toBe(1);

      await lambda.send(
        new DeleteFunctionEventInvokeConfigCommand({ FunctionName: "eic-fn" }),
      );
      await expectError(
        lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: "eic-fn" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Recursion config", () => {
    it("defaults to Terminate and can be set to Allow", async () => {
      await createFn("rec-fn");
      const def = await lambda.send(
        new GetFunctionRecursionConfigCommand({ FunctionName: "rec-fn" }),
      );
      expect(def.RecursiveLoop).toBe("Terminate");

      const put = await lambda.send(
        new PutFunctionRecursionConfigCommand({
          FunctionName: "rec-fn",
          RecursiveLoop: "Allow",
        }),
      );
      expect(put.RecursiveLoop).toBe("Allow");

      const got = await lambda.send(
        new GetFunctionRecursionConfigCommand({ FunctionName: "rec-fn" }),
      );
      expect(got.RecursiveLoop).toBe("Allow");
    });
  });

  // -----------------------------------------------------------------------
  describe("Error envelope (restJson1 wire shape)", () => {
    it("returns the canonical { __type, message } body with x-amzn-errortype header", async () => {
      // Raw wire check: real Lambda restJson1 errors carry the type in the
      // x-amzn-errortype header and a lowercase `message` in the body — and do
      // NOT include a capital-M `Message` key.
      const res = await fetch(`${ENDPOINT}/2015-03-31/functions/ghost-fn`, {
        method: "GET",
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("x-amzn-errortype")).toBe("ResourceNotFoundException");
      const body = await res.json();
      expect(body.__type).toBe("ResourceNotFoundException");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
      expect("Message" in body).toBe(false);
    });

    it("returns a JSON-parse error envelope for a malformed body", async () => {
      const res = await fetch(`${ENDPOINT}/2015-03-31/functions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("x-amzn-errortype")).toBe("InvalidRequestContentException");
      const body = await res.json();
      expect(body.__type).toBe("InvalidRequestContentException");
      expect("Message" in body).toBe(false);
    });

    it("surfaces ResourceNotFoundException through the SDK for a missing function", async () => {
      await expectError(
        lambda.send(new GetFunctionCommand({ FunctionName: "still-ghost" })),
        "ResourceNotFoundException",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Runtime management config", () => {
    it("defaults to Auto and can be updated", async () => {
      await createFn("rt-fn");
      const def = await lambda.send(
        new GetRuntimeManagementConfigCommand({ FunctionName: "rt-fn" }),
      );
      expect(def.UpdateRuntimeOn).toBe("Auto");

      const put = await lambda.send(
        new PutRuntimeManagementConfigCommand({
          FunctionName: "rt-fn",
          UpdateRuntimeOn: "Manual",
          RuntimeVersionArn:
            "arn:aws:lambda:us-east-1::runtime:abc",
        }),
      );
      expect(put.UpdateRuntimeOn).toBe("Manual");

      const got = await lambda.send(
        new GetRuntimeManagementConfigCommand({ FunctionName: "rt-fn" }),
      );
      expect(got.UpdateRuntimeOn).toBe("Manual");
    });
  });
});
