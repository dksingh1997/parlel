import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/discord — a tiny, dependency-free fake of the Discord REST API.
//
// It speaks the exact wire protocol used by the official `discord.js` client
// (which talks to https://discord.com/api/v10) so application code and AI
// agents can run against it with zero cost and zero side effects. State is
// in-memory and ephemeral; guilds, channels, messages, members, roles, bans,
// emojis, webhooks, invites, reactions, threads, etc. are captured for
// inspection and assertions, and the whole world is resettable.
//
// Wire protocol (mirrors https://discord.com/api/v10):
//   - REST routes under /api and /api/v{n} (v6..v10 accepted).
//   - Auth via `Authorization: Bot <token>` (also Bearer accepted).
//   - JSON request/response bodies.
//   - Snowflake IDs are stringified 64-bit-ish integers.
//   - Errors use Discord's envelope: HTTP 4xx/5xx with
//     { message, code, errors? } and rate limits use HTTP 429 with
//     { message, retry_after, global }.
//
// Implemented route families (every commonly-used discord.js REST call):
//   Gateway:    GET /gateway, GET /gateway/bot
//   OAuth:      GET /oauth2/applications/@me, GET /oauth2/@me
//   Users:      GET /users/@me, GET /users/{id}, PATCH /users/@me,
//               GET /users/@me/guilds, GET /users/@me/guilds/{id}/member,
//               POST /users/@me/channels (create DM), DELETE leave guild
//   Channels:   GET/PATCH/DELETE /channels/{id}
//               GET/POST messages, GET/PATCH/DELETE one message
//               bulk-delete, crosspost, typing, pins (GET/PUT/DELETE)
//               reactions (PUT/DELETE/GET self/user/all/emoji)
//               permission overwrites (PUT/DELETE)
//               invites (GET/POST), followers, threads, thread members
//               POST /channels/{id}/webhooks, GET webhooks
//   Guilds:     POST/GET/PATCH/DELETE /guilds and /guilds/{id}
//               channels (GET/POST), members (GET/list/PATCH/PUT/DELETE)
//               member roles (PUT/DELETE), roles (GET/POST/PATCH/DELETE)
//               bans (GET/list/PUT/DELETE), prune, emojis (CRUD)
//               GET /guilds/{id}/invites, GET preview
//   Invites:    GET/DELETE /invites/{code}
//   Webhooks:   GET/PATCH/DELETE /webhooks/{id}, with token variants,
//               POST execute, GET/PATCH/DELETE webhook messages
//   Interactions/commands:
//               GET/POST/PUT/PATCH/DELETE
//               /applications/{id}/commands (+ guild scoped)
//
// Plus parlel control/inspection endpoints under /__parlel.
// ---------------------------------------------------------------------------

const DISCORD_EPOCH = 1420070400000n;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
}

// Discord JSON error envelope.
function discordError(status, message, code, errors) {
  const body = { message, code };
  if (errors) body.errors = errors;
  return { status, body };
}

// Common Discord JSON error codes (subset).
const ErrorCodes = {
  GENERAL: 0,
  UNKNOWN_ACCOUNT: 10001,
  UNKNOWN_APPLICATION: 10002,
  UNKNOWN_CHANNEL: 10003,
  UNKNOWN_GUILD: 10004,
  UNKNOWN_INVITE: 10006,
  UNKNOWN_MEMBER: 10007,
  UNKNOWN_MESSAGE: 10008,
  UNKNOWN_OVERWRITE: 10009,
  UNKNOWN_ROLE: 10011,
  UNKNOWN_TOKEN: 10012,
  UNKNOWN_USER: 10013,
  UNKNOWN_EMOJI: 10014,
  UNKNOWN_WEBHOOK: 10015,
  UNKNOWN_BAN: 10026,
  UNKNOWN_INTERACTION: 10062,
  UNKNOWN_COMMAND: 10063,
  UNKNOWN_GATEWAY: 10067,
  MISSING_ACCESS: 50001,
  INVALID_FORM_BODY: 50035,
  MISSING_PERMISSIONS: 50013,
  CANNOT_EXECUTE_ON_DM: 50003,
  UNAUTHORIZED: 0,
};

// Channel types (Discord enum).
const ChannelType = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
};

export class DiscordServer {
  constructor(port = 4655, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this._snowflakeCounter = 0n;
    this.reset();
  }

  reset() {
    this._snowflakeCounter = 1n;
    this.tokens = new Set([
      "parlel.test.discordbottoken",
      "parlel.test.discordbottoken.bot",
    ]);

    this.application = {
      id: "1000000000000000001",
      name: "Parlel Test App",
      icon: null,
      description: "Parlel in-process Discord fake application",
      bot_public: true,
      bot_require_code_grant: false,
      verify_key: "parlelverifykey",
      flags: 0,
      owner: null, // set after bot user created
    };

    // users keyed by id
    this.users = new Map();
    // guilds keyed by id
    this.guilds = new Map();
    // channels keyed by id (guild channels, DMs, threads)
    this.channels = new Map();
    // messages keyed by channel id -> Map(messageId -> message)
    this.messages = new Map();
    // members keyed by guildId -> Map(userId -> member)
    this.members = new Map();
    // roles keyed by guildId -> Map(roleId -> role)
    this.roles = new Map();
    // bans keyed by guildId -> Map(userId -> ban)
    this.bans = new Map();
    // emojis keyed by guildId -> Map(emojiId -> emoji)
    this.emojis = new Map();
    // invites keyed by code -> invite
    this.invites = new Map();
    // webhooks keyed by id -> webhook
    this.webhooks = new Map();
    // application commands keyed by id -> command (global + guild)
    this.commands = new Map();
    // thread members keyed by threadId -> Map(userId -> threadMember)
    this.threadMembers = new Map();

    this._seedDefaults();
  }

  // -------------------------------------------------------------------------
  // Snowflake generation (monotonic, Discord-shaped).
  // -------------------------------------------------------------------------
  snowflake() {
    const ms = BigInt(Date.now()) - DISCORD_EPOCH;
    const seq = this._snowflakeCounter++;
    const id = (ms << 22n) | (seq & 0xfffn);
    return id.toString();
  }

