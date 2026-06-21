# Outlook

Lightweight, dependency-free Microsoft Graph mail fake for local tests with `@microsoft/microsoft-graph-client`.

## Defaults

| Setting | Value |
| --- | --- |
| Service name | `outlook` |
| Default port | `4620` |
| Protocol | HTTP, Microsoft Graph REST-style JSON |
| Healthcheck | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |
| Base URL | `http://127.0.0.1:4620/v1.0` |

## Quick Start

```js
import { OutlookServer } from "./services/outlook/src/server.js";
import { Client } from "@microsoft/microsoft-graph-client";

const server = new OutlookServer(4620);
await server.start();

const client = Client.init({
  baseUrl: "http://127.0.0.1:4620/v1.0",
  authProvider: (done) => done(null, "local-token"),
});

await client.api("/me/sendMail").post({
  message: {
    subject: "Hello from parlel",
    body: { contentType: "text", content: "Local only" },
    toRecipients: [{ emailAddress: { address: "agent@example.com" } }],
  },
  saveToSentItems: true,
});

const messages = await client.api("/me/mailFolders/sentitems/messages").get();
await server.stop();
```

## Implemented Operations

### Emulator

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/_parlel/health` | Returns service status and object counts. |
| `POST` | `/_parlel/reset` | Clears ephemeral state and restores default folders/categories. |
| `GET` | `/`, `/v1.0`, `/beta` | Lightweight metadata response. |

### Users and Settings

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me` | Returns the current user. |
| `GET` | `/v1.0/users/{userId}` | Returns the requested local user. |
| `GET` | `/v1.0/me/mailboxSettings` | Returns mailbox settings. |
| `PATCH` | `/v1.0/me/mailboxSettings` | Merges mailbox setting changes. |

### Mail Folders

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me/mailFolders` | Lists top-level folders. Supports `$top`, `$skip`, `$count`, `$filter`, `$search`, `$orderby`, `$select`. |
| `POST` | `/v1.0/me/mailFolders` | Creates a top-level folder. |
| `GET` | `/v1.0/me/mailFolders/{id}` | Gets a folder. |
| `PATCH` | `/v1.0/me/mailFolders/{id}` | Updates `displayName`. |
| `DELETE` | `/v1.0/me/mailFolders/{id}` | Deletes non-default folders. |
| `GET` | `/v1.0/me/mailFolders/{id}/childFolders` | Lists child folders. |
| `POST` | `/v1.0/me/mailFolders/{id}/childFolders` | Creates a child folder. |
| `GET` | `/v1.0/me/mailFolders/{id}/childFolders/{childId}` | Gets a child folder. |
| `PATCH` | `/v1.0/me/mailFolders/{id}/childFolders/{childId}` | Updates a child folder. |
| `DELETE` | `/v1.0/me/mailFolders/{id}/childFolders/{childId}` | Deletes a child folder. |

Default folders are `inbox`, `drafts`, `sentitems`, `deleteditems`, `junkemail`, `archive`, and `outbox`.

### Messages and Drafts

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me/messages` | Lists messages. Supports `$top`, `$skip`, `$count`, `$filter`, `$search`, `$orderby`, `$select`. |
| `POST` | `/v1.0/me/messages` | Creates a draft message by default. |
| `GET` | `/v1.0/me/messages/$count` | Returns a plain-text count. |
| `GET` | `/v1.0/me/messages/delta` | Returns current messages plus `@odata.deltaLink`. |
| `GET` | `/v1.0/me/messages/{id}` | Gets a message. Supports `$select` and `$expand=attachments`. |
| `PATCH` | `/v1.0/me/messages/{id}` | Updates common mutable message fields. |
| `DELETE` | `/v1.0/me/messages/{id}` | Soft-deletes a message from visible results. |
| `GET` | `/v1.0/me/mailFolders/{folderId}/messages` | Lists messages in a folder. |
| `POST` | `/v1.0/me/mailFolders/{folderId}/messages` | Creates a draft message in a folder. |
| `GET` | `/v1.0/me/mailFolders/{folderId}/messages/delta` | Folder-scoped delta list. |

### Message Actions

| Method | Endpoint | Notes |
| --- | --- | --- |
| `POST` | `/v1.0/me/sendMail` | Sends a new message and returns `202`. Honors `saveToSentItems: false` by hiding the stored sent copy. |
| `POST` | `/v1.0/me/messages/{id}/send` | Sends a draft and moves it to `sentitems`. |
| `POST` | `/v1.0/me/messages/{id}/reply` | Creates a sent reply and returns `202`. |
| `POST` | `/v1.0/me/messages/{id}/replyAll` | Creates a sent reply-all and returns `202`. |
| `POST` | `/v1.0/me/messages/{id}/forward` | Creates a sent forward and returns `202`. |
| `POST` | `/v1.0/me/messages/{id}/createReply` | Creates and returns a reply draft. |
| `POST` | `/v1.0/me/messages/{id}/createReplyAll` | Creates and returns a reply-all draft. |
| `POST` | `/v1.0/me/messages/{id}/createForward` | Creates and returns a forward draft. |
| `POST` | `/v1.0/me/messages/{id}/move` | Moves a message to `destinationId` and returns it. |
| `POST` | `/v1.0/me/messages/{id}/copy` | Copies a message to `destinationId` and returns the copy. |

