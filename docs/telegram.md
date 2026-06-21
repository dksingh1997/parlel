# Telegram

Lightweight, dependency-free, in-memory fake of the **Telegram Bot API** for testing code that uses the real [`node-telegram-bot-api`](https://github.com/yagop/node-telegram-bot-api) client (or any client that speaks the Telegram Bot HTTP API).

Default port: `4656`

## Quick start

Start the server:

```js
import { TelegramServer } from "./services/telegram/src/server.js";

const server = new TelegramServer(4656);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point the real `node-telegram-bot-api` client at it. The client builds request URLs from a `baseApiUrl` option, so override it to the parlel fake:

```js
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "123456789:parlel-test-bot-token";

const bot = new TelegramBot(TOKEN, {
  baseApiUrl: "http://127.0.0.1:4656", // point at the parlel fake
  polling: false,
});

const me = await bot.getMe();
// me.username === "parlelbot"

const msg = await bot.sendMessage(555000111, "hello from parlel");
// msg.text === "hello from parlel", msg.chat.id === 555000111

// Inject an incoming user message, then poll for it:
await fetch("http://127.0.0.1:4656/__parlel/message", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: 555000111, text: "/start" }),
});
const updates = await bot.getUpdates();
// updates[0].message.text === "/start"
```

Everything the bot sends (messages, media, polls, invoices, …) is captured in memory and can be inspected via the `/__parlel/*` endpoints (see below). The whole world is resettable.

### Wire protocol

The fake speaks the exact Telegram Bot API wire protocol that `node-telegram-bot-api` uses:

- Every method is a request to **`/bot<TOKEN>/<methodName>`** — e.g. `POST /bot123456789:parlel-test-bot-token/sendMessage`. The method name is **case-insensitive**.
- Both **POST** and **GET** are accepted. Params may arrive as a **URL query string**, **`application/x-www-form-urlencoded`** body (the client default), **`application/json`** body, or **`multipart/form-data`** (file uploads, parsed best-effort). Nested values (`reply_markup`, `options`, `media`, `prices`, `permissions`, `scope`, …) may be JSON-encoded strings, which the fake parses transparently.
- The token is supplied in the **URL path** (`/bot<TOKEN>/…`). An unknown token returns HTTP `401`.
- File downloads are served from **`/file/bot<TOKEN>/<file_path>`** (what `getFileLink` resolves to).
- Success responses are HTTP `200` with `{ "ok": true, "result": <value> }`. Failures return an HTTP `4xx` status with `{ "ok": false, "error_code": <int>, "description": "<string>" }` (optionally a `parameters` object). `node-telegram-bot-api` throws an `ETELEGRAM` error carrying `response.body.error_code` and `response.body.description` when `ok` is `false`.

## Default seed state

`reset()` (and startup) seeds a small world so tests can run immediately:

- **Bot identity** (`getMe`): id `123456789`, username `parlelbot`.
- **Private chat** with user *Alice* — chat id `555000111` (also reachable as `@alice`).
- **Supergroup** *Parlel Group* — chat id `-1001000000001` (also `@parlelgroup`), where the bot is an administrator and Alice is a member.
- Valid bot token: `123456789:parlel-test-bot-token`.

## Implemented operations

Grouped by area. All names match `node-telegram-bot-api` method names.

### Bot & connection
`getMe`, `logOut`, `close`, `getUpdates`, `setWebHook` (`setWebhook`), `deleteWebHook` (`deleteWebhook`), `getWebHookInfo` (`getWebhookInfo`)

### Sending messages
`sendMessage`, `forwardMessage`, `copyMessage`, `sendPhoto`, `sendAudio`, `sendDocument`, `sendVideo`, `sendAnimation`, `sendVoice`, `sendVideoNote`, `sendMediaGroup`, `sendSticker`, `sendDice`, `sendChatAction`

### Location / venue / contact / poll
`sendLocation`, `editMessageLiveLocation`, `stopMessageLiveLocation`, `sendVenue`, `sendContact`, `sendPoll`, `stopPoll`

### Editing & deleting
`editMessageText`, `editMessageCaption`, `editMessageReplyMarkup`, `editMessageMedia`, `deleteMessage`

### Files
`getUserProfilePhotos`, `getFile`, `getFileLink` (client-side; resolves to `/file/bot<TOKEN>/<path>`)

### Chat member management
`banChatMember` (`kickChatMember`), `unbanChatMember`, `banChatSenderChat`, `unbanChatSenderChat`, `restrictChatMember`, `promoteChatMember`, `setChatAdministratorCustomTitle`, `setChatPermissions`, `getChatMember`, `getChatMemberCount` (`getChatMembersCount`), `getChatAdministrators`, `leaveChat`

### Invite links & join requests
`exportChatInviteLink`, `createChatInviteLink`, `editChatInviteLink`, `revokeChatInviteLink`, `approveChatJoinRequest`, `declineChatJoinRequest`

### Chat metadata
`getChat`, `setChatTitle`, `setChatDescription`, `setChatPhoto`, `deleteChatPhoto`, `pinChatMessage`, `unpinChatMessage`, `unpinAllChatMessages`, `setChatStickerSet`, `deleteChatStickerSet`, `setChatMenuButton`, `getChatMenuButton`

### Bot profile & commands
`setMyCommands`, `getMyCommands`, `deleteMyCommands` (scope-aware), `setMyDescription`, `getMyDescription`, `setMyShortDescription`, `getMyShortDescription`, `setMyName`, `getMyName`, `setMyDefaultAdministratorRights`, `getMyDefaultAdministratorRights`

### Callback / inline / reactions
`answerCallbackQuery`, `answerInlineQuery`, `setMessageReaction`

### Stickers
`getStickerSet`, `uploadStickerFile`, `createNewStickerSet`, `addStickerToSet`, `setStickerPositionInSet`, `deleteStickerFromSet`

### Games
`sendGame`, `setGameScore`, `getGameHighScores`

### Payments
`sendInvoice`, `answerShippingQuery`, `answerPreCheckoutQuery`

## parlel control / inspection endpoints

These are **not** part of the Telegram API — they let tests inject incoming updates and inspect captured state. No auth required.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Health check → `{ "status": "ok" }` |
| `GET /` | Service metadata |
| `POST /__parlel/reset` | Reset all in-memory state to the seeded defaults |
| `GET /__parlel/sent` | Every message the bot has sent → `{ sent, count }` |
| `GET /__parlel/chats` | All known chats → `{ chats, count }` |
| `GET /__parlel/messages` | All messages across all chats → `{ messages, count }` |
| `GET /__parlel/callbacks` | Recorded `answerCallbackQuery` answers |
| `POST /__parlel/updates` | Inject a raw `Update` object onto the `getUpdates` queue |
| `POST /__parlel/message` | Convenience: inject an incoming text message (`{ chat_id?, text?, from? }`) |

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| Bot API HTTP method surface | ✅ Supported | 90+ methods (see list above) |
| `{ ok, result }` / `{ ok, error_code, description }` envelopes | ✅ Supported | Matches the real wire format |
| URL query / form-urlencoded / JSON / multipart params | ✅ Supported | Multipart parsed best-effort for uploads |
| `@username` chat ids | ✅ Supported | Resolved for seeded chats |
| `getUpdates` long-poll + offset confirmation | ✅ Supported | Updates injected via `/__parlel` |
| Webhook config (`setWebhook` / `getWebhookInfo`) | ✅ Supported | Stored, not actually delivered over HTTP |
| Incoming update injection | ✅ Supported | Via `/__parlel/updates` and `/__parlel/message` |
| Scoped bot commands | ✅ Supported | `default` / `all_group_chats` / chat-scoped |
| File **downloads** | ✅ Supported | `/file/bot<TOKEN>/<path>` returns placeholder bytes |
| Real file storage / image processing | ⟳ Roadmap |
| Live webhook **delivery** to your server | ⟳ Roadmap |
| Long-poll blocking / `timeout` waiting | ⟳ Roadmap |
| Real auth / rate limiting | ✓ By design — Never throttles — local tests run at full speed, zero cost |
| WebSocket / MTProto transport | ⟳ Roadmap |
| Forum topics, business accounts, stars/gifts | ⟳ Roadmap |

## Error codes / shapes

Failures use the Telegram envelope with an HTTP status equal to the `error_code`:

```json
{ "ok": false, "error_code": 400, "description": "Bad Request: message text is empty" }
```

| `error_code` | When |
| --- | --- |
| `400` | Bad request — missing/invalid params (empty text, unknown chat, message not found, too few poll options, etc.) |
| `401` | Unauthorized — unknown bot token in the URL path |
| `404` | Method name not found / route not found |
| `500` | Internal error (unexpected exception) |

`node-telegram-bot-api` surfaces these as a thrown `Error` with `code === "ETELEGRAM"` and `error.response.body` set to the JSON envelope above.

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
TELEGRAM_BOT_TOKEN=123456789:parlel-test-bot-token
TELEGRAM_BASE_URL=http://localhost:4656
```

<!-- parlel:testenv:end -->
