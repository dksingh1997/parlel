# NocoDB

Lightweight, dependency-free in-memory NocoDB REST fake for testing axios-based application code with zero external side effects.

Default port: `4612`

## Quick Start

```js
import axios from "axios";
import { NocodbServer } from "./services/nocodb/src/server.js";

const server = new NocodbServer(4612);
await server.start();

const client = axios.create({ baseURL: "http://127.0.0.1:4612" });
const base = await client.post("/api/v2/meta/bases", { title: "CRM" });
const table = await client.post(`/api/v2/meta/bases/${base.data.id}/tables`, {
  title: "Contacts",
  columns: [{ title: "Name", uidt: "SingleLineText" }],
});
const record = await client.post(`/api/v2/tables/${table.data.id}/records`, { Name: "Ada" });

await server.stop();
```

## Implemented Operations

### Server

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/` | Service metadata. |
| `GET` | `/health` | Health check, returns `{ "status": "ok" }`. |
| `HEAD` | `/health` | Header-only health check for axios `head`. |
| `OPTIONS` | `/*` | CORS preflight for axios browser-style calls. |
| `POST` | `/__reset` | Clears all in-memory bases, tables, columns, views, and records. |

### Auth

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/api/v1/auth/user/signin` | Returns a fake token and user object. |
| `POST` | `/api/v1/auth/user/signup` | Returns a fake token and user object. |
| `GET` | `/api/v1/auth/user/me` | Returns the fake current user. |
| `POST` | `/api/v1/auth/password/forgot` | Returns a password reset acknowledgement. |

### Meta: Bases and Projects

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v2/meta/bases` | List bases. |
| `POST` | `/api/v2/meta/bases` | Create a base. |
| `GET` | `/api/v2/meta/bases/:baseId` | Read a base. |
| `PATCH` | `/api/v2/meta/bases/:baseId` | Update a base title. |
| `PUT` | `/api/v2/meta/bases/:baseId` | Update a base title. |
| `DELETE` | `/api/v2/meta/bases/:baseId` | Delete a base and its tables. |
| `GET` | `/api/v1/db/meta/projects` | v1 alias for listing bases. |
| `POST` | `/api/v1/db/meta/projects` | v1 alias for creating bases. |
| `GET` | `/api/v1/db/meta/projects/:baseId` | v1 alias for reading a base. |
| `PATCH` | `/api/v1/db/meta/projects/:baseId` | v1 alias for updating a base. |
| `PUT` | `/api/v1/db/meta/projects/:baseId` | v1 alias for updating a base. |
| `DELETE` | `/api/v1/db/meta/projects/:baseId` | v1 alias for deleting a base. |

### Meta: Tables

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v2/meta/bases/:baseId/tables` | List tables in a base. |
| `POST` | `/api/v2/meta/bases/:baseId/tables` | Create a table. System fields and a grid view are added automatically. |
| `GET` | `/api/v2/meta/tables/:tableId` | Read a table, including columns and views. |
| `PATCH` | `/api/v2/meta/tables/:tableId` | Update a table title. |
| `PUT` | `/api/v2/meta/tables/:tableId` | Update a table title. |
| `DELETE` | `/api/v2/meta/tables/:tableId` | Delete a table and its columns, views, and records. |
| `GET` | `/api/v1/db/meta/projects/:baseId/tables` | v1 alias for listing tables. |
| `POST` | `/api/v1/db/meta/projects/:baseId/tables` | v1 alias for creating tables. |
| `GET` | `/api/v1/db/meta/tables/:tableId` | v1 alias for reading a table. |
| `PATCH` | `/api/v1/db/meta/tables/:tableId` | v1 alias for updating a table. |
| `PUT` | `/api/v1/db/meta/tables/:tableId` | v1 alias for updating a table. |
| `DELETE` | `/api/v1/db/meta/tables/:tableId` | v1 alias for deleting a table. |

### Meta: Columns

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v2/meta/tables/:tableId/columns` | List columns in a table. |
| `POST` | `/api/v2/meta/tables/:tableId/columns` | Create a column. |
| `GET` | `/api/v2/meta/columns/:columnId` | Read a column. |
| `PATCH` | `/api/v2/meta/columns/:columnId` | Update a column title or `uidt`. |
| `PUT` | `/api/v2/meta/columns/:columnId` | Update a column title or `uidt`. |
| `DELETE` | `/api/v2/meta/columns/:columnId` | Delete a column. |
| `GET` | `/api/v1/db/meta/tables/:tableId/columns` | v1 alias for listing columns. |
| `POST` | `/api/v1/db/meta/tables/:tableId/columns` | v1 alias for creating columns. |
| `GET` | `/api/v1/db/meta/columns/:columnId` | v1 alias for reading a column. |
| `PATCH` | `/api/v1/db/meta/columns/:columnId` | v1 alias for updating a column. |
| `PUT` | `/api/v1/db/meta/columns/:columnId` | v1 alias for updating a column. |
| `DELETE` | `/api/v1/db/meta/columns/:columnId` | v1 alias for deleting a column. |

### Meta: Views

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v2/meta/tables/:tableId/views` | List views in a table. |
| `POST` | `/api/v2/meta/tables/:tableId/views` | Create a view. |
| `GET` | `/api/v2/meta/views/:viewId` | Read a view. |
| `PATCH` | `/api/v2/meta/views/:viewId` | Update a view title. |
| `PUT` | `/api/v2/meta/views/:viewId` | Update a view title. |
| `DELETE` | `/api/v2/meta/views/:viewId` | Delete a view. |
| `GET` | `/api/v1/db/meta/tables/:tableId/views` | v1 alias for listing views. |
| `POST` | `/api/v1/db/meta/tables/:tableId/views` | v1 alias for creating views. |
| `GET` | `/api/v1/db/meta/views/:viewId` | v1 alias for reading a view. |
| `PATCH` | `/api/v1/db/meta/views/:viewId` | v1 alias for updating a view. |
| `PUT` | `/api/v1/db/meta/views/:viewId` | v1 alias for updating a view. |
| `DELETE` | `/api/v1/db/meta/views/:viewId` | v1 alias for deleting a view. |

### Records

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/v2/tables/:tableId/records` | List records. Supports `where`, `sort`, `limit`, `page`, `pageSize`, `offset`, and `fields`. |
| `POST` | `/api/v2/tables/:tableId/records` | Create one record or an array of records. |
| `PATCH` | `/api/v2/tables/:tableId/records` | Bulk update records by `Id` or `id`. |
| `PUT` | `/api/v2/tables/:tableId/records` | Bulk update records by `Id` or `id`. |
| `DELETE` | `/api/v2/tables/:tableId/records` | Bulk delete records with `{ "ids": [...] }`, `{ "records": [...] }`, or an array. |
| `GET` | `/api/v2/tables/:tableId/records/count` | Count records after optional `where` filtering. |
| `GET` | `/api/v2/tables/:tableId/records/:recordId` | Read one record. |
| `PATCH` | `/api/v2/tables/:tableId/records/:recordId` | Update one record. |
| `PUT` | `/api/v2/tables/:tableId/records/:recordId` | Update one record. |
| `DELETE` | `/api/v2/tables/:tableId/records/:recordId` | Delete one record. |
| `GET` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName` | v1 alias for listing records. |
| `POST` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName` | v1 alias for creating records. |
| `PATCH` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName` | v1 alias for bulk updating records. |
| `PUT` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName` | v1 alias for bulk updating records. |
| `DELETE` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName` | v1 alias for bulk deleting records. |
| `GET` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName/count` | v1 alias for counting records. |
| `GET` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName/:recordId` | v1 alias for reading one record. |
| `PATCH` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName/:recordId` | v1 alias for updating one record. |
| `PUT` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName/:recordId` | v1 alias for updating one record. |
| `DELETE` | `/api/v1/db/data/:baseTitleOrId/:tableTitleOrName/:recordId` | v1 alias for deleting one record. |

## Supported Features

| Feature | Status | Notes |
| --- | --- | --- |
| In-memory bases, tables, columns, views, records | Supported | State is ephemeral and reset with `POST /__reset` or `server.reset()`. |
| axios HTTP methods | Supported | `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, and generic `request` map to supported HTTP verbs. |
| v2 meta API | Supported | Bases, tables, columns, and views. |
| v1 project/data aliases | Supported | Common older NocoDB paths are accepted. |
| Record pagination | Supported | `limit`, `page`, `pageSize`, and `offset`. |
| Record projection | Supported | `fields=Name,Age`. |
| Record sorting | Supported | `sort=Name` and `sort=-Name`. |
| Record filtering | Supported | Simple NocoDB-style `where=(Field,eq,value)` with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, and `like`. |
| Persistence | Intentionally unsupported | Data is not written to disk. |
| SQL/database adapters | Intentionally unsupported | This fake only implements the HTTP REST wire protocol. |
| Webhooks, automations, plugins, ACLs | Intentionally unsupported | Calls return `404` unless listed above. |
| Real password validation | Intentionally unsupported | Auth endpoints return deterministic fake users/tokens. |

## Error Shapes

Errors use the NocoDB-style JSON body:

```json
{
  "msg": "Table not found",
  "error": "Not Found",
  "statusCode": 404
}
```

Returned statuses include:

| Status | Shape | When |
| --- | --- | --- |
| `401` | `{ "msg": "Unauthorized", "error": "Unauthorized", "statusCode": 401 }` | Protected routes when `requireAuth: true` and no valid token is supplied. |
| `404` | `{ "msg": "Not found", "error": "Not Found", "statusCode": 404 }` | Unknown routes. |
| `404` | `{ "msg": "Base not found", "error": "Not Found", "statusCode": 404 }` | Missing base. |
| `404` | `{ "msg": "Table not found", "error": "Not Found", "statusCode": 404 }` | Missing table. |
| `404` | `{ "msg": "Column not found", "error": "Not Found", "statusCode": 404 }` | Missing column. |
| `404` | `{ "msg": "View not found", "error": "Not Found", "statusCode": 404 }` | Missing view. |
| `404` | `{ "msg": "Record not found", "error": "Not Found", "statusCode": 404 }` | Missing record. |
| `405` | `{ "msg": "Method not allowed", "error": "Method Not Allowed", "statusCode": 405 }` | Known endpoint with unsupported HTTP method. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
NC_AUTH_JWT_SECRET=parlel
NOCODB_API_TOKEN=parlel
NOCODB_BASE_URL=http://localhost:4612
NOCODB_BASE_ID=base_parlel
```

<!-- parlel:testenv:end -->
