import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DiscordServer } from "../services/discord/src/server.js";

const PORT = 14655;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const API = `${BASE_URL}/api/v10`;
const TOKEN = "parlel.test.discordbottoken";

// Seeded fixtures (see DiscordServer._seedDefaults).
const BOT_ID = "1000000000000000010";
const ALICE_ID = "1000000000000000020";
const GUILD_ID = "2000000000000000001";
const GENERAL_ID = "3000000000000000001";
const APP_ID = "1000000000000000001";

type Json = Record<string, any>;

interface RawResult {
  status: number;
  body: any;
}

/** A faithful, dependency-free mirror of how discord.js's `REST` client
 *  dispatches requests. The real client:
 *    - sends `Authorization: Bot <token>`
 *    - sends/receives JSON bodies under /api/v10
 *    - on a non-2xx response throws a DiscordAPIError carrying status + the
 *      JSON error body ({ message, code, errors? }).
 *  This lets us exercise the exact wire protocol with zero external deps. */
class DiscordAPIError extends Error {
  constructor(public status: number, public code: number, message: string, public rawError: any) {
    super(message);
    this.name = "DiscordAPIError";
  }
}

class RESTSim {
  constructor(private token: string, private base = API) {}

  async request(method: string, route: string, options: Json = {}): Promise<any> {
    const url = `${this.base}${route}${options.query ? `?${new URLSearchParams(options.query)}` : ""}`;
    const headers: Json = { Authorization: `Bot ${this.token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (options.reason) headers["X-Audit-Log-Reason"] = options.reason;
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status >= 400) {
      throw new DiscordAPIError(res.status, data?.code ?? 0, data?.message ?? "error", data);
    }
    return data;
  }

  get(route: string, options: Json = {}) { return this.request("GET", route, options); }
  post(route: string, options: Json = {}) { return this.request("POST", route, options); }
  patch(route: string, options: Json = {}) { return this.request("PATCH", route, options); }
  put(route: string, options: Json = {}) { return this.request("PUT", route, options); }
  delete(route: string, options: Json = {}) { return this.request("DELETE", route, options); }
}

async function http(method: string, path: string, body?: any): Promise<RawResult> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let server: DiscordServer;
let rest: RESTSim;

beforeAll(async () => {
  server = new DiscordServer(PORT);
  await server.start();
  rest = new RESTSim(TOKEN);
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

describe("infra & health", () => {
  it("responds on /health", async () => {
    const r = await http("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("serves a root descriptor", async () => {
    const r = await http("GET", "/");
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("discord");
    expect(r.body.api_version).toBe("v10");
  });

  it("accepts the unversioned /api prefix and arbitrary version", async () => {
    const r1 = await fetch(`${BASE_URL}/api/gateway`, { headers: { Authorization: `Bot ${TOKEN}` } });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${BASE_URL}/api/v9/gateway`, { headers: { Authorization: `Bot ${TOKEN}` } });
    expect(r2.status).toBe(200);
  });
});

