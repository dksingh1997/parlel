import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/slack — a tiny, dependency-free fake of the Slack Web API.
//
// It speaks the exact wire protocol used by the official `@slack/web-api`
// `WebClient` so application code and AI agents can run against it with zero
// cost and zero side effects. State is in-memory and ephemeral; posted
// messages, channels, users, reactions, files, etc. are captured for
// inspection and assertions, and the whole world is resettable.
//
// Wire protocol (mirrors https://slack.com/api/):
//   - Every method is POST (GET also accepted) to /api/<method>
//   - Body is application/json OR application/x-www-form-urlencoded
//   - Auth: `Authorization: Bearer xoxb-...` header OR a `token` body param
//   - Responses are always HTTP 200 with a JSON body { ok: boolean, ... }.
//     On failure ok=false and an `error` string code is set (Slack never uses
//     non-200 for application errors except 429 rate limiting / 401-style).
//
// Implemented method families (every commonly-used WebClient method):
//   api.test
//   auth.test / auth.revoke
//   chat.postMessage / chat.postEphemeral / chat.update / chat.delete
//   chat.scheduleMessage / chat.deleteScheduledMessage
//   chat.scheduledMessages.list / chat.getPermalink / chat.meMessage
//   conversations.list / conversations.create / conversations.info
//   conversations.history / conversations.replies / conversations.members
//   conversations.join / conversations.leave / conversations.open
//   conversations.invite / conversations.kick / conversations.rename
//   conversations.setTopic / conversations.setPurpose / conversations.archive
//   conversations.unarchive / conversations.mark
//   users.list / users.info / users.lookupByEmail / users.identity
//   users.setPresence / users.getPresence / users.conversations
//   users.profile.get / users.profile.set
//   reactions.add / reactions.remove / reactions.get / reactions.list
//   pins.add / pins.remove / pins.list
//   bookmarks.add / bookmarks.list / bookmarks.edit / bookmarks.remove
//   files.upload / files.info / files.list / files.delete
//   files.uploadV2 (getUploadURLExternal + completeUploadExternal)
//   views.open / views.publish / views.push / views.update
//   team.info
//   usergroups.create / usergroups.list / usergroups.update
//   usergroups.users.list / usergroups.users.update
//   emoji.list
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

