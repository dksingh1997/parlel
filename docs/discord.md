# Discord

Lightweight, dependency-free, in-memory fake of the **Discord REST API (v10)** for testing code that uses the real `discord.js` client (and any HTTP client that speaks the Discord REST protocol).

Default port: `4655`

## Quick start

Start the server:

```js
import { DiscordServer } from "./services/discord/src/server.js";

const server = new DiscordServer(4655);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `discord.js` `REST` client at it. The client reads its base URL from the `api` option (it appends `/v{version}` itself), so override it to the parlel fake:

```js
import { REST } from "discord.js"; // or "@discordjs/rest"
import { Routes } from "discord-api-types/v10";

const rest = new REST({ version: "10" })
  .setToken("parlel.test.discordbottoken");

// Override the API base so requests hit the parlel fake instead of discord.com:
rest.options.api = "http://127.0.0.1:4655/api";

// Who am I?
const me = await rest.get(Routes.user("@me"));
// me.id === "1000000000000000010", me.username === "parlelbot"

// Send a message
const msg = await rest.post(Routes.channelMessages("3000000000000000001"), {
  body: { content: "hello from parlel" },
});
// msg.content === "hello from parlel", msg.author.id === me.id

// Register a slash command
await rest.put(
  Routes.applicationCommands("1000000000000000001"),
  { body: [{ name: "ping", description: "Ping!" }] },
);
```

> The full `Client` (with the WebSocket Gateway) is **not** emulated — see the
> unsupported table below. Use the `REST` client (or raw `fetch`) for REST flows,
> which is what `client.guilds`, `channel.send()`, command deployment, etc. use
> under the hood.

Every guild, channel, message, member, role, ban, emoji, webhook, invite, reaction, and thread is captured in memory and can be inspected via the `/__parlel/*` endpoints (see below). The whole world is resettable.

## Wire protocol

- REST routes live under `/api` and `/api/v{n}` (`v6`–`v10` accepted; the prefix is optional).
- Auth via `Authorization: Bot <token>` (a `Bearer` token is also accepted). Webhook execution / webhook-token routes carry the token in the URL and need no header.
- JSON request and response bodies. `multipart/form-data` uploads are parsed best-effort via their `payload_json` part.
- IDs are Discord-shaped **snowflakes** (stringified, monotonically increasing).
- Success responses use the appropriate status (`200`, `201`, or `204 No Content`).
- Errors use Discord's envelope: HTTP `4xx`/`5xx` with `{ "message": string, "code": number, "errors"?: object }`.
- `X-Audit-Log-Reason` is accepted (and ignored) on mutating routes.
- Informational `X-RateLimit-*` headers are sent; the fake never actually rate-limits.

## Seeded fixtures

On startup / reset the world contains:

| Entity | ID | Notes |
| --- | --- | --- |
| Bot user (`@me`) | `1000000000000000010` | `parlelbot`, `bot: true` |
| Human user | `1000000000000000020` | `alice` |
| Application | `1000000000000000001` | `oauth2/applications/@me` |
| Guild | `2000000000000000001` | `Parlel Guild`, owned by the bot |
| `@everyone` role | `2000000000000000001` | role id == guild id |
| Text channel | `3000000000000000001` | `general` |

Valid tokens: `parlel.test.discordbottoken`, `parlel.test.discordbottoken.bot`.

## Implemented operations / endpoints

### Gateway
- `GET /gateway`
- `GET /gateway/bot`

### OAuth2 / application identity
- `GET /oauth2/applications/@me`
- `GET /oauth2/@me`

### Users
- `GET /users/@me`
- `PATCH /users/@me`
- `GET /users/{user.id}`
- `GET /users/@me/guilds`
- `GET /users/@me/guilds/{guild.id}/member`
- `DELETE /users/@me/guilds/{guild.id}` (leave guild)
- `GET /users/@me/channels`
- `POST /users/@me/channels` (open / reuse a DM)

### Channels
- `GET /channels/{channel.id}`
- `PATCH /channels/{channel.id}`
- `DELETE /channels/{channel.id}`
- `POST /channels/{channel.id}/typing`
- `POST /channels/{channel.id}/followers`
- `GET / POST /channels/{channel.id}/invites`
- `PUT / DELETE /channels/{channel.id}/permissions/{overwrite.id}`
- `GET / POST /channels/{channel.id}/webhooks`

### Messages
- `GET /channels/{channel.id}/messages`
- `POST /channels/{channel.id}/messages`
- `GET /channels/{channel.id}/messages/{message.id}`
- `PATCH /channels/{channel.id}/messages/{message.id}`
- `DELETE /channels/{channel.id}/messages/{message.id}`
- `POST /channels/{channel.id}/messages/bulk-delete`
- `POST /channels/{channel.id}/messages/{message.id}/crosspost`
- replies via `message_reference`

### Reactions
- `PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
- `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me`
- `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/{user.id}`
- `GET /channels/{channel.id}/messages/{message.id}/reactions/{emoji}` (list reactors)
- `DELETE /channels/{channel.id}/messages/{message.id}/reactions/{emoji}` (clear one emoji)
- `DELETE /channels/{channel.id}/messages/{message.id}/reactions` (clear all)
- Unicode (`🔥`) and custom (`name:id`) emoji are both supported.
- The `reactions` array embedded in a message uses the full Discord v10 [Reaction object](https://discord.com/developers/docs/resources/message#reaction-object) shape: `{ count, count_details: { burst, normal }, me, me_burst, emoji, burst_colors }`.

### Pins
- `GET /channels/{channel.id}/pins`
- `PUT /channels/{channel.id}/pins/{message.id}`
- `DELETE /channels/{channel.id}/pins/{message.id}`

### Threads
- `POST /channels/{channel.id}/threads` (standalone thread)
- `POST /channels/{channel.id}/messages/{message.id}/threads` (thread from a message)
- `GET /channels/{thread.id}/thread-members`
- `GET /channels/{thread.id}/thread-members/{user.id|@me}`
- `PUT /channels/{thread.id}/thread-members/{user.id}`
- `DELETE /channels/{thread.id}/thread-members/{user.id}`

### Guilds
- `POST /guilds`
- `GET /guilds/{guild.id}` (supports `?with_counts=true`)
- `PATCH /guilds/{guild.id}`
- `DELETE /guilds/{guild.id}`
- `GET /guilds/{guild.id}/preview`
- `GET / POST /guilds/{guild.id}/prune`
- `GET /guilds/{guild.id}/invites`
- `GET /guilds/{guild.id}/webhooks`

### Guild channels
- `GET /guilds/{guild.id}/channels`
- `POST /guilds/{guild.id}/channels`
- `PATCH /guilds/{guild.id}/channels` (bulk reposition)

### Guild members
- `GET /guilds/{guild.id}/members`
- `GET /guilds/{guild.id}/members/search?query=`
- `GET /guilds/{guild.id}/members/{user.id|@me}`
- `PUT /guilds/{guild.id}/members/{user.id}` (add member — `201` with the member body when created, `204` No Content when the user is already a member)
- `PATCH /guilds/{guild.id}/members/{user.id}` (nick / roles / mute / deaf / timeout)
- `DELETE /guilds/{guild.id}/members/{user.id}` (kick)
- `PUT / DELETE /guilds/{guild.id}/members/{user.id}/roles/{role.id}`

### Guild roles
- `GET /guilds/{guild.id}/roles`
- `POST /guilds/{guild.id}/roles`
- `PATCH /guilds/{guild.id}/roles` (bulk reposition)
- `PATCH /guilds/{guild.id}/roles/{role.id}`
- `DELETE /guilds/{guild.id}/roles/{role.id}` (also detaches from members)

### Guild bans
- `GET /guilds/{guild.id}/bans`
- `GET /guilds/{guild.id}/bans/{user.id}`
- `PUT /guilds/{guild.id}/bans/{user.id}` (also removes membership)
- `DELETE /guilds/{guild.id}/bans/{user.id}`

### Guild emojis
- `GET /guilds/{guild.id}/emojis`
- `POST /guilds/{guild.id}/emojis`
- `GET /guilds/{guild.id}/emojis/{emoji.id}`
- `PATCH /guilds/{guild.id}/emojis/{emoji.id}`
- `DELETE /guilds/{guild.id}/emojis/{emoji.id}`

### Invites (top-level)
- `GET /invites/{code}`
- `DELETE /invites/{code}`

### Webhooks
- `GET /webhooks/{webhook.id}`
- `PATCH /webhooks/{webhook.id}`
- `DELETE /webhooks/{webhook.id}`
- `GET /webhooks/{webhook.id}/{token}`
- `PATCH /webhooks/{webhook.id}/{token}`
- `DELETE /webhooks/{webhook.id}/{token}`
- `POST /webhooks/{webhook.id}/{token}` (execute; `?wait=true` returns the message, otherwise `204`)
- `GET /webhooks/{webhook.id}/{token}/messages/{message.id|@original}`
- `PATCH /webhooks/{webhook.id}/{token}/messages/{message.id|@original}`
- `DELETE /webhooks/{webhook.id}/{token}/messages/{message.id|@original}`

### Application (slash) commands
- `GET / POST / PUT /applications/{app.id}/commands`
- `GET / PATCH / DELETE /applications/{app.id}/commands/{command.id}`
- `GET / POST / PUT /applications/{app.id}/guilds/{guild.id}/commands`
- `GET / PATCH / DELETE /applications/{app.id}/guilds/{guild.id}/commands/{command.id}`

### parlel control / inspection endpoints (not part of Discord)
- `POST /__parlel/reset` — wipe all state back to the seeded defaults.
- `GET /__parlel/messages` — every stored message across channels.
- `GET /__parlel/channels` — every channel/thread.
- `GET /__parlel/guilds` — every guild (with roles + emojis).
- `POST /__parlel/users` — add a `User` fixture (e.g. `{ "username": "bob" }`).
- `GET /health` — `{ "status": "ok" }`.
- `GET /` — service descriptor.

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| REST: users, channels, messages, reactions, pins | ✅ Supported |
| REST: reaction object shape (`count_details`, `me_burst`, `burst_colors`) | ✅ Supported |
| REST: guilds, members, roles, bans, emojis | ✅ Supported |
| REST: add-member semantics (`201` created / `204` already a member) | ✅ Supported |
| REST: threads & thread members | ✅ Supported |
| REST: webhooks (create, execute, edit/delete messages) | ✅ Supported |
| REST: invites (channel + top-level) | ✅ Supported |
| REST: application / slash commands (global + guild, bulk) | ✅ Supported |
| Gateway info routes (`/gateway`, `/gateway/bot`) | ✅ Supported |
| OAuth2 application identity routes | ✅ Supported |
| Audit-log reason header | ◐ Accepted (ignored) |
| Discord error envelope + codes | ✅ Supported |
| Message list cursor pagination (`before` / `after` / `around`) | ◐ Accepted — only `limit` is honored (newest-first) |
| Bulk-delete 2–100 count / two-week age validation | ◐ Accepted — deletes the given ids, never 400s |
| **WebSocket Gateway** (real-time events: `messageCreate`, presence, etc.) | ✓ By design — Not emulated — REST only |
| Voice connections / voice state | ✓ By design — Not emulated |
| Stage instances, scheduled events, auto-moderation | ✓ By design — Not emulated |
| Real attachment/CDN file hosting | ⟳ Roadmap — Uploads parsed, files not served from a CDN |
| Real rate limiting / 429 backoff | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| OAuth2 token exchange / authorization-code flow | ✓ By design — Not emulated |

## Error codes / shapes

All errors return the Discord envelope:

```json
{ "message": "Unknown Channel", "code": 10003 }
```

Validation errors additionally include an `errors` object:

```json
{
  "message": "Invalid Form Body",
  "code": 50035,
  "errors": {
    "name": { "_errors": [{ "code": "BASE_TYPE_REQUIRED", "message": "This field is required" }] }
  }
}
```

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 401 | `0` | Missing or invalid `Authorization` token |
| 404 | `10003` | Unknown Channel |
| 404 | `10004` | Unknown Guild |
| 404 | `10006` | Unknown Invite |
| 404 | `10007` | Unknown Member |
| 404 | `10008` | Unknown Message |
| 404 | `10009` | Unknown Overwrite |
| 404 | `10011` | Unknown Role |
| 404 | `10013` | Unknown User |
| 404 | `10014` | Unknown Emoji |
| 404 | `10015` | Unknown Webhook |
| 404 | `10026` | Unknown Ban |
| 404 | `10063` | Unknown Command |
| 400 | `50035` | Invalid Form Body (validation failure) |

## Tests

`tests/discord.test.ts` starts the server on port `14655`, drives every implemented operation (happy paths plus key edge cases) through a faithful `discord.js`-style `REST` client mirror, and tears the server down in `afterAll`. Run it with:

```bash
npx vitest run tests/discord.test.ts
```

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
DISCORD_TOKEN=parlel.test.discordbottoken
DISCORD_BOT_TOKEN=parlel.test.discordbottoken
DISCORD_APPLICATION_ID=1000000000000000001
DISCORD_API_BASE_URL=http://localhost:4655/api/v10
```

<!-- parlel:testenv:end -->
