import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BackupServer } from "../services/backup/src/server.js";

const PORT = 14741;
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

let server: BackupServer;

beforeAll(async () => {
  server = new BackupServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

async function mkVault(name = "vault1") {
  return call("PUT", `/backup-vaults/${name}`, {});
}

describe("backup", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("backup");
  });

  it("default port 4741", () => {
    expect(new BackupServer().port).toBe(4741);
  });

  it("creates and describes a vault", async () => {
    const c = await mkVault("v1");
    expect(c.status).toBe(200);
    expect(c.json.BackupVaultArn).toContain("backup-vault:v1");
    const d = await call("GET", "/backup-vaults/v1");
    expect(d.status).toBe(200);
    expect(d.json.BackupVaultName).toBe("v1");
  });

  it("lists vaults and deletes", async () => {
    await mkVault("v1");
    await mkVault("v2");
    const list = await call("GET", "/backup-vaults");
    expect(list.json.BackupVaultList.length).toBe(2);
    const del = await call("DELETE", "/backup-vaults/v1");
    expect(del.status).toBe(200);
    const d = await call("GET", "/backup-vaults/v1");
    expect(d.status).toBe(400);
  });

  it("creates a backup plan and gets it", async () => {
    const c = await call("PUT", "/backup/plans", {
      BackupPlan: {
        BackupPlanName: "plan1",
        Rules: [{ RuleName: "daily", TargetBackupVaultName: "v1", ScheduleExpression: "cron(0 5 * * ? *)" }],
      },
    });
    expect(c.status).toBe(200);
    const planId = c.json.BackupPlanId;
    expect(planId).toBeTruthy();
    const g = await call("GET", `/backup/plans/${planId}`);
    expect(g.status).toBe(200);
    expect(g.json.BackupPlan.BackupPlanName).toBe("plan1");
  });

  it("lists backup plans", async () => {
    await call("PUT", "/backup/plans", { BackupPlan: { BackupPlanName: "p1", Rules: [] } });
    await call("PUT", "/backup/plans", { BackupPlan: { BackupPlanName: "p2", Rules: [] } });
    const list = await call("GET", "/backup/plans");
    expect(list.json.BackupPlansList.length).toBe(2);
  });

  it("creates a backup selection", async () => {
    const c = await call("PUT", "/backup/plans", { BackupPlan: { BackupPlanName: "p1", Rules: [] } });
    const planId = c.json.BackupPlanId;
    const sel = await call("PUT", `/backup/plans/${planId}/selections`, {
      BackupSelection: {
        SelectionName: "sel1",
        IamRoleArn: "arn:aws:iam::000000000000:role/backup",
        Resources: ["*"],
      },
    });
    expect(sel.status).toBe(200);
    expect(sel.json.SelectionId).toBeTruthy();
    const list = await call("GET", `/backup/plans/${planId}/selections`);
    expect(list.json.BackupSelectionsList.length).toBe(1);
  });

  it("starts a backup job and describes it", async () => {
    await mkVault("v1");
    const start = await call("PUT", "/backup-jobs", {
      BackupVaultName: "v1",
      ResourceArn: "arn:aws:dynamodb:us-east-1:000000000000:table/t1",
      IamRoleArn: "arn:aws:iam::000000000000:role/backup",
    });
    expect(start.status).toBe(200);
    const jobId = start.json.BackupJobId;
    expect(jobId).toBeTruthy();
    expect(start.json.RecoveryPointArn).toContain("recovery-point");
    const d = await call("GET", `/backup-jobs/${jobId}`);
    expect(d.status).toBe(200);
    expect(d.json.State).toBe("COMPLETED");
    expect(d.json.ResourceType).toBe("DynamoDB");
  });

  it("lists backup jobs", async () => {
    await mkVault("v1");
    await call("PUT", "/backup-jobs", {
      BackupVaultName: "v1",
      ResourceArn: "arn:aws:ec2:us-east-1:000000000000:volume/vol-1",
    });
    const list = await call("GET", "/backup-jobs");
    expect(list.json.BackupJobs.length).toBe(1);
  });

  it("rejects job for missing vault", async () => {
    const start = await call("PUT", "/backup-jobs", {
      BackupVaultName: "missing",
      ResourceArn: "arn:aws:ec2:us-east-1:000000000000:volume/vol-1",
    });
    expect(start.status).toBe(400);
  });
});
