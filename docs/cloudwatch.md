# CloudWatch

Lightweight, dependency-free fake of AWS CloudWatch that speaks the real CloudWatch AWS JSON 1.0 wire protocol (JSON requests with an `X-Amz-Target` header, JSON responses, API version `2010-08-01`), so application code using `@aws-sdk/client-cloudwatch` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4574 |
| Protocol | AWS JSON 1.0 (`application/x-amz-json-1.0`) over HTTP |
| API version | 2010-08-01 |
| Target prefix | `GraniteServiceVersion20100801` |
| XML namespace (legacy) | `http://monitoring.amazonaws.com/doc/2010-08-01/` |
| Compatible client | `@aws-sdk/client-cloudwatch` (v3) |
| Size | ~95 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

> **Protocol note.** Recent versions of the CloudWatch SDK (v3) use the AWS
> **JSON 1.0** protocol — *not* the older Query/XML protocol. Requests are a
> `POST /` with `Content-Type: application/x-amz-json-1.0`, the operation in the
> `X-Amz-Target` header (`GraniteServiceVersion20100801.<Operation>`), and a JSON
> body. Wire timestamps are epoch **seconds**. The parlel fake implements this
> exact protocol.

## Quick Start

Start the server:

```js
import { CloudwatchServer } from "./services/cloudwatch/src/server.js";

const server = new CloudwatchServer(4574);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  CloudWatchClient,
  PutMetricDataCommand,
  GetMetricStatisticsCommand,
  PutMetricAlarmCommand,
  DescribeAlarmsCommand,
  SetAlarmStateCommand,
} from "@aws-sdk/client-cloudwatch";

const cw = new CloudWatchClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4574",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Publish a metric datapoint
await cw.send(
  new PutMetricDataCommand({
    Namespace: "MyApp",
    MetricData: [
      {
        MetricName: "Latency",
        Value: 100,
        Unit: "Milliseconds",
        Dimensions: [{ Name: "Host", Value: "web-1" }],
      },
    ],
  }),
);

// Read back aggregated statistics
const stats = await cw.send(
  new GetMetricStatisticsCommand({
    Namespace: "MyApp",
    MetricName: "Latency",
    StartTime: new Date(Date.now() - 3600_000),
    EndTime: new Date(),
    Period: 60,
    Statistics: ["Average", "Sum", "Maximum"],
  }),
);

// Create an alarm and drive its state
await cw.send(
  new PutMetricAlarmCommand({
    AlarmName: "latency-high",
    Namespace: "MyApp",
    MetricName: "Latency",
    Statistic: "Average",
    Period: 60,
    EvaluationPeriods: 2,
    Threshold: 200,
    ComparisonOperator: "GreaterThanThreshold",
  }),
);
await cw.send(
  new SetAlarmStateCommand({
    AlarmName: "latency-high",
    StateValue: "ALARM",
    StateReason: "Synthetic test",
  }),
);
const { MetricAlarms } = await cw.send(
  new DescribeAlarmsCommand({ AlarmNames: ["latency-high"] }),
);
```

## Health & reset (parlel-only helpers)

