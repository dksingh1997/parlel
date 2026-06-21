import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EventbridgeSchedulerServer } from "../services/eventbridge-scheduler/src/server.js";

const PORT = 14740;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

const TARGET = { Arn: "arn:aws:lambda:us-east-1:000000000000:function:fn", RoleArn: "arn:aws:iam::000000000000:role/r" };

let server: EventbridgeSchedulerServer;

beforeAll(async () => {
  server = new EventbridgeSchedulerServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

describe("eventbridge-scheduler", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("eventbridge-scheduler");
  });

  it("default port 4740", () => {
    expect(new EventbridgeSchedulerServer().port).toBe(4740);
  });

  it("creates and gets a schedule", async () => {
    const c = await call("POST", "/schedules/s1", {
      ScheduleExpression: "rate(5 minutes)",
      Target: TARGET,
      FlexibleTimeWindow: { Mode: "OFF" },
    });
    expect(c.status).toBe(200);
    expect(c.json.ScheduleArn).toContain("schedule/default/s1");
    const g = await call("GET", "/schedules/s1");
    expect(g.status).toBe(200);
    expect(g.json.ScheduleExpression).toBe("rate(5 minutes)");
    expect(g.json.State).toBe("ENABLED");
  });

  it("requires ScheduleExpression", async () => {
    const c = await call("POST", "/schedules/bad", { Target: TARGET });
    expect(c.status).toBe(400);
  });

  it("updates a schedule", async () => {
    await call("POST", "/schedules/u1", { ScheduleExpression: "rate(1 hour)", Target: TARGET });
    const u = await call("PUT", "/schedules/u1", {
      ScheduleExpression: "rate(2 hours)",
      Target: TARGET,
      State: "DISABLED",
    });
    expect(u.status).toBe(200);
    const g = await call("GET", "/schedules/u1");
    expect(g.json.ScheduleExpression).toBe("rate(2 hours)");
    expect(g.json.State).toBe("DISABLED");
  });

  it("lists schedules", async () => {
    await call("POST", "/schedules/l1", { ScheduleExpression: "rate(1 hour)", Target: TARGET });
    await call("POST", "/schedules/l2", { ScheduleExpression: "rate(1 hour)", Target: TARGET });
    const list = await call("GET", "/schedules");
    expect(list.status).toBe(200);
    expect(list.json.Schedules.length).toBe(2);
  });

  it("deletes a schedule", async () => {
    await call("POST", "/schedules/d1", { ScheduleExpression: "rate(1 hour)", Target: TARGET });
    const d = await call("DELETE", "/schedules/d1");
    expect(d.status).toBe(200);
    const g = await call("GET", "/schedules/d1");
    expect(g.status).toBe(404);
  });

  it("creates schedule in a custom group", async () => {
    await call("POST", "/schedule-groups/grp", {});
    const c = await call("POST", "/schedules/gs?groupName=grp", {
      ScheduleExpression: "rate(1 hour)",
      Target: TARGET,
      GroupName: "grp",
    });
    expect(c.status).toBe(200);
    expect(c.json.ScheduleArn).toContain("schedule/grp/gs");
  });

  it("creates, gets, lists, deletes schedule groups", async () => {
    const c = await call("POST", "/schedule-groups/g1", {});
    expect(c.status).toBe(200);
    expect(c.json.ScheduleGroupArn).toContain("schedule-group/g1");
    const g = await call("GET", "/schedule-groups/g1");
    expect(g.json.State).toBe("ACTIVE");
    const list = await call("GET", "/schedule-groups");
    // default + g1
    expect(list.json.ScheduleGroups.length).toBe(2);
    const d = await call("DELETE", "/schedule-groups/g1");
    expect(d.status).toBe(200);
  });

  it("cannot delete default group", async () => {
    const d = await call("DELETE", "/schedule-groups/default");
    expect(d.status).toBe(400);
  });

  it("404 for missing schedule", async () => {
    const g = await call("GET", "/schedules/missing");
    expect(g.status).toBe(404);
  });
});
