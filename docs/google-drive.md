# Google Drive

A lightweight, dependency-free, in-memory fake of Google Drive API v3 for testing `googleapis` clients with zero external side effects.

Default port: `4614`

## Quick Start

```js
import { google } from "googleapis";
import { GoogleDriveServer } from "./services/google-drive/src/server.js";

const server = new GoogleDriveServer(4614);
await server.start();

const drive = google.drive({ version: "v3", auth: "test" });
drive.context._options.rootUrl = "http://127.0.0.1:4614/";

const created = await drive.files.create({
  requestBody: { name: "notes.txt", mimeType: "text/plain" },
  media: { mimeType: "text/plain", body: "hello" },
});

await server.stop();
```

Reset state with `server.reset()` or `POST /_parlel/reset`.

## Implemented Operations

### Server

| Operation | Endpoint |
| --- | --- |
| Discovery marker | `GET /`, `GET /drive/v3`, `GET /v3` |
| Healthcheck | `GET /_parlel/health` |
| Reset ephemeral state | `POST /_parlel/reset` |

### About and Apps

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.about.get` | `GET /drive/v3/about` |
| `drive.apps.list` | `GET /drive/v3/apps` |
| `drive.apps.get` | `GET /drive/v3/apps/{appId}` |

### Files

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.files.create` | `POST /drive/v3/files`, `POST /upload/drive/v3/files?uploadType=media|multipart` |
| `drive.files.get` | `GET /drive/v3/files/{fileId}` |
| `drive.files.get` media | `GET /drive/v3/files/{fileId}?alt=media` |
| `drive.files.list` | `GET /drive/v3/files` |
| `drive.files.update` | `PATCH /drive/v3/files/{fileId}`, `PATCH /upload/drive/v3/files/{fileId}?uploadType=media|multipart` |
| `drive.files.delete` | `DELETE /drive/v3/files/{fileId}` |
| `drive.files.copy` | `POST /drive/v3/files/{fileId}/copy` |
| `drive.files.export` | `GET /drive/v3/files/{fileId}/export` |
| `drive.files.download` | `POST /drive/v3/files/{fileId}/download` |
| `drive.files.emptyTrash` | `DELETE /drive/v3/files/trash` |
| `drive.files.generateCseToken` | `GET /drive/v3/files/generateCseToken` |
| `drive.files.generateIds` | `GET /drive/v3/files/generateIds` |
| `drive.files.watch` | `POST /drive/v3/files/{fileId}/watch` |
| `drive.files.listLabels` | `GET /drive/v3/files/{fileId}/listLabels` |
| `drive.files.modifyLabels` | `POST /drive/v3/files/{fileId}/modifyLabels` |

Supported file query clauses: `trashed = true|false`, `starred = true|false`, `mimeType = '...'`, `name = '...'`, `name contains '...'`, `'parentId' in parents`, and `fullText contains '...'`.

### Permissions

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.permissions.create` | `POST /drive/v3/files/{fileId}/permissions` |
| `drive.permissions.list` | `GET /drive/v3/files/{fileId}/permissions` |
| `drive.permissions.get` | `GET /drive/v3/files/{fileId}/permissions/{permissionId}` |
| `drive.permissions.update` | `PATCH /drive/v3/files/{fileId}/permissions/{permissionId}` |
| `drive.permissions.delete` | `DELETE /drive/v3/files/{fileId}/permissions/{permissionId}` |

### Revisions

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.revisions.list` | `GET /drive/v3/files/{fileId}/revisions` |
| `drive.revisions.get` | `GET /drive/v3/files/{fileId}/revisions/{revisionId}` |
| `drive.revisions.update` | `PATCH /drive/v3/files/{fileId}/revisions/{revisionId}` |
| `drive.revisions.delete` | `DELETE /drive/v3/files/{fileId}/revisions/{revisionId}` |

### Comments and Replies

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.comments.create` | `POST /drive/v3/files/{fileId}/comments` |
| `drive.comments.list` | `GET /drive/v3/files/{fileId}/comments` |
| `drive.comments.get` | `GET /drive/v3/files/{fileId}/comments/{commentId}` |
| `drive.comments.update` | `PATCH /drive/v3/files/{fileId}/comments/{commentId}` |
| `drive.comments.delete` | `DELETE /drive/v3/files/{fileId}/comments/{commentId}` |
| `drive.replies.create` | `POST /drive/v3/files/{fileId}/comments/{commentId}/replies` |
| `drive.replies.list` | `GET /drive/v3/files/{fileId}/comments/{commentId}/replies` |
| `drive.replies.get` | `GET /drive/v3/files/{fileId}/comments/{commentId}/replies/{replyId}` |
| `drive.replies.update` | `PATCH /drive/v3/files/{fileId}/comments/{commentId}/replies/{replyId}` |
| `drive.replies.delete` | `DELETE /drive/v3/files/{fileId}/comments/{commentId}/replies/{replyId}` |

### Shared Drives

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.drives.create` | `POST /drive/v3/drives?requestId=...` |
| `drive.drives.list` | `GET /drive/v3/drives` |
| `drive.drives.get` | `GET /drive/v3/drives/{driveId}` |
| `drive.drives.update` | `PATCH /drive/v3/drives/{driveId}` |
| `drive.drives.delete` | `DELETE /drive/v3/drives/{driveId}` |
| `drive.drives.hide` | `POST /drive/v3/drives/{driveId}/hide` |
| `drive.drives.unhide` | `POST /drive/v3/drives/{driveId}/unhide` |