These endpoints are **not** part of the CloudWatch API — they are parlel
conveniences for tests and orchestration.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/_parlel/health` | Returns `{ status, service, metrics, alarms, dashboards }`. |
| `POST` | `/_parlel/reset` | Clears all in-memory state. |

You can also reset in-process via `server.reset()`.

## Implemented operations

All 48 operations the `@aws-sdk/client-cloudwatch` v3 client exposes are
implemented. Grouped below.

### Metrics
- `PutMetricData` — ingest value / statistic-set / value+count histograms; rejects the reserved `AWS/` namespace.
- `GetMetricStatistics` — period-bucketed `Average`/`Sum`/`Minimum`/`Maximum`/`SampleCount` plus `ExtendedStatistics` percentiles (`pNN`).
- `GetMetricData` — metric-stat queries plus a minimal metric-math expression engine (scalar arithmetic over other query ids), honors `ScanBy` and `ReturnData`.
- `ListMetrics` — filter by `Namespace`, `MetricName`, and `Dimensions`; paginated.
- `GetMetricWidgetImage` — returns a tiny valid PNG blob.

### Alarms
- `PutMetricAlarm` — metric and metric-math (`Metrics`) alarms; inline `Tags`.
- `PutCompositeAlarm` — composite alarms with an `AlarmRule`.
- `DescribeAlarms` — filter by names/prefix/state/action-prefix and `AlarmTypes` (defaults to `MetricAlarm` only, matching AWS).
- `DescribeAlarmsForMetric` — alarms attached to a given metric+dimensions.
- `DescribeAlarmHistory` — configuration and state-transition history, filterable and paginated.
- `DescribeAlarmContributors` — returns an empty contributor list.
- `DeleteAlarms` — deletes (errors if any name is missing).
- `SetAlarmState` — drive `OK` / `ALARM` / `INSUFFICIENT_DATA`, records history.
- `EnableAlarmActions` / `DisableAlarmActions` — toggle `ActionsEnabled`.

### Alarm mute rules
- `PutAlarmMuteRule` — create/update a mute rule keyed by `Name`.
- `GetAlarmMuteRule` — fetch by `AlarmMuteRuleName`.
- `DeleteAlarmMuteRule` — delete by `AlarmMuteRuleName`.
- `ListAlarmMuteRules` — returns `AlarmMuteRuleSummaries`.

### Dashboards
- `PutDashboard` — validates JSON body and the `widgets` field.
- `GetDashboard` — returns body + ARN.
- `ListDashboards` — prefix filter, paginated.
- `DeleteDashboards` — errors if any name is missing.

### Anomaly detectors
- `PutAnomalyDetector` — single-metric and metric-math detectors (idempotent).
- `DescribeAnomalyDetectors` — filter by namespace/metric.
- `DeleteAnomalyDetector` — remove a single-metric detector.

### Insight rules (Contributor Insights)
- `PutInsightRule`
- `DescribeInsightRules`
- `DeleteInsightRules` (batch, returns `Failures`)
- `EnableInsightRules` / `DisableInsightRules` (batch, returns `Failures`)
- `GetInsightRuleReport`

### Managed insight rules
- `PutManagedInsightRules` — returns `Failures`.
- `ListManagedInsightRules` — filter by `ResourceARN`.

### Metric streams
- `PutMetricStream` — `IncludeFilters`/`ExcludeFilters` are mutually exclusive.
- `GetMetricStream`
- `ListMetricStreams`
- `DeleteMetricStream` (idempotent)
- `StartMetricStreams` / `StopMetricStreams`

### Tags
- `TagResource`
- `UntagResource`
- `ListTagsForResource`

(Tagging is tracked for alarms, metric streams, insight rules and mute rules.)

### Datasets (newer surface)
- `GetDataset` — by `DatasetIdentifier`.
- `AssociateDatasetKmsKey` — `DatasetIdentifier` + `KmsKeyArn`.
- `DisassociateDatasetKmsKey`.

### OpenTelemetry enrichment (newer surface)
- `GetOTelEnrichment` — returns `{ Status }`.
- `StartOTelEnrichment` / `StopOTelEnrichment`.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported? | Notes |
|---------|------------|-------|
| All 48 SDK operations dispatched | ✅ | Unknown actions return `InvalidAction`. |
| Metric ingestion (Value / StatisticValues / Values+Counts) | ✅ | Stored in-memory per series (namespace + name + dimensions). |
| Period-bucketed statistics | ✅ | `Average`, `Sum`, `Minimum`, `Maximum`, `SampleCount`. |
| Extended statistics (percentiles) | ✅ | `pNN` (e.g. `p50`, `p99`) computed from raw stored values. |
| Metric-math expressions | ⚠️ Partial | Scalar arithmetic referencing other query ids (`m1 * 2`, `m1 + m2`). Advanced functions (`SEARCH`, `FILL`, `RATE`, etc.) are not evaluated. |
| Dimensions matching | ✅ | Exact match on the full dimension set per series. |
| Alarm state machine | ⚠️ Manual | State is set via `SetAlarmState`; the fake does **not** auto-evaluate alarms against ingested metrics. |
| Alarm actions (SNS/Auto Scaling/etc.) | ⟳ Roadmap |
| Composite alarm rule evaluation | ⟳ Roadmap |
| Anomaly detector training/bands | ⟳ Roadmap |
| Insight rule reports | ⚠️ Empty | `GetInsightRuleReport` returns an empty, well-typed report. |
| Metric streams delivery to Firehose | ⟳ Roadmap |
| `GetMetricWidgetImage` rendering | ⚠️ Stub | Returns a valid 1×1 PNG, not a real chart. |
| Pagination (`NextToken`) | ✅ | Base64 offset tokens across list operations. |
| Cross-account / linked accounts | ⟳ Roadmap |
| Persistence | ✓ By design — In-memory by design — fast, isolated, resets cleanly between tests |

## Error codes & shapes

Errors use the AWS JSON 1.0 error envelope. The HTTP status reflects the fault
class, and the body carries the error type and message:

```http
HTTP/1.1 404 Not Found
Content-Type: application/x-amz-json-1.0

{ "__type": "ResourceNotFound", "message": "Dashboard ghost does not exist.", "Message": "..." }
```

The SDK reads `__type` as the error `name` and `message` as the error message.

| Code | HTTP status | When |
|------|-------------|------|
| `MissingParameter` | 400 | A required field is absent (server-side). |
| `InvalidParameterValue` | 400 | A field has an invalid value (e.g. reserved `AWS/` namespace, bad `StateValue`, bad dashboard name, `StartTime >= EndTime`). |
| `InvalidParameterCombination` | 400 | Mutually exclusive / incomplete combos (e.g. both `IncludeFilters` and `ExcludeFilters`; a metric datum with no value). |
| `InvalidFormat` | 400 | Request body is not valid JSON. |
| `DashboardInvalidInputError` | 400 | Dashboard body is not valid JSON or lacks `widgets`. |
| `ResourceNotFound` | 404 | Alarm / dashboard / stream / rule / detector / dataset / mute rule does not exist. |
| `InvalidAction` | 400 | Unknown `X-Amz-Target` operation. |
| `InternalServiceError` | 500 | Unexpected server error. |

> Some required-parameter checks are enforced **client-side** by the AWS SDK
> before a request is sent (it throws `MissingRequiredParameter`). The parlel
> fake also validates server-side, so a raw HTTP request with the field omitted
> returns `MissingParameter`.

## Running the tests

```bash
npx vitest run tests/cloudwatch.test.ts
```

The suite starts the server on a high non-conflicting port (`14574`), exercises
every implemented operation (happy paths plus key edge/error cases), asserts the
real SDK-deserialized responses, and tears the server down in `afterAll`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_CLOUDWATCH=http://localhost:4574
AWS_ENDPOINT_URL=http://localhost:4574
```

<!-- parlel:testenv:end -->
