# OneDrive

Lightweight, dependency-free Microsoft Graph OneDrive emulator for parlel-pool.

Default port: `4622`

## Quick Start

Start the server in-process:

```js
import { OnedriveServer } from "./services/onedrive/src/server.js";

const server = new OnedriveServer(4622);
await server.start();
```

Connect with the real `@microsoft/microsoft-graph-client` client by pointing its Graph base URL at the emulator:

```js
import { Client } from "@microsoft/microsoft-graph-client";

const client = Client.init({
  baseUrl: "http://127.0.0.1:4622/v1.0",
  authProvider: (done) => done(null, "parlel-token"),
});

const root = await client.api("/me/drive/root").get();
await client.api("/me/drive/root:/hello.txt:/content").put("hello");
```

Health and reset endpoints:

```sh
curl http://127.0.0.1:4622/_parlel/health
curl -X POST http://127.0.0.1:4622/_parlel/reset
```

## Implemented Operations

Discovery and users:

- `GET /`, `GET /v1.0`, `GET /beta`
- `GET /me`
- `GET /users/{user-id}`
- `GET /me/drive`, `GET /users/{user-id}/drive`
- `GET /me/drives`, `GET /drives`, `GET /drives/{drive-id}`

Drive item CRUD and addressing:

- `GET /me/drive/root`
- `GET /me/drive/items/{item-id}`
- `PATCH /me/drive/items/{item-id}`
- `DELETE /me/drive/items/{item-id}`
- `GET /me/drive/special/{name}`
- `GET /me/drive/root:/{path}:`
- `GET /me/drive/items/{item-id}:/{path}:`

Children and OData collection options:

- `GET /me/drive/root/children`
- `POST /me/drive/root/children`
- `GET /me/drive/items/{item-id}/children`
- `POST /me/drive/items/{item-id}/children`
- `GET /me/drive/items/{item-id}/children/{child-id-or-name}`
- Supports `$top`, `$skip`, `$count`, `$orderby`, `$select`, `$filter`, `$search`, `$expand=children`, and `$expand=permissions` where applicable.

Content and uploads:

- `GET /me/drive/items/{item-id}/content`
- `PUT /me/drive/items/{item-id}/content`
- `GET /me/drive/root:/{path}:/content`
- `PUT /me/drive/root:/{path}:/content`
- `POST /me/drive/items/{item-id}/createUploadSession`
- `PUT {uploadUrl}` with `Content-Range`
- `DELETE {uploadUrl}`

Actions and collections:

- `POST /me/drive/items/{item-id}/copy`
- `GET /me/drive/operations/{operation-id}`
- `GET /me/drive/items/{item-id}/search(q='term')`
- `GET /me/drive/items/{item-id}/delta`
- `GET /me/drive/recent`
- `GET /me/drive/sharedWithMe`
- `GET /me/drive/following`
- `POST /me/drive/items/{item-id}/follow`
- `POST /me/drive/items/{item-id}/unfollow`
- `POST /me/drive/items/{item-id}/preview`
- `POST /me/drive/items/{item-id}/restore`

Permissions and sharing:

- `GET /me/drive/items/{item-id}/permissions`
- `POST /me/drive/items/{item-id}/permissions`
- `GET /me/drive/items/{item-id}/permissions/{permission-id}`
- `PATCH /me/drive/items/{item-id}/permissions/{permission-id}`
- `DELETE /me/drive/items/{item-id}/permissions/{permission-id}`
- `POST /me/drive/items/{item-id}/invite`
- `POST /me/drive/items/{item-id}/createLink`
- `GET /shares/{share-id}`
- `GET /shares/{share-id}/driveItem`

Thumbnails:

- `GET /me/drive/items/{item-id}/thumbnails`
- `GET /me/drive/items/{item-id}/thumbnails/{set-id}`
- `GET /me/drive/items/{item-id}/thumbnails/{set-id}/{size}`
- `GET /me/drive/items/{item-id}/thumbnails/{set-id}/{size}/content`

Subscriptions and batch:

- `GET /subscriptions`
- `POST /subscriptions`
- `GET /subscriptions/{subscription-id}`
- `PATCH /subscriptions/{subscription-id}`
- `DELETE /subscriptions/{subscription-id}`
- `POST /$batch`

Parlel control endpoints:

- `GET /_parlel/health`
- `POST /_parlel/reset`

The same routes are accepted under `/beta` and under `/drives/{drive-id}` where Graph exposes drive-scoped item routes.

## Support Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| Microsoft Graph REST shape | Supported | JSON resources, OData collections, Graph error envelopes. |
| `@microsoft/microsoft-graph-client` request builders | Supported | Use `Client.init({ baseUrl: "http://127.0.0.1:4622/v1.0" })`. |
| In-memory drive/items/permissions/subscriptions | Supported | Ephemeral; reset with `POST /_parlel/reset`. |
| Small file upload/download | Supported | `PUT`/`GET .../content`. |
| Path-addressed upload/download | Supported | `root:/path:/content`. |
| Resumable upload sessions | Supported | Local upload URL, `Content-Range`, partial `202`, final item response. |
| Async copy operation | Supported | Completes immediately and can be polled. |
| OData query options | Supported | Minimal `$top`, `$skip`, `$count`, `$orderby`, `$select`, `$filter`, `$search`. |
| Thumbnails | Supported | Deterministic fake metadata/content. |
| Webhook subscriptions | Supported | Stored only; no outbound webhook delivery. |
| Authentication/authorization | Intentionally unsupported | Tokens are ignored for zero-cost local testing. |
| Real Microsoft storage, sharing emails, virus scanning, Office conversion | Intentionally unsupported | No external side effects. |
| Multi-tenant persistence | Intentionally unsupported | Single local user and drive only. |

## Error Shapes

Errors use Microsoft Graph-style envelopes:

```json
{
  "error": {
    "code": "itemNotFound",
    "message": "Item not found",
    "innerError": {
      "date": "2026-06-11T00:00:00.000Z",
      "request-id": "req_...",
      "client-request-id": "..."
    }
  }
}
```

Common returned errors:

| Status | Code | When |
| --- | --- | --- |
| `400` | `invalidRequest` | Invalid JSON, missing `name`, folder content download, root rename/delete, missing `Content-Range`. |
| `404` | `itemNotFound` | Missing drive item, permission, share, operation, upload session, or special folder. |
| `404` | `Request_ResourceNotFound` | Unknown route or user. |
| `405` | `Request_BadRequest` | Unsupported method for an existing route. |
| `409` | `nameAlreadyExists` | Child create conflict without `@microsoft.graph.conflictBehavior`. |
| `500` | `InternalServerError` | Unexpected emulator failures. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ONEDRIVE_EMULATOR_HOST=http://localhost:4622
MICROSOFT_GRAPH_BASE_URL=http://localhost:4622/v1.0
AZURE_TENANT_ID=parlel
AZURE_CLIENT_ID=parlel
AZURE_CLIENT_SECRET=parlel
```

<!-- parlel:testenv:end -->