  _seedDefaults() {
    // Bot (self) user.
    const bot = {
      id: "1000000000000000010",
      username: "parlelbot",
      discriminator: "0",
      global_name: "Parlel Bot",
      avatar: null,
      bot: true,
      system: false,
      mfa_enabled: false,
      flags: 0,
      verified: true,
      email: null,
    };
    this.users.set(bot.id, bot);
    this.botId = bot.id;
    this.application.owner = {
      id: "1000000000000000099",
      username: "parlelowner",
      discriminator: "0",
      avatar: null,
    };

    // A second human user for DM / interaction targets.
    const alice = {
      id: "1000000000000000020",
      username: "alice",
      discriminator: "0",
      global_name: "Alice Example",
      avatar: null,
      bot: false,
      system: false,
    };
    this.users.set(alice.id, alice);
    this.aliceId = alice.id;

    // Seed a guild with @everyone role, a text channel and the bot as member.
    const guildId = "2000000000000000001";
    const everyoneRole = {
      id: guildId, // @everyone role id == guild id
      name: "@everyone",
      color: 0,
      hoist: false,
      position: 0,
      permissions: "2248473465835073",
      managed: false,
      mentionable: false,
    };
    const guild = {
      id: guildId,
      name: "Parlel Guild",
      icon: null,
      description: null,
      owner_id: bot.id,
      region: "us-east",
      afk_channel_id: null,
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      features: [],
      mfa_level: 0,
      system_channel_id: null,
      premium_tier: 0,
      preferred_locale: "en-US",
      nsfw_level: 0,
    };
    this.guilds.set(guildId, guild);
    this.roles.set(guildId, new Map([[everyoneRole.id, everyoneRole]]));
    this.members.set(guildId, new Map());
    this.bans.set(guildId, new Map());
    this.emojis.set(guildId, new Map());

    this._addMember(guildId, bot, []);
    this._addMember(guildId, alice, []);

    const general = {
      id: "3000000000000000001",
      type: ChannelType.GUILD_TEXT,
      guild_id: guildId,
      name: "general",
      position: 0,
      topic: null,
      nsfw: false,
      rate_limit_per_user: 0,
      parent_id: null,
      permission_overwrites: [],
    };
    this.channels.set(general.id, general);
    this.messages.set(general.id, new Map());
    guild.system_channel_id = general.id;
  }