### Attachments

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me/messages/{id}/attachments` | Lists file attachments. |
| `POST` | `/v1.0/me/messages/{id}/attachments` | Creates a `#microsoft.graph.fileAttachment`. |
| `GET` | `/v1.0/me/messages/{id}/attachments/{attachmentId}` | Gets attachment metadata and `contentBytes`. |
| `GET` | `/v1.0/me/messages/{id}/attachments/{attachmentId}/$value` | Returns raw attachment bytes. |
| `DELETE` | `/v1.0/me/messages/{id}/attachments/{attachmentId}` | Deletes an attachment. |

### Message Rules

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me/mailFolders/{folderId}/messageRules` | Lists message rules for a folder. |
| `POST` | `/v1.0/me/mailFolders/{folderId}/messageRules` | Creates a message rule. |
| `GET` | `/v1.0/me/mailFolders/{folderId}/messageRules/{ruleId}` | Gets a message rule. |
| `PATCH` | `/v1.0/me/mailFolders/{folderId}/messageRules/{ruleId}` | Updates a message rule. |
| `DELETE` | `/v1.0/me/mailFolders/{folderId}/messageRules/{ruleId}` | Deletes a message rule. |

### Outlook Categories

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me/outlook/masterCategories` | Lists categories. |
| `POST` | `/v1.0/me/outlook/masterCategories` | Creates a category. |
| `GET` | `/v1.0/me/outlook/masterCategories/{id}` | Gets a category. |
| `PATCH` | `/v1.0/me/outlook/masterCategories/{id}` | Updates a category. |
| `DELETE` | `/v1.0/me/outlook/masterCategories/{id}` | Deletes a category. |

### Subscriptions and Batch

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/subscriptions` | Lists subscriptions. |
| `POST` | `/v1.0/subscriptions` | Creates a subscription. Requires `changeType`, `notificationUrl`, and `resource`. |
| `GET` | `/v1.0/subscriptions/{id}` | Gets a subscription. |
| `PATCH` | `/v1.0/subscriptions/{id}` | Updates a subscription. |
| `DELETE` | `/v1.0/subscriptions/{id}` | Deletes a subscription. |
| `POST` | `/v1.0/$batch` | Executes JSON batch requests against the in-process router. |

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| `@microsoft/microsoft-graph-client` REST calls | Supported | Use `Client.init({ baseUrl, authProvider })`. Auth tokens are accepted but ignored. |
| Microsoft Graph v1.0 and beta prefixes | Supported | Both route to the same fake implementation. |
| In-memory mail folders, messages, drafts, actions, attachments | Supported | State is ephemeral and resettable. |
| OData paging/filter/search/order/select/count | Supported | Lightweight common subset for local tests. |
| Delta links | Supported | Returns current state plus a synthetic `@odata.deltaLink`. |
| Webhook subscription CRUD | Supported | Stored locally. No outbound HTTP notifications are sent. |
| JSON batch | Supported | Routes batch items in process. |
| Authentication, authorization, tenants, permissions | Intentionally unsupported | Tokens are ignored to keep local tests zero-config. |
| Real Exchange delivery, spam filtering, transport rules | Intentionally unsupported | No side effects leave the process. |
| Calendar, contacts, OneDrive, Teams, non-mail Graph resources | Intentionally unsupported | This fake is scoped to Graph mail. |
| MIME upload sessions and large attachment upload sessions | Intentionally unsupported | Use normal file attachment `contentBytes`. |

## Error Shapes

Errors follow the Microsoft Graph JSON shape:

```json
{
  "error": {
    "code": "ErrorItemNotFound",
    "message": "Message not found",
    "innerError": {
      "date": "2026-06-11T00:00:00.000Z",
      "request-id": "req_...",
      "client-request-id": "optional-client-id"
    }
  }
}
```

Common returned codes:

| HTTP | Graph code | When |
| --- | --- | --- |
| `400` | `ErrorInvalidRequest` | Missing required fields, invalid JSON, invalid default-folder deletion. |
| `404` | `ErrorItemNotFound` | Missing users, folders, messages, attachments, rules, categories, or subscriptions. |
| `404` | `Request_ResourceNotFound` | Unknown route. |
| `405` | `Request_BadRequest` | Unsupported HTTP method for an implemented route. |
| `500` | `InternalServerError` | Unexpected server errors. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
OUTLOOK_EMULATOR_HOST=http://localhost:4620
MICROSOFT_GRAPH_BASE_URL=http://localhost:4620/v1.0
AZURE_TENANT_ID=parlel
AZURE_CLIENT_ID=parlel
AZURE_CLIENT_SECRET=parlel
```

<!-- parlel:testenv:end -->
