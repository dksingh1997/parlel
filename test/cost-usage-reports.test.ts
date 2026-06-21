import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CostUsageReportsServer } from "../services/cost-usage-reports/src/server.js";

const PORT = 14737;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(op: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSOrigamiServiceGatewayService.${op}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

const DEF = {
  ReportName: "monthly",
  TimeUnit: "MONTHLY",
  Format: "textORcsv",
  Compression: "GZIP",
  AdditionalSchemaElements: ["RESOURCES"],
  S3Bucket: "cur-bucket",
  S3Prefix: "cur/",
  S3Region: "us-east-1",
};

describe("CostUsageReports Service", () => {
  let server: CostUsageReportsServer;

  beforeAll(async () => {
    server = new CostUsageReportsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4737", () => {
    expect(new CostUsageReportsServer().port).toBe(4737);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("cost-usage-reports");
  });

  it("puts and describes a report definition", async () => {
    const p = await call("PutReportDefinition", { ReportDefinition: DEF });
    expect(p.status).toBe(200);
    const d = await call("DescribeReportDefinitions", {});
    expect(d.json.ReportDefinitions.length).toBe(1);
    expect(d.json.ReportDefinitions[0].ReportName).toBe("monthly");
  });

  it("rejects duplicate report name", async () => {
    await call("PutReportDefinition", { ReportDefinition: DEF });
    const p = await call("PutReportDefinition", { ReportDefinition: DEF });
    expect(p.status).toBe(400);
    expect(p.json.__type).toBe("DuplicateReportNameException");
  });

  it("validates required fields", async () => {
    const p = await call("PutReportDefinition", { ReportDefinition: { ReportName: "x" } });
    expect(p.status).toBe(400);
    expect(p.json.__type).toBe("ValidationException");
  });

  it("modifies a report definition", async () => {
    await call("PutReportDefinition", { ReportDefinition: DEF });
    const m = await call("ModifyReportDefinition", {
      ReportName: "monthly",
      ReportDefinition: { ...DEF, S3Prefix: "new-prefix/" },
    });
    expect(m.status).toBe(200);
    const d = await call("DescribeReportDefinitions", {});
    expect(d.json.ReportDefinitions[0].S3Prefix).toBe("new-prefix/");
  });

  it("deletes a report definition", async () => {
    await call("PutReportDefinition", { ReportDefinition: DEF });
    const del = await call("DeleteReportDefinition", { ReportName: "monthly" });
    expect(del.status).toBe(200);
    const d = await call("DescribeReportDefinitions", {});
    expect(d.json.ReportDefinitions.length).toBe(0);
  });

  it("rejects modifying a missing report", async () => {
    const m = await call("ModifyReportDefinition", { ReportName: "ghost", ReportDefinition: DEF });
    expect(m.status).toBe(404);
    expect(m.json.__type).toBe("ResourceNotFoundException");
  });
});
