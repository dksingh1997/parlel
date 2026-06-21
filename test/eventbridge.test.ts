import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  EventBridgeClient,
  // Event buses
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DescribeEventBusCommand,
  ListEventBusesCommand,
  UpdateEventBusCommand,
  // Permissions
  PutPermissionCommand,
  RemovePermissionCommand,
  // Rules
  PutRuleCommand,
  DeleteRuleCommand,
  DescribeRuleCommand,
  DisableRuleCommand,
  EnableRuleCommand,
  ListRulesCommand,
  ListRuleNamesByTargetCommand,
  // Targets
  PutTargetsCommand,
  RemoveTargetsCommand,
  ListTargetsByRuleCommand,
  // Events
  PutEventsCommand,
  PutPartnerEventsCommand,
  TestEventPatternCommand,
  // Archives
  CreateArchiveCommand,
  DeleteArchiveCommand,
  DescribeArchiveCommand,
  ListArchivesCommand,
  UpdateArchiveCommand,
  // Replays
  StartReplayCommand,
  CancelReplayCommand,
  DescribeReplayCommand,
  ListReplaysCommand,
  // Connections
  CreateConnectionCommand,
  DeleteConnectionCommand,
  DescribeConnectionCommand,
  ListConnectionsCommand,
  UpdateConnectionCommand,
  DeauthorizeConnectionCommand,
  // API destinations
  CreateApiDestinationCommand,
  DeleteApiDestinationCommand,
  DescribeApiDestinationCommand,
  ListApiDestinationsCommand,
  UpdateApiDestinationCommand,
  // Endpoints
  CreateEndpointCommand,
  DeleteEndpointCommand,
  DescribeEndpointCommand,
  ListEndpointsCommand,
  UpdateEndpointCommand,
  // Partner event sources
  CreatePartnerEventSourceCommand,
  DeletePartnerEventSourceCommand,
  DescribePartnerEventSourceCommand,
  ListPartnerEventSourcesCommand,
  ListPartnerEventSourceAccountsCommand,
  // Event sources
  DescribeEventSourceCommand,
  ListEventSourcesCommand,
  ActivateEventSourceCommand,
  DeactivateEventSourceCommand,
  // Tagging
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-eventbridge";
import { EventbridgeServer } from "../services/eventbridge/src/server.js";

