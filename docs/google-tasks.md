# Google Tasks

Lightweight, dependency-free in-process fake of the Google Tasks API v1 for testing `googleapis` clients with zero external calls.

Default port: `4626`

## Implemented Operations

Task lists:

- `GET /tasks/v1/users/@me/lists` - list task lists, with `maxResults` and `pageToken`
- `POST /tasks/v1/users/@me/lists` - insert a task list
- `GET /tasks/v1/users/@me/lists/{tasklist}` - get a task list
- `PATCH /tasks/v1/users/@me/lists/{tasklist}` - patch a task list
- `PUT /tasks/v1/users/@me/lists/{tasklist}` - update a task list
- `DELETE /tasks/v1/users/@me/lists/{tasklist}` - delete a task list

Tasks:

- `GET /tasks/v1/lists/{tasklist}/tasks` - list tasks, with `completedMin`, `completedMax`, `dueMin`, `dueMax`, `maxResults`, `pageToken`, `showCompleted`, `showDeleted`, `showHidden`, and `updatedMin`
- `POST /tasks/v1/lists/{tasklist}/tasks` - insert a task, with optional `parent` and `previous`
- `GET /tasks/v1/lists/{tasklist}/tasks/{task}` - get a task
- `PATCH /tasks/v1/lists/{tasklist}/tasks/{task}` - patch a task
- `PUT /tasks/v1/lists/{tasklist}/tasks/{task}` - update a task
- `DELETE /tasks/v1/lists/{tasklist}/tasks/{task}` - delete a task
- `POST /tasks/v1/lists/{tasklist}/tasks/{task}/move` - move a task, with optional `parent` and `previous`
- `POST /tasks/v1/lists/{tasklist}/tasks/clear` - hide completed tasks in a list

Parlel control endpoints:

- `GET /_parlel/health` - health and in-memory object counts
- `POST /_parlel/reset` - reset all ephemeral state
- `GET /tasks/v1` and `GET /v1` - lightweight discovery marker

The server also accepts `/v1/...` as an alias for `/tasks/v1/...` for simple `googleapis` `rootUrl` overrides.

## Quick Start

```js
import { google } from "googleapis";
import { GoogleTasksServer } from "./services/google-tasks/src/server.js";

const server = new GoogleTasksServer(4626);
await server.start();

const tasks = google.tasks({
  version: "v1",
  rootUrl: "http://127.0.0.1:4626/",
});

const list = await tasks.tasklists.insert({
  requestBody: { title: "Agent test list" },
});

await tasks.tasks.insert({
  tasklist: list.data.id,
  requestBody: { title: "Verify integration" },
});

const allTasks = await tasks.tasks.list({ tasklist: list.data.id });
console.log(allTasks.data.items);

await server.stop();
```

## Support Matrix

| Feature | Status | Notes |
| --- | --- | --- |
| Task list CRUD | Supported | In-memory `tasks#taskList` resources. |
| Task CRUD | Supported | In-memory `tasks#task` resources. |
| Task hierarchy | Supported | `parent` and `previous` are honored for insert and move. |
| Pagination | Supported | `maxResults` and numeric `pageToken`. |
| Task filters | Supported | Completion, due date, updated, deleted, hidden, and completed visibility filters. |
| Completed clear | Supported | Completed tasks are marked `hidden: true` and omitted unless `showHidden=true`. |
| OAuth and IAM | Intentionally unsupported | Requests are accepted without auth for local tests. |
| Persistence | Intentionally unsupported | State is ephemeral and resettable. |
| Push notifications | Intentionally unsupported | Google Tasks v1 does not expose watch methods through `googleapis`. |
| Sync tokens | Intentionally unsupported | Google Tasks v1 `googleapis` surface does not require them for common CRUD tests. |

## Error Shape

Errors use Google-style JSON bodies:

```json
{
  "error": {
    "code": 404,
    "message": "Task not found",
    "errors": [
      {
        "message": "Task not found",
        "domain": "global",
        "reason": "notFound"
      }
    ],
    "status": "NOT_FOUND"
  }
}
```

Returned statuses and reasons:

- `400 INVALID_ARGUMENT` with `parseError` for invalid JSON
- `400 INVALID_ARGUMENT` with `invalidArgument` for invalid dates, page tokens, or task move placement
- `404 NOT_FOUND` with `notFound` for missing task lists, tasks, or routes
- `405 METHOD_NOT_ALLOWED` with `methodNotAllowed` for known routes with unsupported methods
- `409 ALREADY_EXISTS` with `alreadyExists` for duplicate explicit task list or task IDs
- `500 INTERNAL` with `backendError` for unexpected server failures

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_TASKS_EMULATOR_HOST=http://localhost:4626
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