### Legacy Team Drives

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.teamdrives.create` | `POST /drive/v3/teamdrives?requestId=...` |
| `drive.teamdrives.list` | `GET /drive/v3/teamdrives` |
| `drive.teamdrives.get` | `GET /drive/v3/teamdrives/{teamDriveId}` |
| `drive.teamdrives.update` | `PATCH /drive/v3/teamdrives/{teamDriveId}` |
| `drive.teamdrives.delete` | `DELETE /drive/v3/teamdrives/{teamDriveId}` |

### Changes and Channels

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.changes.getStartPageToken` | `GET /drive/v3/changes/startPageToken` |
| `drive.changes.list` | `GET /drive/v3/changes?pageToken=...` |
| `drive.changes.watch` | `POST /drive/v3/changes/watch` |
| `drive.channels.stop` | `POST /drive/v3/channels/stop` |

### Operations

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.operations.get` | `GET /drive/v3/operations/{name}` |

`files.download` returns a completed operation object that can be fetched with `operations.get`.

### Approvals

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.approvals.start` | `POST /drive/v3/files/{fileId}/approvals:start` |
| `drive.approvals.list` | `GET /drive/v3/files/{fileId}/approvals` |
| `drive.approvals.get` | `GET /drive/v3/files/{fileId}/approvals/{approvalId}` |
| `drive.approvals.approve` | `POST /drive/v3/files/{fileId}/approvals/{approvalId}:approve` |
| `drive.approvals.decline` | `POST /drive/v3/files/{fileId}/approvals/{approvalId}:decline` |
| `drive.approvals.cancel` | `POST /drive/v3/files/{fileId}/approvals/{approvalId}:cancel` |
| `drive.approvals.comment` | `POST /drive/v3/files/{fileId}/approvals/{approvalId}:comment` |
| `drive.approvals.reassign` | `POST /drive/v3/files/{fileId}/approvals/{approvalId}:reassign` |

### Access Proposals

| `googleapis` method | Endpoint |
| --- | --- |
| `drive.accessproposals.list` | `GET /drive/v3/files/{fileId}/accessproposals` |
| `drive.accessproposals.get` | `GET /drive/v3/files/{fileId}/accessproposals/{proposalId}` |
| `drive.accessproposals.resolve` | `POST /drive/v3/files/{fileId}/accessproposals/{proposalId}:resolve` |

Access proposals are read/resolve-only in the public Drive API, so tests may seed them directly in memory.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| In-memory files, folders, metadata, parents, trash, star state | Supported | State is ephemeral and resettable. |
| JSON metadata create/update | Supported | Field masks are accepted but not interpreted. |
| Media and multipart upload | Supported | `uploadType=media` and `uploadType=multipart` are implemented. |
| Media download and export | Supported | Returns stored bytes with requested content type for export. |
| File list paging | Supported | Uses numeric `pageToken` offsets. |
| Common Drive `q` filters | Supported | See Files section for supported clauses. |
| Permissions | Supported | No real ACL enforcement. |
| Comments and replies | Supported | Delete marks items deleted like the real API. |
| Revisions | Supported | Created on media/metadata update. The only revision cannot be deleted. |
| Shared drives | Supported | Metadata lifecycle only. |
| Legacy team drives | Supported | Aliased to the same in-memory shared drive store. |
| Watches/channels | Supported | Stored in memory; no outbound webhook delivery. |
| Access proposals | Supported | List/get/resolve only, matching the public API surface. |
| Approvals | Supported | In-memory approval state transitions only. |
| Long-running operations | Supported | Operations complete immediately. |
| OAuth, auth scopes, quota enforcement | Intentionally unsupported | The fake trusts all requests. |
| Resumable uploads | Intentionally unsupported | Use media or multipart uploads for tests. |
| Google Docs native conversion fidelity | Intentionally unsupported | Export returns stored bytes. |
| Complex search grammar and `fields` projection | Intentionally unsupported | Unknown query clauses are treated as matches; responses are full resources. |

## Error Shape

Errors use Google JSON error framing:

```json
{
  "error": {
    "code": 404,
    "message": "File not found",
    "status": "NOT_FOUND",
    "errors": [
      { "message": "File not found", "domain": "global", "reason": "notFound" }
    ]
  }
}
```

Common returned reasons include `notFound`, `invalidArgument`, `parseError`, `alreadyExists`, and `methodNotAllowed`.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_DRIVE_EMULATOR_HOST=http://localhost:4614
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