const PORT = 14573;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new EventBridgeClient({
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

describe("EventBridge Service", () => {
  let server: EventbridgeServer;
  let eb: EventBridgeClient;

  beforeAll(async () => {
    server = new EventbridgeServer(PORT);
    await server.start();
    eb = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    eb.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  async function makeRule(name: string, extra: Record<string, unknown> = {}) {
    return eb.send(
      new PutRuleCommand({
        Name: name,
        EventPattern: JSON.stringify({ source: ["my.app"] }),
        ...extra,
      }),
    );
  }

  // =======================================================================
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses the default port 4573 by default", () => {
      const s = new EventbridgeServer();
      expect(s.port).toBe(4573);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.status).toBe("ok");
      expect(json.service).toBe("eventbridge");
    });

    it("seeds the default event bus", () => {
      expect(server.eventBuses.has("default")).toBe(true);
    });

    it("has resettable ephemeral state", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "reset-bus" }));
      expect(server.eventBuses.size).toBe(2);
      server.reset();
      expect(server.eventBuses.size).toBe(1);
    });

    it("supports POST /_parlel/reset", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "reset-bus-2" }));
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.eventBuses.size).toBe(1);
    });
  });

  // =======================================================================
  describe("Event buses", () => {
    it("creates an event bus", async () => {
      const res = await eb.send(new CreateEventBusCommand({ Name: "orders" }));
      expect(res.EventBusArn).toContain("event-bus/orders");
    });

    it("rejects duplicate event bus", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "dup" }));
      await expectError(
        eb.send(new CreateEventBusCommand({ Name: "dup" })),
        "ResourceAlreadyExistsException",
      );
    });

    it("rejects invalid event bus name", async () => {
      await expectError(
        eb.send(new CreateEventBusCommand({ Name: "bad name!" })),
        "ValidationException",
      );
    });

    it("describes the default event bus", async () => {
      const res = await eb.send(new DescribeEventBusCommand({}));
      expect(res.Name).toBe("default");
      expect(res.Arn).toContain("event-bus/default");
    });

    it("describes a named event bus", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "named", Description: "d" }));
      const res = await eb.send(new DescribeEventBusCommand({ Name: "named" }));
      expect(res.Name).toBe("named");
      expect(res.Description).toBe("d");
    });

    it("lists event buses with prefix filter", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "alpha-1" }));
      await eb.send(new CreateEventBusCommand({ Name: "beta-1" }));
      const res = await eb.send(new ListEventBusesCommand({ NamePrefix: "alpha" }));
      expect(res.EventBuses?.length).toBe(1);
      expect(res.EventBuses?.[0].Name).toBe("alpha-1");
    });

    it("updates an event bus", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "upd" }));
      const res = await eb.send(
        new UpdateEventBusCommand({ Name: "upd", Description: "updated" }),
      );
      expect(res.Description).toBe("updated");
    });

    it("deletes an event bus", async () => {
      await eb.send(new CreateEventBusCommand({ Name: "del" }));
      await eb.send(new DeleteEventBusCommand({ Name: "del" }));
      expect(server.eventBuses.has("del")).toBe(false);
    });

    it("refuses to delete the default event bus", async () => {
      await expectError(
        eb.send(new DeleteEventBusCommand({ Name: "default" })),
        "ValidationException",
      );
    });

    it("describe missing bus throws ResourceNotFound", async () => {
      await expectError(
        eb.send(new DescribeEventBusCommand({ Name: "nope" })),
        "ResourceNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("Permissions", () => {
    it("adds a permission statement", async () => {
      await eb.send(
        new PutPermissionCommand({
          Action: "events:PutEvents",
          Principal: "111122223333",
          StatementId: "sid1",
        }),
      );
      const bus = server.eventBuses.get("default");
      expect(bus?.policy).toContain("sid1");
    });

    it("adds a full policy document", async () => {
      await eb.send(
        new PutPermissionCommand({
          Policy: JSON.stringify({ Version: "2012-10-17", Statement: [] }),
        }),
      );
      expect(server.eventBuses.get("default")?.policy).toBeDefined();
    });

    it("removes a permission statement", async () => {
      await eb.send(
        new PutPermissionCommand({
          Action: "events:PutEvents",
          Principal: "111122223333",
          StatementId: "sid2",
        }),
      );
      await eb.send(new RemovePermissionCommand({ StatementId: "sid2" }));
      const bus = server.eventBuses.get("default");
      expect(bus?.policy ?? "").not.toContain("sid2");
    });

    it("removes all permissions", async () => {
      await eb.send(
        new PutPermissionCommand({
          Action: "events:PutEvents",
          Principal: "111122223333",
          StatementId: "sid3",
        }),
      );
      await eb.send(new RemovePermissionCommand({ RemoveAllPermissions: true }));
      expect(server.eventBuses.get("default")?.policy).toBeUndefined();
    });

    it("remove missing statement throws ResourceNotFound", async () => {
      await expectError(
        eb.send(new RemovePermissionCommand({ StatementId: "ghost" })),
        "ResourceNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("Rules", () => {
    it("creates a rule with an event pattern", async () => {
      const res = await makeRule("rule-1");
      expect(res.RuleArn).toContain("rule/rule-1");
    });

    it("creates a rule with a schedule expression", async () => {
      const res = await eb.send(
        new PutRuleCommand({ Name: "sched", ScheduleExpression: "rate(5 minutes)" }),
      );
      expect(res.RuleArn).toContain("rule/sched");
    });

    it("rejects a rule with neither pattern nor schedule", async () => {
      await expectError(
        eb.send(new PutRuleCommand({ Name: "empty" })),
        "ValidationException",
      );
    });

    it("rejects an invalid event pattern", async () => {
      await expectError(
        eb.send(new PutRuleCommand({ Name: "badpat", EventPattern: "{not json" })),
        "InvalidEventPatternException",
      );
    });

    it("describes a rule", async () => {
      await makeRule("describe-rule", { Description: "test rule" });
      const res = await eb.send(new DescribeRuleCommand({ Name: "describe-rule" }));
      expect(res.Name).toBe("describe-rule");
      expect(res.Description).toBe("test rule");
      expect(res.State).toBe("ENABLED");
    });

    it("disables and enables a rule", async () => {
      await makeRule("toggle");
      await eb.send(new DisableRuleCommand({ Name: "toggle" }));
      let res = await eb.send(new DescribeRuleCommand({ Name: "toggle" }));
      expect(res.State).toBe("DISABLED");
      await eb.send(new EnableRuleCommand({ Name: "toggle" }));
      res = await eb.send(new DescribeRuleCommand({ Name: "toggle" }));
      expect(res.State).toBe("ENABLED");
    });

    it("lists rules with prefix", async () => {
      await makeRule("foo-a");
      await makeRule("foo-b");
      await makeRule("bar-a");
      const res = await eb.send(new ListRulesCommand({ NamePrefix: "foo" }));
      expect(res.Rules?.length).toBe(2);
    });

    it("updates a rule via PutRule (upsert)", async () => {
      await makeRule("upsert", { Description: "v1" });
      await makeRule("upsert", { Description: "v2" });
      const res = await eb.send(new DescribeRuleCommand({ Name: "upsert" }));
      expect(res.Description).toBe("v2");
    });

    it("deletes a rule", async () => {
      await makeRule("to-delete");
      await eb.send(new DeleteRuleCommand({ Name: "to-delete" }));
      await expectError(
        eb.send(new DescribeRuleCommand({ Name: "to-delete" })),
        "ResourceNotFoundException",
      );
    });

    it("refuses to delete a rule with targets unless forced", async () => {
      await makeRule("has-targets");
      await eb.send(
        new PutTargetsCommand({
          Rule: "has-targets",
          Targets: [{ Id: "t1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:f" }],
        }),
      );
      await expectError(
        eb.send(new DeleteRuleCommand({ Name: "has-targets" })),
        "ValidationException",
      );
      await eb.send(new DeleteRuleCommand({ Name: "has-targets", Force: true }));
    });

    it("describe missing rule throws ResourceNotFound", async () => {
      await expectError(
        eb.send(new DescribeRuleCommand({ Name: "ghost-rule" })),
        "ResourceNotFoundException",
      );
    });

    it("lists rule names by target", async () => {
      const targetArn = "arn:aws:lambda:us-east-1:000000000000:function:shared";
      await makeRule("rt-1");
      await makeRule("rt-2");
      await eb.send(new PutTargetsCommand({ Rule: "rt-1", Targets: [{ Id: "x", Arn: targetArn }] }));
      await eb.send(new PutTargetsCommand({ Rule: "rt-2", Targets: [{ Id: "y", Arn: targetArn }] }));
      const res = await eb.send(new ListRuleNamesByTargetCommand({ TargetArn: targetArn }));
      expect(res.RuleNames?.sort()).toEqual(["rt-1", "rt-2"]);
    });
  });

  // =======================================================================
  describe("Targets", () => {
    beforeEach(async () => {
      await makeRule("target-rule");
    });

    it("puts targets on a rule", async () => {
      const res = await eb.send(
        new PutTargetsCommand({
          Rule: "target-rule",
          Targets: [
            { Id: "1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:a" },
            { Id: "2", Arn: "arn:aws:sqs:us-east-1:000000000000:q", Input: "{}" },
          ],
        }),
      );
      expect(res.FailedEntryCount).toBe(0);
    });

    it("reports failed entries for invalid targets", async () => {
      const res = await eb.send(
        new PutTargetsCommand({
          Rule: "target-rule",
          Targets: [{ Id: "bad" } as any],
        }),
      );
      expect(res.FailedEntryCount).toBe(1);
      expect(res.FailedEntries?.[0].ErrorCode).toBe("ValidationException");
    });

    it("rejects more than 5 targets per request", async () => {
      const targets = Array.from({ length: 6 }, (_, i) => ({
        Id: `t${i}`,
        Arn: "arn:aws:lambda:us-east-1:000000000000:function:f",
      }));
      await expectError(
        eb.send(new PutTargetsCommand({ Rule: "target-rule", Targets: targets })),
        "LimitExceededException",
      );
    });

    it("lists targets by rule", async () => {
      await eb.send(
        new PutTargetsCommand({
          Rule: "target-rule",
          Targets: [{ Id: "lt1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:a" }],
        }),
      );
      const res = await eb.send(new ListTargetsByRuleCommand({ Rule: "target-rule" }));
      expect(res.Targets?.length).toBe(1);
      expect(res.Targets?.[0].Id).toBe("lt1");
    });

    it("removes targets from a rule", async () => {
      await eb.send(
        new PutTargetsCommand({
          Rule: "target-rule",
          Targets: [{ Id: "rm1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:a" }],
        }),
      );
      const res = await eb.send(
        new RemoveTargetsCommand({ Rule: "target-rule", Ids: ["rm1"] }),
      );
      expect(res.FailedEntryCount).toBe(0);
      const list = await eb.send(new ListTargetsByRuleCommand({ Rule: "target-rule" }));
      expect(list.Targets?.length).toBe(0);
    });

    it("put targets on missing rule throws ResourceNotFound", async () => {
      await expectError(
        eb.send(
          new PutTargetsCommand({
            Rule: "nope",
            Targets: [{ Id: "1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:a" }],
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("PutEvents", () => {
    it("puts a valid event", async () => {
      const res = await eb.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: "my.app",
              DetailType: "OrderPlaced",
              Detail: JSON.stringify({ orderId: 123 }),
            },
          ],
        }),
      );
      expect(res.FailedEntryCount).toBe(0);
      expect(res.Entries?.[0].EventId).toBeDefined();
      expect(server.putEvents.length).toBe(1);
    });

    it("reports per-entry validation errors", async () => {
      const res = await eb.send(
        new PutEventsCommand({
          Entries: [{ Source: "my.app" } as any],
        }),
      );
      expect(res.FailedEntryCount).toBe(1);
      expect(res.Entries?.[0].ErrorCode).toBe("ValidationException");
    });

    it("rejects malformed detail", async () => {
      const res = await eb.send(
        new PutEventsCommand({
          Entries: [{ Source: "my.app", DetailType: "T", Detail: "not json" }],
        }),
      );
      expect(res.FailedEntryCount).toBe(1);
      expect(res.Entries?.[0].ErrorCode).toBe("MalformedDetail");
    });

    it("rejects more than 10 entries", async () => {
      const entries = Array.from({ length: 11 }, () => ({
        Source: "my.app",
        DetailType: "T",
        Detail: "{}",
      }));
      await expectError(eb.send(new PutEventsCommand({ Entries: entries })), "ValidationException");
    });

    it("routes a matching event to an enabled rule", async () => {
      await makeRule("router");
      await eb.send(
        new PutEventsCommand({
          Entries: [{ Source: "my.app", DetailType: "T", Detail: JSON.stringify({ x: 1 }) }],
        }),
      );
      expect(server.routedEvents.length).toBe(1);
      expect(server.routedEvents[0].ruleName).toBe("router");
    });

    it("does not route an event when the pattern does not match", async () => {
      await makeRule("non-router");
      await eb.send(
        new PutEventsCommand({
          Entries: [{ Source: "other.app", DetailType: "T", Detail: "{}" }],
        }),
      );
      expect(server.routedEvents.length).toBe(0);
    });

    it("does not route to a disabled rule", async () => {
      await makeRule("disabled-router");
      await eb.send(new DisableRuleCommand({ Name: "disabled-router" }));
      await eb.send(
        new PutEventsCommand({
          Entries: [{ Source: "my.app", DetailType: "T", Detail: "{}" }],
        }),
      );
      expect(server.routedEvents.length).toBe(0);
    });
  });

  // =======================================================================
  describe("PutPartnerEvents", () => {
    it("accepts partner events", async () => {
      const res = await eb.send(
        new PutPartnerEventsCommand({
          Entries: [
            { Source: "aws.partner/example.com/123", DetailType: "T", Detail: "{}" },
          ],
        }),
      );
      expect(res.FailedEntryCount).toBe(0);
      expect(res.Entries?.[0].EventId).toBeDefined();
    });

    it("reports missing source on partner events", async () => {
      const res = await eb.send(
        new PutPartnerEventsCommand({ Entries: [{ DetailType: "T" } as any] }),
      );
      expect(res.FailedEntryCount).toBe(1);
    });
  });

  // =======================================================================
  describe("TestEventPattern", () => {
    const baseEvent = {
      id: "1",
      account: "000000000000",
      source: "my.app",
      time: new Date().toISOString(),
      region: "us-east-1",
      "detail-type": "OrderPlaced",
      detail: { state: "ok", amount: 50, ip: "10.0.0.5", name: "WidgetCo" },
    };

    async function test(pattern: object, event: object = baseEvent) {
      const res = await eb.send(
        new TestEventPatternCommand({
          EventPattern: JSON.stringify(pattern),
          Event: JSON.stringify(event),
        }),
      );
      return res.Result;
    }

    it("matches a simple source pattern", async () => {
      expect(await test({ source: ["my.app"] })).toBe(true);
      expect(await test({ source: ["other"] })).toBe(false);
    });

    it("matches a nested detail field", async () => {
      expect(await test({ detail: { state: ["ok"] } })).toBe(true);
      expect(await test({ detail: { state: ["bad"] } })).toBe(false);
    });

    it("matches prefix", async () => {
      expect(await test({ source: [{ prefix: "my." }] })).toBe(true);
      expect(await test({ source: [{ prefix: "x." }] })).toBe(false);
    });

    it("matches suffix", async () => {
      expect(await test({ source: [{ suffix: ".app" }] })).toBe(true);
    });

    it("matches anything-but", async () => {
      expect(await test({ source: [{ "anything-but": ["nope"] }] })).toBe(true);
      expect(await test({ source: [{ "anything-but": ["my.app"] }] })).toBe(false);
    });

    it("matches numeric conditions", async () => {
      expect(await test({ detail: { amount: [{ numeric: [">", 10, "<", 100] }] } })).toBe(true);
      expect(await test({ detail: { amount: [{ numeric: [">", 100] }] } })).toBe(false);
    });

    it("matches exists true/false", async () => {
      expect(await test({ detail: { state: [{ exists: true }] } })).toBe(true);
      expect(await test({ detail: { missing: [{ exists: false }] } })).toBe(true);
      expect(await test({ detail: { state: [{ exists: false }] } })).toBe(false);
    });

    it("matches cidr", async () => {
      expect(await test({ detail: { ip: [{ cidr: "10.0.0.0/24" }] } })).toBe(true);
      expect(await test({ detail: { ip: [{ cidr: "192.168.0.0/16" }] } })).toBe(false);
    });

    it("matches equals-ignore-case", async () => {
      expect(await test({ detail: { name: [{ "equals-ignore-case": "widgetco" }] } })).toBe(true);
    });

    it("matches wildcard", async () => {
      expect(await test({ detail: { name: [{ wildcard: "Widget*" }] } })).toBe(true);
    });

    it("rejects invalid pattern JSON", async () => {
      await expectError(
        eb.send(new TestEventPatternCommand({ EventPattern: "{bad", Event: JSON.stringify(baseEvent) })),
        "InvalidEventPatternException",
      );
    });

    it("rejects an event missing envelope fields", async () => {
      await expectError(
        eb.send(
          new TestEventPatternCommand({
            EventPattern: JSON.stringify({ source: ["my.app"] }),
            Event: JSON.stringify({ source: "my.app" }),
          }),
        ),
        "ValidationException",
      );
    });
  });

  // =======================================================================
  describe("Archives", () => {
    const eventSourceArn = "arn:aws:events:us-east-1:000000000000:event-bus/default";

    it("creates an archive", async () => {
      const res = await eb.send(
        new CreateArchiveCommand({ ArchiveName: "arch-1", EventSourceArn: eventSourceArn }),
      );
      expect(res.ArchiveArn).toContain("archive/arch-1");
      expect(res.State).toBe("ENABLED");
    });

    it("rejects duplicate archive", async () => {
      await eb.send(new CreateArchiveCommand({ ArchiveName: "dup-arch", EventSourceArn: eventSourceArn }));
      await expectError(
        eb.send(new CreateArchiveCommand({ ArchiveName: "dup-arch", EventSourceArn: eventSourceArn })),
        "ResourceAlreadyExistsException",
      );
    });

    it("describes an archive", async () => {
      await eb.send(
        new CreateArchiveCommand({
          ArchiveName: "desc-arch",
          EventSourceArn: eventSourceArn,
          Description: "d",
        }),
      );
      const res = await eb.send(new DescribeArchiveCommand({ ArchiveName: "desc-arch" }));
      expect(res.ArchiveName).toBe("desc-arch");
      expect(res.Description).toBe("d");
    });

    it("lists archives", async () => {
      await eb.send(new CreateArchiveCommand({ ArchiveName: "la-1", EventSourceArn: eventSourceArn }));
      const res = await eb.send(new ListArchivesCommand({ NamePrefix: "la-" }));
      expect(res.Archives?.length).toBe(1);
    });

    it("updates an archive", async () => {
      await eb.send(new CreateArchiveCommand({ ArchiveName: "upd-arch", EventSourceArn: eventSourceArn }));
      const res = await eb.send(
        new UpdateArchiveCommand({ ArchiveName: "upd-arch", RetentionDays: 7 }),
      );
      expect(res.ArchiveArn).toContain("archive/upd-arch");
      const desc = await eb.send(new DescribeArchiveCommand({ ArchiveName: "upd-arch" }));
      expect(desc.RetentionDays).toBe(7);
    });

    it("deletes an archive", async () => {
      await eb.send(new CreateArchiveCommand({ ArchiveName: "del-arch", EventSourceArn: eventSourceArn }));
      await eb.send(new DeleteArchiveCommand({ ArchiveName: "del-arch" }));
      await expectError(
        eb.send(new DescribeArchiveCommand({ ArchiveName: "del-arch" })),
        "ResourceNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("Replays", () => {
    const eventSourceArn = "arn:aws:events:us-east-1:000000000000:archive/src-arch";
    const destination = { Arn: "arn:aws:events:us-east-1:000000000000:event-bus/default" };

    async function startReplay(name: string) {
      return eb.send(
        new StartReplayCommand({
          ReplayName: name,
          EventSourceArn: eventSourceArn,
          Destination: destination,
          EventStartTime: new Date(Date.now() - 3600_000),
          EventEndTime: new Date(),
        }),
      );
    }

    it("starts a replay", async () => {
      const res = await startReplay("replay-1");
      expect(res.ReplayArn).toContain("replay/replay-1");
      expect(res.State).toBe("STARTING");
    });

    it("rejects duplicate replay", async () => {
      await startReplay("dup-replay");
      await expectError(startReplay("dup-replay"), "ResourceAlreadyExistsException");
    });

    it("describes a replay", async () => {
      await startReplay("desc-replay");
      const res = await eb.send(new DescribeReplayCommand({ ReplayName: "desc-replay" }));
      expect(res.ReplayName).toBe("desc-replay");
      expect(res.State).toBe("COMPLETED");
    });

    it("lists replays", async () => {
      await startReplay("lr-1");
      const res = await eb.send(new ListReplaysCommand({ NamePrefix: "lr-" }));
      expect(res.Replays?.length).toBe(1);
    });

    it("cancel a completed replay throws IllegalStatus", async () => {
      await startReplay("cancel-replay");
      await expectError(
        eb.send(new CancelReplayCommand({ ReplayName: "cancel-replay" })),
        "IllegalStatusException",
      );
    });

    it("requires start/end times", async () => {
      await expectError(
        eb.send(
          new StartReplayCommand({
            ReplayName: "bad-replay",
            EventSourceArn: eventSourceArn,
            Destination: destination,
          } as any),
        ),
        "ValidationException",
      );
    });
  });

  // =======================================================================
  describe("Connections", () => {
    const authParams = {
      ApiKeyAuthParameters: { ApiKeyName: "x-api-key", ApiKeyValue: "secret-value" },
    };

    it("creates a connection", async () => {
      const res = await eb.send(
        new CreateConnectionCommand({
          Name: "conn-1",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      expect(res.ConnectionArn).toContain("connection/conn-1");
      expect(res.ConnectionState).toBe("AUTHORIZED");
    });

    it("rejects duplicate connection", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "dup-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      await expectError(
        eb.send(
          new CreateConnectionCommand({
            Name: "dup-conn",
            AuthorizationType: "API_KEY",
            AuthParameters: authParams,
          }),
        ),
        "ResourceAlreadyExistsException",
      );
    });

    it("describes a connection and redacts secrets", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "desc-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      const res = await eb.send(new DescribeConnectionCommand({ Name: "desc-conn" }));
      expect(res.Name).toBe("desc-conn");
      expect(res.SecretArn).toContain("secret:events!connection");
      expect((res.AuthParameters as any)?.ApiKeyAuthParameters?.ApiKeyValue).toBeUndefined();
    });

    it("lists connections", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "lc-1",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      const res = await eb.send(new ListConnectionsCommand({ NamePrefix: "lc-" }));
      expect(res.Connections?.length).toBe(1);
    });

    it("updates a connection", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "upd-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      const res = await eb.send(
        new UpdateConnectionCommand({ Name: "upd-conn", Description: "new desc" }),
      );
      expect(res.ConnectionState).toBe("AUTHORIZED");
    });

    it("deauthorizes a connection", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "deauth-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      const res = await eb.send(new DeauthorizeConnectionCommand({ Name: "deauth-conn" }));
      expect(res.ConnectionState).toBe("DEAUTHORIZED");
    });

    it("deletes a connection", async () => {
      await eb.send(
        new CreateConnectionCommand({
          Name: "del-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: authParams,
        }),
      );
      const res = await eb.send(new DeleteConnectionCommand({ Name: "del-conn" }));
      expect(res.ConnectionState).toBe("DELETING");
    });
  });

  // =======================================================================
  describe("API destinations", () => {
    let connectionArn: string;

    beforeEach(async () => {
      const conn = await eb.send(
        new CreateConnectionCommand({
          Name: "api-conn",
          AuthorizationType: "API_KEY",
          AuthParameters: { ApiKeyAuthParameters: { ApiKeyName: "k", ApiKeyValue: "v" } },
        }),
      );
      connectionArn = conn.ConnectionArn!;
    });

    it("creates an api destination", async () => {
      const res = await eb.send(
        new CreateApiDestinationCommand({
          Name: "dest-1",
          ConnectionArn: connectionArn,
          InvocationEndpoint: "https://example.com/hook",
          HttpMethod: "POST",
        }),
      );
      expect(res.ApiDestinationArn).toContain("api-destination/dest-1");
      expect(res.ApiDestinationState).toBe("ACTIVE");
    });

    it("describes an api destination", async () => {
      await eb.send(
        new CreateApiDestinationCommand({
          Name: "dest-desc",
          ConnectionArn: connectionArn,
          InvocationEndpoint: "https://example.com/hook",
          HttpMethod: "GET",
        }),
      );
      const res = await eb.send(new DescribeApiDestinationCommand({ Name: "dest-desc" }));
      expect(res.HttpMethod).toBe("GET");
      expect(res.InvocationRateLimitPerSecond).toBe(300);
    });

    it("lists api destinations", async () => {
      await eb.send(
        new CreateApiDestinationCommand({
          Name: "ld-1",
          ConnectionArn: connectionArn,
          InvocationEndpoint: "https://example.com/hook",
          HttpMethod: "POST",
        }),
      );
      const res = await eb.send(new ListApiDestinationsCommand({ NamePrefix: "ld-" }));
      expect(res.ApiDestinations?.length).toBe(1);
    });

    it("updates an api destination", async () => {
      await eb.send(
        new CreateApiDestinationCommand({
          Name: "upd-dest",
          ConnectionArn: connectionArn,
          InvocationEndpoint: "https://example.com/hook",
          HttpMethod: "POST",
        }),
      );
      await eb.send(
        new UpdateApiDestinationCommand({ Name: "upd-dest", InvocationRateLimitPerSecond: 10 }),
      );
      const res = await eb.send(new DescribeApiDestinationCommand({ Name: "upd-dest" }));
      expect(res.InvocationRateLimitPerSecond).toBe(10);
    });

    it("deletes an api destination", async () => {
      await eb.send(
        new CreateApiDestinationCommand({
          Name: "del-dest",
          ConnectionArn: connectionArn,
          InvocationEndpoint: "https://example.com/hook",
          HttpMethod: "POST",
        }),
      );
      await eb.send(new DeleteApiDestinationCommand({ Name: "del-dest" }));
      await expectError(
        eb.send(new DescribeApiDestinationCommand({ Name: "del-dest" })),
        "ResourceNotFoundException",
      );
    });

    it("rejects api destination with missing connection arn", async () => {
      await expectError(
        eb.send(
          new CreateApiDestinationCommand({
            Name: "no-conn",
            InvocationEndpoint: "https://example.com",
            HttpMethod: "POST",
          } as any),
        ),
        "ValidationException",
      );
    });
  });

  // =======================================================================
  describe("Endpoints", () => {
    const routingConfig = {
      FailoverConfig: {
        Primary: { HealthCheck: "arn:aws:route53:::healthcheck/abc" },
        Secondary: { Route: "us-west-2" },
      },
    };
    const eventBuses = [
      { EventBusArn: "arn:aws:events:us-east-1:000000000000:event-bus/default" },
      { EventBusArn: "arn:aws:events:us-west-2:000000000000:event-bus/default" },
    ];

    it("creates an endpoint", async () => {
      const res = await eb.send(
        new CreateEndpointCommand({
          Name: "ep-1",
          RoutingConfig: routingConfig,
          EventBuses: eventBuses,
        }),
      );
      expect(res.Name).toBe("ep-1");
      expect(res.State).toBe("CREATING");
    });

    it("describes an endpoint", async () => {
      await eb.send(
        new CreateEndpointCommand({
          Name: "ep-desc",
          RoutingConfig: routingConfig,
          EventBuses: eventBuses,
        }),
      );
      const res = await eb.send(new DescribeEndpointCommand({ Name: "ep-desc" }));
      expect(res.Name).toBe("ep-desc");
      expect(res.EndpointUrl).toContain("endpoint.events.amazonaws.com");
    });

    it("lists endpoints", async () => {
      await eb.send(
        new CreateEndpointCommand({
          Name: "le-1",
          RoutingConfig: routingConfig,
          EventBuses: eventBuses,
        }),
      );
      const res = await eb.send(new ListEndpointsCommand({ NamePrefix: "le-" }));
      expect(res.Endpoints?.length).toBe(1);
    });

    it("updates an endpoint", async () => {
      await eb.send(
        new CreateEndpointCommand({
          Name: "ep-upd",
          RoutingConfig: routingConfig,
          EventBuses: eventBuses,
        }),
      );
      const res = await eb.send(
        new UpdateEndpointCommand({ Name: "ep-upd", Description: "updated" }),
      );
      expect(res.State).toBe("UPDATING");
    });

    it("deletes an endpoint", async () => {
      await eb.send(
        new CreateEndpointCommand({
          Name: "ep-del",
          RoutingConfig: routingConfig,
          EventBuses: eventBuses,
        }),
      );
      await eb.send(new DeleteEndpointCommand({ Name: "ep-del" }));
      await expectError(
        eb.send(new DescribeEndpointCommand({ Name: "ep-del" })),
        "ResourceNotFoundException",
      );
    });
  });

  // =======================================================================
  describe("Partner event sources", () => {
    it("creates a partner event source", async () => {
      const res = await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source1",
          Account: "111122223333",
        }),
      );
      expect(res.EventSourceArn).toContain("event-source/aws.partner");
    });

    it("describes a partner event source", async () => {
      await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source2",
          Account: "111122223333",
        }),
      );
      const res = await eb.send(
        new DescribePartnerEventSourceCommand({ Name: "aws.partner/example.com/source2" }),
      );
      expect(res.Name).toBe("aws.partner/example.com/source2");
    });

    it("lists partner event sources", async () => {
      await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source3",
          Account: "111122223333",
        }),
      );
      const res = await eb.send(
        new ListPartnerEventSourcesCommand({ NamePrefix: "aws.partner/example.com" }),
      );
      expect(res.PartnerEventSources?.length).toBeGreaterThanOrEqual(1);
    });

    it("lists partner event source accounts", async () => {
      await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source4",
          Account: "111122223333",
        }),
      );
      const res = await eb.send(
        new ListPartnerEventSourceAccountsCommand({
          EventSourceName: "aws.partner/example.com/source4",
        }),
      );
      expect(res.PartnerEventSourceAccounts?.[0].Account).toBe("111122223333");
    });

    it("deletes a partner event source", async () => {
      await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source5",
          Account: "111122223333",
        }),
      );
      await eb.send(
        new DeletePartnerEventSourceCommand({
          Name: "aws.partner/example.com/source5",
          Account: "111122223333",
        }),
      );
      expect(server.partnerEventSources.has("aws.partner/example.com/source5")).toBe(false);
    });
  });

  // =======================================================================
  describe("Event sources (consumer side)", () => {
    beforeEach(async () => {
      await eb.send(
        new CreatePartnerEventSourceCommand({
          Name: "aws.partner/vendor.com/es",
          Account: "111122223333",
        }),
      );
    });

    it("describes an event source", async () => {
      const res = await eb.send(
        new DescribeEventSourceCommand({ Name: "aws.partner/vendor.com/es" }),
      );
      expect(res.Name).toBe("aws.partner/vendor.com/es");
      expect(res.State).toBe("PENDING");
    });

    it("lists event sources", async () => {
      const res = await eb.send(new ListEventSourcesCommand({ NamePrefix: "aws.partner/vendor.com" }));
      expect(res.EventSources?.length).toBeGreaterThanOrEqual(1);
    });

    it("activates and deactivates an event source", async () => {
      await eb.send(new ActivateEventSourceCommand({ Name: "aws.partner/vendor.com/es" }));
      let res = await eb.send(new DescribeEventSourceCommand({ Name: "aws.partner/vendor.com/es" }));
      expect(res.State).toBe("ACTIVE");
      await eb.send(new DeactivateEventSourceCommand({ Name: "aws.partner/vendor.com/es" }));
      res = await eb.send(new DescribeEventSourceCommand({ Name: "aws.partner/vendor.com/es" }));
      expect(res.State).toBe("DELETED");
    });
  });

  // =======================================================================
  describe("Tagging", () => {
    it("tags and lists tags on a rule", async () => {
      const rule = await makeRule("tagged-rule");
      await eb.send(
        new TagResourceCommand({
          ResourceARN: rule.RuleArn!,
          Tags: [{ Key: "env", Value: "test" }],
        }),
      );
      const res = await eb.send(new ListTagsForResourceCommand({ ResourceARN: rule.RuleArn! }));
      expect(res.Tags).toEqual([{ Key: "env", Value: "test" }]);
    });

    it("tags an event bus", async () => {
      const bus = await eb.send(new CreateEventBusCommand({ Name: "tagged-bus" }));
      await eb.send(
        new TagResourceCommand({
          ResourceARN: bus.EventBusArn!,
          Tags: [{ Key: "team", Value: "platform" }],
        }),
      );
      const res = await eb.send(new ListTagsForResourceCommand({ ResourceARN: bus.EventBusArn! }));
      expect(res.Tags).toEqual([{ Key: "team", Value: "platform" }]);
    });

    it("untags a resource", async () => {
      const rule = await makeRule("untag-rule");
      await eb.send(
        new TagResourceCommand({
          ResourceARN: rule.RuleArn!,
          Tags: [{ Key: "a", Value: "1" }, { Key: "b", Value: "2" }],
        }),
      );
      await eb.send(new UntagResourceCommand({ ResourceARN: rule.RuleArn!, TagKeys: ["a"] }));
      const res = await eb.send(new ListTagsForResourceCommand({ ResourceARN: rule.RuleArn! }));
      expect(res.Tags).toEqual([{ Key: "b", Value: "2" }]);
    });

    it("tagging an unknown resource throws ResourceNotFound", async () => {
      await expectError(
        eb.send(
          new TagResourceCommand({
            ResourceARN: "arn:aws:events:us-east-1:000000000000:rule/ghost",
            Tags: [{ Key: "x", Value: "y" }],
          }),
        ),
        "ResourceNotFoundException",
      );
    });
  });
});
