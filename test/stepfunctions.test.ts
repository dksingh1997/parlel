import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SFNClient,
  // state machines
  CreateStateMachineCommand,
  UpdateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  ValidateStateMachineDefinitionCommand,
  // versions
  PublishStateMachineVersionCommand,
  ListStateMachineVersionsCommand,
  DeleteStateMachineVersionCommand,
  // aliases
  CreateStateMachineAliasCommand,
  UpdateStateMachineAliasCommand,
  DescribeStateMachineAliasCommand,
  ListStateMachineAliasesCommand,
  DeleteStateMachineAliasCommand,
  // executions
  StartExecutionCommand,
  StartSyncExecutionCommand,
  StopExecutionCommand,
  DescribeExecutionCommand,
  ListExecutionsCommand,
  GetExecutionHistoryCommand,
  DescribeStateMachineForExecutionCommand,
  RedriveExecutionCommand,
  // activities
  CreateActivityCommand,
  DeleteActivityCommand,
  DescribeActivityCommand,
  ListActivitiesCommand,
  GetActivityTaskCommand,
  // task tokens
  SendTaskSuccessCommand,
  SendTaskFailureCommand,
  SendTaskHeartbeatCommand,
  // map runs
  DescribeMapRunCommand,
  ListMapRunsCommand,
  UpdateMapRunCommand,
  // test state
  TestStateCommand,
  // tags
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-sfn";
import { StepfunctionsServer } from "../services/stepfunctions/src/server.js";

const PORT = 14577;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const ROLE = "arn:aws:iam::123456789012:role/parlel";

