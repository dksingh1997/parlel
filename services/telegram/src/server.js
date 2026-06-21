import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/telegram — a tiny, dependency-free fake of the Telegram Bot API.
//
// It speaks the exact wire protocol used by the official `node-telegram-bot-api`
// client (which talks to https://api.telegram.org/bot<TOKEN>/<METHOD>) so that
// application code and AI agents can run against it with zero cost and zero
// side effects. State is in-memory and ephemeral; bot identity, chats,
// messages, updates, webhooks, callback queries, etc. are captured for
// inspection and assertions, and the whole world is resettable.
//
// Wire protocol (mirrors https://api.telegram.org):
//   - Method routes under /bot<TOKEN>/<methodName> (case-insensitive method).
//   - File downloads under /file/bot<TOKEN>/<file_path>.
//   - Params accepted via URL query string, application/json, or
//     application/x-www-form-urlencoded (all three are sent by the real client
//     depending on the call); multipart/form-data is parsed best-effort for
//     file uploads.
//   - Both GET and POST are accepted (the client uses POST).
//   - Success: HTTP 200 { ok: true, result: <value> }.
//   - Failure: HTTP 4xx { ok: false, error_code: <int>, description: <string> }
//     (optionally with a `parameters` object, e.g. retry_after / migrate_to).
//
// Implemented methods (every commonly-used node-telegram-bot-api call):
//   getMe, logOut, close, getUpdates, setWebhook, deleteWebhook, getWebhookInfo,
//   sendMessage, forwardMessage, copyMessage, sendPhoto, sendAudio, sendDocument,
//   sendVideo, sendAnimation, sendVoice, sendVideoNote, sendMediaGroup,
//   sendLocation, editMessageLiveLocation, stopMessageLiveLocation, sendVenue,
//   sendContact, sendPoll, stopPoll, sendDice, sendChatAction,
//   getUserProfilePhotos, getFile, banChatMember/kickChatMember,
//   unbanChatMember, restrictChatMember, promoteChatMember,
//   setChatAdministratorCustomTitle, setChatPermissions, exportChatInviteLink,
//   createChatInviteLink, editChatInviteLink, revokeChatInviteLink,
//   approveChatJoinRequest, declineChatJoinRequest, setChatPhoto,
//   deleteChatPhoto, setChatTitle, setChatDescription, pinChatMessage,
//   unpinChatMessage, unpinAllChatMessages, leaveChat, getChat,
//   getChatAdministrators, getChatMemberCount/getChatMembersCount,
//   getChatMember, setChatStickerSet, deleteChatStickerSet, answerCallbackQuery,
//   setMyCommands, deleteMyCommands, getMyCommands, setMyDescription,
//   getMyDescription, setMyShortDescription, getMyShortDescription, setMyName,
//   getMyName, editMessageText, editMessageCaption, editMessageReplyMarkup,
//   editMessageMedia, deleteMessage, sendSticker, getStickerSet,
//   answerInlineQuery, sendInvoice, answerShippingQuery,
//   answerPreCheckoutQuery, setChatMenuButton, getChatMenuButton,
//   setMyDefaultAdministratorRights, getMyDefaultAdministratorRights.
//
// Plus parlel control/inspection endpoints under /__parlel and helpers that
// let tests inject incoming updates (messages from users, callback queries).
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

// Telegram returns plain-int error_code + human description.
function tgError(error_code, description, parameters) {
  const body = { ok: false, error_code, description };
  if (parameters) body.parameters = parameters;
  // Map error_code to an HTTP status (Telegram uses the same number).
  const status = error_code >= 400 && error_code < 600 ? error_code : 400;
  return { status, body };
}

function tgOk(result) {
  return { status: 200, body: { ok: true, result } };
}

export class TelegramServer {
  constructor(port = 4656, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this._idCounter = 1000;
    this._fileCounter = 1;
    this._updateCounter = 1;
    this._pollCounter = 1;

    // Valid bot tokens. The real token format is <bot_id>:<35-char-secret>.
    this.token = "123456789:parlel-test-bot-token";
    this.tokens = new Set([this.token]);

    // Bot identity (returned by getMe).
    this.me = {
      id: 123456789,
      is_bot: true,
      first_name: "Parlel Bot",
      username: "parlelbot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };

    // chats keyed by chat id (number or @username string mapped to id).
    this.chats = new Map();
    // messages keyed by chatId -> Map(messageId -> message)
    this.messages = new Map();
    // chat members keyed by chatId -> Map(userId -> member)
    this.members = new Map();
    // pending incoming updates (getUpdates long-poll queue)
    this.updates = [];
    // delivered offset bookkeeping
    this._lastConfirmedUpdateId = 0;
    // outgoing message log (everything the bot sent), for inspection
    this.sent = [];
    // webhook info
    this.webhook = {
      url: "",
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 40,
      ip_address: undefined,
      allowed_updates: undefined,
    };
    // files keyed by file_id -> file record
    this.files = new Map();
    // invite links keyed by chatId -> [links]
    this.inviteLinks = new Map();
    // active polls keyed by pollId
    this.polls = new Map();
    // bot commands keyed by scope-key -> [commands]
    this.commands = new Map();
    // bot profile texts keyed by lang code
    this.myDescription = new Map();
    this.myShortDescription = new Map();
    this.myName = new Map();
    this.menuButton = new Map();
    this.defaultAdminRights = { for_channels: null, for_groups: null };
    // sticker sets keyed by name
    this.stickerSets = new Map();
    // callback queries answered
    this.answeredCallbacks = [];

    this._seedDefaults();
  }

  _seedDefaults() {
    // A private chat with a human user.
    const user = {
      id: 555000111,
      is_bot: false,
      first_name: "Alice",
      last_name: "Example",
      username: "alice",
      language_code: "en",
    };
    this.testUser = user;
    const privateChat = {
      id: 555000111,
      type: "private",
      first_name: "Alice",
      last_name: "Example",
      username: "alice",
    };
    this.chats.set(privateChat.id, privateChat);
    this.messages.set(privateChat.id, new Map());

    // A group chat.
    const group = {
      id: -1001000000001,
      type: "supergroup",
      title: "Parlel Group",
      username: "parlelgroup",
    };
    this.chats.set(group.id, group);
    this.messages.set(group.id, new Map());
    const gm = new Map();
    gm.set(this.me.id, {
      user: { ...this.me },
      status: "administrator",
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: true,
      can_promote_members: true,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: true,
    });
    gm.set(user.id, { user: { ...user }, status: "member" });
    this.members.set(group.id, gm);

    // Register seeded usernames -> ids.
    this.chats.set("@alice", privateChat);
    this.chats.set("@parlelgroup", group);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { ok: false, error_code: 500, description: error.message });
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // HTTP entry
  // -------------------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const parsed = await this.readBody(req);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-telegram");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Infra endpoints (no auth).
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, parsed);

