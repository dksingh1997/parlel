# eventbridge-scheduler (parlel)

A zero-dependency, in-process fake of Amazon EventBridge Scheduler. Speaks the
REST/JSON API.

| Field | Value |
| --- | --- |
| Service | `eventbridge-scheduler` |
| Port | `4740` |
| Protocol | REST / JSON |
| Health | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |

## Default connection

```
AWS_ENDPOINT_URL=http://127.0.0.1:4740
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
```

## Supported operations

| Operation | HTTP |
| --- | --- |
| CreateSchedule | `POST /schedules/{name}` |
| GetSchedule | `GET /schedules/{name}` |
| UpdateSchedule | `PUT /schedules/{name}` |
| DeleteSchedule | `DELETE /schedules/{name}` |
| ListSchedules | `GET /schedules` |
| CreateScheduleGroup | `POST /schedule-groups/{name}` |
| GetScheduleGroup | `GET /schedule-groups/{name}` |
| ListScheduleGroups | `GET /schedule-groups` |
| DeleteScheduleGroup | `DELETE /schedule-groups/{name}` |

A `default` schedule group always exists and cannot be deleted. Use the
`groupName` query parameter to place a schedule in a non-default group.

## SDK example

```js
import { SchedulerClient, CreateScheduleCommand } from "@aws-sdk/client-scheduler";

const sc = new SchedulerClient({
  endpoint: "http://127.0.0.1:4740",
  region: "us-east-1",
  credentials: { accessKeyId: "parlel", secretAccessKey: "parlel" },
});

await sc.send(new CreateScheduleCommand({
  Name: "nightly",
  ScheduleExpression: "rate(1 day)",
  FlexibleTimeWindow: { Mode: "OFF" },
  Target: {
    Arn: "arn:aws:lambda:us-east-1:000000000000:function:fn",
    RoleArn: "arn:aws:iam::000000000000:role/r",
  },
}));
```

## Access via MCP / preview URL

Under the parlel pool, reach this service through the MCP gateway and the pool's
preview URL.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Area | Limitation |
| --- | --- |
| Triggering | Schedules are stored, never fired (no real cron/rate engine). |
| Targets | Target ARN validated for presence only; never invoked. |
| Time windows | `FlexibleTimeWindow` stored but not applied. |
| Pagination | `Schedules`/`ScheduleGroups` returned in full. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
AWS_ACCESS_KEY_ID=parlel
AWS_SECRET_ACCESS_KEY=parlel
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:4740
```

<!-- parlel:testenv:end -->
