# EventBridge

Lightweight, dependency-free fake of AWS EventBridge that speaks the real EventBridge AWS JSON 1.1 wire protocol (`X-Amz-Target: AWSEvents.<Operation>`, `Content-Type: application/x-amz-json-1.1`), so application code using `@aws-sdk/client-eventbridge` can run against it with zero cost and zero side effects.

| Key | Value |
|-----|-------|
| Port | 4573 |
| Protocol | AWS JSON 1.1 (`X-Amz-Target: AWSEvents.<Op>`) over HTTP |
| Target prefix | `AWSEvents` |
| Compatible client | `@aws-sdk/client-eventbridge` (v3) |
| Size | ~90 KB |
| Startup | < 100ms |
| State | In-memory, ephemeral, resettable |

## Quick Start

Start the server:

```js
import { EventbridgeServer } from "./services/eventbridge/src/server.js";

const server = new EventbridgeServer(4573);
await server.start();
// ... use it ...
await server.stop();
```

Connect with the real AWS SDK client:

```js
import {
  EventBridgeClient,
  CreateEventBusCommand,
  PutRuleCommand,
  PutTargetsCommand,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

const eb = new EventBridgeClient({
  region: "us-east-1",
  endpoint: "http://127.0.0.1:4573",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

// Create a custom event bus (the "default" bus is seeded automatically)
const { EventBusArn } = await eb.send(new CreateEventBusCommand({ Name: "orders" }));

// Create a rule with an event pattern
const { RuleArn } = await eb.send(
  new PutRuleCommand({
    Name: "order-placed",
    EventBusName: "orders",
    EventPattern: JSON.stringify({ source: ["my.app"], "detail-type": ["OrderPlaced"] }),
  }),
);

// Attach a target
await eb.send(
  new PutTargetsCommand({
    Rule: "order-placed",
    EventBusName: "orders",
    Targets: [{ Id: "1", Arn: "arn:aws:lambda:us-east-1:000000000000:function:handler" }],
  }),
);

// Publish an event (matching events are routed to rules in-memory)
const res = await eb.send(
  new PutEventsCommand({
    Entries: [
      {
        Source: "my.app",
        DetailType: "OrderPlaced",
        Detail: JSON.stringify({ orderId: 123 }),
        EventBusName: "orders",
      },
    ],
  }),
);
// res.Entries[0].EventId is the generated event id
```

## Implemented operations

All 57 operations exposed by `@aws-sdk/client-eventbridge` are implemented and tested.

### Event buses
- `CreateEventBus`
- `DeleteEventBus` (idempotent; the `default` bus cannot be deleted)
- `DescribeEventBus`
- `ListEventBuses` (prefix filter + pagination)
- `UpdateEventBus`

### Permissions (event-bus resource policy)
- `PutPermission` (statement form **and** full `Policy` document form)
- `RemovePermission` (single `StatementId` **and** `RemoveAllPermissions`)

### Rules
- `PutRule` (create/upsert; validates event pattern; supports `ScheduleExpression`)
- `DeleteRule` (refuses rules with targets unless `Force=true`)
- `DescribeRule`
- `EnableRule`
- `DisableRule`
- `ListRules` (prefix filter + pagination)
- `ListRuleNamesByTarget`

### Targets
- `PutTargets` (max 5 per request; per-entry `FailedEntries` reporting)
- `RemoveTargets`
- `ListTargetsByRule`

### Events
- `PutEvents` (max 10 entries; per-entry validation; in-memory routing to matching enabled rules)
- `PutPartnerEvents`
- `TestEventPattern` (full content-filter matching engine)

### Archives
- `CreateArchive`
- `DeleteArchive`
- `DescribeArchive`
- `ListArchives` (prefix / source / state filters)
- `UpdateArchive`

### Replays
- `StartReplay` (completes instantly in the fake)
- `CancelReplay`
- `DescribeReplay`
- `ListReplays`

### Connections
- `CreateConnection`
- `DeleteConnection`
- `DescribeConnection` (secret values redacted, like AWS)
- `ListConnections`
- `UpdateConnection`
- `DeauthorizeConnection`

### API destinations
- `CreateApiDestination`
- `DeleteApiDestination`
- `DescribeApiDestination`
- `ListApiDestinations`
- `UpdateApiDestination`

### Global endpoints
- `CreateEndpoint`
- `DeleteEndpoint`
- `DescribeEndpoint`
- `ListEndpoints`
- `UpdateEndpoint`

### Partner event sources (producer side)
- `CreatePartnerEventSource`
- `DeletePartnerEventSource`
- `DescribePartnerEventSource`
- `ListPartnerEventSources`
- `ListPartnerEventSourceAccounts`

### Event sources (consumer side)
- `DescribeEventSource`
- `ListEventSources`
- `ActivateEventSource`
- `DeactivateEventSource`

### Tagging (rules, event buses, archives)
- `TagResource`
- `UntagResource`
- `ListTagsForResource`

## Event pattern matching