function nowTs() {
  // Slack message ts: seconds.microseconds, monotonically increasing.
  const ms = Date.now();
  const micro = Math.floor(Math.random() * 1000000)
    .toString()
    .padStart(6, "0");
  return `${Math.floor(ms / 1000)}.${micro}`;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function genId(prefix) {
  return `${prefix}${randomBytes(6).toString("hex").toUpperCase()}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

// Slack error envelope: HTTP 200, { ok:false, error:"code" }.
function err(code, extra = {}) {
  return { ok: false, error: code, ...extra };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

// Parse "true"/"false"/numbers loosely (form bodies arrive as strings).
function asBool(v) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1" || v === 1) return true;
  if (v === "false" || v === "0" || v === 0) return false;
  return Boolean(v);
}

function maybeJsonParse(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

export class SlackServer {
  constructor(port = 4654, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.tokens = new Set([
      "xoxb-parlel-test-token",
      "xoxp-parlel-test-token",
      "xapp-parlel-test-token",
    ]);
    this.revoked = new Set();

    this.team = {
      id: "T_PARLEL01",
      name: "Parlel Workspace",
      domain: "parlel",
      email_domain: "",
      icon: { image_132: "https://parlel.test/icon.png", image_default: true },
    };
    this.botIdentity = {
      user_id: "U_BOT00001",
      user: "parlelbot",
      bot_id: "B_BOT00001",
    };

    // users keyed by id
    this.users = new Map();
    // channels keyed by id
    this.channels = new Map();
    // messages keyed by channel id -> array (chronological)
    this.messages = new Map();
    // scheduled messages keyed by id
    this.scheduled = new Map();
    // files keyed by id
    this.files = new Map();
    // pins keyed by channel id -> array of { type, ... }
    this.pins = new Map();
    // bookmarks keyed by channel id -> Map(bookmarkId -> bookmark)
    this.bookmarks = new Map();
    // usergroups keyed by id
    this.usergroups = new Map();
    // views keyed by id (modals/home)
    this.views = new Map();
    // pending external upload URLs keyed by file id
    this.pendingUploads = new Map();
    // presence keyed by user id
    this.presence = new Map();

    this._seedDefaults();
  }

  _seedDefaults() {
    const bot = {
      id: this.botIdentity.user_id,
      team_id: this.team.id,
      name: "parlelbot",
      real_name: "Parlel Bot",
      is_bot: true,
      is_admin: false,
      deleted: false,
      profile: {
        real_name: "Parlel Bot",
        display_name: "parlelbot",
        email: "bot@parlel.test",
        image_72: "https://parlel.test/avatar.png",
      },
    };
    const alice = {
      id: "U_ALICE001",
      team_id: this.team.id,
      name: "alice",
      real_name: "Alice Example",
      is_bot: false,
      is_admin: true,
      deleted: false,
      profile: {
        real_name: "Alice Example",
        display_name: "alice",
        email: "alice@parlel.test",
        image_72: "https://parlel.test/alice.png",
      },
    };
    this.users.set(bot.id, bot);
    this.users.set(alice.id, alice);
    this.presence.set(bot.id, "active");
    this.presence.set(alice.id, "away");

    const general = this._makeChannel({
      id: "C_GENERAL1",
      name: "general",
      is_general: true,
      creator: alice.id,
      members: [bot.id, alice.id],
    });
    const random = this._makeChannel({
      id: "C_RANDOM01",
      name: "random",
      creator: alice.id,
      members: [alice.id],
    });
    this.channels.set(general.id, general);
    this.channels.set(random.id, random);
    this.messages.set(general.id, []);
    this.messages.set(random.id, []);
  }

  _makeChannel({ id, name, is_general = false, is_private = false, creator, members = [], is_im = false, is_mpim = false, user }) {
    return {
      id,
      name,
      is_channel: !is_im && !is_mpim,
      is_group: is_mpim, // real API marks MPIMs as is_group:true
      is_im,
      is_mpim,
      is_private: is_private || is_mpim,
      is_general,
      is_archived: false,
      // Standard channel-object flags the real API always returns
      // (https://api.slack.com/methods/conversations.create#response).
      unlinked: 0,
      is_shared: false,
      is_ext_shared: false,
      is_org_shared: false,
      pending_shared: [],
      is_pending_ext_shared: false,
      created: Math.floor(Date.now() / 1000),
      creator: creator || this.botIdentity.user_id,
      name_normalized: name ? name.toLowerCase() : name,
      previous_names: [],
      topic: { value: "", creator: "", last_set: 0 },
      purpose: { value: "", creator: "", last_set: 0 },
      num_members: members.length,
      members,
      user, // for IM channels
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 200, err("internal_error", { detail: error.message }));
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const { body, contentType } = await this.readBody(req);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, User-Agent");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-slack");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Unauthenticated infra endpoints.
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    // parlel control/inspection endpoints.
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Slack API: /api/<method>
    if (parts[0] === "api" && parts.length === 2) {
      return this.routeApi(req, res, parts[1], body, url, contentType);
    }

    return this.send(res, 404, err("unknown_method", { detail: "not_found" }));
  }

  // -------------------------------------------------------------------------
  // Slack API dispatch
  // -------------------------------------------------------------------------
  routeApi(req, res, method, body, url, contentType) {
    // Merge query params + body into one args bag (Slack accepts both).
    const args = {};
    for (const [k, v] of url.searchParams.entries()) args[k] = v;
    if (isPlainObject(body)) Object.assign(args, body);

    // api.test never requires auth (it echoes args).
    if (method === "api.test") {
      const out = ok({ args: clone(stripToken(args)) });
      if (args.error) {
        return this.send(res, 200, err(args.error, { args: clone(stripToken(args)) }));
      }
      return this.send(res, 200, out);
    }

    // Token resolution: header or body.
    const token = this._tokenFromRequest(req, args);
    if (this.requireAuth) {
      if (!token) return this.send(res, 200, err("not_authed"));
      if (this.revoked.has(token)) return this.send(res, 200, err("token_revoked"));
      if (!this.tokens.has(token)) return this.send(res, 200, err("invalid_auth"));
    }

    try {
      const handler = this.methods[method];
      if (!handler) {
        return this.send(res, 200, err("unknown_method", { detail: method }));
      }
      const result = handler.call(this, args, { token, contentType });
      return this.send(res, 200, result);
    } catch (error) {
      return this.send(res, 200, err("internal_error", { detail: error.message }));
    }
  }

  get methods() {
    if (this._methods) return this._methods;
    this._methods = {
      "auth.test": this.authTest,
      "auth.revoke": this.authRevoke,

      "chat.postMessage": this.chatPostMessage,
      "chat.postEphemeral": this.chatPostEphemeral,
      "chat.update": this.chatUpdate,
      "chat.delete": this.chatDelete,
      "chat.meMessage": this.chatMeMessage,
      "chat.getPermalink": this.chatGetPermalink,
      "chat.scheduleMessage": this.chatScheduleMessage,
      "chat.deleteScheduledMessage": this.chatDeleteScheduledMessage,
      "chat.scheduledMessages.list": this.chatScheduledMessagesList,

      "conversations.list": this.conversationsList,
      "conversations.create": this.conversationsCreate,
      "conversations.info": this.conversationsInfo,
      "conversations.history": this.conversationsHistory,
      "conversations.replies": this.conversationsReplies,
      "conversations.members": this.conversationsMembers,
      "conversations.join": this.conversationsJoin,
      "conversations.leave": this.conversationsLeave,
      "conversations.open": this.conversationsOpen,
      "conversations.invite": this.conversationsInvite,
      "conversations.kick": this.conversationsKick,
      "conversations.rename": this.conversationsRename,
      "conversations.setTopic": this.conversationsSetTopic,
      "conversations.setPurpose": this.conversationsSetPurpose,
      "conversations.archive": this.conversationsArchive,
      "conversations.unarchive": this.conversationsUnarchive,
      "conversations.mark": this.conversationsMark,

      "users.list": this.usersList,
      "users.info": this.usersInfo,
      "users.lookupByEmail": this.usersLookupByEmail,
      "users.identity": this.usersIdentity,
      "users.setPresence": this.usersSetPresence,
      "users.getPresence": this.usersGetPresence,
      "users.conversations": this.usersConversations,
      "users.profile.get": this.usersProfileGet,
      "users.profile.set": this.usersProfileSet,

      "reactions.add": this.reactionsAdd,
      "reactions.remove": this.reactionsRemove,
      "reactions.get": this.reactionsGet,
      "reactions.list": this.reactionsList,

      "pins.add": this.pinsAdd,
      "pins.remove": this.pinsRemove,
      "pins.list": this.pinsList,

      "bookmarks.add": this.bookmarksAdd,
      "bookmarks.list": this.bookmarksList,
      "bookmarks.edit": this.bookmarksEdit,
      "bookmarks.remove": this.bookmarksRemove,

      "files.upload": this.filesUpload,
      "files.info": this.filesInfo,
      "files.list": this.filesList,
      "files.delete": this.filesDelete,
      "files.getUploadURLExternal": this.filesGetUploadURLExternal,
      "files.completeUploadExternal": this.filesCompleteUploadExternal,

      "views.open": this.viewsOpen,
      "views.publish": this.viewsPublish,
      "views.push": this.viewsPush,
      "views.update": this.viewsUpdate,

      "team.info": this.teamInfo,

      "usergroups.create": this.usergroupsCreate,
      "usergroups.list": this.usergroupsList,
      "usergroups.update": this.usergroupsUpdate,
      "usergroups.users.list": this.usergroupsUsersList,
      "usergroups.users.update": this.usergroupsUsersUpdate,

      "emoji.list": this.emojiList,
    };
    return this._methods;
  }

  // -------------------------------------------------------------------------
  // auth.*
  // -------------------------------------------------------------------------
  authTest(args, ctx) {
    return ok({
      url: `https://${this.team.domain}.slack.com/`,
      team: this.team.name,
      user: this.botIdentity.user,
      team_id: this.team.id,
      user_id: this.botIdentity.user_id,
      bot_id: this.botIdentity.bot_id,
      is_enterprise_install: false,
    });
  }

  authRevoke(args, ctx) {
    const test = asBool(args.test);
    if (!test && ctx.token) {
      this.revoked.add(ctx.token);
    }
    return ok({ revoked: !test });
  }

  // -------------------------------------------------------------------------
  // chat.*
  // -------------------------------------------------------------------------
  _resolveChannel(idOrName) {
    if (!idOrName) return null;
    if (this.channels.has(idOrName)) return this.channels.get(idOrName);
    const stripped = String(idOrName).replace(/^#/, "");
    for (const ch of this.channels.values()) {
      if (ch.name === stripped) return ch;
    }
    return null;
  }

  chatPostMessage(args) {
    if (!args.channel) return err("channel_not_found");
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");

    const hasText = typeof args.text === "string" && args.text.length > 0;
    const blocks = maybeJsonParse(args.blocks);
    const attachments = maybeJsonParse(args.attachments);
    const hasBlocks = Array.isArray(blocks) && blocks.length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hasText && !hasBlocks && !hasAttachments) {
      return err("no_text");
    }

    const ts = nowTs();
    // A message posted with a bot token is attributed as a "bot_message" by the
    // real API, with a `username` alongside the `bot_id`
    // (https://api.slack.com/methods/chat.postMessage#response). Client code
    // commonly filters on `message.subtype === "bot_message"`.
    const message = {
      type: "message",
      subtype: "bot_message",
      ts,
      user: this.botIdentity.user_id,
      bot_id: this.botIdentity.bot_id,
      username: typeof args.username === "string" && args.username ? args.username : this.botIdentity.user,
      team: this.team.id,
      text: typeof args.text === "string" ? args.text : "",
      blocks: hasBlocks ? clone(blocks) : undefined,
      attachments: hasAttachments ? clone(attachments) : undefined,
      thread_ts: args.thread_ts || undefined,
      reactions: [],
      channel: ch.id,
    };
    if (args.thread_ts) {
      // reply within a thread
      const parent = this._findMessage(ch.id, args.thread_ts);
      if (!parent) return err("thread_not_found");
      parent.reply_count = (parent.reply_count || 0) + 1;
      parent.reply_users_set = parent.reply_users_set || new Set();
      parent.reply_users_set.add(message.user);
      parent.reply_users = Array.from(parent.reply_users_set);
      parent.latest_reply = ts;
      if (asBool(args.reply_broadcast)) message.subtype = "thread_broadcast";
    }
    this._appendMessage(ch.id, message);

    return ok({
      channel: ch.id,
      ts,
      message: this._messageView(message),
    });
  }

  chatPostEphemeral(args) {
    if (!args.channel) return err("channel_not_found");
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.user) return err("user_not_in_channel");
    const hasText = typeof args.text === "string" && args.text.length > 0;
    const blocks = maybeJsonParse(args.blocks);
    if (!hasText && !(Array.isArray(blocks) && blocks.length)) return err("no_text");
    // Ephemeral messages are not stored in history; return a message_ts.
    return ok({ message_ts: nowTs() });
  }

  chatUpdate(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.ts) return err("invalid_arguments");
    const msg = this._findMessage(ch.id, args.ts);
    if (!msg) return err("message_not_found");
    const blocks = maybeJsonParse(args.blocks);
    const attachments = maybeJsonParse(args.attachments);
    if (typeof args.text === "string") msg.text = args.text;
    if (Array.isArray(blocks)) msg.blocks = clone(blocks);
    if (Array.isArray(attachments)) msg.attachments = clone(attachments);
    msg.edited = { user: this.botIdentity.user_id, ts: nowTs() };
    return ok({
      channel: ch.id,
      ts: msg.ts,
      text: msg.text,
      message: this._messageView(msg),
    });
  }

  chatDelete(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.ts) return err("invalid_arguments");
    const list = this.messages.get(ch.id) || [];
    const idx = list.findIndex((m) => m.ts === args.ts);
    if (idx === -1) return err("message_not_found");
    list.splice(idx, 1);
    return ok({ channel: ch.id, ts: args.ts });
  }

  chatMeMessage(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (typeof args.text !== "string" || !args.text) return err("no_text");
    const ts = nowTs();
    const message = {
      type: "message",
      subtype: "me_message",
      ts,
      user: this.botIdentity.user_id,
      text: args.text,
      channel: ch.id,
      reactions: [],
    };
    this._appendMessage(ch.id, message);
    return ok({ channel: ch.id, ts });
  }

  chatGetPermalink(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.message_ts) return err("message_not_found");
    const tsClean = String(args.message_ts).replace(".", "");
    return ok({
      channel: ch.id,
      permalink: `https://${this.team.domain}.slack.com/archives/${ch.id}/p${tsClean}`,
    });
  }

  chatScheduleMessage(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.post_at) return err("invalid_arguments");
    const postAt = Number(args.post_at);
    if (!Number.isFinite(postAt)) return err("invalid_time");
    if (postAt * 1000 <= Date.now()) return err("time_in_past");
    const hasText = typeof args.text === "string" && args.text.length > 0;
    const blocks = maybeJsonParse(args.blocks);
    if (!hasText && !(Array.isArray(blocks) && blocks.length)) return err("no_text");
    const id = genId("Q");
    this.scheduled.set(id, {
      id,
      channel: ch.id,
      post_at: postAt,
      date_created: Math.floor(Date.now() / 1000),
      text: hasText ? args.text : "",
      blocks: Array.isArray(blocks) ? clone(blocks) : undefined,
    });
    return ok({
      channel: ch.id,
      scheduled_message_id: id,
      post_at: postAt,
      message: { text: hasText ? args.text : "", bot_id: this.botIdentity.bot_id },
    });
  }

  chatDeleteScheduledMessage(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const id = args.scheduled_message_id;
    if (!id || !this.scheduled.has(id)) return err("invalid_scheduled_message_id");
    this.scheduled.delete(id);
    return ok({});
  }

  chatScheduledMessagesList(args) {
    let items = Array.from(this.scheduled.values());
    if (args.channel) {
      const ch = this._resolveChannel(args.channel);
      if (ch) items = items.filter((m) => m.channel === ch.id);
    }
    return ok({
      scheduled_messages: items.map((m) => ({
        id: m.id,
        channel_id: m.channel,
        post_at: m.post_at,
        date_created: m.date_created,
        text: m.text,
      })),
      response_metadata: { next_cursor: "" },
    });
  }

  // -------------------------------------------------------------------------
  // conversations.*
  // -------------------------------------------------------------------------
  conversationsList(args) {
    const types = (args.types ? String(args.types).split(",") : ["public_channel", "private_channel"]).map((t) => t.trim());
    const excludeArchived = asBool(args.exclude_archived);
    let chans = Array.from(this.channels.values()).filter((c) => {
      if (excludeArchived && c.is_archived) return false;
      if (c.is_im) return types.includes("im");
      if (c.is_mpim) return types.includes("mpim");
      if (c.is_private) return types.includes("private_channel");
      return types.includes("public_channel");
    });
    const limit = args.limit ? Number(args.limit) : chans.length;
    chans = chans.slice(0, limit);
    return ok({
      channels: chans.map((c) => this._channelView(c)),
      response_metadata: { next_cursor: "" },
    });
  }

  // Slack validates channel names with granular error codes, not a single
  // invalid_name. https://api.slack.com/methods/conversations.create#errors
  //   invalid_name_required   — empty
  //   invalid_name_maxlength  — > 80 chars
  //   invalid_name_punctuation— only punctuation (no alphanumerics)
  //   invalid_name_specials   — uppercase / disallowed characters
  // Returns the normalized (lowercased, leading-# stripped) name on success or
  // an { error } object on failure.
  _validateChannelName(raw) {
    if (raw === undefined || raw === null || String(raw) === "") {
      return { error: "invalid_name_required" };
    }
    const stripped = String(raw).replace(/^#/, "");
    if (stripped.length > 80) return { error: "invalid_name_maxlength" };
    const name = stripped.toLowerCase();
    // Only lowercase letters, digits, hyphen and underscore are allowed. An
    // uppercase letter or any other disallowed char is "specials"; a string
    // made purely of punctuation (no alphanumerics) is "punctuation".
    if (!/^[a-z0-9_-]+$/.test(name)) return { error: "invalid_name_specials" };
    if (!/[a-z0-9]/.test(name)) return { error: "invalid_name_punctuation" };
    return { name };
  }

  conversationsCreate(args) {
    const v = this._validateChannelName(args.name);
    if (v.error) return err(v.error);
    const name = v.name;
    for (const c of this.channels.values()) {
      if (c.name === name && !c.is_im && !c.is_mpim) return err("name_taken");
    }
    const ch = this._makeChannel({
      id: genId("C"),
      name,
      is_private: asBool(args.is_private),
      creator: this.botIdentity.user_id,
      members: [this.botIdentity.user_id],
    });
    this.channels.set(ch.id, ch);
    this.messages.set(ch.id, []);
    return ok({ channel: this._channelView(ch) });
  }

  conversationsInfo(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const view = this._channelView(ch);
    if (asBool(args.include_num_members)) view.num_members = (ch.members || []).length;
    return ok({ channel: view });
  }

  conversationsHistory(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    let list = (this.messages.get(ch.id) || []).filter((m) => !m.thread_ts || m.thread_ts === m.ts);
    // newest first
    let msgs = list.slice().reverse();
    if (args.oldest) msgs = msgs.filter((m) => Number(m.ts) > Number(args.oldest));
    if (args.latest) msgs = msgs.filter((m) => Number(m.ts) <= Number(args.latest));
    const limit = args.limit ? Number(args.limit) : 100;
    const hasMore = msgs.length > limit;
    msgs = msgs.slice(0, limit);
    return ok({
      messages: msgs.map((m) => this._messageView(m)),
      has_more: hasMore,
      pin_count: (this.pins.get(ch.id) || []).length,
      response_metadata: { next_cursor: "" },
    });
  }

  conversationsReplies(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.ts) return err("invalid_arguments");
    const parent = this._findMessage(ch.id, args.ts);
    if (!parent) return err("thread_not_found");
    const list = this.messages.get(ch.id) || [];
    const replies = list.filter((m) => m.thread_ts === args.ts && m.ts !== args.ts);
    const out = [this._messageView(parent), ...replies.map((m) => this._messageView(m))];
    return ok({
      messages: out,
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
  }

  conversationsMembers(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    return ok({
      members: (ch.members || []).slice(),
      response_metadata: { next_cursor: "" },
    });
  }

  conversationsJoin(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (ch.is_archived) return err("is_archived");
    if (!ch.members.includes(this.botIdentity.user_id)) {
      ch.members.push(this.botIdentity.user_id);
      ch.num_members = ch.members.length;
    }
    return ok({ channel: this._channelView(ch) });
  }

  conversationsLeave(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    ch.members = ch.members.filter((u) => u !== this.botIdentity.user_id);
    ch.num_members = ch.members.length;
    return ok({});
  }

  conversationsOpen(args) {
    // Direct message / multi-party IM open.
    const usersArg = args.users
      ? String(args.users).split(",").map((u) => u.trim()).filter(Boolean)
      : [];
    if (args.channel) {
      const ch = this._resolveChannel(args.channel);
      if (!ch) return err("channel_not_found");
      return ok({ channel: { id: ch.id }, no_op: true, already_open: true });
    }
    if (usersArg.length === 0) return err("users_not_found");
    for (const u of usersArg) {
      if (!this.users.has(u)) return err("user_not_found");
    }
    const isMpim = usersArg.length > 1;
    const id = genId(isMpim ? "G" : "D");
    const ch = this._makeChannel({
      id,
      name: isMpim ? `mpdm-${usersArg.join("--")}` : undefined,
      is_im: !isMpim,
      is_mpim: isMpim,
      creator: this.botIdentity.user_id,
      members: [this.botIdentity.user_id, ...usersArg],
      user: isMpim ? undefined : usersArg[0],
    });
    this.channels.set(id, ch);
    this.messages.set(id, []);
    if (asBool(args.return_im) || isMpim) {
      return ok({ channel: this._channelView(ch) });
    }
    return ok({ channel: { id } });
  }

  conversationsInvite(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const users = args.users ? String(args.users).split(",").map((u) => u.trim()) : [];
    if (users.length === 0) return err("no_user");
    for (const u of users) {
      if (!this.users.has(u)) return err("user_not_found");
    }
    for (const u of users) {
      if (!ch.members.includes(u)) ch.members.push(u);
    }
    ch.num_members = ch.members.length;
    return ok({ channel: this._channelView(ch) });
  }

  conversationsKick(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.user) return err("user_not_found");
    if (!ch.members.includes(args.user)) return err("not_in_channel");
    ch.members = ch.members.filter((u) => u !== args.user);
    ch.num_members = ch.members.length;
    return ok({});
  }

  conversationsRename(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const v = this._validateChannelName(args.name);
    if (v.error) return err(v.error);
    const name = v.name;
    for (const c of this.channels.values()) {
      if (c.id !== ch.id && c.name === name) return err("name_taken");
    }
    ch.name = name;
    ch.name_normalized = name;
    return ok({ channel: this._channelView(ch) });
  }

  conversationsSetTopic(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (typeof args.topic !== "string") return err("invalid_arguments");
    ch.topic = { value: args.topic, creator: this.botIdentity.user_id, last_set: Math.floor(Date.now() / 1000) };
    return ok({ channel: this._channelView(ch), topic: args.topic });
  }

  conversationsSetPurpose(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (typeof args.purpose !== "string") return err("invalid_arguments");
    ch.purpose = { value: args.purpose, creator: this.botIdentity.user_id, last_set: Math.floor(Date.now() / 1000) };
    return ok({ channel: this._channelView(ch), purpose: args.purpose });
  }

  conversationsArchive(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (ch.is_general) return err("cant_archive_general");
    if (ch.is_archived) return err("already_archived");
    ch.is_archived = true;
    return ok({});
  }

  conversationsUnarchive(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!ch.is_archived) return err("not_archived");
    ch.is_archived = false;
    return ok({});
  }

  conversationsMark(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.ts) return err("invalid_arguments");
    ch.last_read = args.ts;
    return ok({});
  }

  // -------------------------------------------------------------------------
  // users.*
  // -------------------------------------------------------------------------
  usersList(args) {
    const members = Array.from(this.users.values()).map((u) => this._userView(u));
    return ok({
      members,
      cache_ts: Math.floor(Date.now() / 1000),
      response_metadata: { next_cursor: "" },
    });
  }

  usersInfo(args) {
    if (!args.user) return err("user_not_found");
    const u = this.users.get(args.user);
    if (!u) return err("user_not_found");
    return ok({ user: this._userView(u) });
  }

  usersLookupByEmail(args) {
    if (!args.email) return err("users_not_found");
    for (const u of this.users.values()) {
      if (u.profile && u.profile.email === args.email) return ok({ user: this._userView(u) });
    }
    return err("users_not_found");
  }

  usersIdentity(args) {
    const u = this.users.get(this.botIdentity.user_id);
    return ok({
      user: { name: u.real_name, id: u.id, email: u.profile.email },
      team: { id: this.team.id, name: this.team.name },
    });
  }

  usersSetPresence(args) {
    const presence = args.presence;
    if (presence !== "auto" && presence !== "away") return err("invalid_presence");
    this.presence.set(this.botIdentity.user_id, presence === "auto" ? "active" : "away");
    return ok({});
  }

  usersGetPresence(args) {
    const userId = args.user || this.botIdentity.user_id;
    if (!this.users.has(userId)) return err("user_not_found");
    const presence = this.presence.get(userId) || "away";
    return ok({
      presence,
      online: presence === "active",
      auto_away: false,
      manual_away: presence === "away",
      connection_count: presence === "active" ? 1 : 0,
      last_activity: Math.floor(Date.now() / 1000),
    });
  }

  usersConversations(args) {
    const userId = args.user || this.botIdentity.user_id;
    const types = (args.types ? String(args.types).split(",") : ["public_channel"]).map((t) => t.trim());
    const chans = Array.from(this.channels.values()).filter((c) => {
      if (!(c.members || []).includes(userId)) return false;
      if (c.is_im) return types.includes("im");
      if (c.is_mpim) return types.includes("mpim");
      if (c.is_private) return types.includes("private_channel");
      return types.includes("public_channel");
    });
    return ok({
      channels: chans.map((c) => this._channelView(c)),
      response_metadata: { next_cursor: "" },
    });
  }

  usersProfileGet(args) {
    const userId = args.user || this.botIdentity.user_id;
    const u = this.users.get(userId);
    if (!u) return err("user_not_found");
    return ok({ profile: clone(u.profile) });
  }

  usersProfileSet(args) {
    const userId = args.user || this.botIdentity.user_id;
    const u = this.users.get(userId);
    if (!u) return err("user_not_found");
    let profile = maybeJsonParse(args.profile);
    if (isPlainObject(profile)) {
      Object.assign(u.profile, profile);
    } else if (args.name) {
      // single field update form
      u.profile[args.name] = args.value;
    } else {
      return err("invalid_profile");
    }
    if (u.profile.real_name) u.real_name = u.profile.real_name;
    return ok({ profile: clone(u.profile) });
  }

  // -------------------------------------------------------------------------
  // reactions.*
  // -------------------------------------------------------------------------
  reactionsAdd(args) {
    if (!args.name) return err("no_reaction");
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.timestamp) return err("bad_timestamp");
    const msg = this._findMessage(ch.id, args.timestamp);
    if (!msg) return err("message_not_found");
    msg.reactions = msg.reactions || [];
    let r = msg.reactions.find((x) => x.name === args.name);
    if (!r) {
      r = { name: args.name, users: [], count: 0 };
      msg.reactions.push(r);
    }
    if (r.users.includes(this.botIdentity.user_id)) return err("already_reacted");
    r.users.push(this.botIdentity.user_id);
    r.count = r.users.length;
    return ok({});
  }

  reactionsRemove(args) {
    if (!args.name) return err("no_reaction");
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const msg = this._findMessage(ch.id, args.timestamp);
    if (!msg) return err("message_not_found");
    const r = (msg.reactions || []).find((x) => x.name === args.name);
    if (!r || !r.users.includes(this.botIdentity.user_id)) return err("no_reaction");
    r.users = r.users.filter((u) => u !== this.botIdentity.user_id);
    r.count = r.users.length;
    if (r.count === 0) msg.reactions = msg.reactions.filter((x) => x.name !== args.name);
    return ok({});
  }

  reactionsGet(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const msg = this._findMessage(ch.id, args.timestamp);
    if (!msg) return err("message_not_found");
    return ok({
      type: "message",
      channel: ch.id,
      message: this._messageView(msg),
    });
  }

  reactionsList(args) {
    const items = [];
    for (const [chId, list] of this.messages.entries()) {
      for (const m of list) {
        if ((m.reactions || []).length > 0) {
          items.push({ type: "message", channel: chId, message: this._messageView(m) });
        }
      }
    }
    return ok({ items, response_metadata: { next_cursor: "" } });
  }

  // -------------------------------------------------------------------------
  // pins.*
  // -------------------------------------------------------------------------
  pinsAdd(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.timestamp) return err("bad_timestamp");
    const msg = this._findMessage(ch.id, args.timestamp);
    if (!msg) return err("message_not_found");
    if (!this.pins.has(ch.id)) this.pins.set(ch.id, []);
    const pins = this.pins.get(ch.id);
    if (pins.some((p) => p.message && p.message.ts === args.timestamp)) return err("already_pinned");
    pins.push({ type: "message", created: Math.floor(Date.now() / 1000), created_by: this.botIdentity.user_id, channel: ch.id, message: this._messageView(msg) });
    return ok({});
  }

  pinsRemove(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    const pins = this.pins.get(ch.id) || [];
    const idx = pins.findIndex((p) => p.message && p.message.ts === args.timestamp);
    if (idx === -1) return err("no_pin");
    pins.splice(idx, 1);
    return ok({});
  }

  pinsList(args) {
    const ch = this._resolveChannel(args.channel);
    if (!ch) return err("channel_not_found");
    return ok({ items: clone(this.pins.get(ch.id) || []) });
  }

  // -------------------------------------------------------------------------
  // bookmarks.*
  // -------------------------------------------------------------------------
  bookmarksAdd(args) {
    const ch = this._resolveChannel(args.channel_id || args.channel);
    if (!ch) return err("channel_not_found");
    if (!args.title) return err("invalid_arguments");
    if (!args.type) return err("invalid_arguments");
    if (!this.bookmarks.has(ch.id)) this.bookmarks.set(ch.id, new Map());
    const id = genId("Bk");
    const bookmark = {
      id,
      channel_id: ch.id,
      title: args.title,
      type: args.type,
      link: args.link || undefined,
      emoji: args.emoji || undefined,
      icon_url: args.icon_url || undefined,
      entity_id: args.entity_id || undefined,
      date_created: Math.floor(Date.now() / 1000),
      date_updated: Math.floor(Date.now() / 1000),
      rank: "1",
    };
    this.bookmarks.get(ch.id).set(id, bookmark);
    return ok({ bookmark: clone(bookmark) });
  }

  bookmarksList(args) {
    const ch = this._resolveChannel(args.channel_id || args.channel);
    if (!ch) return err("channel_not_found");
    const bucket = this.bookmarks.get(ch.id) || new Map();
    return ok({ bookmarks: Array.from(bucket.values()).map(clone) });
  }

  bookmarksEdit(args) {
    const ch = this._resolveChannel(args.channel_id || args.channel);
    if (!ch) return err("channel_not_found");
    const bucket = this.bookmarks.get(ch.id);
    if (!bucket || !bucket.has(args.bookmark_id)) return err("bookmark_not_found");
    const b = bucket.get(args.bookmark_id);
    if (typeof args.title === "string") b.title = args.title;
    if (typeof args.link === "string") b.link = args.link;
    if (typeof args.emoji === "string") b.emoji = args.emoji;
    b.date_updated = Math.floor(Date.now() / 1000);
    return ok({ bookmark: clone(b) });
  }

  bookmarksRemove(args) {
    const ch = this._resolveChannel(args.channel_id || args.channel);
    if (!ch) return err("channel_not_found");
    const bucket = this.bookmarks.get(ch.id);
    if (!bucket || !bucket.has(args.bookmark_id)) return err("bookmark_not_found");
    bucket.delete(args.bookmark_id);
    return ok({});
  }

  // -------------------------------------------------------------------------
  // files.*
  // -------------------------------------------------------------------------
  filesUpload(args) {
    const hasContent = typeof args.content === "string";
    const hasFile = args.file !== undefined;
    if (!hasContent && !hasFile) return err("no_file_data");
    const channels = args.channels
      ? String(args.channels).split(",").map((c) => c.trim()).filter(Boolean)
      : [];
    const id = genId("F");
    const name = args.filename || args.title || "untitled";
    const file = {
      id,
      created: Math.floor(Date.now() / 1000),
      timestamp: Math.floor(Date.now() / 1000),
      name,
      title: args.title || name,
      mimetype: args.filetype ? `text/${args.filetype}` : "text/plain",
      filetype: args.filetype || "text",
      pretty_type: (args.filetype || "Text").toUpperCase(),
      user: this.botIdentity.user_id,
      size: hasContent ? Buffer.byteLength(args.content) : 0,
      mode: "hosted",
      is_external: false,
      is_public: channels.length > 0,
      channels: channels.map((c) => (this._resolveChannel(c) || {}).id || c),
      comments_count: 0,
      url_private: `https://files.parlel.test/${id}/${encodeURIComponent(name)}`,
      permalink: `https://${this.team.domain}.slack.com/files/${this.botIdentity.user_id}/${id}/${encodeURIComponent(name)}`,
      _content: hasContent ? args.content : undefined,
    };
    this.files.set(id, file);
    // Post a share message into each channel.
    if (args.initial_comment || channels.length) {
      for (const cName of channels) {
        const ch = this._resolveChannel(cName);
        if (ch) {
          const ts = nowTs();
          this._appendMessage(ch.id, {
            type: "message",
            subtype: "file_share",
            ts,
            user: this.botIdentity.user_id,
            text: args.initial_comment || "",
            files: [this._fileView(file)],
            channel: ch.id,
            reactions: [],
          });
        }
      }
    }
    return ok({ file: this._fileView(file) });
  }

  filesInfo(args) {
    const f = this.files.get(args.file);
    if (!f) return err("file_not_found");
    return ok({ file: this._fileView(f), comments: [], response_metadata: { next_cursor: "" } });
  }

  filesList(args) {
    let files = Array.from(this.files.values());
    if (args.channel) {
      const ch = this._resolveChannel(args.channel);
      if (ch) files = files.filter((f) => (f.channels || []).includes(ch.id));
    }
    if (args.user) files = files.filter((f) => f.user === args.user);
    return ok({
      files: files.map((f) => this._fileView(f)),
      paging: { count: files.length, total: files.length, page: 1, pages: 1 },
    });
  }

  filesDelete(args) {
    if (!this.files.has(args.file)) return err("file_not_found");
    this.files.delete(args.file);
    return ok({});
  }

  // files.uploadV2 internally uses these two:
  filesGetUploadURLExternal(args) {
    if (!args.filename) return err("invalid_arguments");
    const id = genId("F");
    const uploadUrl = `http://${this.host}:${this.port}/__parlel/upload/${id}`;
    this.pendingUploads.set(id, {
      id,
      filename: args.filename,
      length: args.length ? Number(args.length) : 0,
      alt_text: args.alt_text,
      snippet_type: args.snippet_type,
    });
    return ok({ upload_url: uploadUrl, file_id: id });
  }

  filesCompleteUploadExternal(args) {
    let filesArg = maybeJsonParse(args.files);
    if (!Array.isArray(filesArg)) return err("invalid_arguments");
    const out = [];
    for (const entry of filesArg) {
      const pending = this.pendingUploads.get(entry.id);
      if (!pending) return err("file_not_found");
      const name = entry.title || pending.filename;
      const file = {
        id: pending.id,
        created: Math.floor(Date.now() / 1000),
        timestamp: Math.floor(Date.now() / 1000),
        name: pending.filename,
        title: name,
        mimetype: "application/octet-stream",
        filetype: "binary",
        pretty_type: "Binary",
        user: this.botIdentity.user_id,
        size: pending.length,
        mode: "hosted",
        is_external: false,
        is_public: Boolean(args.channel_id),
        channels: args.channel_id ? [args.channel_id] : [],
        url_private: `https://files.parlel.test/${pending.id}/${encodeURIComponent(pending.filename)}`,
        permalink: `https://${this.team.domain}.slack.com/files/${this.botIdentity.user_id}/${pending.id}/${encodeURIComponent(pending.filename)}`,
      };
      this.files.set(file.id, file);
      this.pendingUploads.delete(entry.id);
      out.push({ id: file.id, title: file.title });

      const ch = args.channel_id ? this._resolveChannel(args.channel_id) : null;
      if (ch) {
        this._appendMessage(ch.id, {
          type: "message",
          subtype: "file_share",
          ts: nowTs(),
          user: this.botIdentity.user_id,
          text: args.initial_comment || "",
          files: [this._fileView(file)],
          channel: ch.id,
          reactions: [],
        });
      }
    }
    return ok({ files: out });
  }

  // -------------------------------------------------------------------------
  // views.*
  // -------------------------------------------------------------------------
  _storeView(args, kind) {
    let view = maybeJsonParse(args.view);
    if (!isPlainObject(view)) return null;
    const id = genId("V");
    const stored = {
      id,
      team_id: this.team.id,
      type: view.type || (kind === "home" ? "home" : "modal"),
      title: view.title,
      blocks: view.blocks || [],
      private_metadata: view.private_metadata || "",
      callback_id: view.callback_id || "",
      state: { values: {} },
      hash: `${Math.floor(Date.now() / 1000)}.${randomBytes(4).toString("hex")}`,
      app_id: "A_PARLEL01",
      bot_id: this.botIdentity.bot_id,
    };
    this.views.set(id, stored);
    return stored;
  }

  viewsOpen(args) {
    if (!args.trigger_id) return err("invalid_arguments");
    const view = this._storeView(args, "modal");
    if (!view) return err("invalid_arguments", { response_metadata: { messages: ["view is required"] } });
    return ok({ view: clone(view) });
  }

  viewsPush(args) {
    if (!args.trigger_id) return err("invalid_arguments");
    const view = this._storeView(args, "modal");
    if (!view) return err("invalid_arguments");
    return ok({ view: clone(view) });
  }

  viewsPublish(args) {
    if (!args.user_id) return err("invalid_arguments");
    if (!this.users.has(args.user_id)) return err("user_not_found");
    const view = this._storeView(args, "home");
    if (!view) return err("invalid_arguments");
    return ok({ view: clone(view) });
  }

  viewsUpdate(args) {
    const id = args.view_id;
    if (id && this.views.has(id)) {
      const existing = this.views.get(id);
      const incoming = maybeJsonParse(args.view);
      if (isPlainObject(incoming)) {
        existing.blocks = incoming.blocks || existing.blocks;
        existing.title = incoming.title || existing.title;
        existing.hash = `${Math.floor(Date.now() / 1000)}.${randomBytes(4).toString("hex")}`;
      }
      return ok({ view: clone(existing) });
    }
    if (args.external_id) {
      const view = this._storeView(args, "modal");
      if (!view) return err("invalid_arguments");
      return ok({ view: clone(view) });
    }
    return err("not_found");
  }

  // -------------------------------------------------------------------------
  // team.*
  // -------------------------------------------------------------------------
  teamInfo(args) {
    return ok({ team: clone(this.team) });
  }

  // -------------------------------------------------------------------------
  // usergroups.*
  // -------------------------------------------------------------------------
  usergroupsCreate(args) {
    if (!args.name) return err("invalid_arguments");
    const id = genId("S");
    const ug = {
      id,
      team_id: this.team.id,
      name: args.name,
      handle: args.handle || String(args.name).toLowerCase().replace(/\s+/g, "-"),
      description: args.description || "",
      is_external: false,
      date_create: Math.floor(Date.now() / 1000),
      date_update: Math.floor(Date.now() / 1000),
      date_delete: 0,
      created_by: this.botIdentity.user_id,
      users: args.users ? String(args.users).split(",").map((u) => u.trim()) : [],
      user_count: 0,
    };
    ug.user_count = ug.users.length;
    this.usergroups.set(id, ug);
    return ok({ usergroup: clone(ug) });
  }

  usergroupsList(args) {
    let groups = Array.from(this.usergroups.values());
    if (!asBool(args.include_disabled)) groups = groups.filter((g) => g.date_delete === 0);
    return ok({ usergroups: groups.map((g) => {
      const v = clone(g);
      if (!asBool(args.include_users)) delete v.users;
      return v;
    }) });
  }

  usergroupsUpdate(args) {
    const ug = this.usergroups.get(args.usergroup);
    if (!ug) return err("no_such_subteam");
    if (typeof args.name === "string") ug.name = args.name;
    if (typeof args.handle === "string") ug.handle = args.handle;
    if (typeof args.description === "string") ug.description = args.description;
    ug.date_update = Math.floor(Date.now() / 1000);
    return ok({ usergroup: clone(ug) });
  }

  usergroupsUsersList(args) {
    const ug = this.usergroups.get(args.usergroup);
    if (!ug) return err("no_such_subteam");
    return ok({ users: ug.users.slice() });
  }

  usergroupsUsersUpdate(args) {
    const ug = this.usergroups.get(args.usergroup);
    if (!ug) return err("no_such_subteam");
    const users = args.users ? String(args.users).split(",").map((u) => u.trim()) : [];
    ug.users = users;
    ug.user_count = users.length;
    ug.date_update = Math.floor(Date.now() / 1000);
    return ok({ usergroup: clone(ug) });
  }

  // -------------------------------------------------------------------------
  // emoji.*
  // -------------------------------------------------------------------------
  emojiList(args) {
    return ok({
      emoji: {
        parlel: `https://${this.team.domain}.slack.com/emoji/parlel.png`,
        bowtie: "alias:slightly_smiling_face",
      },
      cache_ts: String(Math.floor(Date.now() / 1000)),
    });
  }

  // -------------------------------------------------------------------------
  // Views / helpers
  // -------------------------------------------------------------------------
  _appendMessage(channelId, message) {
    if (!this.messages.has(channelId)) this.messages.set(channelId, []);
    this.messages.get(channelId).push(message);
  }

  _findMessage(channelId, ts) {
    const list = this.messages.get(channelId) || [];
    return list.find((m) => m.ts === ts) || null;
  }

  _messageView(m) {
    const v = clone(m);
    if (v && v.reactions && v.reactions.length === 0) delete v.reactions;
    if (v) {
      delete v.reply_users_set;
      delete v.channel;
      if (v.subtype === undefined) delete v.subtype;
      if (v.thread_ts === undefined) delete v.thread_ts;
      if (v.blocks === undefined) delete v.blocks;
      if (v.attachments === undefined) delete v.attachments;
    }
    return v;
  }

  _channelView(c) {
    const v = clone(c);
    // is_member reflects whether the calling bot is in the channel — real API
    // returns this on every channel object and client code commonly reads it.
    v.is_member = (c.members || []).includes(this.botIdentity.user_id);
    delete v.members;
    // IM channels (`is_im`) carry a `user` field; non-IM channels should not.
    if (!c.is_im && !c.is_mpim) delete v.user;
    return v;
  }

  _userView(u) {
    const v = clone(u);
    v.tz = "America/Los_Angeles";
    v.tz_label = "Pacific Daylight Time";
    v.tz_offset = -25200;
    return v;
  }

  _fileView(f) {
    const v = clone(f);
    delete v._content;
    return v;
  }

  _tokenFromRequest(req, args) {
    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(\S+)/i);
    if (m) return m[1];
    if (typeof args.token === "string" && args.token) return args.token;
    return null;
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of Slack).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, body) {
    // POST /__parlel/reset
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    // GET /__parlel/messages — every stored message across channels.
    if (req.method === "GET" && parts[1] === "messages") {
      const out = [];
      for (const [chId, list] of this.messages.entries()) {
        for (const m of list) out.push({ channel: chId, ...this._messageView(m) });
      }
      return this.send(res, 200, { messages: out, count: out.length });
    }
    // GET /__parlel/channels
    if (req.method === "GET" && parts[1] === "channels") {
      const channels = Array.from(this.channels.values()).map((c) => clone(c));
      return this.send(res, 200, { channels, count: channels.length });
    }
    // GET /__parlel/files
    if (req.method === "GET" && parts[1] === "files") {
      const files = Array.from(this.files.values()).map((f) => this._fileView(f));
      return this.send(res, 200, { files, count: files.length });
    }
    // POST /__parlel/upload/:id — simulated external file PUT target.
    if (parts[1] === "upload") {
      return this.send(res, 200, { ok: true });
    }
    // POST /__parlel/users — add a user fixture for tests.
    if (req.method === "POST" && parts[1] === "users") {
      const u = isPlainObject(body) ? body : {};
      const id = u.id || genId("U");
      const user = {
        id,
        team_id: this.team.id,
        name: u.name || id.toLowerCase(),
        real_name: u.real_name || u.name || id,
        is_bot: Boolean(u.is_bot),
        is_admin: Boolean(u.is_admin),
        deleted: false,
        profile: {
          real_name: u.real_name || u.name || id,
          display_name: u.name || id,
          email: u.email || `${(u.name || id).toLowerCase()}@parlel.test`,
          image_72: "https://parlel.test/avatar.png",
        },
      };
      this.users.set(id, user);
      this.presence.set(id, "away");
      return this.send(res, 200, { ok: true, user: this._userView(user) });
    }
    return this.send(res, 404, err("unknown_method"));
  }

  root() {
    return {
      name: "slack",
      version: "1.0",
      protocol: "slack-web-api",
      documentation: "/docs/slack.md",
    };
  }

  // Read body supporting JSON and x-www-form-urlencoded (Slack accepts both).
  readBody(req) {
    return new Promise((resolve) => {
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      let data = "";
      req.on("data", (chunk) => {
        data += chunk.toString();
      });
      req.on("end", () => {
        if (!data) return resolve({ body: {}, contentType });
        if (contentType.includes("application/json")) {
          try {
            resolve({ body: JSON.parse(data), contentType });
          } catch {
            resolve({ body: {}, contentType });
          }
          return;
        }
        // default: form-urlencoded (what @slack/web-api sends by default)
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        resolve({ body: obj, contentType });
      });
      req.on("error", () => resolve({ body: {}, contentType }));
    });
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

function stripToken(args) {
  const copy = { ...args };
  delete copy.token;
  return copy;
}

export default SlackServer;
