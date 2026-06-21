# Teams

Lightweight, dependency-free Microsoft Graph Teams and chats fake for local tests with `@microsoft/microsoft-graph-client`.

## Defaults

| Setting | Value |
| --- | --- |
| Service name | `teams` |
| Default port | `4621` |
| Protocol | HTTP, Microsoft Graph REST-style JSON |
| Healthcheck | `GET /_parlel/health` |
| Reset | `POST /_parlel/reset` |
| Base URL | `http://127.0.0.1:4621/v1.0` |

## Quick Start

```js
import { TeamsServer } from "./services/teams/src/server.js";
import { Client } from "@microsoft/microsoft-graph-client";

const server = new TeamsServer(4621);
await server.start();

const client = Client.init({
  baseUrl: "http://127.0.0.1:4621/v1.0",
  authProvider: (done) => done(null, "local-token"),
});

const team = await client.api("/teams").post({
  displayName: "Local Team",
  description: "No Microsoft tenant required",
});

const channel = await client.api(`/teams/${team.id}/channels`).post({
  displayName: "agents",
});

await client.api(`/teams/${team.id}/channels/${channel.id}/messages`).post({
  body: { contentType: "text", content: "Hello from parlel" },
});

const messages = await client.api(`/teams/${team.id}/channels/${channel.id}/messages`).get();
await server.stop();
```

## Implemented Operations

Collection responses support a lightweight OData subset: `$top`, `$skip`, `$count`, `$filter`, `$search`, `$orderby`, and `$select`. Single resource reads support `$select` where practical. Both `/v1.0` and `/beta` prefixes route to the same implementation.

### Emulator

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/_parlel/health` | Returns service status and object counts. |
| `POST` | `/_parlel/reset` | Clears ephemeral state and restores seeded users, team, channel, and chat. |
| `GET` | `/`, `/v1.0`, `/beta` | Lightweight metadata response. |

### Users

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/me` | Returns the current local user. |
| `GET` | `/v1.0/users/{userId}` | Returns a seeded local user by id or mail. |
| `GET` | `/v1.0/me/joinedTeams` | Lists teams where the current user is a member. |
| `GET` | `/v1.0/users/{userId}/joinedTeams` | Lists teams where a user is a member. |
| `GET` | `/v1.0/me/chats` | Lists chats where the current user is a member. |

### Teams

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams` | Lists teams. |
| `POST` | `/v1.0/teams` | Creates a team and returns `202` with the created team. |
| `GET` | `/v1.0/teams/{teamId}` | Gets a team. |
| `PATCH` | `/v1.0/teams/{teamId}` | Updates `displayName`, `description`, `classification`, `visibility`, or `isArchived`. |
| `DELETE` | `/v1.0/teams/{teamId}` | Deletes a team and its in-memory child resources. |
| `POST` | `/v1.0/teams/{teamId}/archive` | Marks the team archived and returns `202`. |
| `POST` | `/v1.0/teams/{teamId}/unarchive` | Marks the team unarchived and returns `202`. |
| `POST` | `/v1.0/teams/{teamId}/sendActivityNotification` | Accepts the notification payload and returns `202`; no outbound notification is sent. |
| `PUT` | `/v1.0/groups/{groupId}/team` | Creates a team using the group id. |
| `GET` | `/v1.0/groups/{groupId}/team` | Gets the team created for a group id. |

### Team Members

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/members` | Lists team conversation members. |
| `POST` | `/v1.0/teams/{teamId}/members` | Creates an `#microsoft.graph.aadUserConversationMember`. |
| `GET` | `/v1.0/teams/{teamId}/members/{memberId}` | Gets a team member. |
| `PATCH` | `/v1.0/teams/{teamId}/members/{memberId}` | Merges member fields such as `roles`. |
| `DELETE` | `/v1.0/teams/{teamId}/members/{memberId}` | Deletes a team member. |

### Channels

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/channels` | Lists channels. |
| `POST` | `/v1.0/teams/{teamId}/channels` | Creates a channel. Requires `displayName`. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}` | Gets a channel. |
| `PATCH` | `/v1.0/teams/{teamId}/channels/{channelId}` | Updates common channel fields. |
| `DELETE` | `/v1.0/teams/{teamId}/channels/{channelId}` | Deletes a channel and child in-memory resources. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/completeMigration` | Returns `204`. |

### Channel Members

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/members` | Lists channel members. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/members` | Creates a channel member. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/members/{memberId}` | Gets a channel member. |
| `PATCH` | `/v1.0/teams/{teamId}/channels/{channelId}/members/{memberId}` | Merges member fields. |
| `DELETE` | `/v1.0/teams/{teamId}/channels/{channelId}/members/{memberId}` | Deletes a channel member. |

### Channel Messages and Replies

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages` | Lists root channel messages. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/messages` | Creates a channel message. Requires `body` or `content`. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/$count` | Returns a plain-text count. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/delta` | Returns current messages plus `@odata.deltaLink`. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}` | Gets a channel message. |
| `PATCH` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}` | Updates common mutable message fields. |
| `DELETE` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}` | Deletes a channel message. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/setReaction` | Adds a local reaction. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/unsetReaction` | Removes a local reaction. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/hostedContents` | Lists hosted content metadata stored on the message. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies` | Lists replies. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies` | Creates a reply. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}` | Gets a reply. |
| `PATCH` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}` | Updates a reply. |
| `DELETE` | `/v1.0/teams/{teamId}/channels/{channelId}/messages/{messageId}/replies/{replyId}` | Deletes a reply. |

