import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SlackServer } from "../services/slack/src/server.js";

const PORT = 14654;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API_URL = `${BASE_URL}/api`;
const TOKEN = "xoxb-parlel-test-token";

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: any;
}

/** Raw HTTP call to a Slack API method (mirrors the wire format). */
async function call(method: string, args: Json = {}, token: string | null = TOKEN): Promise<any> {
  const headers: Json = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  return res.json();
}

/** Raw call sending application/x-www-form-urlencoded (the @slack/web-api default). */
async function callForm(method: string, args: Json = {}, token: string | null = TOKEN): Promise<any> {
  const headers: Json = { "Content-Type": "application/x-www-form-urlencoded" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${API_URL}/${method}`, { method: "POST", headers, body: params.toString() });
  return res.json();
}

async function http(method: string, path: string, body?: any): Promise<ApiResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A faithful, dependency-free re-implementation of how `@slack/web-api`'s
 * `WebClient` dispatches requests. The real client:
 *   - POSTs form-encoded args to `${slackApiUrl}${method}`
 *   - sends the token via `Authorization: Bearer <token>`
 *   - parses the JSON response and, when `ok === false`, throws an Error with
 *     `code === 'slack_webapi_platform_error'` and `error.data.error` set.
 * This mirror lets us exercise the exact protocol with zero external deps.
 */
class WebClientSim {
  constructor(private token: string, private apiUrl = `${API_URL}/`) {}

  async apiCall(method: string, args: Json = {}): Promise<any> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null) continue;
      params.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(`${this.apiUrl}${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "slack-web-api:sim",
      },
      body: params.toString(),
    });
    const data = await res.json();
    if (!data.ok) {
      const e: any = new Error(`An API error occurred: ${data.error}`);
      e.code = "slack_webapi_platform_error";
      e.data = data;
      throw e;
    }
    return data;
  }

  auth = { test: (a: Json = {}) => this.apiCall("auth.test", a), revoke: (a: Json = {}) => this.apiCall("auth.revoke", a) };
  chat = {
    postMessage: (a: Json) => this.apiCall("chat.postMessage", a),
    postEphemeral: (a: Json) => this.apiCall("chat.postEphemeral", a),
    update: (a: Json) => this.apiCall("chat.update", a),
    delete: (a: Json) => this.apiCall("chat.delete", a),
    meMessage: (a: Json) => this.apiCall("chat.meMessage", a),
    getPermalink: (a: Json) => this.apiCall("chat.getPermalink", a),
    scheduleMessage: (a: Json) => this.apiCall("chat.scheduleMessage", a),
    deleteScheduledMessage: (a: Json) => this.apiCall("chat.deleteScheduledMessage", a),
    scheduledMessages: { list: (a: Json = {}) => this.apiCall("chat.scheduledMessages.list", a) },
  };
  conversations = {
    list: (a: Json = {}) => this.apiCall("conversations.list", a),
    create: (a: Json) => this.apiCall("conversations.create", a),
    info: (a: Json) => this.apiCall("conversations.info", a),
    history: (a: Json) => this.apiCall("conversations.history", a),
    replies: (a: Json) => this.apiCall("conversations.replies", a),
    members: (a: Json) => this.apiCall("conversations.members", a),
    join: (a: Json) => this.apiCall("conversations.join", a),
    leave: (a: Json) => this.apiCall("conversations.leave", a),
    open: (a: Json) => this.apiCall("conversations.open", a),
    invite: (a: Json) => this.apiCall("conversations.invite", a),
    kick: (a: Json) => this.apiCall("conversations.kick", a),
    rename: (a: Json) => this.apiCall("conversations.rename", a),
    setTopic: (a: Json) => this.apiCall("conversations.setTopic", a),
    setPurpose: (a: Json) => this.apiCall("conversations.setPurpose", a),
    archive: (a: Json) => this.apiCall("conversations.archive", a),
    unarchive: (a: Json) => this.apiCall("conversations.unarchive", a),
    mark: (a: Json) => this.apiCall("conversations.mark", a),
  };
  users = {
    list: (a: Json = {}) => this.apiCall("users.list", a),
    info: (a: Json) => this.apiCall("users.info", a),
    lookupByEmail: (a: Json) => this.apiCall("users.lookupByEmail", a),
    identity: (a: Json = {}) => this.apiCall("users.identity", a),
    setPresence: (a: Json) => this.apiCall("users.setPresence", a),
    getPresence: (a: Json = {}) => this.apiCall("users.getPresence", a),
    conversations: (a: Json = {}) => this.apiCall("users.conversations", a),
    profile: {
      get: (a: Json = {}) => this.apiCall("users.profile.get", a),
      set: (a: Json) => this.apiCall("users.profile.set", a),
    },
  };
  reactions = {
    add: (a: Json) => this.apiCall("reactions.add", a),
    remove: (a: Json) => this.apiCall("reactions.remove", a),
    get: (a: Json) => this.apiCall("reactions.get", a),
    list: (a: Json = {}) => this.apiCall("reactions.list", a),
  };
  pins = {
    add: (a: Json) => this.apiCall("pins.add", a),
    remove: (a: Json) => this.apiCall("pins.remove", a),
    list: (a: Json) => this.apiCall("pins.list", a),
  };
  bookmarks = {
    add: (a: Json) => this.apiCall("bookmarks.add", a),
    list: (a: Json) => this.apiCall("bookmarks.list", a),
    edit: (a: Json) => this.apiCall("bookmarks.edit", a),
    remove: (a: Json) => this.apiCall("bookmarks.remove", a),
  };
  files = {
    upload: (a: Json) => this.apiCall("files.upload", a),
    info: (a: Json) => this.apiCall("files.info", a),
    list: (a: Json = {}) => this.apiCall("files.list", a),
    delete: (a: Json) => this.apiCall("files.delete", a),
    getUploadURLExternal: (a: Json) => this.apiCall("files.getUploadURLExternal", a),
    completeUploadExternal: (a: Json) => this.apiCall("files.completeUploadExternal", a),
  };
  views = {
    open: (a: Json) => this.apiCall("views.open", a),
    publish: (a: Json) => this.apiCall("views.publish", a),
    push: (a: Json) => this.apiCall("views.push", a),
    update: (a: Json) => this.apiCall("views.update", a),
  };
  team = { info: (a: Json = {}) => this.apiCall("team.info", a) };
  usergroups = {
    create: (a: Json) => this.apiCall("usergroups.create", a),
    list: (a: Json = {}) => this.apiCall("usergroups.list", a),
    update: (a: Json) => this.apiCall("usergroups.update", a),
    users: {
      list: (a: Json) => this.apiCall("usergroups.users.list", a),
      update: (a: Json) => this.apiCall("usergroups.users.update", a),
    },
  };
  emoji = { list: (a: Json = {}) => this.apiCall("emoji.list", a) };
  api = { test: (a: Json = {}) => this.apiCall("api.test", a) };
}