`PutRule`, `TestEventPattern` and `PutEvents` routing all run the same content-based
filtering engine. Supported matchers:

| Matcher | Example |
|---------|---------|
| Exact value | `{ "source": ["my.app"] }` |
| Nested fields | `{ "detail": { "state": ["ok"] } }` |
| `prefix` | `{ "source": [{ "prefix": "my." }] }` |
| `prefix` + `equals-ignore-case` | `{ "source": [{ "prefix": { "equals-ignore-case": "MY." } }] }` |
| `suffix` | `{ "source": [{ "suffix": ".app" }] }` |
| `equals-ignore-case` | `{ "detail": { "name": [{ "equals-ignore-case": "widgetco" }] } }` |
| `wildcard` | `{ "detail": { "name": [{ "wildcard": "Widget*" }] } }` |
| `cidr` | `{ "detail": { "ip": [{ "cidr": "10.0.0.0/24" }] } }` |
| `exists` | `{ "detail": { "state": [{ "exists": true }] } }` |
| `anything-but` | `{ "source": [{ "anything-but": ["x"] }] }` |
| `numeric` | `{ "detail": { "amount": [{ "numeric": [">", 10, "<", 100] }] } }` |

## Internal / non-AWS endpoints

These are convenience endpoints for tests and tooling (not part of EventBridge):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/_parlel/health` | Returns `{ status, service, eventBuses, rules }` |
| `POST` | `/_parlel/reset` | Clears all in-memory state and re-seeds the `default` bus |

`server.reset()` does the same thing in-process. Captured state useful for assertions:
`server.putEvents` (every accepted `PutEvents` entry) and `server.routedEvents`
(events that matched an enabled rule's pattern).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
|---------|--------|-------|
| All 57 `@aws-sdk/client-eventbridge` operations | ✅ Supported | Full happy-path + key edge cases |
| Event-bus management + resource policies | ✅ Supported | Statement and full-policy forms |
| Rules (pattern + schedule) | ✅ Supported | Pattern validated on write |
| Targets | ✅ Supported | 5-per-request limit, failed-entry reporting |
| `PutEvents` + in-memory rule routing | ✅ Supported | Matching events captured on `server.routedEvents` |
| `TestEventPattern` content filtering | ✅ Supported | prefix/suffix/numeric/exists/cidr/anything-but/wildcard/equals-ignore-case |
| Archives, replays, connections, API destinations, endpoints | ✅ Supported | Lifecycle + describe/list |
| Partner event sources + event sources | ✅ Supported | Producer + consumer side |
| Tagging | ✅ Supported | Rules, event buses, archives |
| Pagination (`NextToken`) | ✅ Supported | Base64 offset tokens |
| Actual target delivery (Lambda/SQS/SNS invocation) | ⚠️ Simulated | Targets are stored; matching events are recorded, not delivered to live targets |
| Schedule expression firing (`rate`/`cron`) | ⟳ Roadmap |
| Replay event re-delivery | ⚠️ Simulated | Replays complete instantly without re-emitting events |
| IAM / SigV4 auth enforcement | ✓ By design — Not enforced |
| KMS encryption | ⚠️ Stored only | `KmsKeyIdentifier` persisted, no real crypto |
| Connection OAuth token exchange | ⚠️ Simulated | Connections move to `AUTHORIZED` without calling an auth endpoint |

## Error codes & shapes

Errors are returned as non-2xx responses with `Content-Type: application/x-amz-json-1.1`,
an `x-amzn-errortype` header, and a JSON body of the form:

```json
{ "__type": "ResourceNotFoundException", "message": "Rule foo does not exist on EventBus default." }
```

| Code | HTTP | When |
|------|------|------|
| `ValidationException` | 400 | Invalid/missing parameters, bad names, too many entries/targets |
| `InvalidEventPatternException` | 400 | Event pattern is not valid JSON / not an object |
| `ResourceNotFoundException` | 400 | Bus / rule / archive / replay / connection / destination / endpoint / source missing |
| `ResourceAlreadyExistsException` | 400 | Creating a resource whose name already exists |
| `LimitExceededException` | 400 | More than 5 targets in one `PutTargets` |
| `ManagedRuleException` | 400 | Deleting an AWS-managed rule without `Force` |
| `IllegalStatusException` | 400 | Cancelling a replay that already completed |
| `ConcurrentModificationException` | 400 | Modeled (reserved) |
| `InternalException` | 500 | Unexpected server-side failure |
| `AccessDeniedException` | 403 | Non-POST HTTP method |
| `ThrottlingException` | 429 | Modeled (reserved) |

Per-entry operations (`PutEvents`, `PutPartnerEvents`, `PutTargets`, `RemoveTargets`)
return `200` with a `FailedEntryCount` and a list of failed entries carrying
`ErrorCode` / `ErrorMessage` rather than failing the whole request.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL_EVENTBRIDGE=http://localhost:4573
AWS_ENDPOINT_URL=http://localhost:4573
```

<!-- parlel:testenv:end -->
