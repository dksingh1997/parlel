// parlel/cloudwatch — a lightweight, dependency-free fake of AWS CloudWatch.
//
// Speaks the AWS JSON 1.0 wire protocol (service "GraniteServiceVersion20100801",
// api version 2010-08-01) so that application code using the real
// `@aws-sdk/client-cloudwatch` client (v3) can run against it with zero cost and
// zero side effects. Pure Node.js, no external npm dependencies. State is
// in-memory and ephemeral (resettable via reset() or POST /_parlel/reset).
//
// Protocol details (validated against @aws-sdk/client-cloudwatch v3.1066):
//   * Requests are POST / with `Content-Type: application/x-amz-json-1.0`.
//     The operation is carried in the `X-Amz-Target` header as
//     `GraniteServiceVersion20100801.<Operation>`. The body is a JSON object
//     of the operation input shape. Timestamps arrive as epoch *seconds*.
//   * Success: 200, JSON body of the operation output shape. Timestamps are
//     serialized as epoch seconds (numbers); the SDK rehydrates them to Date.
//   * Error: non-2xx, JSON body `{ "__type": "<Code>", "message": "<msg>" }`.
//     The SDK reads `__type` as the error name and `message` as the message.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const TARGET_PREFIX = "GraniteServiceVersion20100801";
const API_VERSION = "2010-08-01";
const DEFAULT_ACCOUNT_ID = "000000000000";

// CloudWatch error codes -> HTTP status. (4xx == client fault, 5xx == server.)
const ERROR_STATUS = {
  InvalidParameterValue: 400,
  InvalidParameterValueException: 400,
  MissingParameter: 400,
  MissingRequiredParameter: 400,
  InvalidParameterCombination: 400,
  InvalidParameterCombinationException: 400,
  InvalidFormat: 400,
  InvalidFormatFault: 400,
  InvalidNextToken: 400,
  ValidationError: 400,
  ResourceNotFound: 404,
  ResourceNotFoundException: 404,
  ResourceNotFoundFault: 404,
  DashboardNotFoundError: 404,
  DashboardInvalidInputError: 400,
  LimitExceeded: 400,
  LimitExceededFault: 400,
  LimitExceededException: 400,
  ConcurrentModificationException: 429,
  ConflictException: 409,
  AccessDenied: 403,
  AccessDeniedException: 403,
  InternalServiceError: 500,
  InternalServiceFault: 500,
  InternalServiceException: 500,
  ServiceUnavailable: 503,
  Throttling: 429,
  ThrottlingException: 429,
};