async function expectError(p: Promise<any>, code: string) {
  await expect(p).rejects.toMatchObject({
    code: "slack_webapi_platform_error",
    data: { ok: false, error: code },
  });
}

describe("Slack Service", () => {
  let server: SlackServer;
  let web: WebClientSim;

  beforeAll(async () => {
    server = new SlackServer(PORT);
    await server.start();
    web = new WebClientSim(TOKEN);
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    await http("POST", "/__parlel/reset");
  });

  // -------------------------------------------------------------------------
  describe("Infrastructure", () => {
    it("GET /health returns ok", async () => {
      const { status, body } = await http("GET", "/health");
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok" });
    });

    it("GET / returns service metadata", async () => {
      const { body } = await http("GET", "/");
      expect(body.name).toBe("slack");
      expect(body.protocol).toBe("slack-web-api");
    });

    it("unknown method returns ok:false unknown_method", async () => {
      const r = await call("does.notExist");
      expect(r.ok).toBe(false);
      expect(r.error).toBe("unknown_method");
    });

    it("accepts form-urlencoded bodies (the SDK default)", async () => {
      const r = await callForm("auth.test");
      expect(r.ok).toBe(true);
      expect(r.team_id).toBe("T_PARLEL01");
    });
  });

  // -------------------------------------------------------------------------
  describe("Auth", () => {
    it("api.test echoes args without auth", async () => {
      const r = await call("api.test", { foo: "bar" }, null);
      expect(r.ok).toBe(true);
      expect(r.args).toEqual({ foo: "bar" });
    });

    it("api.test returns the provided error", async () => {
      const r = await call("api.test", { error: "my_error" }, null);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("my_error");
    });

    it("missing token -> not_authed", async () => {
      const r = await call("auth.test", {}, null);
      expect(r).toMatchObject({ ok: false, error: "not_authed" });
    });

    it("invalid token -> invalid_auth", async () => {
      const r = await call("auth.test", {}, "xoxb-nope");
      expect(r).toMatchObject({ ok: false, error: "invalid_auth" });
    });

    it("auth.test returns identity", async () => {
      const r = await web.auth.test();
      expect(r.ok).toBe(true);
      expect(r.user_id).toBe("U_BOT00001");
      expect(r.team_id).toBe("T_PARLEL01");
      expect(r.bot_id).toBe("B_BOT00001");
    });

    it("token accepted in body param", async () => {
      const r = await call("auth.test", { token: TOKEN }, null);
      expect(r.ok).toBe(true);
    });

    it("auth.revoke with test=true does not revoke", async () => {
      const r = await web.auth.revoke({ test: true });
      expect(r.revoked).toBe(false);
      expect((await web.auth.test()).ok).toBe(true);
    });

    it("auth.revoke revokes the token", async () => {
      const tmp = new WebClientSim("xoxp-parlel-test-token");
      const r = await tmp.auth.revoke({});
      expect(r.revoked).toBe(true);
      await expectError(tmp.auth.test(), "token_revoked");
    });
  });

  // -------------------------------------------------------------------------
  describe("chat", () => {
    it("postMessage happy path", async () => {
      const r = await web.chat.postMessage({ channel: "C_GENERAL1", text: "hello world" });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("C_GENERAL1");
      expect(r.ts).toMatch(/^\d+\.\d+$/);
      expect(r.message.text).toBe("hello world");
      expect(r.message.bot_id).toBe("B_BOT00001");
    });

    it("postMessage resolves channel by #name", async () => {
      const r = await web.chat.postMessage({ channel: "#general", text: "via name" });
      expect(r.channel).toBe("C_GENERAL1");
    });

    it("postMessage from a bot token returns subtype bot_message + username", async () => {
      // Real API: a message posted with a bot token is a "bot_message" and
      // carries a `username`. Client code commonly filters on this subtype.
      const r = await web.chat.postMessage({ channel: "C_GENERAL1", text: "beep" });
      expect(r.message.type).toBe("message");
      expect(r.message.subtype).toBe("bot_message");
      expect(r.message.username).toBe("parlelbot");
      expect(r.message.bot_id).toBe("B_BOT00001");
    });

    it("postMessage honors a custom username override", async () => {
      const r = await web.chat.postMessage({ channel: "C_GENERAL1", text: "as ecto1", username: "ecto1" });
      expect(r.message.username).toBe("ecto1");
      expect(r.message.subtype).toBe("bot_message");
    });

    it("postMessage with blocks but no text", async () => {
      const r = await web.chat.postMessage({
        channel: "C_GENERAL1",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "*hi*" } }],
      });
      expect(r.ok).toBe(true);
      expect(r.message.blocks).toHaveLength(1);
    });

    it("postMessage missing channel -> channel_not_found", async () => {
      await expectError(web.chat.postMessage({ text: "x" } as any), "channel_not_found");
    });

    it("postMessage unknown channel -> channel_not_found", async () => {
      await expectError(web.chat.postMessage({ channel: "C_NOPE", text: "x" }), "channel_not_found");
    });

    it("postMessage no content -> no_text", async () => {
      await expectError(web.chat.postMessage({ channel: "C_GENERAL1" }), "no_text");
    });

    it("threaded reply increments parent reply_count", async () => {
      const parent = await web.chat.postMessage({ channel: "C_GENERAL1", text: "parent" });
      const reply = await web.chat.postMessage({ channel: "C_GENERAL1", text: "child", thread_ts: parent.ts });
      expect(reply.ok).toBe(true);
      const thread = await web.conversations.replies({ channel: "C_GENERAL1", ts: parent.ts });
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[0].reply_count).toBe(1);
    });

    it("reply to missing thread -> thread_not_found", async () => {
      await expectError(
        web.chat.postMessage({ channel: "C_GENERAL1", text: "x", thread_ts: "1.1" }),
        "thread_not_found",
      );
    });

    it("postEphemeral", async () => {
      const r = await web.chat.postEphemeral({ channel: "C_GENERAL1", user: "U_ALICE001", text: "secret" });
      expect(r.ok).toBe(true);
      expect(r.message_ts).toMatch(/^\d+\.\d+$/);
    });

    it("update edits a message", async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "before" });
      const r = await web.chat.update({ channel: "C_GENERAL1", ts: m.ts, text: "after" });
      expect(r.ok).toBe(true);
      expect(r.text).toBe("after");
      expect(r.message.edited).toBeTruthy();
    });

    it("update missing message -> message_not_found", async () => {
      await expectError(web.chat.update({ channel: "C_GENERAL1", ts: "1.1", text: "x" }), "message_not_found");
    });

    it("delete removes a message", async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "delete me" });
      const r = await web.chat.delete({ channel: "C_GENERAL1", ts: m.ts });
      expect(r.ok).toBe(true);
      const hist = await web.conversations.history({ channel: "C_GENERAL1" });
      expect(hist.messages.find((x: any) => x.ts === m.ts)).toBeUndefined();
    });

    it("delete missing message -> message_not_found", async () => {
      await expectError(web.chat.delete({ channel: "C_GENERAL1", ts: "1.1" }), "message_not_found");
    });

    it("meMessage", async () => {
      const r = await web.chat.meMessage({ channel: "C_GENERAL1", text: "waves" });
      expect(r.ok).toBe(true);
      expect(r.ts).toBeTruthy();
    });

    it("getPermalink", async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "link me" });
      const r = await web.chat.getPermalink({ channel: "C_GENERAL1", message_ts: m.ts });
      expect(r.ok).toBe(true);
      expect(r.permalink).toContain("/archives/C_GENERAL1/p");
    });

    it("scheduleMessage + list + delete", async () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      const r = await web.chat.scheduleMessage({ channel: "C_GENERAL1", text: "later", post_at: future });
      expect(r.ok).toBe(true);
      expect(r.scheduled_message_id).toBeTruthy();
      const list = await web.chat.scheduledMessages.list({});
      expect(list.scheduled_messages).toHaveLength(1);
      const del = await web.chat.deleteScheduledMessage({ channel: "C_GENERAL1", scheduled_message_id: r.scheduled_message_id });
      expect(del.ok).toBe(true);
      const list2 = await web.chat.scheduledMessages.list({});
      expect(list2.scheduled_messages).toHaveLength(0);
    });

    it("scheduleMessage in the past -> time_in_past", async () => {
      await expectError(
        web.chat.scheduleMessage({ channel: "C_GENERAL1", text: "x", post_at: 1 }),
        "time_in_past",
      );
    });

    it("deleteScheduledMessage invalid id", async () => {
      await expectError(
        web.chat.deleteScheduledMessage({ channel: "C_GENERAL1", scheduled_message_id: "QNOPE" }),
        "invalid_scheduled_message_id",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("conversations", () => {
    it("list returns seeded public channels", async () => {
      const r = await web.conversations.list({});
      expect(r.ok).toBe(true);
      const names = r.channels.map((c: any) => c.name);
      expect(names).toContain("general");
      expect(names).toContain("random");
    });

    it("create a channel", async () => {
      const r = await web.conversations.create({ name: "project-x" });
      expect(r.ok).toBe(true);
      expect(r.channel.name).toBe("project-x");
      expect(r.channel.id).toMatch(/^C/);
    });

    it("create duplicate -> name_taken", async () => {
      await expectError(web.conversations.create({ name: "general" }), "name_taken");
    });

    it("create invalid name (specials) -> invalid_name_specials", async () => {
      // Uppercase + spaces + punctuation are disallowed chars (real API).
      await expectError(web.conversations.create({ name: "Bad Name!" }), "invalid_name_specials");
    });

    it("create empty name -> invalid_name_required", async () => {
      await expectError(web.conversations.create({ name: "" } as any), "invalid_name_required");
    });

    it("create name too long -> invalid_name_maxlength", async () => {
      await expectError(web.conversations.create({ name: "a".repeat(81) }), "invalid_name_maxlength");
    });

    it("create punctuation-only name -> invalid_name_punctuation", async () => {
      await expectError(web.conversations.create({ name: "---" }), "invalid_name_punctuation");
    });

    it("created channel object carries standard fidelity fields", async () => {
      const r = await web.conversations.create({ name: "fidelity-room" });
      const ch = r.channel;
      // Fields the real conversations.create response always includes.
      expect(ch.is_member).toBe(true); // creator/bot is a member
      expect(ch.unlinked).toBe(0);
      expect(ch.is_shared).toBe(false);
      expect(ch.is_ext_shared).toBe(false);
      expect(ch.is_org_shared).toBe(false);
      expect(ch.is_pending_ext_shared).toBe(false);
      expect(ch.pending_shared).toEqual([]);
      expect(ch.previous_names).toEqual([]);
      expect(ch.is_channel).toBe(true);
      expect(ch.name_normalized).toBe("fidelity-room");
    });

    it("rename invalid name -> invalid_name_specials", async () => {
      await expectError(
        web.conversations.rename({ channel: "C_RANDOM01", name: "Has Spaces" }),
        "invalid_name_specials",
      );
    });

    it("create private channel", async () => {
      const r = await web.conversations.create({ name: "secret-room", is_private: true });
      expect(r.channel.is_private).toBe(true);
    });

    it("info", async () => {
      const r = await web.conversations.info({ channel: "C_GENERAL1", include_num_members: true });
      expect(r.channel.name).toBe("general");
      expect(r.channel.num_members).toBeGreaterThan(0);
    });

    it("info unknown -> channel_not_found", async () => {
      await expectError(web.conversations.info({ channel: "C_NOPE" }), "channel_not_found");
    });

    it("channel objects report is_member per the calling bot", async () => {
      // Seeded: bot is in #general, only alice is in #random.
      const list = await web.conversations.list({});
      const general = list.channels.find((c: any) => c.name === "general");
      const random = list.channels.find((c: any) => c.name === "random");
      expect(general.is_member).toBe(true);
      expect(random.is_member).toBe(false);
      // is_member flips after the bot joins.
      await web.conversations.join({ channel: "C_RANDOM01" });
      const after = await web.conversations.info({ channel: "C_RANDOM01" });
      expect(after.channel.is_member).toBe(true);
      // list objects must not leak the internal members array.
      expect(general.members).toBeUndefined();
    });

    it("history returns newest-first", async () => {
      await web.chat.postMessage({ channel: "C_GENERAL1", text: "first" });
      await web.chat.postMessage({ channel: "C_GENERAL1", text: "second" });
      const r = await web.conversations.history({ channel: "C_GENERAL1" });
      expect(r.messages[0].text).toBe("second");
      expect(r.messages[1].text).toBe("first");
    });

    it("history respects limit + has_more", async () => {
      for (let i = 0; i < 5; i++) await web.chat.postMessage({ channel: "C_GENERAL1", text: `m${i}` });
      const r = await web.conversations.history({ channel: "C_GENERAL1", limit: 2 });
      expect(r.messages).toHaveLength(2);
      expect(r.has_more).toBe(true);
    });

    it("members", async () => {
      const r = await web.conversations.members({ channel: "C_GENERAL1" });
      expect(r.members).toContain("U_ALICE001");
    });

    it("join + leave", async () => {
      const j = await web.conversations.join({ channel: "C_RANDOM01" });
      expect(j.ok).toBe(true);
      const mem = await web.conversations.members({ channel: "C_RANDOM01" });
      expect(mem.members).toContain("U_BOT00001");
      const l = await web.conversations.leave({ channel: "C_RANDOM01" });
      expect(l.ok).toBe(true);
    });

    it("open a DM", async () => {
      const r = await web.conversations.open({ users: "U_ALICE001" });
      expect(r.ok).toBe(true);
      expect(r.channel.id).toMatch(/^D/);
    });

    it("open an MPIM", async () => {
      await http("POST", "/__parlel/users", { id: "U_BOB00001", name: "bob" });
      const r = await web.conversations.open({ users: "U_ALICE001,U_BOB00001" });
      expect(r.channel.id).toMatch(/^G/);
      expect(r.channel.is_mpim).toBe(true);
    });

    it("open unknown user -> user_not_found", async () => {
      await expectError(web.conversations.open({ users: "U_GHOST" }), "user_not_found");
    });

    it("invite + kick", async () => {
      const r = await web.conversations.invite({ channel: "C_RANDOM01", users: "U_BOT00001" });
      expect(r.ok).toBe(true);
      const k = await web.conversations.kick({ channel: "C_RANDOM01", user: "U_BOT00001" });
      expect(k.ok).toBe(true);
    });

    it("kick non-member -> not_in_channel", async () => {
      await expectError(web.conversations.kick({ channel: "C_RANDOM01", user: "U_BOT00001" }), "not_in_channel");
    });

    it("rename", async () => {
      const r = await web.conversations.rename({ channel: "C_RANDOM01", name: "random-renamed" });
      expect(r.channel.name).toBe("random-renamed");
    });

    it("setTopic + setPurpose", async () => {
      const t = await web.conversations.setTopic({ channel: "C_GENERAL1", topic: "Daily standup" });
      expect(t.topic).toBe("Daily standup");
      const p = await web.conversations.setPurpose({ channel: "C_GENERAL1", purpose: "Team comms" });
      expect(p.purpose).toBe("Team comms");
      const info = await web.conversations.info({ channel: "C_GENERAL1" });
      expect(info.channel.topic.value).toBe("Daily standup");
      expect(info.channel.purpose.value).toBe("Team comms");
    });

    it("archive + unarchive", async () => {
      const a = await web.conversations.archive({ channel: "C_RANDOM01" });
      expect(a.ok).toBe(true);
      await expectError(web.conversations.archive({ channel: "C_RANDOM01" }), "already_archived");
      const u = await web.conversations.unarchive({ channel: "C_RANDOM01" });
      expect(u.ok).toBe(true);
    });

    it("cannot archive general -> cant_archive_general", async () => {
      await expectError(web.conversations.archive({ channel: "C_GENERAL1" }), "cant_archive_general");
    });

    it("mark", async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "read this" });
      const r = await web.conversations.mark({ channel: "C_GENERAL1", ts: m.ts });
      expect(r.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("users", () => {
    it("list", async () => {
      const r = await web.users.list({});
      expect(r.ok).toBe(true);
      const ids = r.members.map((u: any) => u.id);
      expect(ids).toContain("U_ALICE001");
    });

    it("info", async () => {
      const r = await web.users.info({ user: "U_ALICE001" });
      expect(r.user.name).toBe("alice");
      expect(r.user.tz).toBeTruthy();
    });

    it("info unknown -> user_not_found", async () => {
      await expectError(web.users.info({ user: "U_GHOST" }), "user_not_found");
    });

    it("lookupByEmail", async () => {
      const r = await web.users.lookupByEmail({ email: "alice@parlel.test" });
      expect(r.user.id).toBe("U_ALICE001");
    });

    it("lookupByEmail missing -> users_not_found", async () => {
      await expectError(web.users.lookupByEmail({ email: "nobody@parlel.test" }), "users_not_found");
    });

    it("identity", async () => {
      const r = await web.users.identity();
      expect(r.user.id).toBe("U_BOT00001");
      expect(r.team.id).toBe("T_PARLEL01");
    });

    it("setPresence + getPresence", async () => {
      const s = await web.users.setPresence({ presence: "auto" });
      expect(s.ok).toBe(true);
      const g = await web.users.getPresence({});
      expect(g.presence).toBe("active");
      expect(g.online).toBe(true);
    });

    it("setPresence invalid -> invalid_presence", async () => {
      await expectError(web.users.setPresence({ presence: "bogus" }), "invalid_presence");
    });

    it("conversations lists channels the user is in", async () => {
      const r = await web.users.conversations({ user: "U_ALICE001" });
      const names = r.channels.map((c: any) => c.name);
      expect(names).toContain("general");
    });

    it("profile get + set", async () => {
      const set = await web.users.profile.set({ profile: { status_text: "Working", real_name: "Parlel Bot 2" } });
      expect(set.profile.status_text).toBe("Working");
      const get = await web.users.profile.get({});
      expect(get.profile.real_name).toBe("Parlel Bot 2");
    });
  });

  // -------------------------------------------------------------------------
  describe("reactions", () => {
    let ts: string;
    beforeEach(async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "react to me" });
      ts = m.ts;
    });

    it("add + get", async () => {
      const a = await web.reactions.add({ channel: "C_GENERAL1", timestamp: ts, name: "thumbsup" });
      expect(a.ok).toBe(true);
      const g = await web.reactions.get({ channel: "C_GENERAL1", timestamp: ts });
      expect(g.message.reactions[0].name).toBe("thumbsup");
      expect(g.message.reactions[0].count).toBe(1);
    });

    it("add twice -> already_reacted", async () => {
      await web.reactions.add({ channel: "C_GENERAL1", timestamp: ts, name: "eyes" });
      await expectError(web.reactions.add({ channel: "C_GENERAL1", timestamp: ts, name: "eyes" }), "already_reacted");
    });

    it("remove", async () => {
      await web.reactions.add({ channel: "C_GENERAL1", timestamp: ts, name: "tada" });
      const r = await web.reactions.remove({ channel: "C_GENERAL1", timestamp: ts, name: "tada" });
      expect(r.ok).toBe(true);
      const g = await web.reactions.get({ channel: "C_GENERAL1", timestamp: ts });
      expect(g.message.reactions).toBeUndefined();
    });

    it("remove nonexistent -> no_reaction", async () => {
      await expectError(web.reactions.remove({ channel: "C_GENERAL1", timestamp: ts, name: "nope" }), "no_reaction");
    });

    it("list", async () => {
      await web.reactions.add({ channel: "C_GENERAL1", timestamp: ts, name: "rocket" });
      const r = await web.reactions.list({});
      expect(r.items.length).toBeGreaterThan(0);
    });

    it("add to missing message -> message_not_found", async () => {
      await expectError(
        web.reactions.add({ channel: "C_GENERAL1", timestamp: "1.1", name: "x" }),
        "message_not_found",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("pins", () => {
    let ts: string;
    beforeEach(async () => {
      const m = await web.chat.postMessage({ channel: "C_GENERAL1", text: "pin me" });
      ts = m.ts;
    });

    it("add + list + remove", async () => {
      const a = await web.pins.add({ channel: "C_GENERAL1", timestamp: ts });
      expect(a.ok).toBe(true);
      const l = await web.pins.list({ channel: "C_GENERAL1" });
      expect(l.items).toHaveLength(1);
      const r = await web.pins.remove({ channel: "C_GENERAL1", timestamp: ts });
      expect(r.ok).toBe(true);
      const l2 = await web.pins.list({ channel: "C_GENERAL1" });
      expect(l2.items).toHaveLength(0);
    });

    it("add twice -> already_pinned", async () => {
      await web.pins.add({ channel: "C_GENERAL1", timestamp: ts });
      await expectError(web.pins.add({ channel: "C_GENERAL1", timestamp: ts }), "already_pinned");
    });

    it("remove unpinned -> no_pin", async () => {
      await expectError(web.pins.remove({ channel: "C_GENERAL1", timestamp: ts }), "no_pin");
    });
  });

  // -------------------------------------------------------------------------
  describe("bookmarks", () => {
    it("add + list + edit + remove", async () => {
      const a = await web.bookmarks.add({ channel_id: "C_GENERAL1", title: "Docs", type: "link", link: "https://parlel.test" });
      expect(a.ok).toBe(true);
      const id = a.bookmark.id;
      const l = await web.bookmarks.list({ channel_id: "C_GENERAL1" });
      expect(l.bookmarks).toHaveLength(1);
      const e = await web.bookmarks.edit({ channel_id: "C_GENERAL1", bookmark_id: id, title: "Docs v2" });
      expect(e.bookmark.title).toBe("Docs v2");
      const r = await web.bookmarks.remove({ channel_id: "C_GENERAL1", bookmark_id: id });
      expect(r.ok).toBe(true);
      const l2 = await web.bookmarks.list({ channel_id: "C_GENERAL1" });
      expect(l2.bookmarks).toHaveLength(0);
    });

    it("edit missing -> bookmark_not_found", async () => {
      await expectError(
        web.bookmarks.edit({ channel_id: "C_GENERAL1", bookmark_id: "BkNOPE", title: "x" }),
        "bookmark_not_found",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("files", () => {
    it("upload with content", async () => {
      const r = await web.files.upload({ content: "hello file", filename: "note.txt", channels: "C_GENERAL1" });
      expect(r.ok).toBe(true);
      expect(r.file.id).toMatch(/^F/);
      expect(r.file.name).toBe("note.txt");
    });

    it("upload with no data -> no_file_data", async () => {
      await expectError(web.files.upload({ filename: "x.txt" }), "no_file_data");
    });

    it("info + list + delete", async () => {
      const up = await web.files.upload({ content: "data", filename: "a.txt", channels: "C_GENERAL1" });
      const id = up.file.id;
      const info = await web.files.info({ file: id });
      expect(info.file.id).toBe(id);
      const list = await web.files.list({});
      expect(list.files.length).toBeGreaterThan(0);
      const del = await web.files.delete({ file: id });
      expect(del.ok).toBe(true);
      await expectError(web.files.info({ file: id }), "file_not_found");
    });

    it("uploadV2 flow: getUploadURLExternal + completeUploadExternal", async () => {
      const url = await web.files.getUploadURLExternal({ filename: "big.bin", length: 1024 });
      expect(url.upload_url).toBeTruthy();
      expect(url.file_id).toBeTruthy();
      // simulate the PUT of bytes to the upload URL
      const put = await fetch(url.upload_url, { method: "POST", body: "binary-bytes" });
      expect(put.status).toBe(200);
      const complete = await web.files.completeUploadExternal({
        files: [{ id: url.file_id, title: "Big File" }],
        channel_id: "C_GENERAL1",
      });
      expect(complete.ok).toBe(true);
      expect(complete.files[0].id).toBe(url.file_id);
      const info = await web.files.info({ file: url.file_id });
      expect(info.file.title).toBe("Big File");
    });
  });

  // -------------------------------------------------------------------------
  describe("views", () => {
    const modal = { type: "modal", callback_id: "cb1", title: { type: "plain_text", text: "Hi" }, blocks: [] };

    it("open", async () => {
      const r = await web.views.open({ trigger_id: "trig.123", view: modal });
      expect(r.ok).toBe(true);
      expect(r.view.id).toMatch(/^V/);
      expect(r.view.type).toBe("modal");
    });

    it("open without trigger_id -> invalid_arguments", async () => {
      await expectError(web.views.open({ view: modal } as any), "invalid_arguments");
    });

    it("push", async () => {
      const r = await web.views.push({ trigger_id: "trig.123", view: modal });
      expect(r.ok).toBe(true);
    });

    it("publish home view", async () => {
      const r = await web.views.publish({
        user_id: "U_ALICE001",
        view: { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "Home" } }] },
      });
      expect(r.ok).toBe(true);
      expect(r.view.type).toBe("home");
    });

    it("publish unknown user -> user_not_found", async () => {
      await expectError(
        web.views.publish({ user_id: "U_GHOST", view: { type: "home", blocks: [] } }),
        "user_not_found",
      );
    });

    it("update existing view", async () => {
      const opened = await web.views.open({ trigger_id: "trig.123", view: modal });
      const r = await web.views.update({
        view_id: opened.view.id,
        view: { type: "modal", title: { type: "plain_text", text: "Updated" }, blocks: [] },
      });
      expect(r.ok).toBe(true);
      expect(r.view.title.text).toBe("Updated");
    });
  });

  // -------------------------------------------------------------------------
  describe("team", () => {
    it("info", async () => {
      const r = await web.team.info();
      expect(r.team.id).toBe("T_PARLEL01");
      expect(r.team.domain).toBe("parlel");
    });
  });

  // -------------------------------------------------------------------------
  describe("usergroups", () => {
    it("create + list + update + users", async () => {
      const c = await web.usergroups.create({ name: "Engineers", handle: "eng" });
      expect(c.ok).toBe(true);
      const id = c.usergroup.id;
      const l = await web.usergroups.list({});
      expect(l.usergroups.some((g: any) => g.id === id)).toBe(true);
      const u = await web.usergroups.update({ usergroup: id, description: "All engineers" });
      expect(u.usergroup.description).toBe("All engineers");
      const uu = await web.usergroups.users.update({ usergroup: id, users: "U_ALICE001,U_BOT00001" });
      expect(uu.usergroup.user_count).toBe(2);
      const ul = await web.usergroups.users.list({ usergroup: id });
      expect(ul.users).toContain("U_ALICE001");
    });

    it("update unknown -> no_such_subteam", async () => {
      await expectError(web.usergroups.update({ usergroup: "SNOPE", name: "x" }), "no_such_subteam");
    });
  });

  // -------------------------------------------------------------------------
  describe("emoji", () => {
    it("list", async () => {
      const r = await web.emoji.list();
      expect(r.ok).toBe(true);
      expect(r.emoji.parlel).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  describe("parlel control endpoints", () => {
    it("reset clears posted messages", async () => {
      await web.chat.postMessage({ channel: "C_GENERAL1", text: "ephemeral state" });
      let all = await http("GET", "/__parlel/messages");
      expect(all.body.count).toBeGreaterThan(0);
      await http("POST", "/__parlel/reset");
      all = await http("GET", "/__parlel/messages");
      expect(all.body.count).toBe(0);
    });

    it("inspect channels", async () => {
      const r = await http("GET", "/__parlel/channels");
      expect(r.body.count).toBeGreaterThanOrEqual(2);
    });

    it("add a user fixture", async () => {
      const r = await http("POST", "/__parlel/users", { id: "U_CAROL001", name: "carol", email: "carol@parlel.test" });
      expect(r.body.ok).toBe(true);
      const info = await web.users.info({ user: "U_CAROL001" });
      expect(info.user.name).toBe("carol");
    });

    it("inspect files", async () => {
      await web.files.upload({ content: "x", filename: "f.txt" });
      const r = await http("GET", "/__parlel/files");
      expect(r.body.count).toBe(1);
    });
  });
});