    // File download route: /file/bot<TOKEN>/<file_path...>
    if (parts[0] === "file" && parts[1] && parts[1].startsWith("bot")) {
      return this.handleFileDownload(res, parts);
    }

    // Method route: /bot<TOKEN>/<method>
    if (!parts[0] || !parts[0].startsWith("bot")) {
      return this.send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    }

    const token = parts[0].slice(3); // strip "bot"
    const methodName = parts[1];

    if (this.requireAuth && !this.tokens.has(token)) {
      return this.send(res, 401, {
        ok: false,
        error_code: 401,
        description: "Unauthorized",
      });
    }
    if (!methodName) {
      return this.send(res, 404, { ok: false, error_code: 404, description: "Not Found: method name not specified" });
    }

    // Merge query params + body into a single params object.
    const params = this._mergeParams(url, parsed);

    try {
      const result = this.dispatch(methodName, params);
      if (!result) {
        return this.send(res, 404, {
          ok: false,
          error_code: 404,
          description: `Not Found: method "${methodName}" not found`,
        });
      }
      return this.send(res, result.status, result.body);
    } catch (error) {
      return this.send(res, 500, { ok: false, error_code: 500, description: error.message });
    }
  }

  _mergeParams(url, parsed) {
    const params = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    if (isPlainObject(parsed.body)) Object.assign(params, parsed.body);
    return params;
  }

  // -------------------------------------------------------------------------
  // Method dispatch (case-insensitive)
  // -------------------------------------------------------------------------
  dispatch(methodName, p) {
    const m = String(methodName);
    const fn = this._methods[m] || this._methods[m.toLowerCase()];
    if (!fn) return null;
    return fn.call(this, p);
  }

  // Lazily build the method table once (bound through `this`).
  get _methods() {
    if (this.__methods) return this.__methods;
    const t = {
      getMe: this.getMe,
      logOut: this.logOut,
      logout: this.logOut,
      close: this.close,
      getUpdates: this.getUpdates,
      setWebhook: this.setWebhook,
      deleteWebhook: this.deleteWebhook,
      getWebhookInfo: this.getWebhookInfo,
      sendMessage: this.sendMessage,
      forwardMessage: this.forwardMessage,
      copyMessage: this.copyMessage,
      sendPhoto: this.sendPhoto,
      sendAudio: this.sendAudio,
      sendDocument: this.sendDocument,
      sendVideo: this.sendVideo,
      sendAnimation: this.sendAnimation,
      sendVoice: this.sendVoice,
      sendVideoNote: this.sendVideoNote,
      sendMediaGroup: this.sendMediaGroup,
      sendLocation: this.sendLocation,
      editMessageLiveLocation: this.editMessageLiveLocation,
      stopMessageLiveLocation: this.stopMessageLiveLocation,
      sendVenue: this.sendVenue,
      sendContact: this.sendContact,
      sendPoll: this.sendPoll,
      stopPoll: this.stopPoll,
      sendDice: this.sendDice,
      sendChatAction: this.sendChatAction,
      getUserProfilePhotos: this.getUserProfilePhotos,
      getFile: this.getFile,
      banChatMember: this.banChatMember,
      kickChatMember: this.banChatMember,
      unbanChatMember: this.unbanChatMember,
      banChatSenderChat: this.banChatSenderChat,
      unbanChatSenderChat: this.unbanChatSenderChat,
      restrictChatMember: this.restrictChatMember,
      promoteChatMember: this.promoteChatMember,
      setChatAdministratorCustomTitle: this.setChatAdministratorCustomTitle,
      setChatPermissions: this.setChatPermissions,
      exportChatInviteLink: this.exportChatInviteLink,
      createChatInviteLink: this.createChatInviteLink,
      editChatInviteLink: this.editChatInviteLink,
      revokeChatInviteLink: this.revokeChatInviteLink,
      approveChatJoinRequest: this.approveChatJoinRequest,
      declineChatJoinRequest: this.declineChatJoinRequest,
      setChatPhoto: this.setChatPhoto,
      deleteChatPhoto: this.deleteChatPhoto,
      setChatTitle: this.setChatTitle,
      setChatDescription: this.setChatDescription,
      pinChatMessage: this.pinChatMessage,
      unpinChatMessage: this.unpinChatMessage,
      unpinAllChatMessages: this.unpinAllChatMessages,
      leaveChat: this.leaveChat,
      getChat: this.getChat,
      getChatAdministrators: this.getChatAdministrators,
      getChatMemberCount: this.getChatMemberCount,
      getChatMembersCount: this.getChatMemberCount,
      getChatMember: this.getChatMember,
      setChatStickerSet: this.setChatStickerSet,
      deleteChatStickerSet: this.deleteChatStickerSet,
      answerCallbackQuery: this.answerCallbackQuery,
      setMyCommands: this.setMyCommands,
      deleteMyCommands: this.deleteMyCommands,
      getMyCommands: this.getMyCommands,
      setMyDescription: this.setMyDescription,
      getMyDescription: this.getMyDescription,
      setMyShortDescription: this.setMyShortDescription,
      getMyShortDescription: this.getMyShortDescription,
      setMyName: this.setMyName,
      getMyName: this.getMyName,
      editMessageText: this.editMessageText,
      editMessageCaption: this.editMessageCaption,
      editMessageReplyMarkup: this.editMessageReplyMarkup,
      editMessageMedia: this.editMessageMedia,
      deleteMessage: this.deleteMessage,
      sendSticker: this.sendSticker,
      getStickerSet: this.getStickerSet,
      uploadStickerFile: this.uploadStickerFile,
      createNewStickerSet: this.createNewStickerSet,
      addStickerToSet: this.addStickerToSet,
      setStickerPositionInSet: this.setStickerPositionInSet,
      deleteStickerFromSet: this.deleteStickerFromSet,
      setMessageReaction: this.setMessageReaction,
      sendGame: this.sendGame,
      setGameScore: this.setGameScore,
      getGameHighScores: this.getGameHighScores,
      answerInlineQuery: this.answerInlineQuery,
      sendInvoice: this.sendInvoice,
      answerShippingQuery: this.answerShippingQuery,
      answerPreCheckoutQuery: this.answerPreCheckoutQuery,
      setChatMenuButton: this.setChatMenuButton,
      getChatMenuButton: this.getChatMenuButton,
      setMyDefaultAdministratorRights: this.setMyDefaultAdministratorRights,
      getMyDefaultAdministratorRights: this.getMyDefaultAdministratorRights,
    };
    // Add lowercased aliases for every key for case-insensitive dispatch.
    const lower = {};
    for (const k of Object.keys(t)) lower[k.toLowerCase()] = t[k];
    this.__methods = { ...t, ...lower };
    return this.__methods;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------
  _nextId() {
    return ++this._idCounter;
  }

  _resolveChat(chatIdRaw) {
    if (chatIdRaw === undefined || chatIdRaw === null || chatIdRaw === "") return undefined;
    // numeric id (may arrive as a string from query params)
    if (typeof chatIdRaw === "number") return this.chats.get(chatIdRaw);
    const asNum = Number(chatIdRaw);
    if (!Number.isNaN(asNum) && String(asNum) === String(chatIdRaw)) {
      return this.chats.get(asNum);
    }
    // @username
    const key = String(chatIdRaw).startsWith("@") ? String(chatIdRaw) : `@${chatIdRaw}`;
    return this.chats.get(key) || this.chats.get(String(chatIdRaw));
  }

  _requireChat(p) {
    if (p.chat_id === undefined || p.chat_id === null || p.chat_id === "") {
      return { error: tgError(400, "Bad Request: chat_id is empty") };
    }
    const chat = this._resolveChat(p.chat_id);
    if (!chat) {
      return { error: tgError(400, "Bad Request: chat not found") };
    }
    return { chat };
  }

  _parseMaybeJson(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }
    }
    return value;
  }

  _entities(text, parseMode) {
    // Minimal entity synthesis: detect bot_commands and urls; honor parse_mode loosely.
    const entities = [];
    if (typeof text !== "string") return entities;
    const cmd = text.match(/^\/(\w+)/);
    if (cmd) entities.push({ type: "bot_command", offset: 0, length: cmd[0].length });
    return entities;
  }

  _baseMessage(chat, p, extra = {}) {
    const messageId = this._nextId();
    const msg = {
      message_id: messageId,
      from: { ...this.me },
      chat: clone(chat),
      date: Math.floor(Date.now() / 1000),
      ...extra,
    };
    if (p.reply_to_message_id !== undefined) {
      const store = this.messages.get(chat.id);
      const replied = store && store.get(Number(p.reply_to_message_id));
      if (replied) msg.reply_to_message = clone(replied);
    }
    const markup = this._parseMaybeJson(p.reply_markup);
    if (markup && isPlainObject(markup)) msg.reply_markup = markup;
    this._storeMessage(chat, msg);
    return msg;
  }

  _storeMessage(chat, msg) {
    if (!this.messages.has(chat.id)) this.messages.set(chat.id, new Map());
    this.messages.get(chat.id).set(msg.message_id, msg);
    this.sent.push(clone(msg));
  }

  _makeFile(kind, suffix) {
    const fileUniqueId = randomBytes(8).toString("hex");
    const fileId = `parlel-${kind}-${this._fileCounter++}-${fileUniqueId}`;
    const filePath = `${kind}/file_${this._fileCounter}.${suffix}`;
    const record = {
      file_id: fileId,
      file_unique_id: fileUniqueId,
      file_size: 1024,
      file_path: filePath,
    };
    this.files.set(fileId, record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Bot / connection
  // -------------------------------------------------------------------------
  getMe() {
    return tgOk(clone(this.me));
  }

  logOut() {
    return tgOk(true);
  }

  close() {
    return tgOk(true);
  }

  getUpdates(p) {
    const offset = p.offset !== undefined ? Number(p.offset) : undefined;
    const limit = p.limit !== undefined ? Number(p.limit) : 100;
    if (offset !== undefined) {
      // Confirm (discard) updates with id < offset.
      this.updates = this.updates.filter((u) => u.update_id >= offset);
      this._lastConfirmedUpdateId = offset - 1;
    }
    const out = this.updates.slice(0, limit).map(clone);
    return tgOk(out);
  }

  setWebhook(p) {
    if (!p.url && p.url !== "") {
      return tgError(400, "Bad Request: URL host is empty");
    }
    this.webhook = {
      url: String(p.url),
      has_custom_certificate: Boolean(p.certificate),
      pending_update_count: 0,
      max_connections: p.max_connections !== undefined ? Number(p.max_connections) : 40,
      ip_address: p.ip_address,
      allowed_updates: this._parseMaybeJson(p.allowed_updates),
    };
    return tgOk(true);
  }

  deleteWebhook(p) {
    const drop = p && (p.drop_pending_updates === true || p.drop_pending_updates === "true");
    if (drop) this.updates = [];
    this.webhook = {
      url: "",
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 40,
    };
    return tgOk(true);
  }

  getWebhookInfo() {
    const info = { ...this.webhook, pending_update_count: this.updates.length };
    for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
    return tgOk(info);
  }

  // -------------------------------------------------------------------------
  // Sending messages
  // -------------------------------------------------------------------------
  sendMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.text === undefined || p.text === null || String(p.text).length === 0) {
      return tgError(400, "Bad Request: message text is empty");
    }
    const text = String(p.text);
    const msg = this._baseMessage(chat, p, {
      text,
      entities: this._entities(text, p.parse_mode),
    });
    if (!msg.entities || msg.entities.length === 0) delete msg.entities;
    return tgOk(clone(msg));
  }

  forwardMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const fromChat = this._resolveChat(p.from_chat_id);
    if (!fromChat) return tgError(400, "Bad Request: chat not found");
    const fromStore = this.messages.get(fromChat.id);
    const original = fromStore && fromStore.get(Number(p.message_id));
    if (!original) return tgError(400, "Bad Request: message to forward not found");
    const fwd = this._baseMessage(chat, p, {
      forward_from_chat: clone(fromChat),
      forward_from_message_id: original.message_id,
      forward_date: Math.floor(Date.now() / 1000),
    });
    if (original.text !== undefined) fwd.text = original.text;
    if (original.caption !== undefined) fwd.caption = original.caption;
    return tgOk(clone(fwd));
  }

  copyMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const fromChat = this._resolveChat(p.from_chat_id);
    if (!fromChat) return tgError(400, "Bad Request: chat not found");
    const fromStore = this.messages.get(fromChat.id);
    const original = fromStore && fromStore.get(Number(p.message_id));
    if (!original) return tgError(400, "Bad Request: message to copy not found");
    const copyExtra = {};
    if (p.caption !== undefined) copyExtra.text = String(p.caption);
    else if (original.text !== undefined) copyExtra.text = original.text;
    const msg = this._baseMessage(chat, p, copyExtra);
    // copyMessage returns a MessageId, not a full Message.
    return tgOk({ message_id: msg.message_id });
  }

  _sendMedia(p, field, kind, suffix) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const file = this._makeFile(kind, suffix);
    const extra = {};
    const value = p[field];
    if (field === "photo") {
      extra.photo = [
        {
          file_id: file.file_id,
          file_unique_id: file.file_unique_id,
          width: 90,
          height: 90,
          file_size: 1024,
        },
        {
          file_id: file.file_id + "-lg",
          file_unique_id: file.file_unique_id + "lg",
          width: 320,
          height: 320,
          file_size: 4096,
        },
      ];
    } else {
      const media = {
        file_id: file.file_id,
        file_unique_id: file.file_unique_id,
        file_size: 1024,
      };
      if (kind === "document") media.file_name = (typeof value === "string" ? value.split("/").pop() : undefined) || "file.bin";
      if (kind === "audio") {
        media.duration = p.duration !== undefined ? Number(p.duration) : 1;
        if (p.performer) media.performer = String(p.performer);
        if (p.title) media.title = String(p.title);
      }
      if (kind === "video" || kind === "animation" || kind === "video_note") {
        media.duration = p.duration !== undefined ? Number(p.duration) : 1;
        media.width = 320;
        media.height = 320;
      }
      if (kind === "voice") media.duration = p.duration !== undefined ? Number(p.duration) : 1;
      extra[field] = media;
    }
    if (p.caption !== undefined) extra.caption = String(p.caption);
    const msg = this._baseMessage(chat, p, extra);
    return tgOk(clone(msg));
  }

  sendPhoto(p) {
    return this._sendMedia(p, "photo", "photo", "jpg");
  }
  sendAudio(p) {
    return this._sendMedia(p, "audio", "audio", "mp3");
  }
  sendDocument(p) {
    return this._sendMedia(p, "document", "document", "bin");
  }
  sendVideo(p) {
    return this._sendMedia(p, "video", "video", "mp4");
  }
  sendAnimation(p) {
    return this._sendMedia(p, "animation", "animation", "gif");
  }
  sendVoice(p) {
    return this._sendMedia(p, "voice", "voice", "ogg");
  }
  sendVideoNote(p) {
    return this._sendMedia(p, "video_note", "video_note", "mp4");
  }

  sendMediaGroup(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const media = this._parseMaybeJson(p.media);
    if (!Array.isArray(media) || media.length === 0) {
      return tgError(400, "Bad Request: media must be a non-empty array");
    }
    const out = [];
    for (const item of media) {
      const type = item.type || "photo";
      const file = this._makeFile(type, "bin");
      const extra = {};
      if (type === "photo") {
        extra.photo = [{ file_id: file.file_id, file_unique_id: file.file_unique_id, width: 90, height: 90, file_size: 1024 }];
      } else {
        extra[type] = { file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: 1024 };
      }
      if (item.caption !== undefined) extra.caption = String(item.caption);
      const msg = this._baseMessage(chat, p, extra);
      out.push(clone(msg));
    }
    return tgOk(out);
  }

  sendLocation(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.latitude === undefined || p.longitude === undefined) {
      return tgError(400, "Bad Request: latitude and longitude are required");
    }
    const location = {
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
    };
    if (p.live_period !== undefined) location.live_period = Number(p.live_period);
    if (p.horizontal_accuracy !== undefined) location.horizontal_accuracy = Number(p.horizontal_accuracy);
    const msg = this._baseMessage(chat, p, { location });
    return tgOk(clone(msg));
  }

  editMessageLiveLocation(p) {
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    msg.location = {
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
    };
    msg.edit_date = Math.floor(Date.now() / 1000);
    return tgOk(clone(msg));
  }

  stopMessageLiveLocation(p) {
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    msg.edit_date = Math.floor(Date.now() / 1000);
    return tgOk(clone(msg));
  }

  sendVenue(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.latitude === undefined || p.longitude === undefined || !p.title || !p.address) {
      return tgError(400, "Bad Request: latitude, longitude, title and address are required");
    }
    const venue = {
      location: { latitude: Number(p.latitude), longitude: Number(p.longitude) },
      title: String(p.title),
      address: String(p.address),
    };
    const msg = this._baseMessage(chat, p, { venue });
    return tgOk(clone(msg));
  }

  sendContact(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (!p.phone_number || !p.first_name) {
      return tgError(400, "Bad Request: phone_number and first_name are required");
    }
    const contact = {
      phone_number: String(p.phone_number),
      first_name: String(p.first_name),
    };
    if (p.last_name) contact.last_name = String(p.last_name);
    if (p.vcard) contact.vcard = String(p.vcard);
    const msg = this._baseMessage(chat, p, { contact });
    return tgOk(clone(msg));
  }

  sendPoll(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const options = this._parseMaybeJson(p.options);
    if (!p.question || !Array.isArray(options) || options.length < 2) {
      return tgError(400, "Bad Request: question and at least 2 options are required");
    }
    const pollId = String(this._pollCounter++);
    const poll = {
      id: pollId,
      question: String(p.question),
      options: options.map((o) => ({ text: typeof o === "string" ? o : o.text, voter_count: 0 })),
      total_voter_count: 0,
      is_closed: false,
      is_anonymous: p.is_anonymous === undefined ? true : Boolean(p.is_anonymous),
      type: p.type || "regular",
      allows_multiple_answers: Boolean(p.allows_multiple_answers),
    };
    this.polls.set(pollId, poll);
    const msg = this._baseMessage(chat, p, { poll: clone(poll) });
    return tgOk(clone(msg));
  }

  stopPoll(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this.messages.get(chat.id);
    const msg = store && store.get(Number(p.message_id));
    if (!msg || !msg.poll) return tgError(400, "Bad Request: message with poll to stop not found");
    msg.poll.is_closed = true;
    const poll = this.polls.get(msg.poll.id);
    if (poll) poll.is_closed = true;
    return tgOk(clone(msg.poll));
  }

  sendDice(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const emoji = p.emoji || "🎲";
    const dice = { emoji, value: 4 };
    const msg = this._baseMessage(chat, p, { dice });
    return tgOk(clone(msg));
  }

  sendChatAction(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    if (!p.action) return tgError(400, "Bad Request: action is required");
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Files / photos
  // -------------------------------------------------------------------------
  getUserProfilePhotos(p) {
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const file = this._makeFile("photo", "jpg");
    return tgOk({
      total_count: 1,
      photos: [
        [
          { file_id: file.file_id, file_unique_id: file.file_unique_id, width: 160, height: 160, file_size: 4096 },
        ],
      ],
    });
  }

  getFile(p) {
    if (!p.file_id) return tgError(400, "Bad Request: file_id is required");
    let record = this.files.get(p.file_id);
    if (!record) {
      // Unknown file ids still resolve in the real API if well-formed; synthesize.
      record = {
        file_id: String(p.file_id),
        file_unique_id: randomBytes(8).toString("hex"),
        file_size: 1024,
        file_path: `documents/${String(p.file_id).slice(0, 12)}.bin`,
      };
      this.files.set(record.file_id, record);
    }
    return tgOk(clone(record));
  }

  handleFileDownload(res, parts) {
    // /file/bot<TOKEN>/<file_path...>
    const filePath = parts.slice(2).join("/");
    res.setHeader("Content-Type", "application/octet-stream");
    res.statusCode = 200;
    res.end(Buffer.from(`parlel-file:${filePath}`));
  }

  // -------------------------------------------------------------------------
  // Chat member management
  // -------------------------------------------------------------------------
  _memberStore(chat) {
    if (!this.members.has(chat.id)) this.members.set(chat.id, new Map());
    return this.members.get(chat.id);
  }

  banChatMember(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    const existing = store.get(uid) || { user: { id: uid, is_bot: false, first_name: "User" } };
    store.set(uid, { ...existing, status: "kicked" });
    return tgOk(true);
  }

  unbanChatMember(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    store.delete(uid);
    return tgOk(true);
  }

  restrictChatMember(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    const existing = store.get(uid) || { user: { id: uid, is_bot: false, first_name: "User" } };
    store.set(uid, { ...existing, status: "restricted", permissions: this._parseMaybeJson(p.permissions) || {} });
    return tgOk(true);
  }

  promoteChatMember(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    const existing = store.get(uid) || { user: { id: uid, is_bot: false, first_name: "User" } };
    store.set(uid, {
      ...existing,
      status: "administrator",
      can_manage_chat: Boolean(p.can_manage_chat),
      can_delete_messages: Boolean(p.can_delete_messages),
      can_restrict_members: Boolean(p.can_restrict_members),
      can_promote_members: Boolean(p.can_promote_members),
      can_change_info: Boolean(p.can_change_info),
      can_invite_users: Boolean(p.can_invite_users),
      can_pin_messages: Boolean(p.can_pin_messages),
    });
    return tgOk(true);
  }

  setChatAdministratorCustomTitle(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    const m = store.get(uid);
    if (!m || m.status !== "administrator") return tgError(400, "Bad Request: user is not an administrator");
    m.custom_title = String(p.custom_title || "");
    return tgOk(true);
  }

  setChatPermissions(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    chat.permissions = this._parseMaybeJson(p.permissions) || {};
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Invite links
  // -------------------------------------------------------------------------
  _newInviteLink(chat, p = {}) {
    const code = randomBytes(8).toString("base64url");
    const link = {
      invite_link: `https://t.me/+${code}`,
      creator: { ...this.me },
      creates_join_request: Boolean(p.creates_join_request),
      is_primary: false,
      is_revoked: false,
    };
    if (p.name) link.name = String(p.name);
    if (p.expire_date !== undefined) link.expire_date = Number(p.expire_date);
    if (p.member_limit !== undefined) link.member_limit = Number(p.member_limit);
    if (!this.inviteLinks.has(chat.id)) this.inviteLinks.set(chat.id, []);
    this.inviteLinks.get(chat.id).push(link);
    return link;
  }

  exportChatInviteLink(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const link = this._newInviteLink(chat, {});
    link.is_primary = true;
    return tgOk(link.invite_link);
  }

  createChatInviteLink(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const link = this._newInviteLink(chat, p);
    return tgOk(clone(link));
  }

  editChatInviteLink(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const links = this.inviteLinks.get(chat.id) || [];
    const link = links.find((l) => l.invite_link === p.invite_link);
    if (!link) return tgError(400, "Bad Request: invite link not found");
    if (p.name !== undefined) link.name = String(p.name);
    if (p.expire_date !== undefined) link.expire_date = Number(p.expire_date);
    if (p.member_limit !== undefined) link.member_limit = Number(p.member_limit);
    if (p.creates_join_request !== undefined) link.creates_join_request = Boolean(p.creates_join_request);
    return tgOk(clone(link));
  }

  revokeChatInviteLink(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const links = this.inviteLinks.get(chat.id) || [];
    const link = links.find((l) => l.invite_link === p.invite_link);
    if (!link) return tgError(400, "Bad Request: invite link not found");
    link.is_revoked = true;
    return tgOk(clone(link));
  }

  approveChatJoinRequest(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    return tgOk(true);
  }

  declineChatJoinRequest(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Chat metadata
  // -------------------------------------------------------------------------
  setChatPhoto(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    return tgOk(true);
  }
  deleteChatPhoto(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    delete chat.photo;
    return tgOk(true);
  }
  setChatTitle(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (!p.title) return tgError(400, "Bad Request: title is required");
    chat.title = String(p.title);
    return tgOk(true);
  }
  setChatDescription(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    chat.description = p.description !== undefined ? String(p.description) : "";
    return tgOk(true);
  }

  pinChatMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this.messages.get(chat.id);
    const msg = store && store.get(Number(p.message_id));
    if (!msg) return tgError(400, "Bad Request: message to pin not found");
    chat.pinned_message = clone(msg);
    return tgOk(true);
  }
  unpinChatMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    delete chat.pinned_message;
    return tgOk(true);
  }
  unpinAllChatMessages(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    delete chat.pinned_message;
    return tgOk(true);
  }

  leaveChat(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this._memberStore(chat);
    store.delete(this.me.id);
    return tgOk(true);
  }

  getChat(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    return tgOk(clone(chat));
  }

  getChatAdministrators(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this._memberStore(chat);
    const admins = Array.from(store.values()).filter(
      (m) => m.status === "administrator" || m.status === "creator",
    );
    return tgOk(admins.map(clone));
  }

  getChatMemberCount(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this._memberStore(chat);
    const count = Array.from(store.values()).filter((m) => m.status !== "kicked" && m.status !== "left").length;
    return tgOk(count);
  }

  getChatMember(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const store = this._memberStore(chat);
    const uid = Number(p.user_id);
    const m = store.get(uid);
    if (!m) {
      return tgOk({ user: { id: uid, is_bot: false, first_name: "User" }, status: "left" });
    }
    return tgOk(clone(m));
  }

  setChatStickerSet(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    chat.sticker_set_name = String(p.sticker_set_name || "");
    return tgOk(true);
  }
  deleteChatStickerSet(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    delete chat.sticker_set_name;
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Callback / inline queries
  // -------------------------------------------------------------------------
  answerCallbackQuery(p) {
    if (!p.callback_query_id) return tgError(400, "Bad Request: callback_query_id is required");
    this.answeredCallbacks.push({
      callback_query_id: String(p.callback_query_id),
      text: p.text,
      show_alert: Boolean(p.show_alert),
      url: p.url,
    });
    return tgOk(true);
  }

  answerInlineQuery(p) {
    if (!p.inline_query_id) return tgError(400, "Bad Request: inline_query_id is required");
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Bot commands & profile
  // -------------------------------------------------------------------------
  _scopeKey(p) {
    const scope = this._parseMaybeJson(p.scope);
    const lang = p.language_code || "";
    if (!scope || !scope.type || scope.type === "default") return `default:${lang}`;
    return `${scope.type}:${scope.chat_id || ""}:${lang}`;
  }

  setMyCommands(p) {
    const commands = this._parseMaybeJson(p.commands);
    if (!Array.isArray(commands)) return tgError(400, "Bad Request: commands must be an array");
    this.commands.set(this._scopeKey(p), commands.map((c) => ({ command: c.command, description: c.description })));
    return tgOk(true);
  }

  deleteMyCommands(p) {
    this.commands.delete(this._scopeKey(p));
    return tgOk(true);
  }

  getMyCommands(p) {
    const list = this.commands.get(this._scopeKey(p)) || [];
    return tgOk(clone(list));
  }

  setMyDescription(p) {
    this.myDescription.set(p.language_code || "", p.description !== undefined ? String(p.description) : "");
    return tgOk(true);
  }
  getMyDescription(p) {
    return tgOk({ description: this.myDescription.get(p.language_code || "") || "" });
  }
  setMyShortDescription(p) {
    this.myShortDescription.set(p.language_code || "", p.short_description !== undefined ? String(p.short_description) : "");
    return tgOk(true);
  }
  getMyShortDescription(p) {
    return tgOk({ short_description: this.myShortDescription.get(p.language_code || "") || "" });
  }
  setMyName(p) {
    this.myName.set(p.language_code || "", p.name !== undefined ? String(p.name) : "");
    if (!p.language_code && p.name) this.me.first_name = String(p.name);
    return tgOk(true);
  }
  getMyName(p) {
    return tgOk({ name: this.myName.get(p.language_code || "") || this.me.first_name });
  }

  setChatMenuButton(p) {
    const key = p.chat_id !== undefined ? String(p.chat_id) : "default";
    this.menuButton.set(key, this._parseMaybeJson(p.menu_button) || { type: "default" });
    return tgOk(true);
  }
  getChatMenuButton(p) {
    const key = p.chat_id !== undefined ? String(p.chat_id) : "default";
    return tgOk(this.menuButton.get(key) || { type: "commands" });
  }

  setMyDefaultAdministratorRights(p) {
    const rights = this._parseMaybeJson(p.rights) || null;
    if (p.for_channels === true || p.for_channels === "true") this.defaultAdminRights.for_channels = rights;
    else this.defaultAdminRights.for_groups = rights;
    return tgOk(true);
  }
  getMyDefaultAdministratorRights(p) {
    const forChannels = p.for_channels === true || p.for_channels === "true";
    return tgOk(
      (forChannels ? this.defaultAdminRights.for_channels : this.defaultAdminRights.for_groups) || {
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: true,
        can_post_messages: false,
        can_edit_messages: false,
        can_pin_messages: false,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Editing & deleting messages
  // -------------------------------------------------------------------------
  _locateEditable(p) {
    if (p.inline_message_id !== undefined) {
      return { inline: true };
    }
    const chat = this._resolveChat(p.chat_id);
    if (!chat) return { error: tgError(400, "Bad Request: chat not found") };
    const store = this.messages.get(chat.id);
    const msg = store && store.get(Number(p.message_id));
    if (!msg) return { error: tgError(400, "Bad Request: message to edit not found") };
    return { msg, chat };
  }

  editMessageText(p) {
    if (p.text === undefined || String(p.text).length === 0) {
      return tgError(400, "Bad Request: message text is empty");
    }
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    msg.text = String(p.text);
    msg.entities = this._entities(msg.text, p.parse_mode);
    if (!msg.entities.length) delete msg.entities;
    msg.edit_date = Math.floor(Date.now() / 1000);
    const markup = this._parseMaybeJson(p.reply_markup);
    if (markup) msg.reply_markup = markup;
    return tgOk(clone(msg));
  }

  editMessageCaption(p) {
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    msg.caption = p.caption !== undefined ? String(p.caption) : "";
    msg.edit_date = Math.floor(Date.now() / 1000);
    return tgOk(clone(msg));
  }

  editMessageReplyMarkup(p) {
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    const markup = this._parseMaybeJson(p.reply_markup);
    if (markup) msg.reply_markup = markup;
    else delete msg.reply_markup;
    msg.edit_date = Math.floor(Date.now() / 1000);
    return tgOk(clone(msg));
  }

  editMessageMedia(p) {
    const located = this._locateEditable(p);
    if (located.error) return located.error;
    if (located.inline) return tgOk(true);
    const msg = located.msg;
    const media = this._parseMaybeJson(p.media) || {};
    const type = media.type || "photo";
    const file = this._makeFile(type, "bin");
    delete msg.text;
    if (type === "photo") {
      msg.photo = [{ file_id: file.file_id, file_unique_id: file.file_unique_id, width: 90, height: 90, file_size: 1024 }];
    } else {
      msg[type] = { file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: 1024 };
    }
    if (media.caption !== undefined) msg.caption = String(media.caption);
    msg.edit_date = Math.floor(Date.now() / 1000);
    return tgOk(clone(msg));
  }

  deleteMessage(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this.messages.get(chat.id);
    if (!store || !store.has(Number(p.message_id))) {
      return tgError(400, "Bad Request: message to delete not found");
    }
    store.delete(Number(p.message_id));
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Stickers
  // -------------------------------------------------------------------------
  sendSticker(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const file = this._makeFile("sticker", "webp");
    const sticker = {
      file_id: file.file_id,
      file_unique_id: file.file_unique_id,
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
      file_size: 4096,
    };
    const msg = this._baseMessage(chat, p, { sticker });
    return tgOk(clone(msg));
  }

  getStickerSet(p) {
    if (!p.name) return tgError(400, "Bad Request: sticker set name is required");
    const name = String(p.name);
    let set = this.stickerSets.get(name);
    if (!set) {
      const file = this._makeFile("sticker", "webp");
      set = {
        name,
        title: `${name} pack`,
        sticker_type: "regular",
        is_animated: false,
        is_video: false,
        stickers: [
          {
            file_id: file.file_id,
            file_unique_id: file.file_unique_id,
            type: "regular",
            width: 512,
            height: 512,
            is_animated: false,
            is_video: false,
            emoji: "😀",
            set_name: name,
            file_size: 4096,
          },
        ],
      };
      this.stickerSets.set(name, set);
    }
    return tgOk(clone(set));
  }

  uploadStickerFile(p) {
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    const file = this._makeFile("sticker", "webp");
    return tgOk({ file_id: file.file_id, file_unique_id: file.file_unique_id, file_size: 4096 });
  }

  createNewStickerSet(p) {
    if (!p.name || !p.title) return tgError(400, "Bad Request: name and title are required");
    const name = String(p.name);
    const stickers = this._parseMaybeJson(p.stickers);
    const set = {
      name,
      title: String(p.title),
      sticker_type: p.sticker_type || "regular",
      is_animated: false,
      is_video: false,
      stickers: Array.isArray(stickers)
        ? stickers.map(() => {
            const f = this._makeFile("sticker", "webp");
            return {
              file_id: f.file_id,
              file_unique_id: f.file_unique_id,
              type: "regular",
              width: 512,
              height: 512,
              is_animated: false,
              is_video: false,
              set_name: name,
              file_size: 4096,
            };
          })
        : [],
    };
    this.stickerSets.set(name, set);
    return tgOk(true);
  }

  addStickerToSet(p) {
    if (!p.name) return tgError(400, "Bad Request: name is required");
    const set = this.stickerSets.get(String(p.name));
    if (!set) return tgError(400, "Bad Request: STICKERSET_INVALID");
    const f = this._makeFile("sticker", "webp");
    set.stickers.push({
      file_id: f.file_id,
      file_unique_id: f.file_unique_id,
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
      set_name: set.name,
      file_size: 4096,
    });
    return tgOk(true);
  }

  setStickerPositionInSet(p) {
    if (!p.sticker) return tgError(400, "Bad Request: sticker is required");
    return tgOk(true);
  }

  deleteStickerFromSet(p) {
    if (!p.sticker) return tgError(400, "Bad Request: sticker is required");
    for (const set of this.stickerSets.values()) {
      const idx = set.stickers.findIndex((s) => s.file_id === p.sticker);
      if (idx !== -1) set.stickers.splice(idx, 1);
    }
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------
  setMessageReaction(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const store = this.messages.get(chat.id);
    const msg = store && store.get(Number(p.message_id));
    if (!msg) return tgError(400, "Bad Request: message to react to not found");
    msg.reaction = this._parseMaybeJson(p.reaction) || [];
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Games
  // -------------------------------------------------------------------------
  sendGame(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    if (!p.game_short_name) return tgError(400, "Bad Request: game_short_name is required");
    const game = {
      title: String(p.game_short_name),
      description: `Parlel game ${p.game_short_name}`,
      photo: [{ file_id: this._makeFile("photo", "jpg").file_id, file_unique_id: "g", width: 320, height: 180, file_size: 4096 }],
    };
    const msg = this._baseMessage(chat, p, { game });
    return tgOk(clone(msg));
  }

  setGameScore(p) {
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    if (p.score === undefined) return tgError(400, "Bad Request: score is required");
    if (p.inline_message_id !== undefined) return tgOk(true);
    const chat = this._resolveChat(p.chat_id);
    if (!chat) return tgError(400, "Bad Request: chat not found");
    const store = this.messages.get(chat.id);
    const msg = store && store.get(Number(p.message_id));
    if (!msg) return tgError(400, "Bad Request: message not found");
    return tgOk(clone(msg));
  }

  getGameHighScores(p) {
    if (p.user_id === undefined) return tgError(400, "Bad Request: user_id is required");
    return tgOk([
      { position: 1, user: { id: Number(p.user_id), is_bot: false, first_name: "Player" }, score: 100 },
    ]);
  }

  banChatSenderChat(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    if (p.sender_chat_id === undefined) return tgError(400, "Bad Request: sender_chat_id is required");
    return tgOk(true);
  }

  unbanChatSenderChat(p) {
    const { error } = this._requireChat(p);
    if (error) return error;
    if (p.sender_chat_id === undefined) return tgError(400, "Bad Request: sender_chat_id is required");
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------
  sendInvoice(p) {
    const { chat, error } = this._requireChat(p);
    if (error) return error;
    const prices = this._parseMaybeJson(p.prices);
    if (!p.title || !p.description || !p.payload || !p.currency || !Array.isArray(prices)) {
      return tgError(400, "Bad Request: title, description, payload, currency and prices are required");
    }
    const total = prices.reduce((sum, pr) => sum + Number(pr.amount || 0), 0);
    const invoice = {
      title: String(p.title),
      description: String(p.description),
      start_parameter: p.start_parameter ? String(p.start_parameter) : "",
      currency: String(p.currency),
      total_amount: total,
    };
    const msg = this._baseMessage(chat, p, { invoice });
    return tgOk(clone(msg));
  }

  answerShippingQuery(p) {
    if (!p.shipping_query_id) return tgError(400, "Bad Request: shipping_query_id is required");
    if (p.ok === false || p.ok === "false") {
      if (!p.error_message) return tgError(400, "Bad Request: error_message is required when ok is false");
    }
    return tgOk(true);
  }

  answerPreCheckoutQuery(p) {
    if (!p.pre_checkout_query_id) return tgError(400, "Bad Request: pre_checkout_query_id is required");
    if (p.ok === false || p.ok === "false") {
      if (!p.error_message) return tgError(400, "Bad Request: error_message is required when ok is false");
    }
    return tgOk(true);
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection / update-injection endpoints (not Telegram).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, parsed) {
    const body = isPlainObject(parsed.body) ? parsed.body : {};
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "sent") {
      return this.send(res, 200, { sent: this.sent.map(clone), count: this.sent.length });
    }
    if (req.method === "GET" && parts[1] === "chats") {
      const chats = [];
      const seen = new Set();
      for (const c of this.chats.values()) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        chats.push(clone(c));
      }
      return this.send(res, 200, { chats, count: chats.length });
    }
    if (req.method === "GET" && parts[1] === "messages") {
      const out = [];
      for (const [chatId, store] of this.messages.entries()) {
        for (const m of store.values()) out.push({ chat_id: chatId, ...clone(m) });
      }
      return this.send(res, 200, { messages: out, count: out.length });
    }
    if (req.method === "GET" && parts[1] === "callbacks") {
      return this.send(res, 200, { callbacks: this.answeredCallbacks.map(clone), count: this.answeredCallbacks.length });
    }
    // POST /__parlel/updates — inject an incoming update (e.g. a user message).
    if (req.method === "POST" && parts[1] === "updates") {
      const update = this._injectUpdate(body);
      return this.send(res, 200, { ok: true, update: clone(update) });
    }
    // POST /__parlel/message — convenience: inject an incoming text message.
    if (req.method === "POST" && parts[1] === "message") {
      const chat = this._resolveChat(body.chat_id) || this.chats.get(this.testUser.id);
      const from = body.from || { ...this.testUser };
      const message = {
        message_id: this._nextId(),
        from,
        chat: clone(chat),
        date: Math.floor(Date.now() / 1000),
        text: body.text !== undefined ? String(body.text) : "hello",
      };
      const ents = this._entities(message.text);
      if (ents.length) message.entities = ents;
      const update = this._injectUpdate({ message });
      return this.send(res, 200, { ok: true, update: clone(update) });
    }
    return this.send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  }

  _injectUpdate(payload) {
    const update = { update_id: this._updateCounter++, ...payload };
    this.updates.push(update);
    return update;
  }

  root() {
    return {
      name: "telegram",
      version: "1.0",
      protocol: "telegram-bot-api",
      api_base: `/bot<token>/<method>`,
      documentation: "/docs/telegram.md",
    };
  }

  // -------------------------------------------------------------------------
  // Body parsing (json / urlencoded / multipart best-effort).
  // -------------------------------------------------------------------------
  readBody(req) {
    return new Promise((resolve) => {
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const data = buf.toString("utf8");
        if (!data) return resolve({ body: {}, contentType });
        if (contentType.includes("application/json")) {
          try {
            return resolve({ body: JSON.parse(data), contentType });
          } catch {
            return resolve({ body: {}, contentType });
          }
        }
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const body = {};
          const params = new URLSearchParams(data);
          for (const [k, v] of params.entries()) body[k] = v;
          return resolve({ body, contentType });
        }
        if (contentType.includes("multipart/form-data")) {
          return resolve({ body: this._parseMultipart(data, contentType), contentType });
        }
        // fallback: try JSON
        try {
          resolve({ body: JSON.parse(data), contentType });
        } catch {
          resolve({ body: {}, contentType });
        }
      });
      req.on("error", () => resolve({ body: {}, contentType }));
    });
  }

  _parseMultipart(data, contentType) {
    const body = {};
    const m = contentType.match(/boundary=(.+)$/);
    if (!m) return body;
    const boundary = `--${m[1]}`;
    const sections = data.split(boundary);
    for (const section of sections) {
      const nameMatch = section.match(/name="([^"]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const idx = section.indexOf("\r\n\r\n");
      if (idx === -1) continue;
      let value = section.slice(idx + 4);
      // strip trailing CRLF
      value = value.replace(/\r\n$/, "");
      // For file fields, keep a placeholder; for scalar fields keep value.
      if (/filename="/.test(section)) {
        body[name] = `parlel-upload://${name}`;
      } else {
        body[name] = value;
      }
    }
    return body;
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}

export default TelegramServer;

// Suppress unused import lint (createHash kept for potential signature work).
void createHash;
