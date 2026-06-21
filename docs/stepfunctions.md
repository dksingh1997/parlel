# Step Functions

Lightweight, dependency-free fake of AWS Step Functions (Amazon States Language / SFN) that speaks the real Step Functions **AWS JSON 1.0** wire protocol, so application code using `@aws-sdk/client-sfn` can run against it with zero cost and zero side effects. It ships a compact but real Amazon States Language interpreter, so executions actually run.

| Key | Value |
|-----|-------|
| Port | 4577 |
| Protocol | Step Functions AWS JSON 1.0 over HTTP/1.1 (`X-Amz-Target: AWSStepFunctions.<Op>`) |
| Compatible client | `@aws-sdk/client-sfn` (v3) |
| Image | `parlel/stepfunctions:0.1` |
| Size | ~95 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

> **Host prefix.** On real AWS, `StartSyncExecution` and `TestState` use a `sync-` host prefix (e.g. `sync-states.us-east-1.amazonaws.com`). When pointing the SDK at this fake, construct the client with `disableHostPrefix: true` so those two operations reach the single listener. Every operation is served from `POST /`.

## Quick Start

Start the server:

```js
import { StepfunctionsServer } from "./services/stepfunctions/src/server.js";

const server = new StepfunctionsServer(4577);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  SFNClient,
  CreateStateMachineCommand,
  StartExecutionCommand,
  DescribeExecutionCommand,
} from "@aws-sdk/client-sfn";

const sfn = new SFNClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4577",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
  disableHostPrefix: true, // needed for StartSyncExecution / TestState
});

const definition = JSON.stringify({
  StartAt: "Greet",
  States: {
    Greet: { Type: "Pass", Result: { greeting: "hello" }, ResultPath: "$.added", Next: "Done" },
    Done: { Type: "Succeed" },
  },
});

// Create a state machine.
const { stateMachineArn } = await sfn.send(
  new CreateStateMachineCommand({
    name: "greeter",
    definition,
    roleArn: "arn:aws:iam::123456789012:role/parlel",
  }),
);

// Start an execution.
const { executionArn } = await sfn.send(
  new StartExecutionCommand({ stateMachineArn, input: JSON.stringify({ a: 1 }) }),
);

// Inspect the result.
const result = await sfn.send(new DescribeExecutionCommand({ executionArn }));
console.log(result.status); // "SUCCEEDED"
console.log(JSON.parse(result.output)); // { a: 1, added: { greeting: "hello" } }
```

## Implemented operations

All **37** operations exposed by `@aws-sdk/client-sfn` are implemented.

### State machines
- `CreateStateMachine` — STANDARD & EXPRESS, optional `publish`, tag attach, idempotent re-create
- `UpdateStateMachine` — definition / role / logging / tracing / encryption, optional `publish`
- `DescribeStateMachine` — by ARN, version ARN, or alias ARN
- `DeleteStateMachine` — idempotent
- `ListStateMachines` — paginated
- `ValidateStateMachineDefinition` — returns `OK` / `FAIL` with diagnostics

### Versions
- `PublishStateMachineVersion`
- `ListStateMachineVersions` — paginated
- `DeleteStateMachineVersion`

### Aliases
- `CreateStateMachineAlias` — weighted `routingConfiguration` (weights must sum to 100)
- `UpdateStateMachineAlias`
- `DescribeStateMachineAlias`
- `ListStateMachineAliases` — paginated
- `DeleteStateMachineAlias`

### Executions
- `StartExecution` — runs the ASL interpreter; idempotent on `(name, input)`
- `StartSyncExecution` — EXPRESS only; returns output inline
- `StopExecution` — marks `ABORTED`, makes execution redrivable
- `DescribeExecution`
- `ListExecutions` — filter by state machine + `statusFilter`, paginated
- `GetExecutionHistory` — real event stream, `reverseOrder` supported, paginated
- `DescribeStateMachineForExecution`
- `RedriveExecution` — re-runs a failed/aborted (redrivable) execution

### Activities
- `CreateActivity` — idempotent, tag attach
- `DescribeActivity`
- `DeleteActivity`
- `ListActivities` — paginated
- `GetActivityTask` — dequeues a pending `.waitForTaskToken` activity task (returns empty immediately if none)

### Task tokens (callback pattern)
- `SendTaskSuccess` — resolves a `.waitForTaskToken` task with output
- `SendTaskFailure` — fails the task (drives Retry/Catch)
- `SendTaskHeartbeat` — records a heartbeat for a live token

### Map runs (distributed map)
- `DescribeMapRun`
- `ListMapRuns` — paginated
- `UpdateMapRun`

### State testing
- `TestState` — runs a single state definition against an input, returns output / nextState / error

### Tags
- `TagResource`
- `UntagResource`
- `ListTagsForResource`

## Amazon States Language interpreter

`StartExecution` / `StartSyncExecution` actually execute the state machine. Supported state types and features:

| Feature | Supported |
|---------|-----------|
| `Pass` state (Result, Parameters, ResultPath, OutputPath) | Yes |
| `Task` state (identity by default, pluggable resolvers) | Yes |
| `Task` `.waitForTaskToken` callback pattern | Yes |
| `Choice` state (And/Or/Not, all comparators, `*Path`) | Yes |
| `Wait` state (Seconds / SecondsPath / Timestamp / TimestampPath, capped at 2s) | Yes |
| `Succeed` / `Fail` states | Yes |
| `Parallel` state (branches run concurrently) | Yes |
| `Map` state (inline) — ItemsPath, ItemSelector/Parameters, MaxConcurrency | Yes |
| `Map` state (distributed) — creates a MapRun record | Yes |
| `Retry` (ErrorEquals, MaxAttempts, IntervalSeconds, BackoffRate) | Yes (delays sped up) |
| `Catch` (ErrorEquals, Next, ResultPath) | Yes |
| `InputPath` / `OutputPath` / `ResultPath` / `ResultSelector` / `Parameters` | Yes |
| JSONPath (`$`, `$.a.b`, `$['a']`, `$.a[0]`, `$$` context object) | Yes (subset) |
| Intrinsic functions | Yes (see below) |
| Execution history events | Yes |

### Intrinsic functions

`States.Format`, `States.StringToJson`, `States.JsonToString`, `States.Array`, `States.ArrayLength`, `States.ArrayGetItem`, `States.ArrayContains`, `States.ArrayRange`, `States.ArrayPartition`, `States.ArrayUnique`, `States.MathAdd`, `States.MathRandom`, `States.StringSplit`, `States.UUID`, `States.Base64Encode`, `States.Base64Decode`, `States.Hash`, `States.JsonMerge`.

### Task resolution (parlel extension)

By default a `Task` state is an identity task: it returns its effective input as the result, which is enough to test most flow logic. To return real values, register a resolver keyed by the `Resource` ARN on the server instance:

```js
server.taskResolvers.set(
  "arn:aws:lambda:us-east-1:123456789012:function:work",
  async (input, ctx) => ({ doubled: input.value * 2 }),
);
```

For `.waitForTaskToken` resources, complete the task out of band with `SendTaskSuccess` / `SendTaskFailure` using the token surfaced to your resolver (or to a paired activity via `GetActivityTask`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| STANDARD & EXPRESS state machines | Supported |
| Synchronous express executions (`StartSyncExecution`) | Supported |
| Versions, aliases, weighted routing | Supported |
| Activities + callback task tokens | Supported |
| Distributed Map runs (records, counts) | Supported (simplified) |
| Execution history events | Supported (core event types) |
| Real AWS service integrations (Lambda invoke, DynamoDB, SNS, SQS, …) | Identity task unless a resolver is registered |
| CloudWatch Logs / X-Ray delivery | Config accepted; no external delivery |
| KMS encryption | Config accepted; data not actually encrypted |
| IAM authorization / SigV4 verification | Not enforced (any credentials accepted) |
| Long-poll semantics of `GetActivityTask` (60s) | Returns immediately |
| Quotas / throttling | Not enforced |

## Error codes & shapes

Errors are returned with a non-2xx status, the `x-amzn-errortype: <Code>` header, and a JSON body:

```json
{ "__type": "StateMachineDoesNotExist", "message": "State Machine Does Not Exist: '<arn>'." }
```

Modeled error codes returned by this fake:

| Code | When |
|------|------|
| `InvalidArn` | Malformed ARN |
| `InvalidName` | Bad state machine / activity / execution name |
| `InvalidDefinition` | ASL definition fails JSON / schema validation |
| `InvalidExecutionInput` | Execution input is not valid JSON |
| `InvalidToken` | Missing task token |
| `InvalidOutput` | `SendTaskSuccess` output is not valid JSON |
| `MissingRequiredParameter` | Required field absent (e.g. `roleArn`, empty update) |
| `StateMachineAlreadyExists` | Re-create with different definition |
| `StateMachineDoesNotExist` | Unknown state machine ARN |
| `StateMachineTypeNotSupported` | `StartSyncExecution` on a STANDARD machine |
| `ExecutionAlreadyExists` | Duplicate execution name with different input |
| `ExecutionDoesNotExist` | Unknown execution ARN |
| `ExecutionNotRedrivable` | Redrive a running or non-redrivable execution |
| `ActivityDoesNotExist` | Unknown activity ARN |
| `TaskDoesNotExist` | Unknown / already-settled task token |
| `ResourceNotFound` | Unknown alias / map run / taggable resource |
| `ConflictException` | Alias already exists |
| `ValidationException` | Generic validation failure (e.g. routing weights ≠ 100) |
| `TooManyTags` | More than 50 tags |
| `InternalServerException` | Unexpected server fault (500) |

## Internal endpoints

Two non-AWS helper endpoints are exposed for test orchestration:

- `GET /_parlel/health` → `{ status, service, stateMachines, executions, activities }`
- `POST /_parlel/reset` → clears all in-memory state

You can also reset programmatically with `server.reset()`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_STEP_FUNCTIONS=http://localhost:4577
AWS_ENDPOINT_URL=http://localhost:4577
```

<!-- parlel:testenv:end -->