describe("authentication", () => {
  it("rejects requests without a token", async () => {
    const res = await fetch(`${API}/users/@me`);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token", async () => {
    const res = await fetch(`${API}/users/@me`, { headers: { Authorization: "Bot nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts a valid Bot token", async () => {
    const me = await rest.get("/users/@me");
    expect(me.id).toBe(BOT_ID);
  });
});

describe("gateway", () => {
  it("GET /gateway returns a ws url", async () => {
    const g = await rest.get("/gateway");
    expect(g.url).toMatch(/^ws:\/\//);
  });

  it("GET /gateway/bot returns shards + session limit", async () => {
    const g = await rest.get("/gateway/bot");
    expect(g.shards).toBe(1);
    expect(g.session_start_limit.max_concurrency).toBe(1);
  });
});

describe("oauth2", () => {
  it("GET /oauth2/applications/@me returns the application", async () => {
    const app = await rest.get("/oauth2/applications/@me");
    expect(app.id).toBe(APP_ID);
    expect(app.name).toContain("Parlel");
  });

  it("GET /oauth2/@me returns authorization info", async () => {
    const info = await rest.get("/oauth2/@me");
    expect(info.application.id).toBe(APP_ID);
    expect(info.scopes).toContain("bot");
  });
});

describe("users", () => {
  it("GET /users/@me returns the bot identity with private fields", async () => {
    const me = await rest.get("/users/@me");
    expect(me.id).toBe(BOT_ID);
    expect(me.bot).toBe(true);
    expect(me).toHaveProperty("verified");
  });

  it("PATCH /users/@me updates the username", async () => {
    const me = await rest.patch("/users/@me", { body: { username: "renamedbot" } });
    expect(me.username).toBe("renamedbot");
  });

  it("GET /users/{id} returns a known user", async () => {
    const u = await rest.get(`/users/${ALICE_ID}`);
    expect(u.username).toBe("alice");
  });

  it("GET /users/{id} 404s for unknown user", async () => {
    await expect(rest.get("/users/999999999999999999")).rejects.toMatchObject({ status: 404, code: 10013 });
  });

  it("GET /users/@me/guilds lists the seeded guild", async () => {
    const guilds = await rest.get("/users/@me/guilds");
    expect(guilds.some((g: Json) => g.id === GUILD_ID)).toBe(true);
  });

  it("GET /users/@me/guilds/{id}/member returns the bot member", async () => {
    const m = await rest.get(`/users/@me/guilds/${GUILD_ID}/member`);
    expect(m.user.id).toBe(BOT_ID);
  });

  it("POST /users/@me/channels creates a DM channel", async () => {
    const dm = await rest.post("/users/@me/channels", { body: { recipient_id: ALICE_ID } });
    expect(dm.type).toBe(1);
    expect(dm.recipients[0].id).toBe(ALICE_ID);
  });

  it("POST /users/@me/channels reuses an existing DM", async () => {
    const dm1 = await rest.post("/users/@me/channels", { body: { recipient_id: ALICE_ID } });
    const dm2 = await rest.post("/users/@me/channels", { body: { recipient_id: ALICE_ID } });
    expect(dm1.id).toBe(dm2.id);
  });

  it("POST /users/@me/channels validates recipient_id", async () => {
    await expect(rest.post("/users/@me/channels", { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });

  it("DELETE /users/@me/guilds/{id} leaves the guild", async () => {
    await rest.delete(`/users/@me/guilds/${GUILD_ID}`);
    const guilds = await rest.get("/users/@me/guilds");
    expect(guilds.some((g: Json) => g.id === GUILD_ID)).toBe(false);
  });
});

describe("channels", () => {
  it("GET /channels/{id} returns the channel", async () => {
    const ch = await rest.get(`/channels/${GENERAL_ID}`);
    expect(ch.name).toBe("general");
    expect(ch.type).toBe(0);
  });

  it("GET /channels/{id} 404s for unknown channel", async () => {
    await expect(rest.get("/channels/123")).rejects.toMatchObject({ status: 404, code: 10003 });
  });

  it("PATCH /channels/{id} edits the channel", async () => {
    const ch = await rest.patch(`/channels/${GENERAL_ID}`, { body: { name: "renamed", topic: "hello", nsfw: true } });
    expect(ch.name).toBe("renamed");
    expect(ch.topic).toBe("hello");
    expect(ch.nsfw).toBe(true);
  });

  it("DELETE /channels/{id} removes the channel", async () => {
    const created = await rest.post(`/guilds/${GUILD_ID}/channels`, { body: { name: "temp" } });
    const deleted = await rest.delete(`/channels/${created.id}`);
    expect(deleted.id).toBe(created.id);
    await expect(rest.get(`/channels/${created.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it("POST /channels/{id}/typing returns 204", async () => {
    const res = await fetch(`${API}/channels/${GENERAL_ID}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    expect(res.status).toBe(204);
  });
});

describe("messages", () => {
  it("POST creates a message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "hello world" } });
    expect(m.content).toBe("hello world");
    expect(m.author.id).toBe(BOT_ID);
    expect(m.channel_id).toBe(GENERAL_ID);
  });

  it("rejects an empty message", async () => {
    await expect(rest.post(`/channels/${GENERAL_ID}/messages`, { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });

  it("accepts an embeds-only message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { embeds: [{ title: "T", description: "D" }] } });
    expect(m.embeds[0].title).toBe("T");
  });

  it("GET list returns messages newest-first", async () => {
    await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "first" } });
    await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "second" } });
    const list = await rest.get(`/channels/${GENERAL_ID}/messages`, { query: { limit: "10" } });
    expect(list.length).toBe(2);
    expect(list[0].content).toBe("second");
  });

  it("GET one message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "fetch me" } });
    const fetched = await rest.get(`/channels/${GENERAL_ID}/messages/${m.id}`);
    expect(fetched.id).toBe(m.id);
  });

  it("GET unknown message 404s", async () => {
    await expect(rest.get(`/channels/${GENERAL_ID}/messages/123`)).rejects.toMatchObject({ status: 404, code: 10008 });
  });

  it("PATCH edits a message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "before" } });
    const edited = await rest.patch(`/channels/${GENERAL_ID}/messages/${m.id}`, { body: { content: "after" } });
    expect(edited.content).toBe("after");
    expect(edited.edited_timestamp).not.toBeNull();
  });

  it("DELETE removes a message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "delete me" } });
    await rest.delete(`/channels/${GENERAL_ID}/messages/${m.id}`);
    await expect(rest.get(`/channels/${GENERAL_ID}/messages/${m.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it("bulk-delete removes multiple messages", async () => {
    const a = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "a" } });
    const b = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "b" } });
    const res = await fetch(`${API}/channels/${GENERAL_ID}/messages/bulk-delete`, {
      method: "POST",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [a.id, b.id] }),
    });
    expect(res.status).toBe(204);
    const list = await rest.get(`/channels/${GENERAL_ID}/messages`);
    expect(list.length).toBe(0);
  });

  it("crosspost sets the CROSSPOSTED flag", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "news" } });
    const cp = await rest.post(`/channels/${GENERAL_ID}/messages/${m.id}/crosspost`);
    expect(cp.flags & 2).toBe(2);
  });

  it("supports message replies via message_reference", async () => {
    const parent = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "parent" } });
    const reply = await rest.post(`/channels/${GENERAL_ID}/messages`, {
      body: { content: "reply", message_reference: { message_id: parent.id } },
    });
    expect(reply.message_reference.message_id).toBe(parent.id);
  });
});

describe("reactions", () => {
  let msgId: string;
  beforeEach(async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "react to me" } });
    msgId = m.id;
  });

  it("PUT adds the bot's own unicode reaction", async () => {
    const emoji = encodeURIComponent("🔥");
    const res = await fetch(`${API}/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`, {
      method: "PUT",
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    expect(res.status).toBe(204);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    expect(m.reactions[0].emoji.name).toBe("🔥");
    expect(m.reactions[0].count).toBe(1);
    expect(m.reactions[0].me).toBe(true);
  });

  it("reaction objects match the Discord v10 shape and never leak internals", async () => {
    // Real API reaction object: { count, count_details: { burst, normal },
    //   me, me_burst, emoji, burst_colors } — and never an internal `_users` key.
    // https://discord.com/developers/docs/resources/message#reaction-object
    const emoji = encodeURIComponent("🔥");
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    const r = m.reactions[0];
    expect(r).toMatchObject({
      count: 1,
      count_details: { burst: 0, normal: 1 },
      me: true,
      me_burst: false,
      burst_colors: [],
    });
    expect(r.count_details.normal).toBe(1);
    // Internal bookkeeping must not leak onto the wire.
    expect(r).not.toHaveProperty("_users");
  });

  it("GET lists users who reacted", async () => {
    const emoji = encodeURIComponent("🔥");
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    const users = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}`);
    expect(users.some((u: Json) => u.id === BOT_ID)).toBe(true);
  });

  it("DELETE removes own reaction", async () => {
    const emoji = encodeURIComponent("🔥");
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    await rest.delete(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    expect(m.reactions.length).toBe(0);
  });

  it("DELETE all reactions for an emoji", async () => {
    const emoji = encodeURIComponent("👍");
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    await rest.delete(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}`);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    expect(m.reactions.length).toBe(0);
  });

  it("DELETE all reactions on a message", async () => {
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${encodeURIComponent("🔥")}/@me`);
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${encodeURIComponent("👍")}/@me`);
    await rest.delete(`/channels/${GENERAL_ID}/messages/${msgId}/reactions`);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    expect(m.reactions.length).toBe(0);
  });

  it("supports custom emoji reactions (name:id)", async () => {
    const emoji = encodeURIComponent("partyparrot:9876543210");
    await rest.put(`/channels/${GENERAL_ID}/messages/${msgId}/reactions/${emoji}/@me`);
    const m = await rest.get(`/channels/${GENERAL_ID}/messages/${msgId}`);
    expect(m.reactions[0].emoji.id).toBe("9876543210");
    expect(m.reactions[0].emoji.name).toBe("partyparrot");
  });
});

describe("pins", () => {
  it("PUT pins, GET lists, DELETE unpins", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "pin me" } });
    await rest.put(`/channels/${GENERAL_ID}/pins/${m.id}`);
    let pins = await rest.get(`/channels/${GENERAL_ID}/pins`);
    expect(pins.length).toBe(1);
    expect(pins[0].id).toBe(m.id);
    await rest.delete(`/channels/${GENERAL_ID}/pins/${m.id}`);
    pins = await rest.get(`/channels/${GENERAL_ID}/pins`);
    expect(pins.length).toBe(0);
  });
});

describe("channel permission overwrites", () => {
  it("PUT creates and DELETE removes an overwrite", async () => {
    await rest.put(`/channels/${GENERAL_ID}/permissions/${ALICE_ID}`, { body: { type: 1, allow: "1024", deny: "0" } });
    let ch = await rest.get(`/channels/${GENERAL_ID}`);
    expect(ch.permission_overwrites.length).toBe(1);
    expect(ch.permission_overwrites[0].allow).toBe("1024");
    await rest.delete(`/channels/${GENERAL_ID}/permissions/${ALICE_ID}`);
    ch = await rest.get(`/channels/${GENERAL_ID}`);
    expect(ch.permission_overwrites.length).toBe(0);
  });

  it("DELETE unknown overwrite 404s", async () => {
    await expect(rest.delete(`/channels/${GENERAL_ID}/permissions/123`)).rejects.toMatchObject({ status: 404, code: 10009 });
  });
});

describe("channel invites", () => {
  it("POST creates and GET lists invites", async () => {
    const inv = await rest.post(`/channels/${GENERAL_ID}/invites`, { body: { max_age: 3600, max_uses: 5 } });
    expect(inv.code).toBeTruthy();
    expect(inv.channel.id).toBe(GENERAL_ID);
    const list = await rest.get(`/channels/${GENERAL_ID}/invites`);
    expect(list.some((i: Json) => i.code === inv.code)).toBe(true);
  });
});

describe("invites (top-level)", () => {
  it("GET and DELETE an invite", async () => {
    const inv = await rest.post(`/channels/${GENERAL_ID}/invites`, { body: {} });
    const got = await rest.get(`/invites/${inv.code}`);
    expect(got.code).toBe(inv.code);
    const deleted = await rest.delete(`/invites/${inv.code}`);
    expect(deleted.code).toBe(inv.code);
    await expect(rest.get(`/invites/${inv.code}`)).rejects.toMatchObject({ status: 404, code: 10006 });
  });
});

describe("threads", () => {
  it("creates a thread from a message", async () => {
    const m = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "thread starter" } });
    const thread = await rest.post(`/channels/${GENERAL_ID}/messages/${m.id}/threads`, { body: { name: "my thread" } });
    expect(thread.name).toBe("my thread");
    expect(thread.parent_id).toBe(GENERAL_ID);
    expect([10, 11, 12]).toContain(thread.type);
  });

  it("creates a thread without a message", async () => {
    const thread = await rest.post(`/channels/${GENERAL_ID}/threads`, { body: { name: "private thread", type: 12 } });
    expect(thread.type).toBe(12);
  });

  it("manages thread members", async () => {
    const thread = await rest.post(`/channels/${GENERAL_ID}/threads`, { body: { name: "t" } });
    await rest.put(`/channels/${thread.id}/thread-members/${ALICE_ID}`);
    const members = await rest.get(`/channels/${thread.id}/thread-members`);
    expect(members.some((tm: Json) => tm.user_id === ALICE_ID)).toBe(true);
    const me = await rest.get(`/channels/${thread.id}/thread-members/@me`);
    expect(me.user_id).toBe(BOT_ID);
    await rest.delete(`/channels/${thread.id}/thread-members/${ALICE_ID}`);
    const after = await rest.get(`/channels/${thread.id}/thread-members`);
    expect(after.some((tm: Json) => tm.user_id === ALICE_ID)).toBe(false);
  });
});

describe("guilds", () => {
  it("GET a guild with roles and emojis", async () => {
    const g = await rest.get(`/guilds/${GUILD_ID}`);
    expect(g.name).toBe("Parlel Guild");
    expect(Array.isArray(g.roles)).toBe(true);
    expect(g.roles.some((r: Json) => r.id === GUILD_ID)).toBe(true); // @everyone
  });

  it("GET with_counts adds approximate counts", async () => {
    const g = await rest.get(`/guilds/${GUILD_ID}`, { query: { with_counts: "true" } });
    expect(g.approximate_member_count).toBeGreaterThan(0);
  });

  it("GET unknown guild 404s", async () => {
    await expect(rest.get("/guilds/123")).rejects.toMatchObject({ status: 404, code: 10004 });
  });

  it("POST creates a guild", async () => {
    const g = await rest.post("/guilds", { body: { name: "New Guild" } });
    expect(g.name).toBe("New Guild");
    expect(g.owner_id).toBe(BOT_ID);
  });

  it("POST guild validates name", async () => {
    await expect(rest.post("/guilds", { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });

  it("PATCH edits a guild", async () => {
    const g = await rest.patch(`/guilds/${GUILD_ID}`, { body: { name: "Renamed Guild" } });
    expect(g.name).toBe("Renamed Guild");
  });

  it("DELETE removes a guild", async () => {
    const g = await rest.post("/guilds", { body: { name: "Doomed" } });
    await rest.delete(`/guilds/${g.id}`);
    await expect(rest.get(`/guilds/${g.id}`)).rejects.toMatchObject({ status: 404 });
  });

  it("GET guild preview", async () => {
    const p = await rest.get(`/guilds/${GUILD_ID}/preview`);
    expect(p.id).toBe(GUILD_ID);
    expect(p).toHaveProperty("approximate_member_count");
  });

  it("GET/POST prune", async () => {
    const dry = await rest.get(`/guilds/${GUILD_ID}/prune`);
    expect(dry).toHaveProperty("pruned");
    const run = await rest.post(`/guilds/${GUILD_ID}/prune`);
    expect(run).toHaveProperty("pruned");
  });
});

describe("guild channels", () => {
  it("GET lists guild channels", async () => {
    const chans = await rest.get(`/guilds/${GUILD_ID}/channels`);
    expect(chans.some((c: Json) => c.id === GENERAL_ID)).toBe(true);
  });

  it("POST creates a guild channel", async () => {
    const ch = await rest.post(`/guilds/${GUILD_ID}/channels`, { body: { name: "new-channel", type: 0 } });
    expect(ch.name).toBe("new-channel");
    expect(ch.guild_id).toBe(GUILD_ID);
  });

  it("POST validates channel name", async () => {
    await expect(rest.post(`/guilds/${GUILD_ID}/channels`, { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });

  it("PATCH bulk position update returns 204", async () => {
    const res = await fetch(`${API}/guilds/${GUILD_ID}/channels`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ id: GENERAL_ID, position: 3 }]),
    });
    expect(res.status).toBe(204);
    const ch = await rest.get(`/channels/${GENERAL_ID}`);
    expect(ch.position).toBe(3);
  });
});

describe("guild members", () => {
  it("GET list members", async () => {
    const members = await rest.get(`/guilds/${GUILD_ID}/members`);
    expect(members.some((m: Json) => m.user.id === BOT_ID)).toBe(true);
  });

  it("GET single member", async () => {
    const m = await rest.get(`/guilds/${GUILD_ID}/members/${ALICE_ID}`);
    expect(m.user.id).toBe(ALICE_ID);
  });

  it("GET unknown member 404s", async () => {
    await expect(rest.get(`/guilds/${GUILD_ID}/members/999999999999999999`)).rejects.toMatchObject({ status: 404, code: 10007 });
  });

  it("search members by query", async () => {
    const found = await rest.get(`/guilds/${GUILD_ID}/members/search`, { query: { query: "ali" } });
    expect(found.some((m: Json) => m.user.id === ALICE_ID)).toBe(true);
  });

  it("PATCH edits member nick and roles", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "VIP" } });
    const m = await rest.patch(`/guilds/${GUILD_ID}/members/${ALICE_ID}`, { body: { nick: "Al", roles: [role.id] } });
    expect(m.nick).toBe("Al");
    expect(m.roles).toContain(role.id);
  });

  it("PUT add and DELETE remove member role", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Mod" } });
    await rest.put(`/guilds/${GUILD_ID}/members/${ALICE_ID}/roles/${role.id}`);
    let m = await rest.get(`/guilds/${GUILD_ID}/members/${ALICE_ID}`);
    expect(m.roles).toContain(role.id);
    await rest.delete(`/guilds/${GUILD_ID}/members/${ALICE_ID}/roles/${role.id}`);
    m = await rest.get(`/guilds/${GUILD_ID}/members/${ALICE_ID}`);
    expect(m.roles).not.toContain(role.id);
  });

  it("PUT add member requires existing user", async () => {
    const u = await http("POST", "/__parlel/users", { username: "bob" });
    const added = await rest.put(`/guilds/${GUILD_ID}/members/${u.body.user.id}`, { body: {} });
    expect(added.user.id).toBe(u.body.user.id);
  });

  it("PUT add member returns 201 when created, 204 when already a member", async () => {
    // Real API: "Returns a 201 Created with the guild member as the body, or
    //   204 No Content if the user is already a member of the guild."
    // https://discord.com/developers/docs/resources/guild#add-guild-member
    const u = await http("POST", "/__parlel/users", { username: "joiner" });
    const create = await fetch(`${API}/guilds/${GUILD_ID}/members/${u.body.user.id}`, {
      method: "PUT",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(create.status).toBe(201);
    // Alice is already a seeded member -> 204 No Content, empty body.
    const already = await fetch(`${API}/guilds/${GUILD_ID}/members/${ALICE_ID}`, {
      method: "PUT",
      headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(already.status).toBe(204);
    expect(await already.text()).toBe("");
  });

  it("DELETE kicks a member", async () => {
    const u = await http("POST", "/__parlel/users", { username: "kickme" });
    await rest.put(`/guilds/${GUILD_ID}/members/${u.body.user.id}`, { body: {} });
    await rest.delete(`/guilds/${GUILD_ID}/members/${u.body.user.id}`);
    await expect(rest.get(`/guilds/${GUILD_ID}/members/${u.body.user.id}`)).rejects.toMatchObject({ status: 404 });
  });
});

describe("guild roles", () => {
  it("GET lists roles", async () => {
    const roles = await rest.get(`/guilds/${GUILD_ID}/roles`);
    expect(roles.some((r: Json) => r.name === "@everyone")).toBe(true);
  });

  it("POST creates a role", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Helper", color: 255, permissions: "1024" } });
    expect(role.name).toBe("Helper");
    expect(role.color).toBe(255);
    expect(role.permissions).toBe("1024");
  });

  it("PATCH edits a role", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Temp" } });
    const edited = await rest.patch(`/guilds/${GUILD_ID}/roles/${role.id}`, { body: { name: "Perm", hoist: true } });
    expect(edited.name).toBe("Perm");
    expect(edited.hoist).toBe(true);
  });

  it("PATCH bulk position update", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Sortable" } });
    const res = await rest.patch(`/guilds/${GUILD_ID}/roles`, { body: [{ id: role.id, position: 2 }] });
    expect(res.find((r: Json) => r.id === role.id).position).toBe(2);
  });

  it("DELETE removes a role and detaches it from members", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Doomed" } });
    await rest.put(`/guilds/${GUILD_ID}/members/${ALICE_ID}/roles/${role.id}`);
    await rest.delete(`/guilds/${GUILD_ID}/roles/${role.id}`);
    const roles = await rest.get(`/guilds/${GUILD_ID}/roles`);
    expect(roles.some((r: Json) => r.id === role.id)).toBe(false);
    const m = await rest.get(`/guilds/${GUILD_ID}/members/${ALICE_ID}`);
    expect(m.roles).not.toContain(role.id);
  });

  it("DELETE unknown role 404s", async () => {
    await expect(rest.delete(`/guilds/${GUILD_ID}/roles/123`)).rejects.toMatchObject({ status: 404, code: 10011 });
  });
});

describe("guild bans", () => {
  it("PUT bans a user (and removes membership)", async () => {
    await rest.put(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`, { body: { reason: "spam" } });
    const ban = await rest.get(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`);
    expect(ban.user.id).toBe(ALICE_ID);
    expect(ban.reason).toBe("spam");
    await expect(rest.get(`/guilds/${GUILD_ID}/members/${ALICE_ID}`)).rejects.toMatchObject({ status: 404 });
  });

  it("GET lists bans", async () => {
    await rest.put(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`, { body: {} });
    const bans = await rest.get(`/guilds/${GUILD_ID}/bans`);
    expect(bans.some((b: Json) => b.user.id === ALICE_ID)).toBe(true);
  });

  it("DELETE unbans a user", async () => {
    await rest.put(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`, { body: {} });
    await rest.delete(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`);
    await expect(rest.get(`/guilds/${GUILD_ID}/bans/${ALICE_ID}`)).rejects.toMatchObject({ status: 404, code: 10026 });
  });
});

describe("guild emojis", () => {
  it("POST creates, GET reads, PATCH edits, DELETE removes", async () => {
    const e = await rest.post(`/guilds/${GUILD_ID}/emojis`, { body: { name: "parlel", image: "data:image/png;base64,xx" } });
    expect(e.name).toBe("parlel");
    const list = await rest.get(`/guilds/${GUILD_ID}/emojis`);
    expect(list.some((x: Json) => x.id === e.id)).toBe(true);
    const one = await rest.get(`/guilds/${GUILD_ID}/emojis/${e.id}`);
    expect(one.id).toBe(e.id);
    const edited = await rest.patch(`/guilds/${GUILD_ID}/emojis/${e.id}`, { body: { name: "parlel2" } });
    expect(edited.name).toBe("parlel2");
    await rest.delete(`/guilds/${GUILD_ID}/emojis/${e.id}`);
    await expect(rest.get(`/guilds/${GUILD_ID}/emojis/${e.id}`)).rejects.toMatchObject({ status: 404, code: 10014 });
  });

  it("POST validates emoji name", async () => {
    await expect(rest.post(`/guilds/${GUILD_ID}/emojis`, { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });
});

describe("webhooks", () => {
  it("POST creates a channel webhook", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "CI Bot" } });
    expect(wh.name).toBe("CI Bot");
    expect(wh.channel_id).toBe(GENERAL_ID);
    expect(wh.token).toBeTruthy();
  });

  it("GET lists channel and guild webhooks", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "WH" } });
    const channelHooks = await rest.get(`/channels/${GENERAL_ID}/webhooks`);
    expect(channelHooks.some((h: Json) => h.id === wh.id)).toBe(true);
    const guildHooks = await rest.get(`/guilds/${GUILD_ID}/webhooks`);
    expect(guildHooks.some((h: Json) => h.id === wh.id)).toBe(true);
  });

  it("GET/PATCH/DELETE a webhook by id", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Editable" } });
    const got = await rest.get(`/webhooks/${wh.id}`);
    expect(got.id).toBe(wh.id);
    const patched = await rest.patch(`/webhooks/${wh.id}`, { body: { name: "Renamed Hook" } });
    expect(patched.name).toBe("Renamed Hook");
    await rest.delete(`/webhooks/${wh.id}`);
    await expect(rest.get(`/webhooks/${wh.id}`)).rejects.toMatchObject({ status: 404, code: 10015 });
  });

  it("GET a webhook by id+token without auth", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Tokened" } });
    const res = await fetch(`${API}/webhooks/${wh.id}/${wh.token}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(wh.id);
  });

  it("executes a webhook with ?wait=true and returns a message", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Exec" } });
    const msg = await rest.post(`/webhooks/${wh.id}/${wh.token}`, { query: { wait: "true" }, body: { content: "from webhook" } });
    expect(msg.content).toBe("from webhook");
    expect(msg.webhook_id).toBe(wh.id);
  });

  it("executes a webhook without wait returns 204", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Exec2" } });
    const res = await fetch(`${API}/webhooks/${wh.id}/${wh.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "fire and forget" }),
    });
    expect(res.status).toBe(204);
  });

  it("rejects empty webhook execution", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Exec3" } });
    const res = await fetch(`${API}/webhooks/${wh.id}/${wh.token}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("edits and deletes a webhook message via token", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Exec4" } });
    const msg = await rest.post(`/webhooks/${wh.id}/${wh.token}`, { query: { wait: "true" }, body: { content: "v1" } });
    const edited = await rest.patch(`/webhooks/${wh.id}/${wh.token}/messages/${msg.id}`, { body: { content: "v2" } });
    expect(edited.content).toBe("v2");
    const orig = await rest.get(`/webhooks/${wh.id}/${wh.token}/messages/@original`);
    expect(orig.id).toBe(msg.id);
    const res = await fetch(`${API}/webhooks/${wh.id}/${wh.token}/messages/${msg.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("404s for a bad webhook token", async () => {
    const wh = await rest.post(`/channels/${GENERAL_ID}/webhooks`, { body: { name: "Exec5" } });
    const res = await fetch(`${API}/webhooks/${wh.id}/wrongtoken`);
    expect(res.status).toBe(404);
  });
});

describe("application commands", () => {
  it("POST creates a global command", async () => {
    const cmd = await rest.post(`/applications/${APP_ID}/commands`, { body: { name: "ping", description: "Ping!" } });
    expect(cmd.name).toBe("ping");
    expect(cmd.application_id).toBe(APP_ID);
  });

  it("GET lists global commands", async () => {
    await rest.post(`/applications/${APP_ID}/commands`, { body: { name: "alpha", description: "a" } });
    const cmds = await rest.get(`/applications/${APP_ID}/commands`);
    expect(cmds.some((c: Json) => c.name === "alpha")).toBe(true);
  });

  it("POST validates command name", async () => {
    await expect(rest.post(`/applications/${APP_ID}/commands`, { body: {} })).rejects.toMatchObject({ status: 400, code: 50035 });
  });

  it("GET/PATCH/DELETE a single command", async () => {
    const cmd = await rest.post(`/applications/${APP_ID}/commands`, { body: { name: "edit", description: "x" } });
    const got = await rest.get(`/applications/${APP_ID}/commands/${cmd.id}`);
    expect(got.id).toBe(cmd.id);
    const patched = await rest.patch(`/applications/${APP_ID}/commands/${cmd.id}`, { body: { description: "updated" } });
    expect(patched.description).toBe("updated");
    await rest.delete(`/applications/${APP_ID}/commands/${cmd.id}`);
    await expect(rest.get(`/applications/${APP_ID}/commands/${cmd.id}`)).rejects.toMatchObject({ status: 404, code: 10063 });
  });

  it("PUT bulk overwrites global commands", async () => {
    await rest.post(`/applications/${APP_ID}/commands`, { body: { name: "old", description: "x" } });
    const out = await rest.put(`/applications/${APP_ID}/commands`, {
      body: [{ name: "one", description: "1" }, { name: "two", description: "2" }],
    });
    expect(out.length).toBe(2);
    const cmds = await rest.get(`/applications/${APP_ID}/commands`);
    expect(cmds.length).toBe(2);
    expect(cmds.some((c: Json) => c.name === "old")).toBe(false);
  });

  it("manages guild-scoped commands separately from global", async () => {
    await rest.post(`/applications/${APP_ID}/commands`, { body: { name: "globalcmd", description: "g" } });
    const guildCmd = await rest.post(`/applications/${APP_ID}/guilds/${GUILD_ID}/commands`, { body: { name: "guildcmd", description: "gg" } });
    expect(guildCmd.guild_id).toBe(GUILD_ID);
    const guildCmds = await rest.get(`/applications/${APP_ID}/guilds/${GUILD_ID}/commands`);
    expect(guildCmds.length).toBe(1);
    expect(guildCmds[0].name).toBe("guildcmd");
    const globalCmds = await rest.get(`/applications/${APP_ID}/commands`);
    expect(globalCmds.some((c: Json) => c.name === "globalcmd")).toBe(true);
    expect(globalCmds.some((c: Json) => c.name === "guildcmd")).toBe(false);
  });
});

describe("audit-log reason header", () => {
  it("accepts X-Audit-Log-Reason without error", async () => {
    const role = await rest.post(`/guilds/${GUILD_ID}/roles`, { body: { name: "Reasoned" }, reason: "testing reasons" });
    expect(role.name).toBe("Reasoned");
  });
});

describe("parlel control endpoints", () => {
  it("resets state", async () => {
    await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "ephemeral" } });
    const reset = await http("POST", "/__parlel/reset");
    expect(reset.body.ok).toBe(true);
    const list = await rest.get(`/channels/${GENERAL_ID}/messages`);
    expect(list.length).toBe(0);
  });

  it("inspects all messages", async () => {
    await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "inspect me" } });
    const r = await http("GET", "/__parlel/messages");
    expect(r.body.count).toBeGreaterThan(0);
    expect(r.body.messages[0]).toHaveProperty("channel_id");
  });

  it("inspects channels and guilds", async () => {
    const chans = await http("GET", "/__parlel/channels");
    expect(chans.body.count).toBeGreaterThan(0);
    const guilds = await http("GET", "/__parlel/guilds");
    expect(guilds.body.count).toBeGreaterThan(0);
  });

  it("adds a user fixture", async () => {
    const r = await http("POST", "/__parlel/users", { username: "fixture" });
    expect(r.body.ok).toBe(true);
    const u = await rest.get(`/users/${r.body.user.id}`);
    expect(u.username).toBe("fixture");
  });
});

describe("snowflake ids", () => {
  it("are unique and monotonically increasing strings", async () => {
    const a = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "a" } });
    const b = await rest.post(`/channels/${GENERAL_ID}/messages`, { body: { content: "b" } });
    expect(typeof a.id).toBe("string");
    expect(BigInt(b.id) > BigInt(a.id)).toBe(true);
  });
});