### Tabs

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/tabs` | Lists channel tabs. |
| `POST` | `/v1.0/teams/{teamId}/channels/{channelId}/tabs` | Creates a tab. Requires `displayName`. |
| `GET` | `/v1.0/teams/{teamId}/channels/{channelId}/tabs/{tabId}` | Gets a tab. |
| `PATCH` | `/v1.0/teams/{teamId}/channels/{channelId}/tabs/{tabId}` | Updates a tab. |
| `DELETE` | `/v1.0/teams/{teamId}/channels/{channelId}/tabs/{tabId}` | Deletes a tab. |

### Installed Apps

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/teams/{teamId}/installedApps` | Lists team installed apps. |
| `POST` | `/v1.0/teams/{teamId}/installedApps` | Installs a team app. |
| `GET` | `/v1.0/teams/{teamId}/installedApps/{appId}` | Gets a team installed app. |
| `POST` | `/v1.0/teams/{teamId}/installedApps/{appId}/upgrade` | Updates the stored app version and returns `204`. |
| `DELETE` | `/v1.0/teams/{teamId}/installedApps/{appId}` | Deletes a team installed app. |
| `GET` | `/v1.0/chats/{chatId}/installedApps` | Lists chat installed apps. |
| `POST` | `/v1.0/chats/{chatId}/installedApps` | Installs a chat app. |
| `GET` | `/v1.0/chats/{chatId}/installedApps/{appId}` | Gets a chat installed app. |
| `POST` | `/v1.0/chats/{chatId}/installedApps/{appId}/upgrade` | Updates the stored app version and returns `204`. |
| `DELETE` | `/v1.0/chats/{chatId}/installedApps/{appId}` | Deletes a chat installed app. |

### Chats and Chat Members

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/chats` | Lists chats. |
| `POST` | `/v1.0/chats` | Creates a chat. Requires `chatType` or `members`. |
| `GET` | `/v1.0/chats/{chatId}` | Gets a chat. |
| `PATCH` | `/v1.0/chats/{chatId}` | Updates `topic` or `chatType`. |
| `DELETE` | `/v1.0/chats/{chatId}` | Deletes a chat and child in-memory resources. |
| `POST` | `/v1.0/chats/{chatId}/sendActivityNotification` | Accepts the notification payload and returns `202`. |
| `GET` | `/v1.0/chats/{chatId}/members` | Lists chat members. |
| `POST` | `/v1.0/chats/{chatId}/members` | Creates a chat member. |
| `GET` | `/v1.0/chats/{chatId}/members/{memberId}` | Gets a chat member. |
| `PATCH` | `/v1.0/chats/{chatId}/members/{memberId}` | Merges member fields. |
| `DELETE` | `/v1.0/chats/{chatId}/members/{memberId}` | Deletes a chat member. |

### Chat Messages

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/v1.0/chats/{chatId}/messages` | Lists chat messages. |
| `POST` | `/v1.0/chats/{chatId}/messages` | Creates a chat message. Requires `body` or `content`. |
| `GET` | `/v1.0/chats/{chatId}/messages/$count` | Returns a plain-text count. |
| `GET` | `/v1.0/chats/{chatId}/messages/delta` | Returns current messages plus `@odata.deltaLink`. |
| `GET` | `/v1.0/chats/{chatId}/messages/{messageId}` | Gets a chat message. |
| `PATCH` | `/v1.0/chats/{chatId}/messages/{messageId}` | Updates common mutable message fields. |
| `DELETE` | `/v1.0/chats/{chatId}/messages/{messageId}` | Deletes a chat message. |
| `POST` | `/v1.0/chats/{chatId}/messages/{messageId}/setReaction` | Adds a local reaction. |
| `POST` | `/v1.0/chats/{chatId}/messages/{messageId}/unsetReaction` | Removes a local reaction. |
| `GET` | `/v1.0/chats/{chatId}/messages/{messageId}/hostedContents` | Lists hosted content metadata stored on the message. |

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
| In-memory users, teams, channels, messages, replies, tabs, apps, chats, members | Supported | State is ephemeral and resettable. |
| OData paging/filter/search/order/select/count | Supported | Lightweight common subset for local tests. |
| Delta links for team channel messages and chat messages | Supported | Returns current state plus a synthetic `@odata.deltaLink`. |
| Webhook subscription CRUD | Supported | Stored locally. No outbound HTTP notifications are sent. |
| JSON batch | Supported | Routes batch items in process. |
| Authentication, authorization, tenants, permissions | Intentionally unsupported | Tokens are ignored to keep local tests zero-config. |
| Real Microsoft Teams delivery, notifications, tenant policy, compliance, retention | Intentionally unsupported | No side effects leave the process. |
| Calls, online meetings, SharePoint files, Planner, OneDrive, Exchange mail | Intentionally unsupported | This fake is scoped to Teams/chats Graph REST resources. |
| Large hosted content upload sessions and binary download | Intentionally unsupported | Hosted content metadata can be stored inline on messages. |

## Error Shapes

Errors follow the Microsoft Graph JSON shape:

```json
{
  "error": {
    "code": "ErrorItemNotFound",
    "message": "Team not found",
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
| `400` | `ErrorInvalidRequest` | Missing required fields or invalid JSON. |
| `404` | `ErrorItemNotFound` | Missing users, teams, channels, messages, replies, members, tabs, apps, chats, or subscriptions. |
| `404` | `Request_ResourceNotFound` | Unknown route. |
| `405` | `Request_BadRequest` | Unsupported HTTP method for an implemented route. |
| `500` | `InternalServerError` | Unexpected server errors. |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TEAMS_EMULATOR_HOST=http://localhost:4621
MICROSOFT_GRAPH_BASE_URL=http://localhost:4621/v1.0
AZURE_TENANT_ID=parlel
AZURE_CLIENT_ID=parlel
AZURE_CLIENT_SECRET=parlel
```

<!-- parlel:testenv:end -->
