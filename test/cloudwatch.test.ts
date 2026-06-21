import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  CloudWatchClient,
  // Metrics
  PutMetricDataCommand,
  GetMetricDataCommand,
  GetMetricStatisticsCommand,
  ListMetricsCommand,
  GetMetricWidgetImageCommand,
  // Alarms
  PutMetricAlarmCommand,
  PutCompositeAlarmCommand,
  DescribeAlarmsCommand,
  DescribeAlarmsForMetricCommand,
  DescribeAlarmHistoryCommand,
  DescribeAlarmContributorsCommand,
  DeleteAlarmsCommand,
  SetAlarmStateCommand,
  EnableAlarmActionsCommand,
  DisableAlarmActionsCommand,
  // Alarm mute rules
  PutAlarmMuteRuleCommand,
  GetAlarmMuteRuleCommand,
  DeleteAlarmMuteRuleCommand,
  ListAlarmMuteRulesCommand,
  // Dashboards
  PutDashboardCommand,
  GetDashboardCommand,
  ListDashboardsCommand,
  DeleteDashboardsCommand,
  // Anomaly detectors
  PutAnomalyDetectorCommand,
  DescribeAnomalyDetectorsCommand,
  DeleteAnomalyDetectorCommand,
  // Insight rules
  PutInsightRuleCommand,
  DescribeInsightRulesCommand,
  DeleteInsightRulesCommand,
  EnableInsightRulesCommand,
  DisableInsightRulesCommand,
  GetInsightRuleReportCommand,
  // Managed insight rules
  PutManagedInsightRulesCommand,
  ListManagedInsightRulesCommand,
  // Metric streams
  PutMetricStreamCommand,
  GetMetricStreamCommand,
  ListMetricStreamsCommand,
  DeleteMetricStreamCommand,
  StartMetricStreamsCommand,
  StopMetricStreamsCommand,
  // Tags
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
  // Datasets
  GetDatasetCommand,
  AssociateDatasetKmsKeyCommand,
  DisassociateDatasetKmsKeyCommand,
  // OTel enrichment
  GetOTelEnrichmentCommand,
  StartOTelEnrichmentCommand,
  StopOTelEnrichmentCommand,
} from "@aws-sdk/client-cloudwatch";
import { CloudwatchServer } from "../services/cloudwatch/src/server.js";

const PORT = 14574;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

