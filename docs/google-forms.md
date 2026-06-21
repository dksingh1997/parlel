# Google Forms

Lightweight, dependency-free in-process fake of the Google Forms API v1 for zero-cost local agent tests.

## Default Port

`4625`

## Implemented Operations

### Forms

| googleapis method | HTTP endpoint |
| --- | --- |
| `forms.forms.create` | `POST /v1/forms` |
| `forms.forms.get` | `GET /v1/forms/{formId}` |
| `forms.forms.batchUpdate` | `POST /v1/forms/{formId}:batchUpdate` |
| `forms.forms.setPublishSettings` | `POST /v1/forms/{formId}:setPublishSettings` |

### Responses

| googleapis method | HTTP endpoint |
| --- | --- |
| `forms.forms.responses.get` | `GET /v1/forms/{formId}/responses/{responseId}` |
| `forms.forms.responses.list` | `GET /v1/forms/{formId}/responses` |

### Watches

| googleapis method | HTTP endpoint |
| --- | --- |
| `forms.forms.watches.create` | `POST /v1/forms/{formId}/watches` |
| `forms.forms.watches.list` | `GET /v1/forms/{formId}/watches` |
| `forms.forms.watches.renew` | `POST /v1/forms/{formId}/watches/{watchId}:renew` |
| `forms.forms.watches.delete` | `DELETE /v1/forms/{formId}/watches/{watchId}` |

### Parlel Helpers

| helper | HTTP endpoint |
| --- | --- |
| Health | `GET /_parlel/health` |
| Reset ephemeral state | `POST /_parlel/reset` |
| Seed a response for read-only Forms response APIs | `POST /_parlel/forms/{formId}/responses` |

The server also accepts `/forms/v1/...` as an alias for `/v1/...`, matching the product-prefixed root URL style used by the other Google service fakes.

## Quick Start

```js
import { google } from "googleapis";
import { GoogleFormsServer } from "./services/google-forms/src/server.js";

const server = new GoogleFormsServer(4625);
await server.start();

const forms = google.forms({
  version: "v1",
  rootUrl: "http://127.0.0.1:4625/",
  auth: "not-used-by-parlel",
});

const created = await forms.forms.create({
  requestBody: { info: { title: "Local survey" } },
});

await forms.forms.batchUpdate({
  formId: created.data.formId,
  requestBody: {
    requests: [
      {
        createItem: {
          location: { index: 0 },
          item: {
            title: "Name",
            questionItem: { question: { textQuestion: {} } },
          },
        },
      },
    ],
  },
});

await server.stop();
```

## Supported Features

| Feature | Status | Notes |
| --- | --- | --- |
| In-memory forms | Supported | `formId`, `revisionId`, `responderUri`, `info`, `settings`, `items`, and `publishSettings` are returned in Forms-shaped JSON. |
| `forms.create` | Supported | Accepts `info.title`, optional `info.documentTitle`, and `unpublished=true`; rejects disallowed create-time fields such as `items` and `settings`. |
| `forms.get` | Supported | Returns the current in-memory form. |
| `forms.batchUpdate` | Supported | Supports all request variants exposed by Google Forms v1 discovery: `updateFormInfo`, `updateSettings`, `createItem`, `moveItem`, `deleteItem`, and `updateItem`. Applies batches atomically. |
| `forms.setPublishSettings` | Supported | Updates `publishSettings.publishState`; rejects accepting responses while unpublished. |
| Response reads | Supported | `responses.get` and `responses.list` read seeded in-memory responses. List supports `pageSize`, `pageToken`, and timestamp filters `timestamp > RFC3339` and `timestamp >= RFC3339`. |
| Response writes via Google API | Intentionally unsupported | The public Google Forms API does not expose a response create endpoint. Use the parlel-only seeding helper or `server.addResponse()` in tests. |
| Watch lifecycle | Supported | Create/list/renew/delete are implemented in memory with event-type uniqueness per form and seven-day expiration timestamps. |
| Pub/Sub delivery | Intentionally unsupported | Watches store target metadata but do not publish messages. Pair with the parlel Pub/Sub fake at the application layer if needed. |
| OAuth, Drive permissions, linked Sheets, real Forms UI | Intentionally unsupported | Auth headers are ignored; access control and side effects outside this process are not modeled. |
| Persistence | Intentionally unsupported | State is ephemeral and reset by `POST /_parlel/reset` or `server.reset()`. |

## Error Shape

Errors use the Google JSON envelope used across parlel Google fakes:

```json
{
  "error": {
    "code": 404,
    "message": "Form not found",
    "status": "NOT_FOUND",
    "errors": [
      {
        "message": "Form not found",
        "domain": "global",
        "reason": "notFound"
      }
    ]
  }
}
```

Common statuses returned:

| HTTP status | Google status | Typical reason |
| --- | --- | --- |
| `400` | `INVALID_ARGUMENT` | Invalid JSON, invalid field mask, missing required field, stale `requiredRevisionId`, invalid response filter, invalid watch ID. |
| `404` | `NOT_FOUND` | Missing form, response, watch, or unsupported route. |
| `405` | `METHOD_NOT_ALLOWED` | Valid route with unsupported HTTP method. |
| `409` | `ALREADY_EXISTS` | Duplicate watch ID or duplicate watch event type on the same form. |
| `500` | `INTERNAL` | Unexpected emulator error. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_FORMS_EMULATOR_HOST=http://localhost:4625
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