class CloudWatchError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// CloudWatch wire timestamps are epoch seconds (numbers). Convert to/from ms.
function toEpochSeconds(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    // Already seconds (the SDK sends seconds). Guard against accidental ms.
    return value > 1e12 ? value / 1000 : value;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

function nowSeconds() {
  return Date.now() / 1000;
}

function dimsKey(dimensions) {
  if (!dimensions || dimensions.length === 0) return "";
  return dimensions
    .map((d) => `${d.Name}=${d.Value}`)
    .sort()
    .join("&");
}

function round(n) {
  // Avoid floating-point noise in aggregated stats.
  return Math.round(n * 1e10) / 1e10;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  const frac = rank - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class CloudwatchServer {
  constructor(port = 4574, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    this.reset();
  }

  reset() {
    // metrics: Map<seriesKey, { namespace, metricName, dimensions, unit,
    //   datapoints: [{ ts, values:[], counts:[] }] }>
    this.metrics = new Map();
    // alarms: Map<alarmName, alarm object> (metric + composite alarms)
    this.alarms = new Map();
    // alarm history: array of history items
    this.alarmHistory = [];
    // dashboards: Map<name, { body, lastModified, size }>
    this.dashboards = new Map();
    // anomaly detectors: array
    this.anomalyDetectors = [];
    // metric streams: Map<name, stream object>
    this.metricStreams = new Map();
    // insight rules: Map<name, rule object>
    this.insightRules = new Map();
    // managed insight rules: Map<templateName+resourceArn, rule>
    this.managedInsightRules = new Map();
    // tags: Map<resourceArn, { key: value }>
    this.tags = new Map();
    // alarm mute rules: Map<id, rule>
    this.alarmMuteRules = new Map();
    // datasets: Map<name, dataset>
    this.datasets = new Map();
    // otel enrichment state: { Status }
    this.otelEnrichment = { Status: "DISABLED" };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(
            res,
            new CloudWatchError("InternalServiceError", error.message, 500),
          );
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  arnFor(type, name) {
    return `arn:aws:cloudwatch:${this.region}:${this.accountId}:${type}:${name}`;
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    // Internal/health endpoints (not part of CloudWatch).
    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, {
        status: "ok",
        service: "cloudwatch",
        metrics: this.metrics.size,
        alarms: this.alarms.size,
        dashboards: this.dashboards.size,
      });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cloudwatch");

    if (method !== "POST") {
      return this.sendError(
        res,
        new CloudWatchError(
          "InvalidParameterValue",
          "Only POST is supported by the parlel cloudwatch fake.",
          405,
        ),
      );
    }

    const target = req.headers["x-amz-target"] || "";
    const operation = String(target).split(".").pop();

    const raw = (await this.readBody(req)).toString("utf8");
    let input;
    try {
      input = raw.length ? JSON.parse(raw) : {};
    } catch {
      return this.sendError(
        res,
        new CloudWatchError("InvalidFormat", "Request body is not valid JSON.", 400),
      );
    }

    try {
      const result = this.dispatch(operation, input);
      return this.sendJson(res, 200, result || {});
    } catch (error) {
      if (error instanceof CloudWatchError) return this.sendError(res, error);
      throw error;
    }
  }

  dispatch(operation, input) {
    const handlers = {
      // Metrics
      PutMetricData: () => this.putMetricData(input),
      GetMetricData: () => this.getMetricData(input),
      GetMetricStatistics: () => this.getMetricStatistics(input),
      ListMetrics: () => this.listMetrics(input),
      GetMetricWidgetImage: () => this.getMetricWidgetImage(input),
      // Alarms
      PutMetricAlarm: () => this.putMetricAlarm(input),
      PutCompositeAlarm: () => this.putCompositeAlarm(input),
      DescribeAlarms: () => this.describeAlarms(input),
      DescribeAlarmsForMetric: () => this.describeAlarmsForMetric(input),
      DescribeAlarmHistory: () => this.describeAlarmHistory(input),
      DescribeAlarmContributors: () => this.describeAlarmContributors(input),
      DeleteAlarms: () => this.deleteAlarms(input),
      SetAlarmState: () => this.setAlarmState(input),
      EnableAlarmActions: () => this.enableAlarmActions(input),
      DisableAlarmActions: () => this.disableAlarmActions(input),
      // Alarm mute rules
      PutAlarmMuteRule: () => this.putAlarmMuteRule(input),
      GetAlarmMuteRule: () => this.getAlarmMuteRule(input),
      DeleteAlarmMuteRule: () => this.deleteAlarmMuteRule(input),
      ListAlarmMuteRules: () => this.listAlarmMuteRules(input),
      // Dashboards
      PutDashboard: () => this.putDashboard(input),
      GetDashboard: () => this.getDashboard(input),
      ListDashboards: () => this.listDashboards(input),
      DeleteDashboards: () => this.deleteDashboards(input),
      // Anomaly detectors
      PutAnomalyDetector: () => this.putAnomalyDetector(input),
      DescribeAnomalyDetectors: () => this.describeAnomalyDetectors(input),
      DeleteAnomalyDetector: () => this.deleteAnomalyDetector(input),
      // Insight rules
      PutInsightRule: () => this.putInsightRule(input),
      DescribeInsightRules: () => this.describeInsightRules(input),
      DeleteInsightRules: () => this.deleteInsightRules(input),
      EnableInsightRules: () => this.enableInsightRules(input),
      DisableInsightRules: () => this.disableInsightRules(input),
      GetInsightRuleReport: () => this.getInsightRuleReport(input),
      // Managed insight rules
      PutManagedInsightRules: () => this.putManagedInsightRules(input),
      ListManagedInsightRules: () => this.listManagedInsightRules(input),
      // Metric streams
      PutMetricStream: () => this.putMetricStream(input),
      GetMetricStream: () => this.getMetricStream(input),
      ListMetricStreams: () => this.listMetricStreams(input),
      DeleteMetricStream: () => this.deleteMetricStream(input),
      StartMetricStreams: () => this.startMetricStreams(input),
      StopMetricStreams: () => this.stopMetricStreams(input),
      // Tags
      TagResource: () => this.tagResource(input),
      UntagResource: () => this.untagResource(input),
      ListTagsForResource: () => this.listTagsForResource(input),
      // Datasets (newer surface)
      GetDataset: () => this.getDataset(input),
      AssociateDatasetKmsKey: () => this.associateDatasetKmsKey(input),
      DisassociateDatasetKmsKey: () => this.disassociateDatasetKmsKey(input),
      // OTel enrichment (newer surface)
      GetOTelEnrichment: () => this.getOTelEnrichment(input),
      StartOTelEnrichment: () => this.startOTelEnrichment(input),
      StopOTelEnrichment: () => this.stopOTelEnrichment(input),
    };
    const handler = handlers[operation];
    if (!handler) {
      throw new CloudWatchError(
        "InvalidAction",
        `The action ${operation || "(none)"} is not valid for this endpoint.`,
        400,
      );
    }
    return handler();
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------
  seriesKey(namespace, metricName, dimensions) {
    return `${namespace}\u0000${metricName}\u0000${dimsKey(dimensions)}`;
  }

  getOrCreateSeries(namespace, metricName, dimensions, unit) {
    const key = this.seriesKey(namespace, metricName, dimensions);
    let series = this.metrics.get(key);
    if (!series) {
      series = {
        namespace,
        metricName,
        dimensions: (dimensions || []).map((d) => ({ Name: d.Name, Value: d.Value })),
        unit,
        datapoints: [],
      };
      this.metrics.set(key, series);
    }
    if (unit && !series.unit) series.unit = unit;
    return series;
  }

  putMetricData(input) {
    const namespace = input.Namespace;
    if (!namespace) {
      throw new CloudWatchError(
        "MissingParameter",
        "The parameter Namespace is required.",
      );
    }
    if (/^AWS\//.test(namespace)) {
      throw new CloudWatchError(
        "InvalidParameterValue",
        "Namespace must not start with reserved prefix 'AWS/'.",
      );
    }
    const data = input.MetricData;
    if (!Array.isArray(data) || data.length === 0) {
      throw new CloudWatchError(
        "MissingParameter",
        "The parameter MetricData is required.",
      );
    }
    if (data.length > 1000) {
      throw new CloudWatchError(
        "InvalidParameterValue",
        "The collection MetricData must not have a size greater than 1000.",
      );
    }

    for (const datum of data) {
      if (!datum.MetricName) {
        throw new CloudWatchError(
          "MissingParameter",
          "The parameter MetricData.member.N.MetricName is required.",
        );
      }
      const hasValue = datum.Value !== undefined && datum.Value !== null;
      const hasStats = datum.StatisticValues && typeof datum.StatisticValues === "object";
      const hasValues = Array.isArray(datum.Values) && datum.Values.length > 0;
      if (!hasValue && !hasStats && !hasValues) {
        throw new CloudWatchError(
          "InvalidParameterCombination",
          "At least one of Value, StatisticValues, or Values must be specified for each MetricDatum.",
        );
      }
      if (hasValues && Array.isArray(datum.Counts) && datum.Counts.length !== datum.Values.length) {
        throw new CloudWatchError(
          "InvalidParameterValue",
          "The two arrays Values and Counts must have the same length.",
        );
      }

      const series = this.getOrCreateSeries(
        namespace,
        datum.MetricName,
        datum.Dimensions,
        datum.Unit,
      );
      const ts = toEpochSeconds(datum.Timestamp) ?? nowSeconds();

      let values = [];
      let counts = [];
      if (hasValues) {
        values = datum.Values.map(Number);
        counts = datum.Counts ? datum.Counts.map(Number) : values.map(() => 1);
      } else if (hasStats) {
        // Expand statistic values into a synthetic min/max + sum representation.
        const sv = datum.StatisticValues;
        series.datapoints.push({
          ts,
          stat: {
            sampleCount: Number(sv.SampleCount),
            sum: Number(sv.Sum),
            min: Number(sv.Minimum),
            max: Number(sv.Maximum),
          },
          values: [],
          counts: [],
        });
        continue;
      } else {
        values = [Number(datum.Value)];
        counts = [1];
      }
      series.datapoints.push({ ts, values, counts });
    }
    return {};
  }

  // Aggregate raw datapoints in a [start,end) window into a single bucket of stats.
  aggregateBucket(points) {
    let sampleCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const allValues = [];
    for (const p of points) {
      if (p.stat) {
        sampleCount += p.stat.sampleCount;
        sum += p.stat.sum;
        min = Math.min(min, p.stat.min);
        max = Math.max(max, p.stat.max);
        // approximate distribution with min & max for percentile purposes
        allValues.push(p.stat.min, p.stat.max);
      } else {
        for (let i = 0; i < p.values.length; i++) {
          const v = p.values[i];
          const c = p.counts[i] ?? 1;
          sampleCount += c;
          sum += v * c;
          min = Math.min(min, v);
          max = Math.max(max, v);
          for (let n = 0; n < c; n++) allValues.push(v);
        }
      }
    }
    if (sampleCount === 0) return null;
    return {
      sampleCount,
      sum: round(sum),
      min: round(min),
      max: round(max),
      average: round(sum / sampleCount),
      values: allValues.sort((a, b) => a - b),
    };
  }

  collectWindow(series, startSec, endSec) {
    return series.datapoints.filter((p) => p.ts >= startSec && p.ts < endSec);
  }

  getMetricStatistics(input) {
    const { Namespace, MetricName, StartTime, EndTime, Period } = input;
    if (!Namespace) throw new CloudWatchError("MissingParameter", "The parameter Namespace is required.");
    if (!MetricName) throw new CloudWatchError("MissingParameter", "The parameter MetricName is required.");
    if (StartTime === undefined) throw new CloudWatchError("MissingParameter", "The parameter StartTime is required.");
    if (EndTime === undefined) throw new CloudWatchError("MissingParameter", "The parameter EndTime is required.");
    if (!Period) throw new CloudWatchError("MissingParameter", "The parameter Period is required.");

    const statistics = input.Statistics || [];
    const extended = input.ExtendedStatistics || [];
    if (statistics.length === 0 && extended.length === 0) {
      throw new CloudWatchError(
        "MissingParameter",
        "Must specify either Statistics or ExtendedStatistics.",
      );
    }

    const start = toEpochSeconds(StartTime);
    const end = toEpochSeconds(EndTime);
    if (start >= end) {
      throw new CloudWatchError(
        "InvalidParameterValue",
        "The parameter StartTime must be less than the parameter EndTime.",
      );
    }
    const period = Number(Period);
    const key = this.seriesKey(Namespace, MetricName, input.Dimensions);
    const series = this.metrics.get(key);

    const datapoints = [];
    if (series) {
      for (let bStart = start; bStart < end; bStart += period) {
        const bEnd = Math.min(bStart + period, end);
        const points = this.collectWindow(series, bStart, bEnd);
        const agg = this.aggregateBucket(points);
        if (!agg) continue;
        const dp = { Timestamp: bStart };
        if (input.Unit) dp.Unit = input.Unit;
        else if (series.unit) dp.Unit = series.unit;
        for (const stat of statistics) {
          if (stat === "Average") dp.Average = agg.average;
          else if (stat === "Sum") dp.Sum = agg.sum;
          else if (stat === "Minimum") dp.Minimum = agg.min;
          else if (stat === "Maximum") dp.Maximum = agg.max;
          else if (stat === "SampleCount") dp.SampleCount = agg.sampleCount;
        }
        if (extended.length > 0) {
          dp.ExtendedStatistics = {};
          for (const ext of extended) {
            const m = /^p(\d+(\.\d+)?)$/.exec(ext);
            if (m) {
              dp.ExtendedStatistics[ext] = round(percentile(agg.values, Number(m[1])));
            }
          }
        }
        datapoints.push(dp);
      }
    }
    // CloudWatch returns datapoints in no particular order; sort ascending.
    datapoints.sort((a, b) => a.Timestamp - b.Timestamp);
    return { Label: MetricName, Datapoints: datapoints };
  }

  getMetricData(input) {
    const queries = input.MetricDataQueries;
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new CloudWatchError(
        "MissingParameter",
        "The parameter MetricDataQueries is required.",
      );
    }
    const start = toEpochSeconds(input.StartTime);
    const end = toEpochSeconds(input.EndTime);
    if (start === undefined || end === undefined) {
      throw new CloudWatchError(
        "MissingParameter",
        "StartTime and EndTime are required.",
      );
    }
    const scanBy = input.ScanBy || "TimestampDescending";

    // First evaluate metric-stat queries to fill a value map for expressions.
    const valuesById = {};
    const results = [];

    for (const q of queries) {
      if (!q.Id) {
        throw new CloudWatchError(
          "MissingParameter",
          "The parameter MetricDataQueries.member.N.Id is required.",
        );
      }
    }

    for (const q of queries) {
      const returnData = q.ReturnData !== false;
      let timestamps = [];
      let values = [];
      let label = q.Label;

      if (q.MetricStat) {
        const ms = q.MetricStat;
        const metric = ms.Metric || {};
        const period = Number(ms.Period || 60);
        const stat = ms.Stat || "Average";
        const key = this.seriesKey(metric.Namespace, metric.MetricName, metric.Dimensions);
        const series = this.metrics.get(key);
        if (!label) label = `${metric.MetricName || q.Id} ${stat}`;
        if (series) {
          for (let bStart = start; bStart < end; bStart += period) {
            const bEnd = Math.min(bStart + period, end);
            const points = this.collectWindow(series, bStart, bEnd);
            const agg = this.aggregateBucket(points);
            if (!agg) continue;
            timestamps.push(bStart);
            values.push(this.applyStat(stat, agg));
          }
        }
      } else if (q.Expression) {
        // Minimal expression engine: supports referencing one prior id and
        // scalar arithmetic like "m1 * 2", "m1 + m2". Falls back to empty.
        const evaluated = this.evaluateExpression(q.Expression, valuesById);
        timestamps = evaluated.timestamps;
        values = evaluated.values;
        if (!label) label = q.Expression;
      } else {
        throw new CloudWatchError(
          "InvalidParameterValue",
          `MetricDataQuery ${q.Id} must contain either MetricStat or Expression.`,
        );
      }

      valuesById[q.Id] = { timestamps, values };

      if (returnData) {
        // Order by ScanBy.
        const paired = timestamps.map((t, i) => [t, values[i]]);
        paired.sort((a, b) =>
          scanBy === "TimestampAscending" ? a[0] - b[0] : b[0] - a[0],
        );
        results.push({
          Id: q.Id,
          Label: label,
          Timestamps: paired.map((p) => p[0]),
          Values: paired.map((p) => round(p[1])),
          StatusCode: "Complete",
        });
      }
    }
    const out = { MetricDataResults: results, Messages: [] };
    return out;
  }

  applyStat(stat, agg) {
    switch (stat) {
      case "Sum": return agg.sum;
      case "Minimum": return agg.min;
      case "Maximum": return agg.max;
      case "SampleCount": return agg.sampleCount;
      case "Average": return agg.average;
      default: {
        const m = /^p(\d+(\.\d+)?)$/.exec(stat);
        if (m) return round(percentile(agg.values, Number(m[1])));
        return agg.average;
      }
    }
  }

  // Very small expression evaluator over previously-computed series.
  evaluateExpression(expr, valuesById) {
    // Build a timestamp-aligned map of referenced ids.
    const ids = Object.keys(valuesById).filter((id) =>
      new RegExp(`\\b${id}\\b`).test(expr),
    );
    if (ids.length === 0) return { timestamps: [], values: [] };
    // Align on the first referenced id's timestamps.
    const base = valuesById[ids[0]];
    const timestamps = base.timestamps.slice();
    const values = [];
    for (let i = 0; i < timestamps.length; i++) {
      let e = expr;
      for (const id of ids) {
        const v = valuesById[id].values[i];
        e = e.replace(new RegExp(`\\b${id}\\b`, "g"), v === undefined ? "0" : String(v));
      }
      let val = 0;
      // Only allow numbers and arithmetic operators for safety.
      if (/^[\d\s+\-*/().]+$/.test(e)) {
        try {
          // eslint-disable-next-line no-new-func
          val = Function(`"use strict";return (${e});`)();
        } catch {
          val = 0;
        }
      }
      values.push(Number.isFinite(val) ? val : 0);
    }
    return { timestamps, values };
  }

  listMetrics(input) {
    let all = [...this.metrics.values()];
    if (input.Namespace) {
      all = all.filter((s) => s.namespace === input.Namespace);
    }
    if (input.MetricName) {
      all = all.filter((s) => s.metricName === input.MetricName);
    }
    if (Array.isArray(input.Dimensions) && input.Dimensions.length > 0) {
      all = all.filter((s) => {
        return input.Dimensions.every((filter) => {
          if (filter.Value !== undefined) {
            return s.dimensions.some(
              (d) => d.Name === filter.Name && d.Value === filter.Value,
            );
          }
          return s.dimensions.some((d) => d.Name === filter.Name);
        });
      });
    }
    const metrics = all.map((s) => ({
      Namespace: s.namespace,
      MetricName: s.metricName,
      Dimensions: s.dimensions.map((d) => ({ Name: d.Name, Value: d.Value })),
    }));

    const { page, nextToken } = this.paginate(metrics, input.NextToken, 500);
    const out = { Metrics: page };
    if (nextToken) out.NextToken = nextToken;
    if (input.IncludeLinkedAccounts) out.OwningAccounts = page.map(() => this.accountId);
    return out;
  }

  getMetricWidgetImage(input) {
    if (!input.MetricWidget) {
      throw new CloudWatchError(
        "MissingParameter",
        "The parameter MetricWidget is required.",
      );
    }
    // Return a tiny 1x1 transparent PNG as the "rendered" widget image.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    // The SDK expects MetricWidgetImage as a blob; JSON protocol transports it
    // base64-encoded.
    return { MetricWidgetImage: png.toString("base64") };
  }

  // -------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------
  putMetricAlarm(input) {
    const name = input.AlarmName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmName is required.");
    }
    if (!input.ComparisonOperator) {
      throw new CloudWatchError("MissingParameter", "The parameter ComparisonOperator is required.");
    }
    if (input.EvaluationPeriods === undefined) {
      throw new CloudWatchError("MissingParameter", "The parameter EvaluationPeriods is required.");
    }
    const hasMetric = !!input.MetricName && !!input.Namespace;
    const hasMetrics = Array.isArray(input.Metrics) && input.Metrics.length > 0;
    if (!hasMetric && !hasMetrics) {
      throw new CloudWatchError(
        "InvalidParameterCombination",
        "Must specify either MetricName + Namespace or Metrics.",
      );
    }
    if (hasMetric && !input.Statistic && !input.ExtendedStatistic) {
      throw new CloudWatchError(
        "MissingParameter",
        "Must specify either Statistic or ExtendedStatistic for a metric alarm.",
      );
    }

    const existing = this.alarms.get(name);
    const isUpdate = !!existing;
    const arn = this.arnFor("alarm", name);
    const now = nowSeconds();

    const alarm = {
      Type: "MetricAlarm",
      AlarmName: name,
      AlarmArn: arn,
      AlarmDescription: input.AlarmDescription,
      AlarmConfigurationUpdatedTimestamp: now,
      ActionsEnabled: input.ActionsEnabled !== undefined ? input.ActionsEnabled : true,
      OKActions: input.OKActions || [],
      AlarmActions: input.AlarmActions || [],
      InsufficientDataActions: input.InsufficientDataActions || [],
      StateValue: existing ? existing.StateValue : "INSUFFICIENT_DATA",
      StateReason: existing ? existing.StateReason : "Unchecked: Initial alarm creation",
      StateReasonData: existing ? existing.StateReasonData : undefined,
      StateUpdatedTimestamp: existing ? existing.StateUpdatedTimestamp : now,
      MetricName: input.MetricName,
      Namespace: input.Namespace,
      Statistic: input.Statistic,
      ExtendedStatistic: input.ExtendedStatistic,
      Dimensions: input.Dimensions || [],
      Period: input.Period,
      Unit: input.Unit,
      EvaluationPeriods: input.EvaluationPeriods,
      DatapointsToAlarm: input.DatapointsToAlarm,
      Threshold: input.Threshold,
      ComparisonOperator: input.ComparisonOperator,
      TreatMissingData: input.TreatMissingData,
      EvaluateLowSampleCountPercentile: input.EvaluateLowSampleCountPercentile,
      Metrics: input.Metrics,
      ThresholdMetricId: input.ThresholdMetricId,
    };
    this.alarms.set(name, alarm);

    if (Array.isArray(input.Tags) && input.Tags.length > 0) {
      this.setTags(arn, input.Tags);
    }

    this.recordAlarmHistory(name, arn, "ConfigurationUpdate", {
      message: isUpdate ? "Alarm updated" : "Alarm created",
    });
    return {};
  }

  putCompositeAlarm(input) {
    const name = input.AlarmName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmName is required.");
    }
    if (!input.AlarmRule) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmRule is required.");
    }
    const arn = this.arnFor("alarm", name);
    const now = nowSeconds();
    const existing = this.alarms.get(name);
    const alarm = {
      Type: "CompositeAlarm",
      AlarmName: name,
      AlarmArn: arn,
      AlarmDescription: input.AlarmDescription,
      AlarmRule: input.AlarmRule,
      AlarmConfigurationUpdatedTimestamp: now,
      ActionsEnabled: input.ActionsEnabled !== undefined ? input.ActionsEnabled : true,
      OKActions: input.OKActions || [],
      AlarmActions: input.AlarmActions || [],
      InsufficientDataActions: input.InsufficientDataActions || [],
      StateValue: existing ? existing.StateValue : "INSUFFICIENT_DATA",
      StateReason: existing ? existing.StateReason : "Unchecked: Initial alarm creation",
      StateUpdatedTimestamp: existing ? existing.StateUpdatedTimestamp : now,
      ActionsSuppressor: input.ActionsSuppressor,
      ActionsSuppressorWaitPeriod: input.ActionsSuppressorWaitPeriod,
      ActionsSuppressorExtensionPeriod: input.ActionsSuppressorExtensionPeriod,
    };
    this.alarms.set(name, alarm);
    if (Array.isArray(input.Tags) && input.Tags.length > 0) {
      this.setTags(arn, input.Tags);
    }
    this.recordAlarmHistory(name, arn, "ConfigurationUpdate", {
      message: existing ? "Composite alarm updated" : "Composite alarm created",
    });
    return {};
  }

  metricAlarmView(a) {
    const v = {
      AlarmName: a.AlarmName,
      AlarmArn: a.AlarmArn,
      AlarmDescription: a.AlarmDescription,
      AlarmConfigurationUpdatedTimestamp: a.AlarmConfigurationUpdatedTimestamp,
      ActionsEnabled: a.ActionsEnabled,
      OKActions: a.OKActions,
      AlarmActions: a.AlarmActions,
      InsufficientDataActions: a.InsufficientDataActions,
      StateValue: a.StateValue,
      StateReason: a.StateReason,
      StateReasonData: a.StateReasonData,
      StateUpdatedTimestamp: a.StateUpdatedTimestamp,
      MetricName: a.MetricName,
      Namespace: a.Namespace,
      Statistic: a.Statistic,
      ExtendedStatistic: a.ExtendedStatistic,
      Dimensions: a.Dimensions,
      Period: a.Period,
      Unit: a.Unit,
      EvaluationPeriods: a.EvaluationPeriods,
      DatapointsToAlarm: a.DatapointsToAlarm,
      Threshold: a.Threshold,
      ComparisonOperator: a.ComparisonOperator,
      TreatMissingData: a.TreatMissingData,
      EvaluateLowSampleCountPercentile: a.EvaluateLowSampleCountPercentile,
      Metrics: a.Metrics,
      ThresholdMetricId: a.ThresholdMetricId,
    };
    return v;
  }

  compositeAlarmView(a) {
    return {
      AlarmName: a.AlarmName,
      AlarmArn: a.AlarmArn,
      AlarmDescription: a.AlarmDescription,
      AlarmRule: a.AlarmRule,
      AlarmConfigurationUpdatedTimestamp: a.AlarmConfigurationUpdatedTimestamp,
      ActionsEnabled: a.ActionsEnabled,
      OKActions: a.OKActions,
      AlarmActions: a.AlarmActions,
      InsufficientDataActions: a.InsufficientDataActions,
      StateValue: a.StateValue,
      StateReason: a.StateReason,
      StateReasonData: a.StateReasonData,
      StateUpdatedTimestamp: a.StateUpdatedTimestamp,
      ActionsSuppressor: a.ActionsSuppressor,
      ActionsSuppressorWaitPeriod: a.ActionsSuppressorWaitPeriod,
      ActionsSuppressorExtensionPeriod: a.ActionsSuppressorExtensionPeriod,
    };
  }

  describeAlarms(input) {
    let alarms = [...this.alarms.values()];

    if (Array.isArray(input.AlarmNames) && input.AlarmNames.length > 0) {
      const set = new Set(input.AlarmNames);
      alarms = alarms.filter((a) => set.has(a.AlarmName));
    }
    if (input.AlarmNamePrefix) {
      alarms = alarms.filter((a) => a.AlarmName.startsWith(input.AlarmNamePrefix));
    }
    if (input.StateValue) {
      alarms = alarms.filter((a) => a.StateValue === input.StateValue);
    }
    if (input.ActionPrefix) {
      alarms = alarms.filter((a) =>
        (a.AlarmActions || []).some((x) => x.startsWith(input.ActionPrefix)),
      );
    }

    let types = input.AlarmTypes;
    if (!Array.isArray(types) || types.length === 0) {
      // Real CloudWatch default: only MetricAlarm unless AlarmTypes specified.
      types = ["MetricAlarm"];
    }

    const metricAlarms = [];
    const compositeAlarms = [];
    for (const a of alarms) {
      if (a.Type === "CompositeAlarm" && types.includes("CompositeAlarm")) {
        compositeAlarms.push(this.compositeAlarmView(a));
      } else if (a.Type === "MetricAlarm" && types.includes("MetricAlarm")) {
        metricAlarms.push(this.metricAlarmView(a));
      }
    }

    const out = { MetricAlarms: metricAlarms, CompositeAlarms: compositeAlarms };
    return out;
  }

  describeAlarmsForMetric(input) {
    if (!input.MetricName) {
      throw new CloudWatchError("MissingParameter", "The parameter MetricName is required.");
    }
    if (!input.Namespace) {
      throw new CloudWatchError("MissingParameter", "The parameter Namespace is required.");
    }
    const dk = dimsKey(input.Dimensions);
    const metricAlarms = [...this.alarms.values()]
      .filter(
        (a) =>
          a.Type === "MetricAlarm" &&
          a.MetricName === input.MetricName &&
          a.Namespace === input.Namespace &&
          (input.Dimensions === undefined || dimsKey(a.Dimensions) === dk),
      )
      .map((a) => this.metricAlarmView(a));
    return { MetricAlarms: metricAlarms };
  }

  describeAlarmContributors(input) {
    if (!input.AlarmName) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmName is required.");
    }
    const alarm = this.alarms.get(input.AlarmName);
    if (!alarm) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Alarm ${input.AlarmName} does not exist.`,
        404,
      );
    }
    // No per-contributor breakdown in the fake.
    return { AlarmContributors: [] };
  }

  deleteAlarms(input) {
    const names = input.AlarmNames;
    if (!Array.isArray(names) || names.length === 0) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmNames is required.");
    }
    // Validate all exist first (real CloudWatch errors if any are missing).
    for (const name of names) {
      if (!this.alarms.has(name)) {
        throw new CloudWatchError(
          "ResourceNotFound",
          `Alarm ${name} does not exist.`,
          404,
        );
      }
    }
    for (const name of names) {
      const a = this.alarms.get(name);
      this.alarms.delete(name);
      if (a) {
        this.recordAlarmHistory(name, a.AlarmArn, "ConfigurationUpdate", {
          message: "Alarm deleted",
        });
      }
    }
    return {};
  }

  setAlarmState(input) {
    const name = input.AlarmName;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter AlarmName is required.");
    if (!input.StateValue) throw new CloudWatchError("MissingParameter", "The parameter StateValue is required.");
    if (!input.StateReason) throw new CloudWatchError("MissingParameter", "The parameter StateReason is required.");
    const valid = new Set(["OK", "ALARM", "INSUFFICIENT_DATA"]);
    if (!valid.has(input.StateValue)) {
      throw new CloudWatchError(
        "InvalidParameterValue",
        `StateValue must be one of OK, ALARM, INSUFFICIENT_DATA.`,
      );
    }
    const alarm = this.alarms.get(name);
    if (!alarm) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Alarm ${name} does not exist.`,
        404,
      );
    }
    const oldState = alarm.StateValue;
    alarm.StateValue = input.StateValue;
    alarm.StateReason = input.StateReason;
    alarm.StateReasonData = input.StateReasonData;
    alarm.StateUpdatedTimestamp = nowSeconds();
    this.recordAlarmHistory(name, alarm.AlarmArn, "StateUpdate", {
      oldState,
      newState: input.StateValue,
      reason: input.StateReason,
    });
    return {};
  }

  enableAlarmActions(input) {
    const names = input.AlarmNames || [];
    for (const name of names) {
      const a = this.alarms.get(name);
      if (a) a.ActionsEnabled = true;
    }
    return {};
  }

  disableAlarmActions(input) {
    const names = input.AlarmNames || [];
    for (const name of names) {
      const a = this.alarms.get(name);
      if (a) a.ActionsEnabled = false;
    }
    return {};
  }

  recordAlarmHistory(alarmName, alarmArn, itemType, data) {
    this.alarmHistory.push({
      AlarmName: alarmName,
      AlarmType: this.alarms.get(alarmName)?.Type || "MetricAlarm",
      Timestamp: nowSeconds(),
      HistoryItemType: itemType,
      HistorySummary:
        itemType === "StateUpdate"
          ? `Alarm updated from ${data.oldState} to ${data.newState}`
          : data.message || "Configuration updated",
      HistoryData: JSON.stringify(data),
    });
  }

  describeAlarmHistory(input) {
    let items = [...this.alarmHistory];
    if (input.AlarmName) {
      items = items.filter((h) => h.AlarmName === input.AlarmName);
    }
    if (input.HistoryItemType) {
      items = items.filter((h) => h.HistoryItemType === input.HistoryItemType);
    }
    if (Array.isArray(input.AlarmTypes) && input.AlarmTypes.length > 0) {
      items = items.filter((h) => input.AlarmTypes.includes(h.AlarmType));
    }
    if (input.StartDate !== undefined) {
      const s = toEpochSeconds(input.StartDate);
      items = items.filter((h) => h.Timestamp >= s);
    }
    if (input.EndDate !== undefined) {
      const e = toEpochSeconds(input.EndDate);
      items = items.filter((h) => h.Timestamp <= e);
    }
    // Default ordering: newest first.
    if (input.ScanBy === "TimestampAscending") {
      items.sort((a, b) => a.Timestamp - b.Timestamp);
    } else {
      items.sort((a, b) => b.Timestamp - a.Timestamp);
    }
    const { page, nextToken } = this.paginate(items, input.NextToken, input.MaxRecords || 100);
    const out = { AlarmHistoryItems: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Alarm mute rules
  // -------------------------------------------------------------------------
  putAlarmMuteRule(input) {
    const name = input.Name;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter Name is required.");
    const existing = this.alarmMuteRules.get(name);
    const arn = this.arnFor("mute-rule", name);
    const rule = {
      Name: name,
      AlarmMuteRuleArn: arn,
      Description: input.Description,
      Rule: input.Rule,
      MuteTargets: input.MuteTargets,
      StartDate: toEpochSeconds(input.StartDate),
      ExpireDate: toEpochSeconds(input.ExpireDate),
      Status: "ACTIVE",
      MuteType: input.StartDate || input.ExpireDate ? "SCHEDULED" : "MANUAL",
      LastUpdatedTimestamp: nowSeconds(),
    };
    this.alarmMuteRules.set(name, rule);
    if (Array.isArray(input.Tags) && input.Tags.length > 0) {
      this.setTags(arn, input.Tags);
    }
    // PutAlarmMuteRule has no output members.
    return {};
  }

  getAlarmMuteRule(input) {
    const name = input.AlarmMuteRuleName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmMuteRuleName is required.");
    }
    const rule = this.alarmMuteRules.get(name);
    if (!rule) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Mute rule ${name} does not exist.`,
        404,
      );
    }
    return {
      Name: rule.Name,
      AlarmMuteRuleArn: rule.AlarmMuteRuleArn,
      Description: rule.Description,
      Rule: rule.Rule,
      MuteTargets: rule.MuteTargets,
      StartDate: rule.StartDate,
      ExpireDate: rule.ExpireDate,
      Status: rule.Status,
      LastUpdatedTimestamp: rule.LastUpdatedTimestamp,
      MuteType: rule.MuteType,
    };
  }

  deleteAlarmMuteRule(input) {
    const name = input.AlarmMuteRuleName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter AlarmMuteRuleName is required.");
    }
    if (!this.alarmMuteRules.has(name)) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Mute rule ${name} does not exist.`,
        404,
      );
    }
    this.alarmMuteRules.delete(name);
    return {};
  }

  listAlarmMuteRules(input) {
    const all = [...this.alarmMuteRules.values()].map((r) => ({
      AlarmMuteRuleArn: r.AlarmMuteRuleArn,
      ExpireDate: r.ExpireDate,
      Status: r.Status,
      MuteType: r.MuteType,
      LastUpdatedTimestamp: r.LastUpdatedTimestamp,
    }));
    const { page, nextToken } = this.paginate(all, input.NextToken, input.MaxRecords || 100);
    const out = { AlarmMuteRuleSummaries: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Dashboards
  // -------------------------------------------------------------------------
  putDashboard(input) {
    const name = input.DashboardName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter DashboardName is required.");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new CloudWatchError(
        "InvalidParameterValue",
        "The dashboard name may only contain alphanumerics, '-' and '_'.",
      );
    }
    const body = input.DashboardBody;
    if (body === undefined || body === null) {
      throw new CloudWatchError("MissingParameter", "The parameter DashboardBody is required.");
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new CloudWatchError(
        "DashboardInvalidInputError",
        "The dashboard body is invalid JSON.",
        400,
      );
    }
    if (!parsed || typeof parsed !== "object" || !("widgets" in parsed)) {
      throw new CloudWatchError(
        "DashboardInvalidInputError",
        "The dashboard body must contain a 'widgets' field.",
        400,
      );
    }
    this.dashboards.set(name, {
      name,
      body,
      lastModified: nowSeconds(),
      size: Buffer.byteLength(body, "utf8"),
    });
    // Validation messages (empty when valid).
    return { DashboardValidationMessages: [] };
  }

  getDashboard(input) {
    const name = input.DashboardName;
    if (!name) {
      throw new CloudWatchError("MissingParameter", "The parameter DashboardName is required.");
    }
    const dash = this.dashboards.get(name);
    if (!dash) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Dashboard ${name} does not exist.`,
        404,
      );
    }
    return {
      DashboardArn: `arn:aws:cloudwatch::${this.accountId}:dashboard/${name}`,
      DashboardName: name,
      DashboardBody: dash.body,
    };
  }

  listDashboards(input) {
    let all = [...this.dashboards.values()];
    if (input.DashboardNamePrefix) {
      all = all.filter((d) => d.name.startsWith(input.DashboardNamePrefix));
    }
    const entries = all.map((d) => ({
      DashboardName: d.name,
      DashboardArn: `arn:aws:cloudwatch::${this.accountId}:dashboard/${d.name}`,
      LastModified: d.lastModified,
      Size: d.size,
    }));
    const { page, nextToken } = this.paginate(entries, input.NextToken, 1000);
    const out = { DashboardEntries: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  deleteDashboards(input) {
    const names = input.DashboardNames;
    if (!Array.isArray(names) || names.length === 0) {
      throw new CloudWatchError("MissingParameter", "The parameter DashboardNames is required.");
    }
    for (const name of names) {
      if (!this.dashboards.has(name)) {
        throw new CloudWatchError(
          "ResourceNotFound",
          `Dashboard ${name} does not exist.`,
          404,
        );
      }
    }
    for (const name of names) this.dashboards.delete(name);
    return {};
  }

  // -------------------------------------------------------------------------
  // Anomaly detectors
  // -------------------------------------------------------------------------
  putAnomalyDetector(input) {
    const single = input.SingleMetricAnomalyDetector || {
      Namespace: input.Namespace,
      MetricName: input.MetricName,
      Dimensions: input.Dimensions,
      Stat: input.Stat,
    };
    if (input.MetricMathAnomalyDetector) {
      // Math-based detector.
      this.anomalyDetectors.push({
        MetricMathAnomalyDetector: input.MetricMathAnomalyDetector,
        Configuration: input.Configuration,
        StateValue: "TRAINED",
      });
      return {};
    }
    if (!single.Namespace || !single.MetricName || !single.Stat) {
      throw new CloudWatchError(
        "MissingParameter",
        "Namespace, MetricName and Stat are required for a single-metric anomaly detector.",
      );
    }
    // Idempotent on (namespace, metric, dims, stat).
    const exists = this.anomalyDetectors.find(
      (d) =>
        d.SingleMetricAnomalyDetector &&
        d.SingleMetricAnomalyDetector.Namespace === single.Namespace &&
        d.SingleMetricAnomalyDetector.MetricName === single.MetricName &&
        d.SingleMetricAnomalyDetector.Stat === single.Stat &&
        dimsKey(d.SingleMetricAnomalyDetector.Dimensions) === dimsKey(single.Dimensions),
    );
    if (!exists) {
      this.anomalyDetectors.push({
        SingleMetricAnomalyDetector: {
          Namespace: single.Namespace,
          MetricName: single.MetricName,
          Dimensions: single.Dimensions || [],
          Stat: single.Stat,
        },
        // Legacy flat fields too for older readers.
        Namespace: single.Namespace,
        MetricName: single.MetricName,
        Dimensions: single.Dimensions || [],
        Stat: single.Stat,
        Configuration: input.Configuration,
        StateValue: "TRAINED",
      });
    }
    return {};
  }

  describeAnomalyDetectors(input) {
    let detectors = [...this.anomalyDetectors];
    if (input.Namespace) {
      detectors = detectors.filter(
        (d) =>
          (d.SingleMetricAnomalyDetector &&
            d.SingleMetricAnomalyDetector.Namespace === input.Namespace) ||
          d.Namespace === input.Namespace,
      );
    }
    if (input.MetricName) {
      detectors = detectors.filter(
        (d) =>
          (d.SingleMetricAnomalyDetector &&
            d.SingleMetricAnomalyDetector.MetricName === input.MetricName) ||
          d.MetricName === input.MetricName,
      );
    }
    const view = detectors.map((d) => ({
      Namespace: d.Namespace,
      MetricName: d.MetricName,
      Dimensions: d.Dimensions,
      Stat: d.Stat,
      Configuration: d.Configuration,
      StateValue: d.StateValue,
      SingleMetricAnomalyDetector: d.SingleMetricAnomalyDetector,
      MetricMathAnomalyDetector: d.MetricMathAnomalyDetector,
    }));
    const { page, nextToken } = this.paginate(view, input.NextToken, input.MaxResults || 100);
    const out = { AnomalyDetectors: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  deleteAnomalyDetector(input) {
    const single = input.SingleMetricAnomalyDetector || {
      Namespace: input.Namespace,
      MetricName: input.MetricName,
      Dimensions: input.Dimensions,
      Stat: input.Stat,
    };
    const before = this.anomalyDetectors.length;
    this.anomalyDetectors = this.anomalyDetectors.filter((d) => {
      const det = d.SingleMetricAnomalyDetector || d;
      return !(
        det.Namespace === single.Namespace &&
        det.MetricName === single.MetricName &&
        det.Stat === single.Stat &&
        dimsKey(det.Dimensions) === dimsKey(single.Dimensions)
      );
    });
    if (this.anomalyDetectors.length === before) {
      throw new CloudWatchError(
        "ResourceNotFound",
        "The anomaly detector does not exist.",
        404,
      );
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // Insight rules
  // -------------------------------------------------------------------------
  putInsightRule(input) {
    const name = input.RuleName;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter RuleName is required.");
    if (!input.RuleDefinition) {
      throw new CloudWatchError("MissingParameter", "The parameter RuleDefinition is required.");
    }
    this.insightRules.set(name, {
      Name: name,
      State: input.RuleState || "ENABLED",
      Definition: input.RuleDefinition,
      Schema: '{"Name":"CloudWatchLogRule","Version":1}',
      ManagedRule: false,
    });
    if (Array.isArray(input.Tags) && input.Tags.length > 0) {
      this.setTags(this.arnFor("insight-rule", name), input.Tags);
    }
    return {};
  }

  describeInsightRules(input) {
    const rules = [...this.insightRules.values()].map((r) => ({
      Name: r.Name,
      State: r.State,
      Schema: r.Schema,
      Definition: r.Definition,
      ManagedRule: r.ManagedRule,
    }));
    const { page, nextToken } = this.paginate(rules, input.NextToken, input.MaxResults || 100);
    const out = { InsightRules: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  deleteInsightRules(input) {
    const names = input.RuleNames || [];
    const failures = [];
    for (const name of names) {
      if (!this.insightRules.has(name)) {
        failures.push({
          FailureResource: name,
          ExceptionType: "MissingParameter",
          FailureCode: "404",
          FailureDescription: `Rule ${name} does not exist.`,
        });
      } else {
        this.insightRules.delete(name);
      }
    }
    return { Failures: failures };
  }

  enableInsightRules(input) {
    const names = input.RuleNames || [];
    const failures = [];
    for (const name of names) {
      const r = this.insightRules.get(name);
      if (!r) {
        failures.push({
          FailureResource: name,
          ExceptionType: "MissingParameter",
          FailureCode: "404",
          FailureDescription: `Rule ${name} does not exist.`,
        });
      } else {
        r.State = "ENABLED";
      }
    }
    return { Failures: failures };
  }

  disableInsightRules(input) {
    const names = input.RuleNames || [];
    const failures = [];
    for (const name of names) {
      const r = this.insightRules.get(name);
      if (!r) {
        failures.push({
          FailureResource: name,
          ExceptionType: "MissingParameter",
          FailureCode: "404",
          FailureDescription: `Rule ${name} does not exist.`,
        });
      } else {
        r.State = "DISABLED";
      }
    }
    return { Failures: failures };
  }

  getInsightRuleReport(input) {
    const name = input.RuleName;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter RuleName is required.");
    if (!this.insightRules.has(name)) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Rule ${name} does not exist.`,
        404,
      );
    }
    return {
      KeyLabels: [],
      AggregationStatistic: "Sum",
      AggregateValue: 0,
      ApproximateUniqueCount: 0,
      Contributors: [],
      MetricDatapoints: [],
    };
  }

  putManagedInsightRules(input) {
    const rules = input.ManagedRules || [];
    const failures = [];
    for (const r of rules) {
      if (!r.TemplateName || !r.ResourceARN) {
        failures.push({
          FailureResource: r.ResourceARN || r.TemplateName || "(unknown)",
          ExceptionType: "MissingParameter",
          FailureCode: "400",
          FailureDescription: "TemplateName and ResourceARN are required.",
        });
        continue;
      }
      const key = `${r.TemplateName}\u0000${r.ResourceARN}`;
      this.managedInsightRules.set(key, {
        TemplateName: r.TemplateName,
        ResourceARN: r.ResourceARN,
        State: "ENABLED",
        Tags: r.Tags || [],
      });
    }
    return { Failures: failures };
  }

  listManagedInsightRules(input) {
    if (!input.ResourceARN) {
      throw new CloudWatchError("MissingParameter", "The parameter ResourceARN is required.");
    }
    const rules = [...this.managedInsightRules.values()]
      .filter((r) => r.ResourceARN === input.ResourceARN)
      .map((r) => ({
        TemplateName: r.TemplateName,
        ResourceARN: r.ResourceARN,
        RuleState: { RuleName: r.TemplateName, State: r.State },
      }));
    const { page, nextToken } = this.paginate(rules, input.NextToken, input.MaxResults || 100);
    const out = { ManagedRules: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  // -------------------------------------------------------------------------
  // Metric streams
  // -------------------------------------------------------------------------
  putMetricStream(input) {
    const name = input.Name;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter Name is required.");
    if (!input.FirehoseArn) throw new CloudWatchError("MissingParameter", "The parameter FirehoseArn is required.");
    if (!input.RoleArn) throw new CloudWatchError("MissingParameter", "The parameter RoleArn is required.");
    if (!input.OutputFormat) throw new CloudWatchError("MissingParameter", "The parameter OutputFormat is required.");
    if (input.IncludeFilters && input.ExcludeFilters) {
      throw new CloudWatchError(
        "InvalidParameterCombination",
        "IncludeFilters and ExcludeFilters are mutually exclusive.",
      );
    }
    const arn = this.arnFor("metric-stream", name);
    const existing = this.metricStreams.get(name);
    const now = nowSeconds();
    this.metricStreams.set(name, {
      Name: name,
      Arn: arn,
      FirehoseArn: input.FirehoseArn,
      RoleArn: input.RoleArn,
      OutputFormat: input.OutputFormat,
      IncludeFilters: input.IncludeFilters,
      ExcludeFilters: input.ExcludeFilters,
      StatisticsConfigurations: input.StatisticsConfigurations || [],
      IncludeLinkedAccountsMetrics: input.IncludeLinkedAccountsMetrics || false,
      State: existing ? existing.State : "running",
      CreationDate: existing ? existing.CreationDate : now,
      LastUpdateDate: now,
    });
    if (Array.isArray(input.Tags) && input.Tags.length > 0) {
      this.setTags(arn, input.Tags);
    }
    return { Arn: arn };
  }

  getMetricStream(input) {
    const name = input.Name;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter Name is required.");
    const s = this.metricStreams.get(name);
    if (!s) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Metric stream ${name} does not exist.`,
        404,
      );
    }
    return {
      Arn: s.Arn,
      Name: s.Name,
      FirehoseArn: s.FirehoseArn,
      RoleArn: s.RoleArn,
      IncludeFilters: s.IncludeFilters,
      ExcludeFilters: s.ExcludeFilters,
      OutputFormat: s.OutputFormat,
      State: s.State,
      CreationDate: s.CreationDate,
      LastUpdateDate: s.LastUpdateDate,
      StatisticsConfigurations: s.StatisticsConfigurations,
      IncludeLinkedAccountsMetrics: s.IncludeLinkedAccountsMetrics,
    };
  }

  listMetricStreams(input) {
    const entries = [...this.metricStreams.values()].map((s) => ({
      Arn: s.Arn,
      Name: s.Name,
      FirehoseArn: s.FirehoseArn,
      State: s.State,
      OutputFormat: s.OutputFormat,
      CreationDate: s.CreationDate,
      LastUpdateDate: s.LastUpdateDate,
    }));
    const { page, nextToken } = this.paginate(entries, input.NextToken, input.MaxResults || 100);
    const out = { Entries: page };
    if (nextToken) out.NextToken = nextToken;
    return out;
  }

  deleteMetricStream(input) {
    const name = input.Name;
    if (!name) throw new CloudWatchError("MissingParameter", "The parameter Name is required.");
    // Idempotent delete.
    this.metricStreams.delete(name);
    return {};
  }

  startMetricStreams(input) {
    const names = input.Names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new CloudWatchError("MissingParameter", "The parameter Names is required.");
    }
    for (const name of names) {
      const s = this.metricStreams.get(name);
      if (!s) {
        throw new CloudWatchError(
          "ResourceNotFound",
          `Metric stream ${name} does not exist.`,
          404,
        );
      }
      s.State = "running";
      s.LastUpdateDate = nowSeconds();
    }
    return {};
  }

  stopMetricStreams(input) {
    const names = input.Names;
    if (!Array.isArray(names) || names.length === 0) {
      throw new CloudWatchError("MissingParameter", "The parameter Names is required.");
    }
    for (const name of names) {
      const s = this.metricStreams.get(name);
      if (!s) {
        throw new CloudWatchError(
          "ResourceNotFound",
          `Metric stream ${name} does not exist.`,
          404,
        );
      }
      s.State = "stopped";
      s.LastUpdateDate = nowSeconds();
    }
    return {};
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------
  setTags(resourceArn, tags) {
    let map = this.tags.get(resourceArn);
    if (!map) {
      map = {};
      this.tags.set(resourceArn, map);
    }
    for (const t of tags) {
      if (t && t.Key !== undefined) map[t.Key] = t.Value ?? "";
    }
  }

  knownResource(arn) {
    // We track tags for alarms, metric streams, insight rules. Real CloudWatch
    // validates the resource exists; we accept any CloudWatch-style ARN that
    // maps to a tracked resource, otherwise 404.
    if (this.tags.has(arn)) return true;
    // alarm arn
    const alarmMatch = /:alarm:(.+)$/.exec(arn);
    if (alarmMatch && this.alarms.has(alarmMatch[1])) return true;
    const streamMatch = /:metric-stream:(.+)$/.exec(arn);
    if (streamMatch && this.metricStreams.has(streamMatch[1])) return true;
    const ruleMatch = /:insight-rule:(.+)$/.exec(arn);
    if (ruleMatch && this.insightRules.has(ruleMatch[1])) return true;
    return false;
  }

  tagResource(input) {
    const arn = input.ResourceARN;
    if (!arn) throw new CloudWatchError("MissingParameter", "The parameter ResourceARN is required.");
    if (!Array.isArray(input.Tags) || input.Tags.length === 0) {
      throw new CloudWatchError("MissingParameter", "The parameter Tags is required.");
    }
    if (!this.knownResource(arn)) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `The resource ${arn} does not exist.`,
        404,
      );
    }
    this.setTags(arn, input.Tags);
    return {};
  }

  untagResource(input) {
    const arn = input.ResourceARN;
    if (!arn) throw new CloudWatchError("MissingParameter", "The parameter ResourceARN is required.");
    if (!this.knownResource(arn)) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `The resource ${arn} does not exist.`,
        404,
      );
    }
    const map = this.tags.get(arn);
    if (map) {
      for (const key of input.TagKeys || []) delete map[key];
    }
    return {};
  }

  listTagsForResource(input) {
    const arn = input.ResourceARN;
    if (!arn) throw new CloudWatchError("MissingParameter", "The parameter ResourceARN is required.");
    if (!this.knownResource(arn)) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `The resource ${arn} does not exist.`,
        404,
      );
    }
    const map = this.tags.get(arn) || {};
    const tags = Object.entries(map).map(([Key, Value]) => ({ Key, Value }));
    return { Tags: tags };
  }

  // -------------------------------------------------------------------------
  // Datasets (newer surface)
  // -------------------------------------------------------------------------
  getDataset(input) {
    const id = input.DatasetIdentifier;
    if (!id) {
      throw new CloudWatchError("MissingParameter", "The parameter DatasetIdentifier is required.");
    }
    const ds = this.datasets.get(id);
    if (!ds) {
      throw new CloudWatchError(
        "ResourceNotFound",
        `Dataset ${id} does not exist.`,
        404,
      );
    }
    return {
      DatasetId: ds.DatasetId,
      Arn: ds.Arn,
      KmsKeyArn: ds.KmsKeyArn,
    };
  }

  associateDatasetKmsKey(input) {
    const id = input.DatasetIdentifier;
    if (!id) {
      throw new CloudWatchError("MissingParameter", "The parameter DatasetIdentifier is required.");
    }
    if (!input.KmsKeyArn) {
      throw new CloudWatchError("MissingParameter", "The parameter KmsKeyArn is required.");
    }
    const ds = this.datasets.get(id) || {
      DatasetId: id,
      Arn: this.arnFor("dataset", id),
    };
    ds.KmsKeyArn = input.KmsKeyArn;
    this.datasets.set(id, ds);
    return {};
  }

  disassociateDatasetKmsKey(input) {
    const id = input.DatasetIdentifier;
    if (!id) {
      throw new CloudWatchError("MissingParameter", "The parameter DatasetIdentifier is required.");
    }
    const ds = this.datasets.get(id);
    if (ds) delete ds.KmsKeyArn;
    return {};
  }

  // -------------------------------------------------------------------------
  // OTel enrichment (newer surface)
  // -------------------------------------------------------------------------
  getOTelEnrichment() {
    return { Status: this.otelEnrichment.Status };
  }

  startOTelEnrichment() {
    this.otelEnrichment.Status = "ENABLED";
    return {};
  }

  stopOTelEnrichment() {
    this.otelEnrichment.Status = "DISABLED";
    return {};
  }

  // -------------------------------------------------------------------------
  // Pagination helper (NextToken is a base64 offset)
  // -------------------------------------------------------------------------
  paginate(items, nextToken, pageSize) {
    const size = pageSize && pageSize > 0 ? pageSize : 100;
    let start = 0;
    if (nextToken) {
      const decoded = parseInt(
        Buffer.from(String(nextToken), "base64").toString("utf8"),
        10,
      );
      if (!Number.isNaN(decoded)) start = decoded;
    }
    const page = items.slice(start, start + size);
    let token;
    if (start + size < items.length) {
      token = Buffer.from(String(start + size)).toString("base64");
    }
    return { page, nextToken: token };
  }

  // -------------------------------------------------------------------------
  // Response writers
  // -------------------------------------------------------------------------
  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/x-amz-json-1.0");
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalServiceError";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/x-amz-json-1.0");
    // AWS JSON 1.0 error shape: { __type, message }. The SDK reads __type for
    // the error name and message for the human-readable message.
    res.end(
      JSON.stringify({
        __type: code,
        message: error.message || code,
        Message: error.message || code,
      }),
    );
  }
}

export default CloudwatchServer;
export const API_VERSION_CLOUDWATCH = API_VERSION;
