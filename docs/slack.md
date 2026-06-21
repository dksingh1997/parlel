# Slack

Lightweight, dependency-free, in-memory fake of the **Slack Web API** for testing code that uses the real `@slack/web-api` `WebClient` (and the language-agnostic Slack Web API).

Default port: `4654`

## Quick start

Start the server:

```js
import { SlackServer } from "./services/slack/src/server.js";

const server = new SlackServer(4654);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `@slack/web-api` client at it. The `WebClient` reads its base URL from the `slackApiUrl` option, so override it to the parlel fake:

```js
import { WebClient } from "@slack/web-api";

const web = new WebClient("xoxb-parlel-test-token", {
  slackApiUrl: "http://127.0.0.1:4654/api/", // point at the parlel fake
});

const res = await web.chat.postMessage({
  channel: "C_GENERAL1",
  text: "hello from parlel",
});
// res.ok === true, res.ts === "<seconds>.<micros>", res.channel === "C_GENERAL1"

const history = await web.conversations.history({ channel: "C_GENERAL1" });
// history.messages[0].text === "hello from parlel"
```

Every posted message, channel, file, reaction, etc. is captured in memory and can be inspected via the `/__parlel/*` endpoints (see below). The whole world is resettable.

### Wire protocol

The fake speaks the exact Slack Web API wire protocol that `@slack/web-api` uses:

- Every method is a **POST** (GET also accepted) to `/api/<method>` — e.g. `POST /api/chat.postMessage`.
- The request body is **`application/x-www-form-urlencoded`** (the SDK default) **or** `application/json`. Nested values (`blocks`, `attachments`, `view`, `files`, `profile`) may be JSON-encoded strings, which the fake parses transparently.
- The token is supplied via the **`Authorization: Bearer xoxb-...`** header or a `token` body param.
- Responses are **always HTTP 200** with a JSON body `{ "ok": true, ... }` on success or `{ "ok": false, "error": "<code>" }` on failure (Slack does not use non-2xx status codes for application errors). `@slack/web-api` throws an error with `code === "slack_webapi_platform_error"` and `error.data.error === "<code>"` when `ok` is `false`.

## Implemented operations

### Auth & misc
- `api.test` — echoes args (no auth required); returns the provided `error` if set
- `auth.test` — bot/team identity
- `auth.revoke` — revoke the current token (`test=true` is a no-op probe)
- `team.info`
- `emoji.list`

### chat
- `chat.postMessage` — supports `text`, `blocks`, `attachments`, `thread_ts`, `reply_broadcast`, `username`. Bot-token posts return `message.subtype === "bot_message"` with a `username` and `bot_id`, exactly like the real API.
- `chat.postEphemeral`
- `chat.update`
- `chat.delete`
- `chat.meMessage`
- `chat.getPermalink`
- `chat.scheduleMessage`
- `chat.deleteScheduledMessage`
- `chat.scheduledMessages.list`

### conversations
- `conversations.list` — returns channel objects with the full standard field set (`is_member`, `is_shared`, `is_ext_shared`, `is_org_shared`, `unlinked`, `pending_shared`, `is_pending_ext_shared`, `previous_names`)
- `conversations.create` — granular name validation (`invalid_name_required`, `invalid_name_maxlength`, `invalid_name_specials`, `invalid_name_punctuation`)
- `conversations.info`
- `conversations.history`
- `conversations.replies`
- `conversations.members`
- `conversations.join`
- `conversations.leave`
- `conversations.open` (DM + multi-party IM)
- `conversations.invite`
- `conversations.kick`
- `conversations.rename`
- `conversations.setTopic`
- `conversations.setPurpose`
- `conversations.archive`
- `conversations.unarchive`
- `conversations.mark`

### users
- `users.list`
- `users.info`
- `users.lookupByEmail`
- `users.identity`
- `users.setPresence`
- `users.getPresence`
- `users.conversations`
- `users.profile.get`
- `users.profile.set`

### reactions
- `reactions.add`
- `reactions.remove`
- `reactions.get`
- `reactions.list`

### pins
- `pins.add`
- `pins.remove`
- `pins.list`

### bookmarks
- `bookmarks.add`
- `bookmarks.list`
- `bookmarks.edit`
- `bookmarks.remove`

### files
- `files.upload` (legacy; supports `content`, `channels`, `initial_comment`)
- `files.info`
- `files.list`
- `files.delete`
- `files.getUploadURLExternal` + `files.completeUploadExternal` (the modern `files.uploadV2` two-step flow)

### views (Block Kit surfaces)
- `views.open`
- `views.push`
- `views.publish` (App Home)
- `views.update`

### usergroups
- `usergroups.create`
- `usergroups.list`
- `usergroups.update`
- `usergroups.users.list`
- `usergroups.users.update`

## parlel control / inspection endpoints

These are **not** part of Slack — they are parlel extensions for test setup and assertions.

| Method & path | Purpose |
| --- | --- |
| `POST /__parlel/reset` | Wipe all state and re-seed defaults (workspace, bot, `#general`, `#random`, Alice) |
| `GET /__parlel/messages` | Every stored message across all channels (`{ messages, count }`) |
| `GET /__parlel/channels` | Every channel including private members (`{ channels, count }`) |
| `GET /__parlel/files` | Every stored file (`{ files, count }`) |
| `POST /__parlel/users` | Add a user fixture (`{ id?, name, email?, is_bot?, is_admin? }`) |
| `POST /__parlel/upload/:id` | Simulated external-upload PUT target used by `files.uploadV2` |
| `GET /health` | Health check (`{ "status": "ok" }`) |
| `GET /` | Service metadata |

### Default seeded state

After `start()` (or `reset`) the world contains:

- Workspace `T_PARLEL01` ("Parlel Workspace", domain `parlel`)
- Bot user `U_BOT00001` (`parlelbot`, bot_id `B_BOT00001`)
- Admin user `U_ALICE001` (`alice`, `alice@parlel.test`)
- Channels `C_GENERAL1` (`#general`) and `C_RANDOM01` (`#random`)
- Accepted tokens: `xoxb-parlel-test-token`, `xoxp-parlel-test-token`, `xapp-parlel-test-token`

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Supported | Notes |
| --- | --- | --- |
| `chat.*` messaging | ✅ | post / update / delete / ephemeral / schedule / permalink / meMessage |
| Bot message shape (`subtype`, `username`) | ✅ | bot-token posts return `subtype: "bot_message"`, `username`, `bot_id` |
| Threads & replies | ✅ | `thread_ts`, reply counts, `conversations.replies` |
| `conversations.*` channel lifecycle | ✅ | create / join / leave / invite / kick / archive / rename / topic / purpose |
| Channel object fidelity | ✅ | `is_member`, `is_shared`, `is_ext_shared`, `is_org_shared`, `unlinked`, `pending_shared`, `previous_names` |
| Granular channel-name validation | ✅ | `invalid_name_required` / `invalid_name_maxlength` / `invalid_name_specials` / `invalid_name_punctuation` |
| DMs & multi-party IMs | ✅ | via `conversations.open` |
| `users.*` directory & presence | ✅ | list / info / lookupByEmail / presence / profile |
| Reactions, pins, bookmarks | ✅ | full CRUD |
| Files (legacy upload + uploadV2) | ✅ | content captured in-memory; binary bytes simulated |
| Block Kit views (modals + App Home) | ✅ | open / push / publish / update |
| Usergroups (subteams) | ✅ | create / list / update / membership |
| Form-encoded **and** JSON bodies | ✅ | matches the SDK default + JSON callers |
| Token / auth checking | ✅ | `not_authed`, `invalid_auth`, `token_revoked` |
| Pagination cursors | ◐ | `response_metadata.next_cursor` returned as `""` (single page); `limit`/`has_more` honored on `conversations.history` |
| Rate limiting (HTTP 429 / `Retry-After`) | ✓ | By design — never throttles, so local tests run at full speed, zero cost |
| Request signing / `x-slack-signature` verification | ⟳ | Roadmap |
| Socket Mode / RTM / Events API / webhooks | ⟳ | Roadmap |
| `admin.*` (Enterprise Grid) | ⟳ | Roadmap |
| `oauth.*`, `apps.*`, `dnd.*`, `stars.*`, `search.*` | ⟳ | Roadmap |

## Error codes / shapes

All errors are returned as HTTP 200 with `{ "ok": false, "error": "<code>" }`. Common codes:

| Code | When |
| --- | --- |
| `not_authed` | No token supplied |
| `invalid_auth` | Unknown token |
| `token_revoked` | Token was revoked via `auth.revoke` |
| `unknown_method` | Method not implemented |
| `channel_not_found` | Channel id/name does not resolve |
| `no_text` | `chat.postMessage` with no `text`/`blocks`/`attachments` |
| `message_not_found` | `ts` does not match a stored message |
| `thread_not_found` | `thread_ts` parent missing |
| `user_not_found` / `users_not_found` | Unknown user / email lookup miss |
| `name_taken` | `conversations.create`/`rename` with a name already in use |
| `invalid_name_required` | `conversations.create`/`rename` with an empty name |
| `invalid_name_maxlength` | Channel name longer than 80 characters |
| `invalid_name_specials` | Channel name with uppercase or otherwise disallowed characters |
| `invalid_name_punctuation` | Channel name made only of punctuation (no alphanumerics) |
| `already_archived` / `not_archived` / `cant_archive_general` | Archive lifecycle |
| `already_reacted` / `no_reaction` | `reactions.add`/`remove` |
| `already_pinned` / `no_pin` | `pins.add`/`remove` |
| `bookmark_not_found` | `bookmarks.edit`/`remove` |
| `file_not_found` / `no_file_data` | Files API |
| `invalid_presence` | `users.setPresence` with a value other than `auto`/`away` |
| `time_in_past` / `invalid_scheduled_message_id` | Scheduled messages |
| `no_such_subteam` | Usergroups |
| `invalid_arguments` | Missing required arguments (e.g. `views.open` without `trigger_id`) |

> The image target stays tiny (<1MB): a single pure-Node.js file, no external npm dependencies.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SLACK_BOT_TOKEN=xoxb-parlel-test-token
SLACK_APP_TOKEN=xapp-parlel-test-token
SLACK_SIGNING_SECRET=parlel_test_signing_secret
SLACK_BASE_URL=http://localhost:4654/api/
```

<!-- parlel:testenv:end -->