function makeClient() {
  return new CloudWatchClient({
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

// Send a raw JSON-1.0 request directly to the server, bypassing the SDK's
// client-side required-parameter validation. Returns { status, json }.
async function rawCall(operation: string, body: Record<string, unknown>) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Target": `GraniteServiceVersion20100801.${operation}`,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

// Assert that a raw server call returns the given error __type.
async function expectRawError(
  operation: string,
  body: Record<string, unknown>,
  code: string,
) {
  const { json } = await rawCall(operation, body);
  expect(json.__type).toContain(code);
}

describe("CloudWatch Service", () => {
  let server: CloudwatchServer;
  let cw: CloudWatchClient;

  beforeAll(async () => {
    server = new CloudwatchServer(PORT);
    await server.start();
    cw = makeClient();
    await new Promise((r) => setTimeout(r, 100));
  }, 15000);

  afterAll(async () => {
    cw.destroy();
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // Helper: push a metric and read it back.
  async function putValue(
    namespace: string,
    metricName: string,
    value: number,
    timestamp: Date,
    dimensions?: { Name: string; Value: string }[],
    unit?: string,
  ) {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: [
          {
            MetricName: metricName,
            Value: value,
            Timestamp: timestamp,
            Dimensions: dimensions,
            Unit: unit as any,
          },
        ],
      }),
    );
  }

  // -----------------------------------------------------------------------
  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("defaults to port 4574", () => {
      const s = new CloudwatchServer();
      expect(s.port).toBe(4574);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.status).toBe("ok");
      expect(json.service).toBe("cloudwatch");
    });

    it("supports reset over HTTP", async () => {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: "reset-me",
          MetricName: "X",
          Namespace: "N",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
        }),
      );
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const out = await cw.send(new DescribeAlarmsCommand({}));
      expect(out.MetricAlarms?.length).toBe(0);
    });

    it("rejects non-POST API requests", async () => {
      const res = await fetch(ENDPOINT, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });

  // -----------------------------------------------------------------------
  describe("PutMetricData", () => {
    it("accepts a simple value datapoint", async () => {
      const res = await cw.send(
        new PutMetricDataCommand({
          Namespace: "MyApp",
          MetricData: [{ MetricName: "Latency", Value: 100, Unit: "Milliseconds" }],
        }),
      );
      expect(res.$metadata.httpStatusCode).toBe(200);
    });

    it("accepts statistic values", async () => {
      const res = await cw.send(
        new PutMetricDataCommand({
          Namespace: "MyApp",
          MetricData: [
            {
              MetricName: "Sized",
              StatisticValues: { SampleCount: 10, Sum: 100, Minimum: 1, Maximum: 50 },
            },
          ],
        }),
      );
      expect(res.$metadata.httpStatusCode).toBe(200);
    });

    it("accepts values + counts (histogram)", async () => {
      const res = await cw.send(
        new PutMetricDataCommand({
          Namespace: "MyApp",
          MetricData: [
            { MetricName: "Hist", Values: [1, 2, 3], Counts: [10, 20, 30], StorageResolution: 1 },
          ],
        }),
      );
      expect(res.$metadata.httpStatusCode).toBe(200);
    });

    it("requires a Namespace", async () => {
      await expectRawError(
        "PutMetricData",
        { MetricData: [{ MetricName: "X", Value: 1 }] },
        "MissingParameter",
      );
    });

    it("rejects reserved AWS/ namespace", async () => {
      await expectError(
        cw.send(
          new PutMetricDataCommand({
            Namespace: "AWS/EC2",
            MetricData: [{ MetricName: "X", Value: 1 }],
          }),
        ),
        "InvalidParameterValue",
      );
    });

    it("rejects a datum with no value at all", async () => {
      await expectError(
        cw.send(
          new PutMetricDataCommand({
            Namespace: "MyApp",
            MetricData: [{ MetricName: "Empty" }],
          }),
        ),
        "InvalidParameterCombination",
      );
    });

    it("rejects mismatched Values/Counts lengths", async () => {
      await expectError(
        cw.send(
          new PutMetricDataCommand({
            Namespace: "MyApp",
            MetricData: [{ MetricName: "Bad", Values: [1, 2], Counts: [1] }],
          }),
        ),
        "InvalidParameterValue",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("GetMetricStatistics", () => {
    const t0 = new Date("2020-01-01T00:00:00Z");
    const t1 = new Date("2020-01-01T00:00:30Z");
    const t2 = new Date("2020-01-01T00:01:30Z");

    it("aggregates Average / Sum / Min / Max / SampleCount per period", async () => {
      await putValue("Stats", "M", 10, t0);
      await putValue("Stats", "M", 20, t1);
      await putValue("Stats", "M", 60, t2);

      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "Stats",
          MetricName: "M",
          StartTime: t0,
          EndTime: new Date("2020-01-01T00:02:00Z"),
          Period: 60,
          Statistics: ["Average", "Sum", "Minimum", "Maximum", "SampleCount"],
        }),
      );
      expect(res.Label).toBe("M");
      expect(res.Datapoints?.length).toBe(2);
      const first = res.Datapoints!.find(
        (d) => d.Timestamp!.getTime() === t0.getTime(),
      )!;
      expect(first.Sum).toBe(30);
      expect(first.Average).toBe(15);
      expect(first.Minimum).toBe(10);
      expect(first.Maximum).toBe(20);
      expect(first.SampleCount).toBe(2);
      const second = res.Datapoints!.find(
        (d) => d.Timestamp!.getTime() === new Date("2020-01-01T00:01:00Z").getTime(),
      )!;
      expect(second.Sum).toBe(60);
    });

    it("computes extended (percentile) statistics", async () => {
      for (let i = 1; i <= 100; i++) {
        await putValue("Stats", "P", i, t0);
      }
      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "Stats",
          MetricName: "P",
          StartTime: t0,
          EndTime: new Date("2020-01-01T00:01:00Z"),
          Period: 60,
          ExtendedStatistics: ["p50", "p99"],
        }),
      );
      const dp = res.Datapoints![0];
      expect(dp.ExtendedStatistics!.p50).toBeGreaterThan(45);
      expect(dp.ExtendedStatistics!.p50).toBeLessThan(55);
      expect(dp.ExtendedStatistics!.p99).toBeGreaterThan(95);
    });

    it("returns empty datapoints for unknown metric", async () => {
      const res = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "Nope",
          MetricName: "Nope",
          StartTime: t0,
          EndTime: t2,
          Period: 60,
          Statistics: ["Average"],
        }),
      );
      expect(res.Datapoints).toEqual([]);
    });

    it("requires statistics", async () => {
      await expectRawError(
        "GetMetricStatistics",
        {
          Namespace: "Stats",
          MetricName: "M",
          StartTime: t0.getTime() / 1000,
          EndTime: t2.getTime() / 1000,
          Period: 60,
        },
        "MissingParameter",
      );
    });

    it("rejects StartTime >= EndTime", async () => {
      await expectError(
        cw.send(
          new GetMetricStatisticsCommand({
            Namespace: "Stats",
            MetricName: "M",
            StartTime: t2,
            EndTime: t0,
            Period: 60,
            Statistics: ["Average"],
          }),
        ),
        "InvalidParameterValue",
      );
    });

    it("respects dimensions when matching series", async () => {
      const dims = [{ Name: "Host", Value: "h1" }];
      await putValue("Stats", "D", 42, t0, dims);
      const matched = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "Stats",
          MetricName: "D",
          Dimensions: dims,
          StartTime: t0,
          EndTime: new Date("2020-01-01T00:01:00Z"),
          Period: 60,
          Statistics: ["Sum"],
        }),
      );
      expect(matched.Datapoints![0].Sum).toBe(42);

      const unmatched = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "Stats",
          MetricName: "D",
          StartTime: t0,
          EndTime: new Date("2020-01-01T00:01:00Z"),
          Period: 60,
          Statistics: ["Sum"],
        }),
      );
      expect(unmatched.Datapoints).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  describe("GetMetricData", () => {
    const start = new Date("2020-01-01T00:00:00Z");
    const end = new Date("2020-01-01T00:02:00Z");

    it("returns metric-stat query results", async () => {
      await putValue("MD", "Lat", 10, new Date("2020-01-01T00:00:10Z"));
      await putValue("MD", "Lat", 30, new Date("2020-01-01T00:00:50Z"));
      const res = await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          MetricDataQueries: [
            {
              Id: "m1",
              MetricStat: {
                Metric: { Namespace: "MD", MetricName: "Lat" },
                Period: 60,
                Stat: "Average",
              },
              ReturnData: true,
            },
          ],
        }),
      );
      expect(res.MetricDataResults?.length).toBe(1);
      const r = res.MetricDataResults![0];
      expect(r.Id).toBe("m1");
      expect(r.StatusCode).toBe("Complete");
      expect(r.Values).toEqual([20]);
    });

    it("evaluates a math expression referencing another query", async () => {
      await putValue("MD", "Base", 5, new Date("2020-01-01T00:00:10Z"));
      const res = await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          ScanBy: "TimestampAscending",
          MetricDataQueries: [
            {
              Id: "m1",
              MetricStat: {
                Metric: { Namespace: "MD", MetricName: "Base" },
                Period: 60,
                Stat: "Sum",
              },
              ReturnData: false,
            },
            { Id: "e1", Expression: "m1 * 2", Label: "double" },
          ],
        }),
      );
      // only e1 returned (m1 ReturnData=false)
      const ids = res.MetricDataResults!.map((r) => r.Id);
      expect(ids).toContain("e1");
      expect(ids).not.toContain("m1");
      const e1 = res.MetricDataResults!.find((r) => r.Id === "e1")!;
      expect(e1.Label).toBe("double");
      expect(e1.Values).toEqual([10]);
    });

    it("orders timestamps by ScanBy", async () => {
      await putValue("MD", "Ord", 1, new Date("2020-01-01T00:00:10Z"));
      await putValue("MD", "Ord", 2, new Date("2020-01-01T00:01:10Z"));
      const desc = await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          ScanBy: "TimestampDescending",
          MetricDataQueries: [
            {
              Id: "m1",
              MetricStat: {
                Metric: { Namespace: "MD", MetricName: "Ord" },
                Period: 60,
                Stat: "Sum",
              },
            },
          ],
        }),
      );
      const ts = desc.MetricDataResults![0].Timestamps!;
      expect(ts[0].getTime()).toBeGreaterThan(ts[1].getTime());
    });

    it("requires MetricDataQueries", async () => {
      await expectRawError(
        "GetMetricData",
        {
          StartTime: start.getTime() / 1000,
          EndTime: end.getTime() / 1000,
          MetricDataQueries: [],
        },
        "MissingParameter",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("ListMetrics", () => {
    beforeEach(async () => {
      await putValue("App1", "Latency", 1, new Date(), [{ Name: "Host", Value: "h1" }]);
      await putValue("App1", "Errors", 1, new Date(), [{ Name: "Host", Value: "h2" }]);
      await putValue("App2", "Latency", 1, new Date());
    });

    it("lists all metrics", async () => {
      const res = await cw.send(new ListMetricsCommand({}));
      expect(res.Metrics!.length).toBe(3);
    });

    it("filters by namespace", async () => {
      const res = await cw.send(new ListMetricsCommand({ Namespace: "App1" }));
      expect(res.Metrics!.length).toBe(2);
      expect(res.Metrics!.every((m) => m.Namespace === "App1")).toBe(true);
    });

    it("filters by metric name", async () => {
      const res = await cw.send(new ListMetricsCommand({ MetricName: "Latency" }));
      expect(res.Metrics!.length).toBe(2);
    });

    it("filters by dimension name+value", async () => {
      const res = await cw.send(
        new ListMetricsCommand({ Dimensions: [{ Name: "Host", Value: "h1" }] }),
      );
      expect(res.Metrics!.length).toBe(1);
      expect(res.Metrics![0].MetricName).toBe("Latency");
    });
  });

  // -----------------------------------------------------------------------
  describe("GetMetricWidgetImage", () => {
    it("returns a PNG image blob", async () => {
      const res = await cw.send(
        new GetMetricWidgetImageCommand({ MetricWidget: JSON.stringify({ metrics: [] }) }),
      );
      expect(res.MetricWidgetImage).toBeInstanceOf(Uint8Array);
      // PNG magic bytes
      const bytes = res.MetricWidgetImage!;
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50);
    });

    it("requires MetricWidget", async () => {
      await expectRawError("GetMetricWidgetImage", {}, "MissingParameter");
    });
  });

  // -----------------------------------------------------------------------
  describe("Metric alarms", () => {
    async function makeAlarm(name: string, extra: Record<string, any> = {}) {
      return cw.send(
        new PutMetricAlarmCommand({
          AlarmName: name,
          MetricName: "CPU",
          Namespace: "App",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 2,
          Threshold: 80,
          ComparisonOperator: "GreaterThanThreshold",
          ...extra,
        }),
      );
    }

    it("creates a metric alarm", async () => {
      await makeAlarm("cpu-high");
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms!.length).toBe(1);
      const a = res.MetricAlarms![0];
      expect(a.AlarmName).toBe("cpu-high");
      expect(a.StateValue).toBe("INSUFFICIENT_DATA");
      expect(a.Threshold).toBe(80);
      expect(a.AlarmArn).toContain(":alarm:cpu-high");
    });

    it("requires AlarmName", async () => {
      await expectRawError(
        "PutMetricAlarm",
        {
          MetricName: "X",
          Namespace: "N",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
        },
        "MissingParameter",
      );
    });

    it("requires a statistic for metric alarms", async () => {
      await expectRawError(
        "PutMetricAlarm",
        {
          AlarmName: "no-stat",
          MetricName: "X",
          Namespace: "N",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
        },
        "MissingParameter",
      );
    });

    it("updates an existing alarm (idempotent name)", async () => {
      await makeAlarm("cpu-high", { Threshold: 80 });
      await makeAlarm("cpu-high", { Threshold: 90 });
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms!.length).toBe(1);
      expect(res.MetricAlarms![0].Threshold).toBe(90);
    });

    it("filters DescribeAlarms by prefix and state", async () => {
      await makeAlarm("web-1");
      await makeAlarm("web-2");
      await makeAlarm("db-1");
      const byPrefix = await cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: "web-" }));
      expect(byPrefix.MetricAlarms!.length).toBe(2);

      await cw.send(
        new SetAlarmStateCommand({ AlarmName: "web-1", StateValue: "ALARM", StateReason: "test" }),
      );
      const byState = await cw.send(new DescribeAlarmsCommand({ StateValue: "ALARM" }));
      expect(byState.MetricAlarms!.length).toBe(1);
      expect(byState.MetricAlarms![0].AlarmName).toBe("web-1");
    });

    it("describes alarms for a specific metric", async () => {
      await makeAlarm("cpu-high");
      const res = await cw.send(
        new DescribeAlarmsForMetricCommand({ MetricName: "CPU", Namespace: "App" }),
      );
      expect(res.MetricAlarms!.length).toBe(1);
    });

    it("sets and transitions alarm state, recording history", async () => {
      await makeAlarm("cpu-high");
      await cw.send(
        new SetAlarmStateCommand({
          AlarmName: "cpu-high",
          StateValue: "ALARM",
          StateReason: "threshold crossed",
        }),
      );
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms![0].StateValue).toBe("ALARM");
      expect(res.MetricAlarms![0].StateReason).toBe("threshold crossed");

      const hist = await cw.send(
        new DescribeAlarmHistoryCommand({ AlarmName: "cpu-high", HistoryItemType: "StateUpdate" }),
      );
      expect(hist.AlarmHistoryItems!.length).toBeGreaterThanOrEqual(1);
      expect(hist.AlarmHistoryItems![0].HistoryItemType).toBe("StateUpdate");
    });

    it("rejects SetAlarmState for missing alarm", async () => {
      await expectError(
        cw.send(
          new SetAlarmStateCommand({ AlarmName: "ghost", StateValue: "OK", StateReason: "r" }),
        ),
        "ResourceNotFound",
      );
    });

    it("rejects invalid StateValue", async () => {
      await makeAlarm("cpu-high");
      await expectError(
        cw.send(
          new SetAlarmStateCommand({
            AlarmName: "cpu-high",
            StateValue: "WUT" as any,
            StateReason: "r",
          }),
        ),
        "InvalidParameterValue",
      );
    });

    it("enables and disables alarm actions", async () => {
      await makeAlarm("cpu-high", { ActionsEnabled: true });
      await cw.send(new DisableAlarmActionsCommand({ AlarmNames: ["cpu-high"] }));
      let res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms![0].ActionsEnabled).toBe(false);
      await cw.send(new EnableAlarmActionsCommand({ AlarmNames: ["cpu-high"] }));
      res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms![0].ActionsEnabled).toBe(true);
    });

    it("deletes alarms", async () => {
      await makeAlarm("cpu-high");
      await cw.send(new DeleteAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["cpu-high"] }));
      expect(res.MetricAlarms!.length).toBe(0);
    });

    it("rejects deleting a missing alarm", async () => {
      await expectError(
        cw.send(new DeleteAlarmsCommand({ AlarmNames: ["ghost"] })),
        "ResourceNotFound",
      );
    });

    it("describes alarm contributors (empty for fake)", async () => {
      await makeAlarm("cpu-high");
      const res = await cw.send(new DescribeAlarmContributorsCommand({ AlarmName: "cpu-high" }));
      expect(res.AlarmContributors).toEqual([]);
    });

    it("supports metric-math (Metrics) alarms", async () => {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: "math-alarm",
          EvaluationPeriods: 1,
          Threshold: 10,
          ComparisonOperator: "GreaterThanThreshold",
          Metrics: [
            {
              Id: "m1",
              MetricStat: {
                Metric: { Namespace: "App", MetricName: "CPU" },
                Period: 60,
                Stat: "Average",
              },
              ReturnData: true,
            },
          ],
        }),
      );
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["math-alarm"] }));
      expect(res.MetricAlarms!.length).toBe(1);
      expect(res.MetricAlarms![0].Metrics!.length).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  describe("Composite alarms", () => {
    it("creates a composite alarm and lists it via AlarmTypes", async () => {
      await cw.send(
        new PutCompositeAlarmCommand({
          AlarmName: "composite",
          AlarmRule: "ALARM(cpu-high)",
        }),
      );
      const res = await cw.send(
        new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"] }),
      );
      expect(res.CompositeAlarms!.length).toBe(1);
      expect(res.CompositeAlarms![0].AlarmRule).toBe("ALARM(cpu-high)");
    });

    it("does not return composite alarms by default (MetricAlarm only)", async () => {
      await cw.send(
        new PutCompositeAlarmCommand({ AlarmName: "composite", AlarmRule: "ALARM(x)" }),
      );
      const res = await cw.send(new DescribeAlarmsCommand({}));
      expect(res.CompositeAlarms!.length).toBe(0);
    });

    it("requires AlarmRule", async () => {
      await expectRawError("PutCompositeAlarm", { AlarmName: "x" }, "MissingParameter");
    });

    it("can be set to a state", async () => {
      await cw.send(
        new PutCompositeAlarmCommand({ AlarmName: "composite", AlarmRule: "ALARM(x)" }),
      );
      await cw.send(
        new SetAlarmStateCommand({
          AlarmName: "composite",
          StateValue: "ALARM",
          StateReason: "child fired",
        }),
      );
      const res = await cw.send(
        new DescribeAlarmsCommand({ AlarmTypes: ["CompositeAlarm"] }),
      );
      expect(res.CompositeAlarms![0].StateValue).toBe("ALARM");
    });
  });

  // -----------------------------------------------------------------------
  describe("Alarm history", () => {
    it("records configuration and state history", async () => {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: "h1",
          MetricName: "CPU",
          Namespace: "App",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
        }),
      );
      await cw.send(
        new SetAlarmStateCommand({ AlarmName: "h1", StateValue: "ALARM", StateReason: "r" }),
      );
      const all = await cw.send(new DescribeAlarmHistoryCommand({ AlarmName: "h1" }));
      expect(all.AlarmHistoryItems!.length).toBeGreaterThanOrEqual(2);
      const types = all.AlarmHistoryItems!.map((h) => h.HistoryItemType);
      expect(types).toContain("StateUpdate");
      expect(types).toContain("ConfigurationUpdate");
    });
  });

  // -----------------------------------------------------------------------
  describe("Alarm mute rules", () => {
    it("creates, gets, lists and deletes a mute rule", async () => {
      await cw.send(
        new PutAlarmMuteRuleCommand({
          Name: "nightly",
          Description: "mute at night",
        }),
      );

      const got = await cw.send(new GetAlarmMuteRuleCommand({ AlarmMuteRuleName: "nightly" }));
      expect(got.Name).toBe("nightly");
      expect(got.Status).toBe("ACTIVE");
      expect(got.AlarmMuteRuleArn).toContain("mute-rule:nightly");

      const list = await cw.send(new ListAlarmMuteRulesCommand({}));
      expect(list.AlarmMuteRuleSummaries!.length).toBe(1);

      await cw.send(new DeleteAlarmMuteRuleCommand({ AlarmMuteRuleName: "nightly" }));
      await expectError(
        cw.send(new GetAlarmMuteRuleCommand({ AlarmMuteRuleName: "nightly" })),
        "ResourceNotFound",
      );
    });

    it("requires a Name on put", async () => {
      await expectRawError("PutAlarmMuteRule", {}, "MissingParameter");
    });
  });

  // -----------------------------------------------------------------------
  describe("Dashboards", () => {
    const body = JSON.stringify({ widgets: [{ type: "text", properties: { markdown: "hi" } }] });

    it("puts and gets a dashboard", async () => {
      const put = await cw.send(
        new PutDashboardCommand({ DashboardName: "main", DashboardBody: body }),
      );
      expect(put.DashboardValidationMessages).toEqual([]);
      const got = await cw.send(new GetDashboardCommand({ DashboardName: "main" }));
      expect(got.DashboardBody).toBe(body);
      expect(got.DashboardArn).toContain("dashboard/main");
    });

    it("lists dashboards with prefix", async () => {
      await cw.send(new PutDashboardCommand({ DashboardName: "prod-a", DashboardBody: body }));
      await cw.send(new PutDashboardCommand({ DashboardName: "prod-b", DashboardBody: body }));
      await cw.send(new PutDashboardCommand({ DashboardName: "dev-a", DashboardBody: body }));
      const res = await cw.send(new ListDashboardsCommand({ DashboardNamePrefix: "prod-" }));
      expect(res.DashboardEntries!.length).toBe(2);
    });

    it("deletes dashboards", async () => {
      await cw.send(new PutDashboardCommand({ DashboardName: "main", DashboardBody: body }));
      await cw.send(new DeleteDashboardsCommand({ DashboardNames: ["main"] }));
      await expectError(
        cw.send(new GetDashboardCommand({ DashboardName: "main" })),
        "ResourceNotFound",
      );
    });

    it("rejects invalid dashboard body", async () => {
      await expectError(
        cw.send(new PutDashboardCommand({ DashboardName: "bad", DashboardBody: "not json" })),
        "DashboardInvalidInputError",
      );
    });

    it("rejects a body without widgets", async () => {
      await expectError(
        cw.send(
          new PutDashboardCommand({ DashboardName: "bad", DashboardBody: JSON.stringify({}) }),
        ),
        "DashboardInvalidInputError",
      );
    });

    it("rejects invalid dashboard name", async () => {
      await expectError(
        cw.send(new PutDashboardCommand({ DashboardName: "bad name!", DashboardBody: body })),
        "InvalidParameterValue",
      );
    });

    it("rejects deleting a missing dashboard", async () => {
      await expectError(
        cw.send(new DeleteDashboardsCommand({ DashboardNames: ["ghost"] })),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Anomaly detectors", () => {
    it("puts, describes and deletes a single-metric detector", async () => {
      await cw.send(
        new PutAnomalyDetectorCommand({
          Namespace: "App",
          MetricName: "CPU",
          Stat: "Average",
          Dimensions: [{ Name: "Host", Value: "h1" }],
        }),
      );
      const desc = await cw.send(new DescribeAnomalyDetectorsCommand({ Namespace: "App" }));
      expect(desc.AnomalyDetectors!.length).toBe(1);
      expect(desc.AnomalyDetectors![0].Stat).toBe("Average");

      await cw.send(
        new DeleteAnomalyDetectorCommand({
          SingleMetricAnomalyDetector: {
            Namespace: "App",
            MetricName: "CPU",
            Stat: "Average",
            Dimensions: [{ Name: "Host", Value: "h1" }],
          },
        }),
      );
      const after = await cw.send(new DescribeAnomalyDetectorsCommand({}));
      expect(after.AnomalyDetectors!.length).toBe(0);
    });

    it("is idempotent on identical detector", async () => {
      const args = { Namespace: "App", MetricName: "CPU", Stat: "Average" };
      await cw.send(new PutAnomalyDetectorCommand(args));
      await cw.send(new PutAnomalyDetectorCommand(args));
      const desc = await cw.send(new DescribeAnomalyDetectorsCommand({}));
      expect(desc.AnomalyDetectors!.length).toBe(1);
    });

    it("rejects deleting a missing detector", async () => {
      await expectError(
        cw.send(
          new DeleteAnomalyDetectorCommand({
            SingleMetricAnomalyDetector: { Namespace: "X", MetricName: "Y", Stat: "Average" },
          }),
        ),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Insight rules", () => {
    async function makeRule(name: string) {
      return cw.send(
        new PutInsightRuleCommand({
          RuleName: name,
          RuleState: "ENABLED",
          RuleDefinition: JSON.stringify({ Schema: { Name: "CloudWatchLogRule", Version: 1 } }),
        }),
      );
    }

    it("puts and describes an insight rule", async () => {
      await makeRule("rule1");
      const desc = await cw.send(new DescribeInsightRulesCommand({}));
      expect(desc.InsightRules!.length).toBe(1);
      expect(desc.InsightRules![0].Name).toBe("rule1");
      expect(desc.InsightRules![0].State).toBe("ENABLED");
    });

    it("enables and disables rules", async () => {
      await makeRule("rule1");
      await cw.send(new DisableInsightRulesCommand({ RuleNames: ["rule1"] }));
      let desc = await cw.send(new DescribeInsightRulesCommand({}));
      expect(desc.InsightRules![0].State).toBe("DISABLED");
      await cw.send(new EnableInsightRulesCommand({ RuleNames: ["rule1"] }));
      desc = await cw.send(new DescribeInsightRulesCommand({}));
      expect(desc.InsightRules![0].State).toBe("ENABLED");
    });

    it("reports failures for missing rules on enable", async () => {
      const res = await cw.send(new EnableInsightRulesCommand({ RuleNames: ["ghost"] }));
      expect(res.Failures!.length).toBe(1);
      expect(res.Failures![0].FailureResource).toBe("ghost");
    });

    it("deletes rules", async () => {
      await makeRule("rule1");
      const res = await cw.send(new DeleteInsightRulesCommand({ RuleNames: ["rule1"] }));
      expect(res.Failures).toEqual([]);
      const desc = await cw.send(new DescribeInsightRulesCommand({}));
      expect(desc.InsightRules!.length).toBe(0);
    });

    it("gets an insight rule report", async () => {
      await makeRule("rule1");
      const res = await cw.send(
        new GetInsightRuleReportCommand({
          RuleName: "rule1",
          StartTime: new Date("2020-01-01T00:00:00Z"),
          EndTime: new Date("2020-01-01T01:00:00Z"),
          Period: 60,
        }),
      );
      expect(res.Contributors).toEqual([]);
      expect(res.MetricDatapoints).toEqual([]);
    });

    it("rejects report for missing rule", async () => {
      await expectError(
        cw.send(
          new GetInsightRuleReportCommand({
            RuleName: "ghost",
            StartTime: new Date(),
            EndTime: new Date(Date.now() + 1000),
            Period: 60,
          }),
        ),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Managed insight rules", () => {
    const resourceArn = "arn:aws:kafka:us-east-1:000000000000:cluster/demo/abc";

    it("puts and lists managed insight rules", async () => {
      const put = await cw.send(
        new PutManagedInsightRulesCommand({
          ManagedRules: [{ TemplateName: "KafkaTemplate", ResourceARN: resourceArn }],
        }),
      );
      expect(put.Failures).toEqual([]);
      const list = await cw.send(new ListManagedInsightRulesCommand({ ResourceARN: resourceArn }));
      expect(list.ManagedRules!.length).toBe(1);
      expect(list.ManagedRules![0].TemplateName).toBe("KafkaTemplate");
      expect(list.ManagedRules![0].RuleState!.State).toBe("ENABLED");
    });

    it("requires ResourceARN on list", async () => {
      await expectRawError("ListManagedInsightRules", {}, "MissingParameter");
    });
  });

  // -----------------------------------------------------------------------
  describe("Metric streams", () => {
    async function makeStream(name: string) {
      return cw.send(
        new PutMetricStreamCommand({
          Name: name,
          FirehoseArn: "arn:aws:firehose:us-east-1:000000000000:deliverystream/s",
          RoleArn: "arn:aws:iam::000000000000:role/r",
          OutputFormat: "json",
          IncludeFilters: [{ Namespace: "App" }],
        }),
      );
    }

    it("puts and gets a metric stream", async () => {
      const put = await makeStream("stream1");
      expect(put.Arn).toContain("metric-stream:stream1");
      const got = await cw.send(new GetMetricStreamCommand({ Name: "stream1" }));
      expect(got.Name).toBe("stream1");
      expect(got.OutputFormat).toBe("json");
      expect(got.State).toBe("running");
    });

    it("lists metric streams", async () => {
      await makeStream("stream1");
      await makeStream("stream2");
      const list = await cw.send(new ListMetricStreamsCommand({}));
      expect(list.Entries!.length).toBe(2);
    });

    it("stops and starts streams", async () => {
      await makeStream("stream1");
      await cw.send(new StopMetricStreamsCommand({ Names: ["stream1"] }));
      let got = await cw.send(new GetMetricStreamCommand({ Name: "stream1" }));
      expect(got.State).toBe("stopped");
      await cw.send(new StartMetricStreamsCommand({ Names: ["stream1"] }));
      got = await cw.send(new GetMetricStreamCommand({ Name: "stream1" }));
      expect(got.State).toBe("running");
    });

    it("deletes a stream (idempotent)", async () => {
      await makeStream("stream1");
      await cw.send(new DeleteMetricStreamCommand({ Name: "stream1" }));
      await cw.send(new DeleteMetricStreamCommand({ Name: "stream1" })); // no error
      await expectError(
        cw.send(new GetMetricStreamCommand({ Name: "stream1" })),
        "ResourceNotFound",
      );
    });

    it("rejects mutually exclusive include/exclude filters", async () => {
      await expectError(
        cw.send(
          new PutMetricStreamCommand({
            Name: "bad",
            FirehoseArn: "arn:fh",
            RoleArn: "arn:role",
            OutputFormat: "json",
            IncludeFilters: [{ Namespace: "A" }],
            ExcludeFilters: [{ Namespace: "B" }],
          }),
        ),
        "InvalidParameterCombination",
      );
    });

    it("requires FirehoseArn", async () => {
      await expectRawError(
        "PutMetricStream",
        { Name: "bad", RoleArn: "arn:role", OutputFormat: "json" },
        "MissingParameter",
      );
    });

    it("rejects start of missing stream", async () => {
      await expectError(
        cw.send(new StartMetricStreamsCommand({ Names: ["ghost"] })),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Tags", () => {
    let alarmArn: string;

    beforeEach(async () => {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: "tagged",
          MetricName: "CPU",
          Namespace: "App",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
        }),
      );
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["tagged"] }));
      alarmArn = res.MetricAlarms![0].AlarmArn!;
    });

    it("tags, lists and untags a resource", async () => {
      await cw.send(
        new TagResourceCommand({
          ResourceARN: alarmArn,
          Tags: [{ Key: "env", Value: "prod" }, { Key: "team", Value: "core" }],
        }),
      );
      let list = await cw.send(new ListTagsForResourceCommand({ ResourceARN: alarmArn }));
      expect(list.Tags!.length).toBe(2);

      await cw.send(new UntagResourceCommand({ ResourceARN: alarmArn, TagKeys: ["team"] }));
      list = await cw.send(new ListTagsForResourceCommand({ ResourceARN: alarmArn }));
      expect(list.Tags!.length).toBe(1);
      expect(list.Tags![0].Key).toBe("env");
    });

    it("creates an alarm with inline tags", async () => {
      await cw.send(
        new PutMetricAlarmCommand({
          AlarmName: "inline-tags",
          MetricName: "CPU",
          Namespace: "App",
          Statistic: "Average",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanThreshold",
          Tags: [{ Key: "owner", Value: "me" }],
        }),
      );
      const res = await cw.send(new DescribeAlarmsCommand({ AlarmNames: ["inline-tags"] }));
      const arn = res.MetricAlarms![0].AlarmArn!;
      const list = await cw.send(new ListTagsForResourceCommand({ ResourceARN: arn }));
      expect(list.Tags![0].Key).toBe("owner");
    });

    it("rejects tagging unknown resource", async () => {
      await expectError(
        cw.send(
          new TagResourceCommand({
            ResourceARN: "arn:aws:cloudwatch:us-east-1:000000000000:alarm:ghost",
            Tags: [{ Key: "k", Value: "v" }],
          }),
        ),
        "ResourceNotFound",
      );
    });

    it("rejects listing tags for unknown resource", async () => {
      await expectError(
        cw.send(
          new ListTagsForResourceCommand({
            ResourceARN: "arn:aws:cloudwatch:us-east-1:000000000000:alarm:ghost",
          }),
        ),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("Datasets", () => {
    it("associates and disassociates a KMS key, then gets the dataset", async () => {
      await cw.send(
        new AssociateDatasetKmsKeyCommand({
          DatasetIdentifier: "ds1",
          KmsKeyArn: "arn:aws:kms:us-east-1:000000000000:key/abc",
        }),
      );
      const got = await cw.send(new GetDatasetCommand({ DatasetIdentifier: "ds1" }));
      expect(got.KmsKeyArn).toContain("key/abc");
      expect(got.DatasetId).toBe("ds1");
      await cw.send(new DisassociateDatasetKmsKeyCommand({ DatasetIdentifier: "ds1" }));
      const after = await cw.send(new GetDatasetCommand({ DatasetIdentifier: "ds1" }));
      expect(after.KmsKeyArn).toBeUndefined();
    });

    it("rejects get for unknown dataset", async () => {
      await expectError(
        cw.send(new GetDatasetCommand({ DatasetIdentifier: "ghost" })),
        "ResourceNotFound",
      );
    });
  });

  // -----------------------------------------------------------------------
  describe("OTel enrichment", () => {
    it("starts, reads and stops enrichment", async () => {
      let res = await cw.send(new GetOTelEnrichmentCommand({} as any));
      expect((res as any).Status).toBe("DISABLED");
      await cw.send(new StartOTelEnrichmentCommand({} as any));
      res = await cw.send(new GetOTelEnrichmentCommand({} as any));
      expect((res as any).Status).toBe("ENABLED");
      await cw.send(new StopOTelEnrichmentCommand({} as any));
      res = await cw.send(new GetOTelEnrichmentCommand({} as any));
      expect((res as any).Status).toBe("DISABLED");
    });
  });

  // -----------------------------------------------------------------------
  describe("Error wire format", () => {
    it("returns an unknown-action error for a bad target", async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "GraniteServiceVersion20100801.NotARealAction",
        },
        body: "{}",
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as any;
      expect(json.__type).toBe("InvalidAction");
    });

    it("returns 404-status errors with __type for missing resources", async () => {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.0",
          "X-Amz-Target": "GraniteServiceVersion20100801.GetDashboard",
        },
        body: JSON.stringify({ DashboardName: "ghost" }),
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as any;
      expect(json.__type).toBe("ResourceNotFound");
    });
  });
});