  _addMember(guildId, user, roleIds = []) {
    if (!this.members.has(guildId)) this.members.set(guildId, new Map());
    const member = {
      user: this._userView(user),
      nick: null,
      avatar: null,
      roles: roleIds.slice(),
      joined_at: new Date().toISOString(),
      premium_since: null,
      deaf: false,
      mute: false,
      pending: false,
      communication_disabled_until: null,
    };
    this.members.get(guildId).set(user.id, member);
    return member;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { message: error.message, code: 0 });
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
    let parts = splitPath(url.pathname);
    const { body } = await this.readBody(req);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Audit-Log-Reason");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-discord");
    // Discord rate-limit informational headers (we never actually limit).
    res.setHeader("X-RateLimit-Limit", "50");
    res.setHeader("X-RateLimit-Remaining", "49");
    res.setHeader("X-RateLimit-Reset-After", "1");
    res.setHeader("X-RateLimit-Bucket", "parlel");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    // Infra endpoints (no auth).
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    // Strip /api and optional version prefix: /api/v10/...
    if (parts[0] !== "api") {
      return this.send(res, 404, { message: "404: Not Found", code: 0 });
    }
    parts = parts.slice(1);
    if (parts[0] && /^v\d+$/.test(parts[0])) parts = parts.slice(1);

    // Webhook execution and webhook-token routes are auth-optional (token in URL).
    const tokenless = parts[0] === "webhooks" && parts.length >= 3;

    if (this.requireAuth && !tokenless) {
      const token = this._tokenFromRequest(req);
      if (!token) {
        return this.send(res, 401, { message: "401: Unauthorized", code: 0 });
      }
      if (!this.tokens.has(token)) {
        return this.send(res, 401, { message: "401: Unauthorized", code: 0 });
      }
    }

    try {
      const result = this.route(req.method, parts, body, url);
      if (!result) {
        return this.send(res, 404, { message: "404: Not Found", code: 0 });
      }
      return this.send(res, result.status, result.body);
    } catch (error) {
      return this.send(res, 500, { message: error.message, code: 0 });
    }
  }

  ok(body, status = 200) {
    return { status, body };
  }

  // -------------------------------------------------------------------------
  // Router
  // -------------------------------------------------------------------------
  route(method, parts, body, url) {
    const top = parts[0];
    switch (top) {
      case "gateway":
        return this.routeGateway(method, parts);
      case "oauth2":
        return this.routeOauth(method, parts);
      case "users":
        return this.routeUsers(method, parts, body);
      case "channels":
        return this.routeChannels(method, parts, body, url);
      case "guilds":
        return this.routeGuilds(method, parts, body, url);
      case "invites":
        return this.routeInvites(method, parts);
      case "webhooks":
        return this.routeWebhooks(method, parts, body, url);
      case "applications":
        return this.routeApplications(method, parts, body);
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Gateway
  // -------------------------------------------------------------------------
  routeGateway(method, parts) {
    if (method !== "GET") return null;
    const urlBase = `ws://${this.host}:${this.port}`;
    if (parts.length === 1) {
      return this.ok({ url: urlBase });
    }
    if (parts[1] === "bot") {
      return this.ok({
        url: urlBase,
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 0,
          max_concurrency: 1,
        },
      });
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // OAuth2
  // -------------------------------------------------------------------------
  routeOauth(method, parts) {
    if (method !== "GET") return null;
    // GET /oauth2/applications/@me
    if (parts[1] === "applications" && parts[2] === "@me") {
      return this.ok(clone(this.application));
    }
    // GET /oauth2/@me  (current authorization information)
    if (parts[1] === "@me") {
      return this.ok({
        application: { id: this.application.id, name: this.application.name },
        scopes: ["bot", "applications.commands"],
        expires: new Date(Date.now() + 604800000).toISOString(),
        user: this._userView(this.users.get(this.botId)),
      });
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  routeUsers(method, parts, body) {
    const target = parts[1];

    // /users/@me
    if (target === "@me") {
      // /users/@me/guilds
      if (parts[2] === "guilds") {
        // /users/@me/guilds/{id}/member
        if (parts[3] && parts[4] === "member") {
          const g = this.guilds.get(parts[3]);
          if (!g) return discordError(404, "Unknown Guild", ErrorCodes.UNKNOWN_GUILD);
          const m = (this.members.get(parts[3]) || new Map()).get(this.botId);
          if (!m) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
          return this.ok(clone(m));
        }
        // DELETE /users/@me/guilds/{id} — leave guild
        if (method === "DELETE" && parts[3]) {
          const g = this.guilds.get(parts[3]);
          if (!g) return discordError(404, "Unknown Guild", ErrorCodes.UNKNOWN_GUILD);
          const members = this.members.get(parts[3]);
          if (members) members.delete(this.botId);
          return this.ok(null, 204);
        }
        if (method === "GET") {
          const out = [];
          for (const g of this.guilds.values()) {
            const members = this.members.get(g.id);
            if (members && members.has(this.botId)) {
              out.push({
                id: g.id,
                name: g.name,
                icon: g.icon,
                owner: g.owner_id === this.botId,
                permissions: "2248473465835073",
                features: g.features || [],
              });
            }
          }
          return this.ok(out);
        }
        return null;
      }

      // /users/@me/channels — list/create DM
      if (parts[2] === "channels") {
        if (method === "POST") {
          const recipientId = body && body.recipient_id;
          if (!recipientId) {
            return discordError(400, "Invalid Form Body", ErrorCodes.INVALID_FORM_BODY, {
              recipient_id: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] },
            });
          }
          const recipient = this.users.get(String(recipientId));
          if (!recipient) return discordError(404, "Unknown User", ErrorCodes.UNKNOWN_USER);
          // Reuse an existing DM if present.
          for (const ch of this.channels.values()) {
            if (ch.type === ChannelType.DM && (ch.recipients || []).some((r) => r.id === recipient.id)) {
              return this.ok(clone(ch));
            }
          }
          const dm = {
            id: this.snowflake(),
            type: ChannelType.DM,
            last_message_id: null,
            recipients: [this._userView(recipient)],
          };
          this.channels.set(dm.id, dm);
          this.messages.set(dm.id, new Map());
          return this.ok(clone(dm));
        }
        if (method === "GET") {
          const out = [];
          for (const ch of this.channels.values()) {
            if (ch.type === ChannelType.DM) out.push(clone(ch));
          }
          return this.ok(out);
        }
        return null;
      }

      // GET / PATCH /users/@me
      if (method === "GET") {
        return this.ok(this._userView(this.users.get(this.botId), true));
      }
      if (method === "PATCH") {
        const bot = this.users.get(this.botId);
        if (body && typeof body.username === "string") bot.username = body.username;
        if (body && body.avatar !== undefined) bot.avatar = body.avatar === null ? null : "parlelavatarhash";
        return this.ok(this._userView(bot, true));
      }
      return null;
    }

    // GET /users/{id}
    if (method === "GET" && target) {
      const u = this.users.get(target);
      if (!u) return discordError(404, "Unknown User", ErrorCodes.UNKNOWN_USER);
      return this.ok(this._userView(u));
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------
  routeChannels(method, parts, body, url) {
    const channelId = parts[1];
    if (!channelId) return null;
    const sub = parts[2];

    const ch = this.channels.get(channelId);

    // Base channel ops.
    if (!sub) {
      if (!ch) return discordError(404, "Unknown Channel", ErrorCodes.UNKNOWN_CHANNEL);
      if (method === "GET") return this.ok(clone(ch));
      if (method === "PATCH") {
        if (body && typeof body.name === "string") ch.name = body.name;
        if (body && body.topic !== undefined) ch.topic = body.topic;
        if (body && body.nsfw !== undefined) ch.nsfw = Boolean(body.nsfw);
        if (body && body.position !== undefined) ch.position = Number(body.position);
        if (body && body.rate_limit_per_user !== undefined) ch.rate_limit_per_user = Number(body.rate_limit_per_user);
        if (body && body.parent_id !== undefined) ch.parent_id = body.parent_id;
        if (body && body.archived !== undefined && ch.thread_metadata) ch.thread_metadata.archived = Boolean(body.archived);
        return this.ok(clone(ch));
      }
      if (method === "DELETE") {
        this.channels.delete(channelId);
        this.messages.delete(channelId);
        return this.ok(clone(ch));
      }
      return null;
    }

    if (!ch && sub !== "webhooks") {
      return discordError(404, "Unknown Channel", ErrorCodes.UNKNOWN_CHANNEL);
    }

    // /channels/{id}/messages
    if (sub === "messages") return this.routeChannelMessages(method, parts, body, url, ch);

    // /channels/{id}/typing
    if (sub === "typing" && method === "POST") {
      return this.ok(null, 204);
    }

    // /channels/{id}/pins
    if (sub === "pins") return this.routeChannelPins(method, parts, ch);

    // /channels/{id}/permissions/{overwriteId}
    if (sub === "permissions") return this.routeChannelPermissions(method, parts, body, ch);

    // /channels/{id}/invites
    if (sub === "invites") return this.routeChannelInvites(method, parts, body, ch);

    // /channels/{id}/followers
    if (sub === "followers" && method === "POST") {
      return this.ok({ channel_id: channelId, webhook_id: this.snowflake() });
    }

    // /channels/{id}/webhooks
    if (sub === "webhooks") {
      if (!ch) return discordError(404, "Unknown Channel", ErrorCodes.UNKNOWN_CHANNEL);
      if (method === "POST") {
        const wh = this._createWebhook(ch, body);
        return this.ok(clone(this._webhookView(wh)));
      }
      if (method === "GET") {
        const out = [];
        for (const wh of this.webhooks.values()) {
          if (wh.channel_id === channelId) out.push(this._webhookView(wh));
        }
        return this.ok(out);
      }
      return null;
    }

    // /channels/{id}/threads  and message-thread creation
    if (sub === "threads" && method === "POST") {
      return this.routeCreateThread(parts, body, ch, null);
    }

    // /channels/{id}/thread-members
    if (sub === "thread-members") return this.routeThreadMembers(method, parts, ch);

    // /channels/{id}/recipients/{userId} — group DM (rarely used by bots)
    if (sub === "recipients") {
      return this.ok(null, 204);
    }

    return null;
  }

  routeChannelMessages(method, parts, body, url, ch) {
    const channelId = ch.id;
    const messageId = parts[3];
    const store = this.messages.get(channelId) || new Map();

    // /channels/{id}/messages/bulk-delete
    if (messageId === "bulk-delete" && method === "POST") {
      const ids = (body && body.messages) || [];
      for (const id of ids) store.delete(String(id));
      return this.ok(null, 204);
    }

    if (!messageId) {
      // GET list
      if (method === "GET") {
        let list = Array.from(store.values());
        // newest first by id
        list = list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50;
        return this.ok(list.slice(0, limit).map((m) => this._messageView(m)));
      }
      // POST create
      if (method === "POST") {
        return this.routeCreateMessage(channelId, body, ch);
      }
      return null;
    }

    // sub-resource on a specific message
    const sub = parts[4];

    if (!sub) {
      const msg = store.get(messageId);
      if (method === "GET") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        return this.ok(this._messageView(msg));
      }
      if (method === "PATCH") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        if (body && body.content !== undefined) msg.content = body.content || "";
        if (body && body.embeds !== undefined) msg.embeds = clone(body.embeds) || [];
        if (body && body.components !== undefined) msg.components = clone(body.components) || [];
        if (body && body.flags !== undefined) msg.flags = Number(body.flags);
        msg.edited_timestamp = new Date().toISOString();
        return this.ok(this._messageView(msg));
      }
      if (method === "DELETE") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        store.delete(messageId);
        return this.ok(null, 204);
      }
      return null;
    }

    // /messages/{id}/crosspost
    if (sub === "crosspost" && method === "POST") {
      const msg = store.get(messageId);
      if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
      msg.flags = (msg.flags || 0) | 2; // CROSSPOSTED
      return this.ok(this._messageView(msg));
    }

    // /messages/{id}/threads — create thread from message
    if (sub === "threads" && method === "POST") {
      const msg = store.get(messageId);
      if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
      return this.routeCreateThread(parts, body, ch, messageId);
    }

    // /messages/{id}/reactions...
    if (sub === "reactions") {
      return this.routeReactions(method, parts, ch, messageId);
    }

    return null;
  }

  routeCreateMessage(channelId, body, ch) {
    body = body || {};
    const hasContent = typeof body.content === "string" && body.content.length > 0;
    const hasEmbeds = Array.isArray(body.embeds) && body.embeds.length > 0;
    const hasComponents = Array.isArray(body.components) && body.components.length > 0;
    const hasStickers = Array.isArray(body.sticker_ids) && body.sticker_ids.length > 0;
    if (!hasContent && !hasEmbeds && !hasComponents && !hasStickers) {
      return discordError(400, "Cannot send an empty message", ErrorCodes.INVALID_FORM_BODY, {
        content: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "Cannot send an empty message" }] },
      });
    }
    const id = this.snowflake();
    const bot = this.users.get(this.botId);
    let messageReference;
    if (body.message_reference && body.message_reference.message_id) {
      messageReference = {
        message_id: String(body.message_reference.message_id),
        channel_id: body.message_reference.channel_id || channelId,
        guild_id: body.message_reference.guild_id || ch.guild_id,
      };
    }
    const msg = {
      id,
      channel_id: channelId,
      guild_id: ch.guild_id,
      author: this._userView(bot),
      content: hasContent ? body.content : "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: Boolean(body.tts),
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: hasEmbeds ? clone(body.embeds) : [],
      components: hasComponents ? clone(body.components) : [],
      reactions: [],
      pinned: false,
      type: 0,
      flags: body.flags ? Number(body.flags) : 0,
      message_reference: messageReference,
      sticker_items: hasStickers ? body.sticker_ids.map((sid) => ({ id: String(sid), name: "sticker", format_type: 1 })) : undefined,
      nonce: body.nonce,
    };
    if (!this.messages.has(channelId)) this.messages.set(channelId, new Map());
    this.messages.get(channelId).set(id, msg);
    ch.last_message_id = id;
    return this.ok(this._messageView(msg));
  }

  routeReactions(method, parts, ch, messageId) {
    // parts: channels {cid} messages {mid} reactions [emoji] [@me|userId]
    const store = this.messages.get(ch.id) || new Map();
    const msg = store.get(messageId);
    if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
    msg.reactions = msg.reactions || [];

    const emojiRaw = parts[5];
    const userPart = parts[6];

    // DELETE all reactions on a message
    if (method === "DELETE" && emojiRaw === undefined) {
      msg.reactions = [];
      return this.ok(null, 204);
    }

    const emoji = emojiRaw !== undefined ? decodeURIComponent(emojiRaw) : undefined;
    const emojiName = emoji ? this._emojiName(emoji) : undefined;

    // DELETE all reactions for a specific emoji
    if (method === "DELETE" && emoji !== undefined && userPart === undefined) {
      msg.reactions = msg.reactions.filter((r) => this._emojiKey(r.emoji) !== emojiName);
      return this.ok(null, 204);
    }

    // GET /reactions/{emoji} — list users who reacted
    if (method === "GET" && emoji !== undefined) {
      const r = msg.reactions.find((x) => this._emojiKey(x.emoji) === emojiName);
      const users = (r && r._users) || [];
      return this.ok(users.map((uid) => this._userView(this.users.get(uid) || { id: uid, username: "user", discriminator: "0" })));
    }

    // PUT /reactions/{emoji}/@me — add self reaction
    if (method === "PUT" && emoji !== undefined && userPart === "@me") {
      let r = msg.reactions.find((x) => this._emojiKey(x.emoji) === emojiName);
      if (!r) {
        r = { count: 0, me: false, emoji: this._emojiObject(emoji), _users: [] };
        msg.reactions.push(r);
      }
      if (!r._users.includes(this.botId)) {
        r._users.push(this.botId);
        r.count = r._users.length;
        r.me = true;
      }
      return this.ok(null, 204);
    }

    // DELETE /reactions/{emoji}/@me or /{userId}
    if (method === "DELETE" && emoji !== undefined && userPart !== undefined) {
      const uid = userPart === "@me" ? this.botId : userPart;
      const r = msg.reactions.find((x) => this._emojiKey(x.emoji) === emojiName);
      if (r) {
        r._users = (r._users || []).filter((u) => u !== uid);
        r.count = r._users.length;
        r.me = r._users.includes(this.botId);
        if (r.count === 0) msg.reactions = msg.reactions.filter((x) => x !== r);
      }
      return this.ok(null, 204);
    }

    return null;
  }

  routeChannelPins(method, parts, ch) {
    const store = this.messages.get(ch.id) || new Map();
    const messageId = parts[3];

    if (!messageId) {
      // GET list of pinned
      if (method === "GET") {
        const pinned = Array.from(store.values()).filter((m) => m.pinned).map((m) => this._messageView(m));
        return this.ok(pinned);
      }
      return null;
    }
    const msg = store.get(messageId);
    if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
    if (method === "PUT") {
      msg.pinned = true;
      return this.ok(null, 204);
    }
    if (method === "DELETE") {
      msg.pinned = false;
      return this.ok(null, 204);
    }
    return null;
  }

  routeChannelPermissions(method, parts, body, ch) {
    const overwriteId = parts[3];
    if (!overwriteId) return null;
    ch.permission_overwrites = ch.permission_overwrites || [];
    if (method === "PUT") {
      const existing = ch.permission_overwrites.find((o) => o.id === overwriteId);
      const overwrite = {
        id: overwriteId,
        type: body && body.type !== undefined ? Number(body.type) : 0,
        allow: (body && String(body.allow)) || "0",
        deny: (body && String(body.deny)) || "0",
      };
      if (existing) Object.assign(existing, overwrite);
      else ch.permission_overwrites.push(overwrite);
      return this.ok(null, 204);
    }
    if (method === "DELETE") {
      const idx = ch.permission_overwrites.findIndex((o) => o.id === overwriteId);
      if (idx === -1) return discordError(404, "Unknown Overwrite", ErrorCodes.UNKNOWN_OVERWRITE);
      ch.permission_overwrites.splice(idx, 1);
      return this.ok(null, 204);
    }
    return null;
  }

  routeChannelInvites(method, parts, body, ch) {
    if (method === "GET") {
      const out = [];
      for (const inv of this.invites.values()) {
        if (inv.channel.id === ch.id) out.push(clone(inv));
      }
      return this.ok(out);
    }
    if (method === "POST") {
      const code = randomBytes(4).toString("hex").slice(0, 8);
      const invite = {
        code,
        type: 0,
        channel: { id: ch.id, name: ch.name, type: ch.type },
        guild: ch.guild_id ? this._guildInviteView(this.guilds.get(ch.guild_id)) : null,
        inviter: this._userView(this.users.get(this.botId)),
        max_age: body && body.max_age !== undefined ? Number(body.max_age) : 86400,
        max_uses: body && body.max_uses !== undefined ? Number(body.max_uses) : 0,
        temporary: Boolean(body && body.temporary),
        uses: 0,
        created_at: new Date().toISOString(),
      };
      this.invites.set(code, invite);
      return this.ok(clone(invite));
    }
    return null;
  }

  routeCreateThread(parts, body, ch, fromMessageId) {
    body = body || {};
    const id = this.snowflake();
    const thread = {
      id,
      type: body.type !== undefined ? Number(body.type) : (fromMessageId ? ChannelType.PUBLIC_THREAD : ChannelType.PRIVATE_THREAD),
      guild_id: ch.guild_id,
      parent_id: ch.id,
      name: body.name || "thread",
      owner_id: this.botId,
      last_message_id: null,
      message_count: 0,
      member_count: 1,
      rate_limit_per_user: body.rate_limit_per_user ? Number(body.rate_limit_per_user) : 0,
      thread_metadata: {
        archived: false,
        auto_archive_duration: body.auto_archive_duration ? Number(body.auto_archive_duration) : 1440,
        archive_timestamp: new Date().toISOString(),
        locked: false,
      },
    };
    this.channels.set(id, thread);
    this.messages.set(id, new Map());
    this.threadMembers.set(id, new Map([[this.botId, {
      id,
      user_id: this.botId,
      join_timestamp: new Date().toISOString(),
      flags: 0,
    }]]));
    return this.ok(clone(thread));
  }

  routeThreadMembers(method, parts, ch) {
    const tmStore = this.threadMembers.get(ch.id) || new Map();
    this.threadMembers.set(ch.id, tmStore);
    const userPart = parts[3];

    if (!userPart) {
      if (method === "GET") {
        return this.ok(Array.from(tmStore.values()).map(clone));
      }
      return null;
    }
    const uid = userPart === "@me" ? this.botId : userPart;
    if (method === "GET") {
      const tm = tmStore.get(uid);
      if (!tm) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
      return this.ok(clone(tm));
    }
    if (method === "PUT") {
      tmStore.set(uid, { id: ch.id, user_id: uid, join_timestamp: new Date().toISOString(), flags: 0 });
      return this.ok(null, 204);
    }
    if (method === "DELETE") {
      tmStore.delete(uid);
      return this.ok(null, 204);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Guilds
  // -------------------------------------------------------------------------
  routeGuilds(method, parts, body, url) {
    // POST /guilds — create
    if (parts.length === 1 && method === "POST") {
      return this.routeCreateGuild(body);
    }
    const guildId = parts[1];
    if (!guildId) return null;
    const guild = this.guilds.get(guildId);
    const sub = parts[2];

    if (!sub) {
      if (!guild) return discordError(404, "Unknown Guild", ErrorCodes.UNKNOWN_GUILD);
      if (method === "GET") return this.ok(this._guildView(guild, url));
      if (method === "PATCH") {
        if (body && typeof body.name === "string") guild.name = body.name;
        if (body && body.description !== undefined) guild.description = body.description;
        if (body && body.afk_timeout !== undefined) guild.afk_timeout = Number(body.afk_timeout);
        if (body && body.verification_level !== undefined) guild.verification_level = Number(body.verification_level);
        if (body && body.system_channel_id !== undefined) guild.system_channel_id = body.system_channel_id;
        if (body && body.owner_id !== undefined) guild.owner_id = body.owner_id;
        return this.ok(this._guildView(guild, url));
      }
      if (method === "DELETE") {
        this.guilds.delete(guildId);
        this.members.delete(guildId);
        this.roles.delete(guildId);
        this.bans.delete(guildId);
        this.emojis.delete(guildId);
        return this.ok(null, 204);
      }
      return null;
    }

    if (!guild) return discordError(404, "Unknown Guild", ErrorCodes.UNKNOWN_GUILD);

    switch (sub) {
      case "channels":
        return this.routeGuildChannels(method, parts, body, guild);
      case "members":
        return this.routeGuildMembers(method, parts, body, guild, url);
      case "roles":
        return this.routeGuildRoles(method, parts, body, guild);
      case "bans":
        return this.routeGuildBans(method, parts, body, guild);
      case "emojis":
        return this.routeGuildEmojis(method, parts, body, guild);
      case "prune":
        if (method === "GET") return this.ok({ pruned: 0 });
        if (method === "POST") return this.ok({ pruned: 0 });
        return null;
      case "invites":
        if (method === "GET") {
          const out = [];
          for (const inv of this.invites.values()) {
            if (inv.guild && inv.guild.id === guild.id) out.push(clone(inv));
          }
          return this.ok(out);
        }
        return null;
      case "preview":
        if (method === "GET") {
          return this.ok({
            id: guild.id,
            name: guild.name,
            icon: guild.icon,
            splash: null,
            discovery_splash: null,
            emojis: Array.from((this.emojis.get(guild.id) || new Map()).values()),
            features: guild.features || [],
            approximate_member_count: (this.members.get(guild.id) || new Map()).size,
            approximate_presence_count: 0,
            description: guild.description,
          });
        }
        return null;
      case "webhooks":
        if (method === "GET") {
          const out = [];
          for (const wh of this.webhooks.values()) {
            if (wh.guild_id === guild.id) out.push(this._webhookView(wh));
          }
          return this.ok(out);
        }
        return null;
      default:
        return null;
    }
  }

  routeCreateGuild(body) {
    body = body || {};
    if (!body.name) {
      return discordError(400, "Invalid Form Body", ErrorCodes.INVALID_FORM_BODY, {
        name: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] },
      });
    }
    const guildId = this.snowflake();
    const everyone = {
      id: guildId,
      name: "@everyone",
      color: 0,
      hoist: false,
      position: 0,
      permissions: "2248473465835073",
      managed: false,
      mentionable: false,
    };
    const guild = {
      id: guildId,
      name: body.name,
      icon: null,
      description: null,
      owner_id: this.botId,
      afk_timeout: 300,
      verification_level: body.verification_level || 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      features: [],
      system_channel_id: null,
      premium_tier: 0,
      preferred_locale: "en-US",
    };
    this.guilds.set(guildId, guild);
    this.roles.set(guildId, new Map([[everyone.id, everyone]]));
    this.members.set(guildId, new Map());
    this.bans.set(guildId, new Map());
    this.emojis.set(guildId, new Map());
    this._addMember(guildId, this.users.get(this.botId), []);

    // Optional initial channels.
    if (Array.isArray(body.channels)) {
      for (const c of body.channels) {
        const cid = this.snowflake();
        const channel = {
          id: cid,
          type: c.type !== undefined ? Number(c.type) : ChannelType.GUILD_TEXT,
          guild_id: guildId,
          name: c.name || "channel",
          position: 0,
          topic: null,
          nsfw: false,
          parent_id: null,
          permission_overwrites: [],
        };
        this.channels.set(cid, channel);
        this.messages.set(cid, new Map());
      }
    }
    return this.ok(this._guildView(guild), 201);
  }

  routeGuildChannels(method, parts, body, guild) {
    if (method === "GET") {
      const out = [];
      for (const ch of this.channels.values()) {
        if (ch.guild_id === guild.id && !ch.thread_metadata) out.push(clone(ch));
      }
      return this.ok(out);
    }
    if (method === "POST") {
      body = body || {};
      if (!body.name) {
        return discordError(400, "Invalid Form Body", ErrorCodes.INVALID_FORM_BODY, {
          name: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] },
        });
      }
      const id = this.snowflake();
      const ch = {
        id,
        type: body.type !== undefined ? Number(body.type) : ChannelType.GUILD_TEXT,
        guild_id: guild.id,
        name: body.name,
        position: body.position !== undefined ? Number(body.position) : 0,
        topic: body.topic || null,
        nsfw: Boolean(body.nsfw),
        rate_limit_per_user: body.rate_limit_per_user ? Number(body.rate_limit_per_user) : 0,
        bitrate: body.bitrate,
        user_limit: body.user_limit,
        parent_id: body.parent_id || null,
        permission_overwrites: body.permission_overwrites ? clone(body.permission_overwrites) : [],
      };
      this.channels.set(id, ch);
      this.messages.set(id, new Map());
      return this.ok(clone(ch), 201);
    }
    if (method === "PATCH") {
      // bulk position update
      if (Array.isArray(body)) {
        for (const entry of body) {
          const ch = this.channels.get(String(entry.id));
          if (ch && entry.position !== undefined) ch.position = Number(entry.position);
        }
      }
      return this.ok(null, 204);
    }
    return null;
  }

  routeGuildMembers(method, parts, body, guild, url) {
    const members = this.members.get(guild.id) || new Map();
    const userPart = parts[3];

    // GET /guilds/{id}/members/search
    if (userPart === "search" && method === "GET") {
      const query = (url.searchParams.get("query") || "").toLowerCase();
      const out = [];
      for (const m of members.values()) {
        const name = (m.nick || m.user.username || "").toLowerCase();
        if (name.includes(query)) out.push(clone(m));
      }
      return this.ok(out);
    }

    if (!userPart) {
      // GET list
      if (method === "GET") {
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 1000;
        return this.ok(Array.from(members.values()).slice(0, limit).map(clone));
      }
      return null;
    }

    // member role sub-route: /members/{userId}/roles/{roleId}
    if (parts[4] === "roles") {
      const roleId = parts[5];
      const m = members.get(userPart);
      if (!m) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
      const roleStore = this.roles.get(guild.id) || new Map();
      if (!roleStore.has(roleId)) return discordError(404, "Unknown Role", ErrorCodes.UNKNOWN_ROLE);
      if (method === "PUT") {
        if (!m.roles.includes(roleId)) m.roles.push(roleId);
        return this.ok(null, 204);
      }
      if (method === "DELETE") {
        m.roles = m.roles.filter((r) => r !== roleId);
        return this.ok(null, 204);
      }
      return null;
    }

    const uid = userPart === "@me" ? this.botId : userPart;

    if (method === "GET") {
      const m = members.get(uid);
      if (!m) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
      return this.ok(clone(m));
    }
    if (method === "PUT") {
      // Add a member (requires a real user to exist).
      const user = this.users.get(uid);
      if (!user) return discordError(404, "Unknown User", ErrorCodes.UNKNOWN_USER);
      if (members.has(uid)) return this.ok(null, 204); // already a member -> 204 No Content (real API)
      const m = this._addMember(guild.id, user, (body && body.roles) || []);
      if (body && typeof body.nick === "string") m.nick = body.nick;
      return this.ok(clone(m), 201);
    }
    if (method === "PATCH") {
      const m = members.get(uid);
      if (!m) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
      if (body && body.nick !== undefined) m.nick = body.nick;
      if (body && Array.isArray(body.roles)) m.roles = body.roles.slice();
      if (body && body.mute !== undefined) m.mute = Boolean(body.mute);
      if (body && body.deaf !== undefined) m.deaf = Boolean(body.deaf);
      if (body && body.communication_disabled_until !== undefined) m.communication_disabled_until = body.communication_disabled_until;
      return this.ok(clone(m));
    }
    if (method === "DELETE") {
      if (!members.has(uid)) return discordError(404, "Unknown Member", ErrorCodes.UNKNOWN_MEMBER);
      members.delete(uid);
      return this.ok(null, 204);
    }
    return null;
  }

  routeGuildRoles(method, parts, body, guild) {
    const roleStore = this.roles.get(guild.id) || new Map();
    this.roles.set(guild.id, roleStore);
    const roleId = parts[3];

    if (!roleId) {
      if (method === "GET") {
        return this.ok(Array.from(roleStore.values()).map(clone));
      }
      if (method === "POST") {
        body = body || {};
        const id = this.snowflake();
        const role = {
          id,
          name: body.name || "new role",
          color: body.color !== undefined ? Number(body.color) : 0,
          hoist: Boolean(body.hoist),
          position: roleStore.size,
          permissions: body.permissions !== undefined ? String(body.permissions) : "0",
          managed: false,
          mentionable: Boolean(body.mentionable),
        };
        roleStore.set(id, role);
        return this.ok(clone(role), 200);
      }
      if (method === "PATCH") {
        // bulk role position update
        if (Array.isArray(body)) {
          for (const entry of body) {
            const r = roleStore.get(String(entry.id));
            if (r && entry.position !== undefined) r.position = Number(entry.position);
          }
        }
        return this.ok(Array.from(roleStore.values()).map(clone));
      }
      return null;
    }

    const role = roleStore.get(roleId);
    if (method === "PATCH") {
      if (!role) return discordError(404, "Unknown Role", ErrorCodes.UNKNOWN_ROLE);
      if (body && typeof body.name === "string") role.name = body.name;
      if (body && body.color !== undefined) role.color = Number(body.color);
      if (body && body.hoist !== undefined) role.hoist = Boolean(body.hoist);
      if (body && body.permissions !== undefined) role.permissions = String(body.permissions);
      if (body && body.mentionable !== undefined) role.mentionable = Boolean(body.mentionable);
      return this.ok(clone(role));
    }
    if (method === "DELETE") {
      if (!role) return discordError(404, "Unknown Role", ErrorCodes.UNKNOWN_ROLE);
      roleStore.delete(roleId);
      // remove from members
      for (const m of (this.members.get(guild.id) || new Map()).values()) {
        m.roles = m.roles.filter((r) => r !== roleId);
      }
      return this.ok(null, 204);
    }
    return null;
  }

  routeGuildBans(method, parts, body, guild) {
    const banStore = this.bans.get(guild.id) || new Map();
    this.bans.set(guild.id, banStore);
    const userPart = parts[3];

    if (!userPart) {
      if (method === "GET") {
        return this.ok(Array.from(banStore.values()).map(clone));
      }
      return null;
    }
    if (method === "GET") {
      const ban = banStore.get(userPart);
      if (!ban) return discordError(404, "Unknown Ban", ErrorCodes.UNKNOWN_BAN);
      return this.ok(clone(ban));
    }
    if (method === "PUT") {
      const user = this.users.get(userPart);
      if (!user) return discordError(404, "Unknown User", ErrorCodes.UNKNOWN_USER);
      banStore.set(userPart, { reason: (body && body.reason) || null, user: this._userView(user) });
      // banning removes membership
      const members = this.members.get(guild.id);
      if (members) members.delete(userPart);
      return this.ok(null, 204);
    }
    if (method === "DELETE") {
      if (!banStore.has(userPart)) return discordError(404, "Unknown Ban", ErrorCodes.UNKNOWN_BAN);
      banStore.delete(userPart);
      return this.ok(null, 204);
    }
    return null;
  }

  routeGuildEmojis(method, parts, body, guild) {
    const emojiStore = this.emojis.get(guild.id) || new Map();
    this.emojis.set(guild.id, emojiStore);
    const emojiId = parts[3];

    if (!emojiId) {
      if (method === "GET") {
        return this.ok(Array.from(emojiStore.values()).map(clone));
      }
      if (method === "POST") {
        body = body || {};
        if (!body.name) {
          return discordError(400, "Invalid Form Body", ErrorCodes.INVALID_FORM_BODY, {
            name: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] },
          });
        }
        const id = this.snowflake();
        const emoji = {
          id,
          name: body.name,
          roles: body.roles || [],
          user: this._userView(this.users.get(this.botId)),
          require_colons: true,
          managed: false,
          animated: false,
          available: true,
        };
        emojiStore.set(id, emoji);
        return this.ok(clone(emoji), 201);
      }
      return null;
    }
    const emoji = emojiStore.get(emojiId);
    if (method === "GET") {
      if (!emoji) return discordError(404, "Unknown Emoji", ErrorCodes.UNKNOWN_EMOJI);
      return this.ok(clone(emoji));
    }
    if (method === "PATCH") {
      if (!emoji) return discordError(404, "Unknown Emoji", ErrorCodes.UNKNOWN_EMOJI);
      if (body && typeof body.name === "string") emoji.name = body.name;
      if (body && Array.isArray(body.roles)) emoji.roles = body.roles.slice();
      return this.ok(clone(emoji));
    }
    if (method === "DELETE") {
      if (!emoji) return discordError(404, "Unknown Emoji", ErrorCodes.UNKNOWN_EMOJI);
      emojiStore.delete(emojiId);
      return this.ok(null, 204);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------
  routeInvites(method, parts) {
    const code = parts[1];
    if (!code) return null;
    const invite = this.invites.get(code);
    if (method === "GET") {
      if (!invite) return discordError(404, "Unknown Invite", ErrorCodes.UNKNOWN_INVITE);
      return this.ok(clone(invite));
    }
    if (method === "DELETE") {
      if (!invite) return discordError(404, "Unknown Invite", ErrorCodes.UNKNOWN_INVITE);
      this.invites.delete(code);
      return this.ok(clone(invite));
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  _createWebhook(ch, body) {
    body = body || {};
    const id = this.snowflake();
    const wh = {
      id,
      type: 1,
      guild_id: ch.guild_id || null,
      channel_id: ch.id,
      name: body.name || "Parlel Webhook",
      avatar: body.avatar ? "parlelwebhookavatar" : null,
      token: randomBytes(24).toString("hex"),
      application_id: null,
      user: this._userView(this.users.get(this.botId)),
    };
    this.webhooks.set(id, wh);
    return wh;
  }

  routeWebhooks(method, parts, body, url) {
    const webhookId = parts[1];
    if (!webhookId) return null;
    const token = parts[2];
    const wh = this.webhooks.get(webhookId);

    // /webhooks/{id} (token-less, requires auth)
    if (!token) {
      if (method === "GET") {
        if (!wh) return discordError(404, "Unknown Webhook", ErrorCodes.UNKNOWN_WEBHOOK);
        return this.ok(this._webhookView(wh, true));
      }
      if (method === "PATCH") {
        if (!wh) return discordError(404, "Unknown Webhook", ErrorCodes.UNKNOWN_WEBHOOK);
        if (body && typeof body.name === "string") wh.name = body.name;
        if (body && body.channel_id !== undefined) wh.channel_id = body.channel_id;
        return this.ok(this._webhookView(wh, true));
      }
      if (method === "DELETE") {
        if (!wh) return discordError(404, "Unknown Webhook", ErrorCodes.UNKNOWN_WEBHOOK);
        this.webhooks.delete(webhookId);
        return this.ok(null, 204);
      }
      return null;
    }

    // /webhooks/{id}/{token}...
    if (!wh || wh.token !== token) {
      return discordError(404, "Unknown Webhook", ErrorCodes.UNKNOWN_WEBHOOK);
    }

    const messagesSeg = parts[3]; // "messages" | undefined
    if (!messagesSeg) {
      if (method === "GET") return this.ok(this._webhookView(wh));
      if (method === "PATCH") {
        if (body && typeof body.name === "string") wh.name = body.name;
        return this.ok(this._webhookView(wh));
      }
      if (method === "DELETE") {
        this.webhooks.delete(webhookId);
        return this.ok(null, 204);
      }
      // POST execute
      if (method === "POST") {
        return this.routeExecuteWebhook(wh, body, url);
      }
      return null;
    }

    if (messagesSeg === "messages") {
      const messageId = parts[4]; // "@original" | id
      const store = this.messages.get(wh.channel_id) || new Map();
      const realId = messageId === "@original" ? wh._lastMessageId : messageId;
      const msg = realId ? store.get(realId) : null;
      if (method === "GET") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        return this.ok(this._messageView(msg));
      }
      if (method === "PATCH") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        if (body && body.content !== undefined) msg.content = body.content || "";
        if (body && body.embeds !== undefined) msg.embeds = clone(body.embeds) || [];
        msg.edited_timestamp = new Date().toISOString();
        return this.ok(this._messageView(msg));
      }
      if (method === "DELETE") {
        if (!msg) return discordError(404, "Unknown Message", ErrorCodes.UNKNOWN_MESSAGE);
        store.delete(realId);
        return this.ok(null, 204);
      }
    }
    return null;
  }

  routeExecuteWebhook(wh, body, url) {
    body = body || {};
    const hasContent = typeof body.content === "string" && body.content.length > 0;
    const hasEmbeds = Array.isArray(body.embeds) && body.embeds.length > 0;
    if (!hasContent && !hasEmbeds) {
      return discordError(400, "Cannot send an empty message", ErrorCodes.INVALID_FORM_BODY, {
        content: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "Cannot send an empty message" }] },
      });
    }
    const wait = url.searchParams.get("wait") === "true";
    const id = this.snowflake();
    const msg = {
      id,
      channel_id: wh.channel_id,
      guild_id: wh.guild_id,
      author: {
        id: wh.id,
        username: body.username || wh.name,
        avatar: null,
        discriminator: "0000",
        bot: true,
      },
      content: hasContent ? body.content : "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: Boolean(body.tts),
      embeds: hasEmbeds ? clone(body.embeds) : [],
      components: body.components ? clone(body.components) : [],
      attachments: [],
      mentions: [],
      mention_roles: [],
      reactions: [],
      pinned: false,
      type: 0,
      webhook_id: wh.id,
      flags: body.flags ? Number(body.flags) : 0,
    };
    if (!this.messages.has(wh.channel_id)) this.messages.set(wh.channel_id, new Map());
    this.messages.get(wh.channel_id).set(id, msg);
    wh._lastMessageId = id;
    if (wait) return this.ok(this._messageView(msg));
    return this.ok(null, 204);
  }

  // -------------------------------------------------------------------------
  // Applications (slash commands)
  // -------------------------------------------------------------------------
  routeApplications(method, parts, body) {
    const appId = parts[1];
    if (!appId) return null;
    // /applications/{appId}/commands
    // /applications/{appId}/guilds/{guildId}/commands
    let guildId = null;
    let commandsIdx = 2;
    if (parts[2] === "guilds") {
      guildId = parts[3];
      commandsIdx = 4;
    }
    if (parts[commandsIdx] !== "commands") return null;
    const commandId = parts[commandsIdx + 1];

    if (!commandId) {
      if (method === "GET") {
        const out = [];
        for (const c of this.commands.values()) {
          if ((c.guild_id || null) === (guildId || null) && c.application_id === appId) out.push(clone(c));
        }
        return this.ok(out);
      }
      if (method === "POST") {
        return this.routeCreateCommand(appId, guildId, body);
      }
      if (method === "PUT") {
        // bulk overwrite
        const incoming = Array.isArray(body) ? body : [];
        // remove existing for this scope
        for (const [id, c] of Array.from(this.commands.entries())) {
          if ((c.guild_id || null) === (guildId || null) && c.application_id === appId) this.commands.delete(id);
        }
        const out = [];
        for (const cmd of incoming) {
          const created = this.routeCreateCommand(appId, guildId, cmd);
          out.push(created.body);
        }
        return this.ok(out);
      }
      return null;
    }

    const cmd = this.commands.get(commandId);
    if (method === "GET") {
      if (!cmd) return discordError(404, "Unknown Command", ErrorCodes.UNKNOWN_COMMAND);
      return this.ok(clone(cmd));
    }
    if (method === "PATCH") {
      if (!cmd) return discordError(404, "Unknown Command", ErrorCodes.UNKNOWN_COMMAND);
      if (body && typeof body.name === "string") cmd.name = body.name;
      if (body && body.description !== undefined) cmd.description = body.description;
      if (body && body.options !== undefined) cmd.options = clone(body.options);
      if (body && body.default_member_permissions !== undefined) cmd.default_member_permissions = body.default_member_permissions;
      return this.ok(clone(cmd));
    }
    if (method === "DELETE") {
      if (!cmd) return discordError(404, "Unknown Command", ErrorCodes.UNKNOWN_COMMAND);
      this.commands.delete(commandId);
      return this.ok(null, 204);
    }
    return null;
  }

  routeCreateCommand(appId, guildId, body) {
    body = body || {};
    if (!body.name) {
      return discordError(400, "Invalid Form Body", ErrorCodes.INVALID_FORM_BODY, {
        name: { _errors: [{ code: "BASE_TYPE_REQUIRED", message: "This field is required" }] },
      });
    }
    const id = this.snowflake();
    const cmd = {
      id,
      application_id: appId,
      guild_id: guildId || undefined,
      type: body.type !== undefined ? Number(body.type) : 1,
      name: body.name,
      description: body.description || "",
      options: body.options ? clone(body.options) : [],
      default_member_permissions: body.default_member_permissions ?? null,
      dm_permission: body.dm_permission ?? true,
      nsfw: Boolean(body.nsfw),
      version: this.snowflake(),
    };
    this.commands.set(id, cmd);
    return this.ok(clone(cmd), 201);
  }

  // -------------------------------------------------------------------------
  // Views / helpers
  // -------------------------------------------------------------------------
  // Serialize a stored message to the exact wire shape Discord returns. The
  // internal reaction bookkeeping field `_users` is stripped, and reactions are
  // normalized to the Discord v10 Reaction object (with `count_details`,
  // `me_burst`, and `burst_colors`) so client code that reads those fields works
  // identically to production.
  _messageView(msg) {
    if (!msg) return msg;
    const v = clone(msg);
    if (Array.isArray(v.reactions)) {
      v.reactions = v.reactions.map((r) => {
        const count = r.count || 0;
        return {
          count,
          count_details: { burst: 0, normal: count },
          me: Boolean(r.me),
          me_burst: false,
          emoji: r.emoji,
          burst_colors: [],
        };
      });
    }
    return v;
  }

  _userView(u, includePrivate = false) {
    if (!u) return null;
    const v = {
      id: u.id,
      username: u.username,
      discriminator: u.discriminator || "0",
      global_name: u.global_name ?? null,
      avatar: u.avatar ?? null,
      bot: Boolean(u.bot),
      system: Boolean(u.system),
      banner: null,
      accent_color: null,
      public_flags: u.flags || 0,
    };
    if (includePrivate) {
      v.mfa_enabled = Boolean(u.mfa_enabled);
      v.verified = Boolean(u.verified);
      v.email = u.email ?? null;
      v.flags = u.flags || 0;
      v.locale = "en-US";
    }
    return v;
  }

  _guildView(guild, url) {
    const v = clone(guild);
    v.roles = Array.from((this.roles.get(guild.id) || new Map()).values()).map(clone);
    v.emojis = Array.from((this.emojis.get(guild.id) || new Map()).values()).map(clone);
    if (url && (url.searchParams.get("with_counts") === "true")) {
      v.approximate_member_count = (this.members.get(guild.id) || new Map()).size;
      v.approximate_presence_count = 0;
    }
    return v;
  }

  _guildInviteView(guild) {
    if (!guild) return null;
    return { id: guild.id, name: guild.name, icon: guild.icon, features: guild.features || [] };
  }

  _webhookView(wh, includeToken = false) {
    const v = clone(wh);
    delete v._lastMessageId;
    if (!includeToken) {
      // token is still typically returned for incoming webhooks; keep it.
    }
    return v;
  }

  // Emoji normalization for reaction routes.
  // Unicode: "🔥"; custom: "name:id".
  _emojiName(raw) {
    return raw; // the raw encoded form is the comparison key
  }

  _emojiKey(emojiObj) {
    if (!emojiObj) return "";
    if (emojiObj.id) return `${emojiObj.name}:${emojiObj.id}`;
    return emojiObj.name;
  }

  _emojiObject(raw) {
    // custom emoji format "name:id"
    const m = String(raw).match(/^(.+):(\d+)$/);
    if (m) return { id: m[2], name: m[1], animated: false };
    return { id: null, name: raw };
  }

  _tokenFromRequest(req) {
    const auth = req.headers.authorization || "";
    const bot = auth.match(/^Bot\s+(\S+)/i);
    if (bot) return bot[1];
    const bearer = auth.match(/^Bearer\s+(\S+)/i);
    if (bearer) return bearer[1];
    if (auth) return auth.trim();
    return null;
  }

  // -------------------------------------------------------------------------
  // parlel control / inspection endpoints (not part of Discord).
  // -------------------------------------------------------------------------
  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "messages") {
      const out = [];
      for (const [chId, store] of this.messages.entries()) {
        for (const m of store.values()) out.push({ channel_id: chId, ...this._messageView(m) });
      }
      return this.send(res, 200, { messages: out, count: out.length });
    }
    if (req.method === "GET" && parts[1] === "channels") {
      const channels = Array.from(this.channels.values()).map(clone);
      return this.send(res, 200, { channels, count: channels.length });
    }
    if (req.method === "GET" && parts[1] === "guilds") {
      const guilds = Array.from(this.guilds.values()).map((g) => this._guildView(g));
      return this.send(res, 200, { guilds, count: guilds.length });
    }
    // POST /__parlel/users — add a user fixture for tests.
    if (req.method === "POST" && parts[1] === "users") {
      const u = isPlainObject(body) ? body : {};
      const id = u.id || this.snowflake();
      const user = {
        id,
        username: u.username || `user${id}`,
        discriminator: u.discriminator || "0",
        global_name: u.global_name || u.username || null,
        avatar: u.avatar || null,
        bot: Boolean(u.bot),
        system: false,
      };
      this.users.set(id, user);
      return this.send(res, 200, { ok: true, user: this._userView(user) });
    }
    return this.send(res, 404, { message: "404: Not Found", code: 0 });
  }

  root() {
    return {
      name: "discord",
      version: "1.0",
      protocol: "discord-rest-api",
      api_version: "v10",
      documentation: "/docs/discord.md",
    };
  }

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
        if (contentType.includes("multipart/form-data")) {
          // discord.js sends payload_json for file uploads; extract it best-effort.
          const m = data.match(/name="payload_json"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/);
          if (m) {
            try {
              return resolve({ body: JSON.parse(m[1]), contentType });
            } catch {
              return resolve({ body: {}, contentType });
            }
          }
          return resolve({ body: {}, contentType });
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

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}

export default DiscordServer;