function makeClient() {
  return new SFNClient({
    region: "us-east-1",
    endpoint: ENDPOINT,
    credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
    maxAttempts: 1,
    // StartSyncExecution / TestState use a `sync-` host prefix on real AWS;
    // disable it so they hit this single listener.
    disableHostPrefix: true,
  });
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected error ${code} but call succeeded`);
  } catch (err: any) {
    const name = err?.name || err?.Code || err?.code || "";
    const combined = `${name} ${err?.message || ""} ${err?.__type || ""}`;
    expect(combined).toContain(code);
    return err;
  }
}

// A small ASL: a Pass state that injects a result, then succeeds.
const PASS_DEF = JSON.stringify({
  Comment: "pass",
  StartAt: "Hello",
  States: {
    Hello: { Type: "Pass", Result: { greeting: "hello" }, ResultPath: "$.added", Next: "Done" },
    Done: { Type: "Succeed" },
  },
});

// Task identity flow.
const TASK_DEF = JSON.stringify({
  StartAt: "DoWork",
  States: {
    DoWork: { Type: "Task", Resource: "arn:aws:lambda:us-east-1:123456789012:function:work", End: true },
  },
});

const CHOICE_DEF = JSON.stringify({
  StartAt: "Check",
  States: {
    Check: {
      Type: "Choice",
      Choices: [{ Variable: "$.n", NumericGreaterThan: 5, Next: "Big" }],
      Default: "Small",
    },
    Big: { Type: "Pass", Result: "big", End: true },
    Small: { Type: "Pass", Result: "small", End: true },
  },
});

const WAIT_DEF = JSON.stringify({
  StartAt: "Wait",
  States: { Wait: { Type: "Wait", Seconds: 1, Next: "End" }, End: { Type: "Succeed" } },
});

const FAIL_DEF = JSON.stringify({
  StartAt: "Boom",
  States: { Boom: { Type: "Fail", Error: "MyError", Cause: "It broke" } },
});

const PARALLEL_DEF = JSON.stringify({
  StartAt: "Fork",
  States: {
    Fork: {
      Type: "Parallel",
      Branches: [
        { StartAt: "A", States: { A: { Type: "Pass", Result: 1, End: true } } },
        { StartAt: "B", States: { B: { Type: "Pass", Result: 2, End: true } } },
      ],
      End: true,
    },
  },
});

const MAP_DEF = JSON.stringify({
  StartAt: "Mapper",
  States: {
    Mapper: {
      Type: "Map",
      ItemsPath: "$.items",
      ItemProcessor: {
        ProcessorConfig: { Mode: "INLINE" },
        StartAt: "Double",
        States: { Double: { Type: "Pass", Parameters: { "v.$": "$.v" }, End: true } },
      },
      End: true,
    },
  },
});

const RETRY_CATCH_DEF = JSON.stringify({
  StartAt: "Try",
  States: {
    Try: {
      Type: "Task",
      Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken",
      Catch: [{ ErrorEquals: ["States.ALL"], Next: "Recover", ResultPath: "$.error" }],
      End: true,
    },
    Recover: { Type: "Pass", Result: "recovered", End: true },
  },
});

const EXPRESS_DEF = JSON.stringify({
  StartAt: "Echo",
  States: { Echo: { Type: "Pass", End: true } },
});

describe("Step Functions Service", () => {
  let server: StepfunctionsServer;
  let sfn: SFNClient;

  beforeAll(async () => {
    server = new StepfunctionsServer(PORT);
    await server.start();
    sfn = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    sfn.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function createSM(name: string, definition = PASS_DEF, extra: any = {}) {
    const res = await sfn.send(
      new CreateStateMachineCommand({ name, definition, roleArn: ROLE, ...extra }),
    );
    return res.stateMachineArn!;
  }

  async function waitForExecution(arn: string, tries = 50): Promise<any> {
    for (let i = 0; i < tries; i++) {
      const res = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
      if (res.status !== "RUNNING") return res;
      await new Promise((r) => setTimeout(r, 20));
    }
    return sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
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
      expect(body.service).toBe("stepfunctions");
    });

    it("supports an internal reset endpoint", async () => {
      await createSM("reset-me");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const list = await sfn.send(new ListStateMachinesCommand({}));
      expect(list.stateMachines!.map((s) => s.name)).not.toContain("reset-me");
    });
  });

  // -----------------------------------------------------------------------
  describe("State machine lifecycle", () => {
    it("creates and describes a state machine", async () => {
      const arn = await createSM("sm1");
      expect(arn).toContain("stateMachine:sm1");
      const desc = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
      expect(desc.name).toBe("sm1");
      expect(desc.status).toBe("ACTIVE");
      expect(desc.type).toBe("STANDARD");
      expect(desc.roleArn).toBe(ROLE);
      expect(JSON.parse(desc.definition!).StartAt).toBe("Hello");
    });

    it("creates an EXPRESS state machine", async () => {
      const arn = await createSM("expr", EXPRESS_DEF, { type: "EXPRESS" });
      const desc = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
      expect(desc.type).toBe("EXPRESS");
    });

    it("is idempotent for identical create", async () => {
      const arn1 = await createSM("idem");
      const arn2 = await createSM("idem");
      expect(arn1).toBe(arn2);
    });

    it("rejects duplicate create with different definition", async () => {
      await createSM("dup");
      await expectError(
        sfn.send(new CreateStateMachineCommand({ name: "dup", definition: TASK_DEF, roleArn: ROLE })),
        "StateMachineAlreadyExists",
      );
    });

    it("rejects invalid names", async () => {
      await expectError(
        sfn.send(new CreateStateMachineCommand({ name: "bad name!", definition: PASS_DEF, roleArn: ROLE })),
        "InvalidName",
      );
    });

    it("rejects invalid definitions", async () => {
      await expectError(
        sfn.send(new CreateStateMachineCommand({ name: "baddef", definition: "{not json", roleArn: ROLE })),
        "InvalidDefinition",
      );
      await expectError(
        sfn.send(
          new CreateStateMachineCommand({
            name: "nostart",
            definition: JSON.stringify({ States: {} }),
            roleArn: ROLE,
          }),
        ),
        "InvalidDefinition",
      );
    });

    it("updates a state machine", async () => {
      const arn = await createSM("upd");
      const res = await sfn.send(
        new UpdateStateMachineCommand({ stateMachineArn: arn, definition: TASK_DEF }),
      );
      expect(res.updateDate).toBeInstanceOf(Date);
      const desc = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
      expect(JSON.parse(desc.definition!).StartAt).toBe("DoWork");
    });

    it("rejects update with no fields", async () => {
      const arn = await createSM("upd-empty");
      await expectError(
        sfn.send(new UpdateStateMachineCommand({ stateMachineArn: arn })),
        "MissingRequiredParameter",
      );
    });

    it("lists state machines", async () => {
      await createSM("l1");
      await createSM("l2");
      const res = await sfn.send(new ListStateMachinesCommand({}));
      const names = res.stateMachines!.map((s) => s.name);
      expect(names).toContain("l1");
      expect(names).toContain("l2");
    });

    it("paginates list state machines", async () => {
      for (let i = 0; i < 5; i++) await createSM(`page${i}`);
      const first = await sfn.send(new ListStateMachinesCommand({ maxResults: 2 }));
      expect(first.stateMachines!.length).toBe(2);
      expect(first.nextToken).toBeTruthy();
      const second = await sfn.send(new ListStateMachinesCommand({ maxResults: 2, nextToken: first.nextToken }));
      expect(second.stateMachines!.length).toBe(2);
    });

    it("deletes a state machine (idempotent)", async () => {
      const arn = await createSM("del");
      await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: arn }));
      await expectError(
        sfn.send(new DescribeStateMachineCommand({ stateMachineArn: arn })),
        "StateMachineDoesNotExist",
      );
      // Deleting again does not throw.
      await sfn.send(new DeleteStateMachineCommand({ stateMachineArn: arn }));
    });

    it("describe on missing machine errors", async () => {
      await expectError(
        sfn.send(
          new DescribeStateMachineCommand({
            stateMachineArn: "arn:aws:states:us-east-1:123456789012:stateMachine:nope",
          }),
        ),
        "StateMachineDoesNotExist",
      );
    });

    it("rejects invalid arns", async () => {
      await expectError(
        sfn.send(new DescribeStateMachineCommand({ stateMachineArn: "not-an-arn" })),
        "InvalidArn",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Validate definition", () => {
    it("returns OK for a valid definition", async () => {
      const res = await sfn.send(new ValidateStateMachineDefinitionCommand({ definition: PASS_DEF }));
      expect(res.result).toBe("OK");
      expect(res.diagnostics!.length).toBe(0);
    });

    it("returns FAIL with diagnostics for an invalid definition", async () => {
      const res = await sfn.send(
        new ValidateStateMachineDefinitionCommand({ definition: JSON.stringify({ States: {} }) }),
      );
      expect(res.result).toBe("FAIL");
      expect(res.diagnostics!.length).toBeGreaterThan(0);
      expect(res.diagnostics![0].severity).toBe("ERROR");
    });
  });

  // -----------------------------------------------------------------------
  describe("Versions", () => {
    it("publishes and lists versions", async () => {
      const arn = await createSM("ver");
      const v1 = await sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn }));
      expect(v1.stateMachineVersionArn).toBe(`${arn}:1`);
      const v2 = await sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn }));
      expect(v2.stateMachineVersionArn).toBe(`${arn}:2`);
      const list = await sfn.send(new ListStateMachineVersionsCommand({ stateMachineArn: arn }));
      expect(list.stateMachineVersions!.length).toBe(2);
    });

    it("publishes a version at create time", async () => {
      const res = await sfn.send(
        new CreateStateMachineCommand({ name: "pubcreate", definition: PASS_DEF, roleArn: ROLE, publish: true }),
      );
      expect(res.stateMachineVersionArn).toBe(`${res.stateMachineArn}:1`);
    });

    it("describes a version by arn", async () => {
      const arn = await createSM("verdesc");
      const v = await sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn }));
      const desc = await sfn.send(
        new DescribeStateMachineCommand({ stateMachineArn: v.stateMachineVersionArn! }),
      );
      expect(desc.stateMachineArn).toBe(v.stateMachineVersionArn);
    });

    it("deletes a version", async () => {
      const arn = await createSM("verdel");
      const v = await sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn }));
      await sfn.send(new DeleteStateMachineVersionCommand({ stateMachineVersionArn: v.stateMachineVersionArn! }));
      const list = await sfn.send(new ListStateMachineVersionsCommand({ stateMachineArn: arn }));
      expect(list.stateMachineVersions!.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("Aliases", () => {
    async function setupVersion(name: string) {
      const arn = await createSM(name);
      const v = await sfn.send(new PublishStateMachineVersionCommand({ stateMachineArn: arn }));
      return { arn, versionArn: v.stateMachineVersionArn! };
    }

    it("creates, describes, and lists aliases", async () => {
      const { arn, versionArn } = await setupVersion("al1");
      const created = await sfn.send(
        new CreateStateMachineAliasCommand({
          name: "PROD",
          routingConfiguration: [{ stateMachineVersionArn: versionArn, weight: 100 }],
        }),
      );
      expect(created.stateMachineAliasArn).toBe(`${arn}:PROD`);
      const desc = await sfn.send(
        new DescribeStateMachineAliasCommand({ stateMachineAliasArn: created.stateMachineAliasArn! }),
      );
      expect(desc.name).toBe("PROD");
      const list = await sfn.send(new ListStateMachineAliasesCommand({ stateMachineArn: arn }));
      expect(list.stateMachineAliases!.length).toBe(1);
    });

    it("rejects routing weights that do not sum to 100", async () => {
      const { versionArn } = await setupVersion("al2");
      await expectError(
        sfn.send(
          new CreateStateMachineAliasCommand({
            name: "BAD",
            routingConfiguration: [{ stateMachineVersionArn: versionArn, weight: 50 }],
          }),
        ),
        "ValidationException",
      );
    });

    it("updates and deletes an alias", async () => {
      const { arn, versionArn } = await setupVersion("al3");
      const created = await sfn.send(
        new CreateStateMachineAliasCommand({
          name: "LIVE",
          routingConfiguration: [{ stateMachineVersionArn: versionArn, weight: 100 }],
        }),
      );
      const upd = await sfn.send(
        new UpdateStateMachineAliasCommand({
          stateMachineAliasArn: created.stateMachineAliasArn!,
          description: "now with a description",
        }),
      );
      expect(upd.updateDate).toBeInstanceOf(Date);
      await sfn.send(
        new DeleteStateMachineAliasCommand({ stateMachineAliasArn: created.stateMachineAliasArn! }),
      );
      const list = await sfn.send(new ListStateMachineAliasesCommand({ stateMachineArn: arn }));
      expect(list.stateMachineAliases!.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  describe("Executions (ASL interpreter)", () => {
    it("runs a Pass state machine to SUCCEEDED", async () => {
      const arn = await createSM("exec-pass");
      const start = await sfn.send(
        new StartExecutionCommand({ stateMachineArn: arn, name: "e1", input: JSON.stringify({ a: 1 }) }),
      );
      expect(start.executionArn).toContain("execution:exec-pass:e1");
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      const out = JSON.parse(desc.output);
      expect(out.added.greeting).toBe("hello");
      expect(out.a).toBe(1);
    });

    it("runs a Task identity flow", async () => {
      const arn = await createSM("exec-task", TASK_DEF);
      const start = await sfn.send(
        new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ x: 42 }) }),
      );
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output).x).toBe(42);
    });

    it("evaluates Choice states", async () => {
      const arn = await createSM("exec-choice", CHOICE_DEF);
      const big = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ n: 10 }) }));
      const bigDesc = await waitForExecution(big.executionArn!);
      expect(JSON.parse(bigDesc.output)).toBe("big");
      const small = await sfn.send(
        new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ n: 1 }) }),
      );
      const smallDesc = await waitForExecution(small.executionArn!);
      expect(JSON.parse(smallDesc.output)).toBe("small");
    });

    it("handles Wait states", async () => {
      const arn = await createSM("exec-wait", WAIT_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
      const desc = await waitForExecution(start.executionArn!, 200);
      expect(desc.status).toBe("SUCCEEDED");
    });

    it("handles Fail states", async () => {
      const arn = await createSM("exec-fail", FAIL_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("FAILED");
      expect(desc.error).toBe("MyError");
      expect(desc.cause).toBe("It broke");
    });

    it("handles Parallel states", async () => {
      const arn = await createSM("exec-parallel", PARALLEL_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output)).toEqual([1, 2]);
    });

    it("handles Map states", async () => {
      const arn = await createSM("exec-map", MAP_DEF);
      const start = await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: arn,
          input: JSON.stringify({ items: [{ v: 1 }, { v: 2 }, { v: 3 }] }),
        }),
      );
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output)).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
    });

    it("rejects duplicate execution names", async () => {
      const arn = await createSM("exec-dup");
      await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: "dup", input: "{}" }));
      await expectError(
        sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: "dup", input: JSON.stringify({ x: 1 }) })),
        "ExecutionAlreadyExists",
      );
    });

    it("rejects invalid execution input", async () => {
      const arn = await createSM("exec-badinput");
      await expectError(
        sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{bad json" })),
        "InvalidExecutionInput",
      );
    });

    it("lists executions and filters by status", async () => {
      const arn = await createSM("exec-list");
      await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: "a", input: "{}" }));
      await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, name: "b", input: "{}" }));
      await new Promise((r) => setTimeout(r, 50));
      const all = await sfn.send(new ListExecutionsCommand({ stateMachineArn: arn }));
      expect(all.executions!.length).toBe(2);
      const succeeded = await sfn.send(
        new ListExecutionsCommand({ stateMachineArn: arn, statusFilter: "SUCCEEDED" }),
      );
      expect(succeeded.executions!.length).toBe(2);
    });

    it("stops a running execution", async () => {
      // waitForTaskToken keeps it RUNNING.
      const arn = await createSM("exec-stop", RETRY_CATCH_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
      await new Promise((r) => setTimeout(r, 30));
      const stop = await sfn.send(
        new StopExecutionCommand({ executionArn: start.executionArn!, error: "Manual", cause: "test" }),
      );
      expect(stop.stopDate).toBeInstanceOf(Date);
      const desc = await sfn.send(new DescribeExecutionCommand({ executionArn: start.executionArn! }));
      expect(desc.status).toBe("ABORTED");
    });

    it("returns execution history with events", async () => {
      const arn = await createSM("exec-hist");
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      await waitForExecution(start.executionArn!);
      const hist = await sfn.send(new GetExecutionHistoryCommand({ executionArn: start.executionArn! }));
      const types = hist.events!.map((e) => e.type);
      expect(types).toContain("ExecutionStarted");
      expect(types).toContain("ExecutionSucceeded");
      expect(hist.events![0].id).toBe(1);
    });

    it("supports reverseOrder history", async () => {
      const arn = await createSM("exec-hist-rev");
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      await waitForExecution(start.executionArn!);
      const hist = await sfn.send(
        new GetExecutionHistoryCommand({ executionArn: start.executionArn!, reverseOrder: true }),
      );
      expect(hist.events![0].type).toBe("ExecutionSucceeded");
    });

    it("describes the state machine for an execution", async () => {
      const arn = await createSM("exec-desc-sm");
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      const res = await sfn.send(
        new DescribeStateMachineForExecutionCommand({ executionArn: start.executionArn! }),
      );
      expect(res.stateMachineArn).toBe(arn);
      expect(res.name).toBe("exec-desc-sm");
    });

    it("describe missing execution errors", async () => {
      await expectError(
        sfn.send(
          new DescribeExecutionCommand({
            executionArn: "arn:aws:states:us-east-1:123456789012:execution:x:y",
          }),
        ),
        "ExecutionDoesNotExist",
      );
    });

    it("redrives a failed execution", async () => {
      const arn = await createSM("exec-redrive", FAIL_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn }));
      await waitForExecution(start.executionArn!);
      const redrive = await sfn.send(new RedriveExecutionCommand({ executionArn: start.executionArn! }));
      expect(redrive.redriveDate).toBeInstanceOf(Date);
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.redriveCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Sync executions (EXPRESS)", () => {
    it("runs StartSyncExecution and returns output inline", async () => {
      const arn = await createSM("sync-sm", EXPRESS_DEF, { type: "EXPRESS" });
      const res = await sfn.send(
        new StartSyncExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ ping: "pong" }) }),
      );
      expect(res.status).toBe("SUCCEEDED");
      expect(JSON.parse(res.output!).ping).toBe("pong");
    });

    it("rejects StartSyncExecution on STANDARD machines", async () => {
      const arn = await createSM("sync-std");
      await expectError(
        sfn.send(new StartSyncExecutionCommand({ stateMachineArn: arn, input: "{}" })),
        "StateMachineTypeNotSupported",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Activities", () => {
    it("creates, describes, and lists activities", async () => {
      const created = await sfn.send(new CreateActivityCommand({ name: "act1" }));
      expect(created.activityArn).toContain("activity:act1");
      const desc = await sfn.send(new DescribeActivityCommand({ activityArn: created.activityArn! }));
      expect(desc.name).toBe("act1");
      const list = await sfn.send(new ListActivitiesCommand({}));
      expect(list.activities!.map((a) => a.name)).toContain("act1");
    });

    it("is idempotent on create", async () => {
      const a = await sfn.send(new CreateActivityCommand({ name: "actidem" }));
      const b = await sfn.send(new CreateActivityCommand({ name: "actidem" }));
      expect(a.activityArn).toBe(b.activityArn);
    });

    it("deletes activities", async () => {
      const a = await sfn.send(new CreateActivityCommand({ name: "actdel" }));
      await sfn.send(new DeleteActivityCommand({ activityArn: a.activityArn! }));
      await expectError(
        sfn.send(new DescribeActivityCommand({ activityArn: a.activityArn! })),
        "ActivityDoesNotExist",
      );
    });

    it("GetActivityTask returns empty when no task is queued", async () => {
      const a = await sfn.send(new CreateActivityCommand({ name: "actpoll" }));
      const res = await sfn.send(new GetActivityTaskCommand({ activityArn: a.activityArn! }));
      expect(res.taskToken).toBeFalsy();
    });

    it("describe missing activity errors", async () => {
      await expectError(
        sfn.send(
          new DescribeActivityCommand({
            activityArn: "arn:aws:states:us-east-1:123456789012:activity:nope",
          }),
        ),
        "ActivityDoesNotExist",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Task tokens (callback pattern)", () => {
    it("completes a waitForTaskToken task via SendTaskSuccess", async () => {
      // Register a resolver that captures the token, then resolve out of band.
      let captured: string | null = null;
      server.taskResolvers.set("arn:aws:states:::lambda:invoke.waitForTaskToken", async (eff: any) => {
        captured = eff.taskToken;
        // never resolves here; we complete via SendTaskSuccess below
        return new Promise(() => {});
      });
      const def = JSON.stringify({
        StartAt: "Wait",
        States: {
          Wait: {
            Type: "Task",
            Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken",
            End: true,
          },
        },
      });
      const arn = await createSM("cb-success", def);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      // poll until token captured
      for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 20));
      expect(captured).toBeTruthy();
      await sfn.send(
        new SendTaskSuccessCommand({ taskToken: captured!, output: JSON.stringify({ done: true }) }),
      );
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output).done).toBe(true);
      server.taskResolvers.clear();
    });

    it("fails a task via SendTaskFailure and triggers Catch", async () => {
      let captured: string | null = null;
      server.taskResolvers.set("arn:aws:states:::lambda:invoke.waitForTaskToken", async (eff: any) => {
        captured = eff.taskToken;
        return new Promise(() => {});
      });
      const arn = await createSM("cb-fail", RETRY_CATCH_DEF);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 20));
      expect(captured).toBeTruthy();
      await sfn.send(new SendTaskFailureCommand({ taskToken: captured!, error: "Nope", cause: "boom" }));
      const desc = await waitForExecution(start.executionArn!);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output)).toBe("recovered");
      server.taskResolvers.clear();
    });

    it("accepts a heartbeat for a live token", async () => {
      let captured: string | null = null;
      server.taskResolvers.set("arn:aws:states:::lambda:invoke.waitForTaskToken", async (eff: any) => {
        captured = eff.taskToken;
        return new Promise(() => {});
      });
      const def = JSON.stringify({
        StartAt: "Wait",
        States: {
          Wait: { Type: "Task", Resource: "arn:aws:states:::lambda:invoke.waitForTaskToken", End: true },
        },
      });
      const arn = await createSM("cb-heartbeat", def);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 20));
      expect(captured).toBeTruthy();
      await sfn.send(new SendTaskHeartbeatCommand({ taskToken: captured! }));
      await sfn.send(new SendTaskSuccessCommand({ taskToken: captured!, output: "{}" }));
      server.taskResolvers.clear();
    });

    it("rejects unknown task tokens", async () => {
      await expectError(
        sfn.send(new SendTaskSuccessCommand({ taskToken: "bogus", output: "{}" })),
        "TaskDoesNotExist",
      );
      await expectError(
        sfn.send(new SendTaskFailureCommand({ taskToken: "bogus" })),
        "TaskDoesNotExist",
      );
      await expectError(
        sfn.send(new SendTaskHeartbeatCommand({ taskToken: "bogus" })),
        "TaskDoesNotExist",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Map runs (distributed)", () => {
    const DIST_MAP_DEF = JSON.stringify({
      StartAt: "DistMap",
      States: {
        DistMap: {
          Type: "Map",
          ItemsPath: "$.items",
          MaxConcurrency: 2,
          ItemProcessor: {
            ProcessorConfig: { Mode: "DISTRIBUTED" },
            StartAt: "P",
            States: { P: { Type: "Pass", End: true } },
          },
          End: true,
        },
      },
    });

    it("creates a MapRun and lists/describes it", async () => {
      const arn = await createSM("maprun-sm", DIST_MAP_DEF);
      const start = await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: arn,
          input: JSON.stringify({ items: [1, 2, 3, 4] }),
        }),
      );
      await waitForExecution(start.executionArn!);
      const list = await sfn.send(new ListMapRunsCommand({ executionArn: start.executionArn! }));
      expect(list.mapRuns!.length).toBe(1);
      const mapRunArn = list.mapRuns![0].mapRunArn!;
      const desc = await sfn.send(new DescribeMapRunCommand({ mapRunArn }));
      expect(desc.status).toBe("SUCCEEDED");
      expect(desc.itemCounts!.total).toBe(4);
    });

    it("updates a MapRun", async () => {
      const arn = await createSM("maprun-upd", DIST_MAP_DEF);
      const start = await sfn.send(
        new StartExecutionCommand({ stateMachineArn: arn, input: JSON.stringify({ items: [1, 2] }) }),
      );
      await waitForExecution(start.executionArn!);
      const list = await sfn.send(new ListMapRunsCommand({ executionArn: start.executionArn! }));
      const mapRunArn = list.mapRuns![0].mapRunArn!;
      await sfn.send(new UpdateMapRunCommand({ mapRunArn, maxConcurrency: 5 }));
      const desc = await sfn.send(new DescribeMapRunCommand({ mapRunArn }));
      expect(desc.maxConcurrency).toBe(5);
    });

    it("describe missing map run errors", async () => {
      await expectError(
        sfn.send(
          new DescribeMapRunCommand({
            mapRunArn: "arn:aws:states:us-east-1:123456789012:mapRun:x/y:z",
          }),
        ),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("TestState", () => {
    it("tests a Pass state and returns output", async () => {
      const res = await sfn.send(
        new TestStateCommand({
          definition: JSON.stringify({ Type: "Pass", Result: { ok: true }, End: true }),
          input: JSON.stringify({ x: 1 }),
        }),
      );
      expect(res.status).toBe("SUCCEEDED");
      expect(JSON.parse(res.output!).ok).toBe(true);
    });

    it("tests a Choice state and returns nextState", async () => {
      const res = await sfn.send(
        new TestStateCommand({
          definition: JSON.stringify({
            Type: "Choice",
            Choices: [{ Variable: "$.n", NumericGreaterThan: 5, Next: "Big" }],
            Default: "Small",
          }),
          input: JSON.stringify({ n: 9 }),
        }),
      );
      expect(res.status).toBe("SUCCEEDED");
      expect(res.nextState).toBe("Big");
    });

    it("reports failure for a Fail state", async () => {
      const res = await sfn.send(
        new TestStateCommand({
          definition: JSON.stringify({ Type: "Fail", Error: "X", Cause: "Y" }),
        }),
      );
      expect(res.status).toBe("FAILED");
      expect(res.error).toBe("X");
    });
  });

  // -----------------------------------------------------------------------
  describe("Intrinsic functions & JSONPath", () => {
    it("evaluates States.Format and States.Array via Parameters", async () => {
      const def = JSON.stringify({
        StartAt: "Fmt",
        States: {
          Fmt: {
            Type: "Pass",
            Parameters: {
              "greeting.$": "States.Format('Hello {}!', $.name)",
              "list.$": "States.Array($.a, $.b)",
              "len.$": "States.ArrayLength($.items)",
            },
            End: true,
          },
        },
      });
      const arn = await createSM("intrinsic", def);
      const start = await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: arn,
          input: JSON.stringify({ name: "World", a: 1, b: 2, items: [1, 2, 3] }),
        }),
      );
      const desc = await waitForExecution(start.executionArn!);
      const out = JSON.parse(desc.output);
      expect(out.greeting).toBe("Hello World!");
      expect(out.list).toEqual([1, 2]);
      expect(out.len).toBe(3);
    });

    it("supports Retry then Catch on a failing identity flow", async () => {
      // A registered resolver always throws -> retries exhaust -> catch fires.
      server.taskResolvers.set("arn:aws:lambda:us-east-1:123456789012:function:flaky", async () => {
        throw new Error("always fails");
      });
      const def = JSON.stringify({
        StartAt: "Flaky",
        States: {
          Flaky: {
            Type: "Task",
            Resource: "arn:aws:lambda:us-east-1:123456789012:function:flaky",
            Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 2, IntervalSeconds: 1 }],
            Catch: [{ ErrorEquals: ["States.ALL"], Next: "Recovered" }],
            End: true,
          },
          Recovered: { Type: "Pass", Result: "ok", End: true },
        },
      });
      const arn = await createSM("retrycatch", def);
      const start = await sfn.send(new StartExecutionCommand({ stateMachineArn: arn, input: "{}" }));
      const desc = await waitForExecution(start.executionArn!, 200);
      expect(desc.status).toBe("SUCCEEDED");
      expect(JSON.parse(desc.output)).toBe("ok");
      const hist = await sfn.send(new GetExecutionHistoryCommand({ executionArn: start.executionArn! }));
      const failures = hist.events!.filter((e) => e.type === "TaskFailed");
      expect(failures.length).toBeGreaterThanOrEqual(2);
      server.taskResolvers.clear();
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    it("tags, lists, and untags a state machine", async () => {
      const arn = await createSM("tagsm");
      await sfn.send(
        new TagResourceCommand({ resourceArn: arn, tags: [{ key: "env", value: "test" }, { key: "team", value: "parlel" }] }),
      );
      let list = await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }));
      expect(list.tags!.length).toBe(2);
      await sfn.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: ["env"] }));
      list = await sfn.send(new ListTagsForResourceCommand({ resourceArn: arn }));
      expect(list.tags!.map((t) => t.key)).toEqual(["team"]);
    });

    it("tags an activity", async () => {
      const a = await sfn.send(new CreateActivityCommand({ name: "tagact", tags: [{ key: "k", value: "v" }] }));
      const list = await sfn.send(new ListTagsForResourceCommand({ resourceArn: a.activityArn! }));
      expect(list.tags![0].key).toBe("k");
    });

    it("tagging a missing resource errors", async () => {
      await expectError(
        sfn.send(
          new TagResourceCommand({
            resourceArn: "arn:aws:states:us-east-1:123456789012:stateMachine:ghost",
            tags: [{ key: "a", value: "b" }],
          }),
        ),
        "ResourceNotFound",
      );
    });
  });
});
