import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TeamsServer } from "../services/teams/src/server.js";

const PORT = 14621;
const BASE = `http://127.0.0.1:${PORT}/v1.0`;

type ApiResponse<T = any> = { status: number; body: T; headers: Headers };

async function api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "client-request-id": "test-request" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  if (text && response.headers.get("content-type")?.includes("application/json")) parsed = JSON.parse(text);
  return { status: response.status, body: parsed, headers: response.headers };
}

async function reset() {
  const response = await fetch(`http://127.0.0.1:${PORT}/_parlel/reset`, { method: "POST" });
  expect(response.status).toBe(200);
}

describe("Teams Service", () => {
  let server: TeamsServer;

  beforeAll(async () => {
    server = new TeamsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 250));
  }, 10000);

  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("has seeded ephemeral state", () => {
      expect(server.teams.size).toBe(1);
      expect(server.chats.size).toBe(1);
      expect(server.channels.get("team_general")?.size).toBe(1);
    });

    it("returns health and metadata", async () => {
      const health = await fetch(`http://127.0.0.1:${PORT}/_parlel/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", service: "teams", teams: 1, chats: 1 });

      const root = await fetch(`http://127.0.0.1:${PORT}/v1.0`);
      expect(root.status).toBe(200);
      expect(await root.json()).toMatchObject({ service: "teams", emulator: "parlel" });
    });
  });

  describe("Users", () => {
    it("gets me, users, joinedTeams, and me/chats", async () => {
      const me = await api("GET", "/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ id: "user_parlel", displayName: "Parlel Agent" });

      const user = await api("GET", "/users/user_alice");
      expect(user.status).toBe(200);
      expect(user.body.mail).toBe("alice@parlel.test");

      const joined = await api("GET", "/me/joinedTeams");
      expect(joined.status).toBe(200);
      expect(joined.body.value.map((team: any) => team.id)).toContain("team_general");

      const chats = await api("GET", "/me/chats");
      expect(chats.status).toBe(200);
      expect(chats.body.value.map((chat: any) => chat.id)).toContain("chat_general");
    });
  });

  describe("Teams", () => {
    it("lists, creates, gets, updates, archives, unarchives, notifies, and deletes teams", async () => {
      const created = await api("POST", "/teams", { displayName: "Launch Team", description: "Build locally", visibility: "private" });
      expect(created.status).toBe(202);
      expect(created.body).toMatchObject({ displayName: "Launch Team", description: "Build locally" });

      const listed = await api("GET", "/teams?$filter=displayName eq 'Launch Team'&$count=true");
      expect(listed.status).toBe(200);
      expect(listed.body["@odata.count"]).toBe(1);
      expect(listed.body.value[0].id).toBe(created.body.id);

      const selected = await api("GET", `/teams/${created.body.id}?$select=displayName`);
      expect(selected.status).toBe(200);
      expect(selected.body).toEqual({ id: created.body.id, displayName: "Launch Team" });

      const patched = await api("PATCH", `/teams/${created.body.id}`, { description: "Updated" });
      expect(patched.status).toBe(200);
      expect(patched.body.description).toBe("Updated");

      expect((await api("POST", `/teams/${created.body.id}/archive`, {})).status).toBe(202);
      expect((await api("GET", `/teams/${created.body.id}`)).body.isArchived).toBe(true);
      expect((await api("POST", `/teams/${created.body.id}/unarchive`, {})).status).toBe(202);
      expect((await api("POST", `/teams/${created.body.id}/sendActivityNotification`, { topic: {}, activityType: "local" })).status).toBe(202);
      expect((await api("DELETE", `/teams/${created.body.id}`)).status).toBe(204);
      expect((await api("GET", `/teams/${created.body.id}`)).status).toBe(404);
    });

    it("creates and reads a team through /groups/{id}/team", async () => {
      const put = await api("PUT", "/groups/group_one/team", { displayName: "Group Team", description: "From group" });
      expect(put.status).toBe(201);
      expect(put.body.id).toBe("group_one");

      const get = await api("GET", "/groups/group_one/team");
      expect(get.status).toBe(200);
      expect(get.body.displayName).toBe("Group Team");
    });
  });

  describe("Team Members", () => {
    it("creates, lists, gets, updates, and deletes team members", async () => {
      const created = await api("POST", "/teams/team_general/members", { userId: "user_alice", displayName: "Alice Example", roles: ["member"] });
      expect(created.status).toBe(201);
      expect(created.body.userId).toBe("user_alice");

      const listed = await api("GET", "/teams/team_general/members?$search=Alice");
      expect(listed.body.value.some((m: any) => m.id === created.body.id)).toBe(true);

      const got = await api("GET", `/teams/team_general/members/${created.body.id}`);
      expect(got.status).toBe(200);
      expect(got.body.displayName).toBe("Alice Example");

      const patched = await api("PATCH", `/teams/team_general/members/${created.body.id}`, { roles: ["owner"] });
      expect(patched.body.roles).toEqual(["owner"]);
      expect((await api("DELETE", `/teams/team_general/members/${created.body.id}`)).status).toBe(204);
    });
  });

  describe("Channels", () => {
    it("creates, lists, gets, updates, completes migration, and deletes channels", async () => {
      const created = await api("POST", "/teams/team_general/channels", { displayName: "Planning", description: "Plan work" });
      expect(created.status).toBe(201);
      expect(created.body.displayName).toBe("Planning");

      const listed = await api("GET", "/teams/team_general/channels?$orderby=displayName desc&$top=1&$count=true");
      expect(listed.status).toBe(200);
      expect(listed.body["@odata.count"]).toBeGreaterThan(0);

      const got = await api("GET", `/teams/team_general/channels/${created.body.id}`);
      expect(got.body.description).toBe("Plan work");

      const patched = await api("PATCH", `/teams/team_general/channels/${created.body.id}`, { description: "Updated plan" });
      expect(patched.body.description).toBe("Updated plan");

      expect((await api("POST", `/teams/team_general/channels/${created.body.id}/completeMigration`, {})).status).toBe(204);
      expect((await api("DELETE", `/teams/team_general/channels/${created.body.id}`)).status).toBe(204);
    });

    it("creates, lists, gets, updates, and deletes channel members", async () => {
      const created = await api("POST", "/teams/team_general/channels/channel_general/members", { userId: "user_alice", displayName: "Alice Example" });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/teams/team_general/channels/channel_general/members");
      expect(listed.body.value.some((m: any) => m.id === created.body.id)).toBe(true);

      const got = await api("GET", `/teams/team_general/channels/channel_general/members/${created.body.id}`);
      expect(got.body.userId).toBe("user_alice");

      const patched = await api("PATCH", `/teams/team_general/channels/channel_general/members/${created.body.id}`, { displayName: "Alice Renamed" });
      expect(patched.body.displayName).toBe("Alice Renamed");
      expect((await api("DELETE", `/teams/team_general/channels/channel_general/members/${created.body.id}`)).status).toBe(204);
    });
  });

  describe("Channel Messages", () => {
    it("creates, lists, counts, deltas, gets, updates, reacts, hosted-content lists, and deletes messages", async () => {
      const created = await api("POST", "/teams/team_general/channels/channel_general/messages", {
        subject: "Hello",
        body: { contentType: "html", content: "<b>Hello channel</b>" },
        hostedContents: [{ id: "hc1", contentBytes: "aGk=", contentType: "text/plain" }],
      });
      expect(created.status).toBe(201);
      expect(created.body.body.content).toContain("Hello channel");

      const listed = await api("GET", "/teams/team_general/channels/channel_general/messages?$expand=hostedContents");
      expect(listed.body.value[0].hostedContents[0].id).toBe("hc1");

      const count = await api("GET", "/teams/team_general/channels/channel_general/messages/$count");
      expect(count.status).toBe(200);
      expect(count.body).toBe("1");

      const delta = await api("GET", "/teams/team_general/channels/channel_general/messages/delta");
      expect(delta.body["@odata.deltaLink"]).toContain("deltatoken");

      const got = await api("GET", `/teams/team_general/channels/channel_general/messages/${created.body.id}?$select=subject`);
      expect(got.body).toEqual({ id: created.body.id, subject: "Hello" });

      const patched = await api("PATCH", `/teams/team_general/channels/channel_general/messages/${created.body.id}`, { body: { contentType: "text", content: "Updated" } });
      expect(patched.body.body.content).toBe("Updated");

      expect((await api("POST", `/teams/team_general/channels/channel_general/messages/${created.body.id}/setReaction`, { reactionType: "like" })).status).toBe(204);
      expect((await api("GET", `/teams/team_general/channels/channel_general/messages/${created.body.id}`)).body.reactions[0].reactionType).toBe("like");
      expect((await api("POST", `/teams/team_general/channels/channel_general/messages/${created.body.id}/unsetReaction`, { reactionType: "like" })).status).toBe(204);

      const hosted = await api("GET", `/teams/team_general/channels/channel_general/messages/${created.body.id}/hostedContents`);
      expect(hosted.body.value[0].contentType).toBe("text/plain");
      expect((await api("DELETE", `/teams/team_general/channels/channel_general/messages/${created.body.id}`)).status).toBe(204);
    });

    it("creates, lists, gets, updates, and deletes channel message replies", async () => {
      const message = await api("POST", "/teams/team_general/channels/channel_general/messages", { body: { contentType: "text", content: "Parent" } });
      const reply = await api("POST", `/teams/team_general/channels/channel_general/messages/${message.body.id}/replies`, { body: { contentType: "text", content: "Reply" } });
      expect(reply.status).toBe(201);
      expect(reply.body.replyToId).toBe(message.body.id);

      const listed = await api("GET", `/teams/team_general/channels/channel_general/messages/${message.body.id}/replies`);
      expect(listed.body.value[0].id).toBe(reply.body.id);

      const got = await api("GET", `/teams/team_general/channels/channel_general/messages/${message.body.id}/replies/${reply.body.id}`);
      expect(got.body.body.content).toBe("Reply");

      const patched = await api("PATCH", `/teams/team_general/channels/channel_general/messages/${message.body.id}/replies/${reply.body.id}`, { body: { contentType: "text", content: "Updated reply" } });
      expect(patched.body.body.content).toBe("Updated reply");
      expect((await api("DELETE", `/teams/team_general/channels/channel_general/messages/${message.body.id}/replies/${reply.body.id}`)).status).toBe(204);
    });
  });

  describe("Tabs and Apps", () => {
    it("creates, lists, gets, updates, and deletes channel tabs", async () => {
      const created = await api("POST", "/teams/team_general/channels/channel_general/tabs", { displayName: "Runbook", configuration: { contentUrl: "https://parlel.test/runbook" } });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/teams/team_general/channels/channel_general/tabs");
      expect(listed.body.value[0].displayName).toBe("Runbook");

      const got = await api("GET", `/teams/team_general/channels/channel_general/tabs/${created.body.id}`);
      expect(got.body.configuration.contentUrl).toContain("runbook");

      const patched = await api("PATCH", `/teams/team_general/channels/channel_general/tabs/${created.body.id}`, { displayName: "Runbook 2" });
      expect(patched.body.displayName).toBe("Runbook 2");
      expect((await api("DELETE", `/teams/team_general/channels/channel_general/tabs/${created.body.id}`)).status).toBe(204);
    });

    it("installs, lists, gets, upgrades, and deletes team apps", async () => {
      const created = await api("POST", "/teams/team_general/installedApps", { teamsAppId: "app_test", displayName: "Test App" });
      expect(created.status).toBe(201);
      expect(created.body.teamsApp.id).toBe("app_test");

      const listed = await api("GET", "/teams/team_general/installedApps");
      expect(listed.body.value[0].id).toBe(created.body.id);

      const got = await api("GET", `/teams/team_general/installedApps/${created.body.id}`);
      expect(got.body.teamsApp.displayName).toBe("Test App");
      expect((await api("POST", `/teams/team_general/installedApps/${created.body.id}/upgrade`, { version: "2.0" })).status).toBe(204);
      expect((await api("DELETE", `/teams/team_general/installedApps/${created.body.id}`)).status).toBe(204);
    });
  });

  describe("Chats", () => {
    it("lists, creates, gets, updates, notifies, and deletes chats", async () => {
      const created = await api("POST", "/chats", {
        chatType: "group",
        topic: "Local Chat",
        members: [{ userId: "user_parlel", displayName: "Parlel Agent" }, { userId: "user_alice", displayName: "Alice Example" }],
      });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/chats?$filter=topic eq 'Local Chat'");
      expect(listed.body.value[0].id).toBe(created.body.id);

      const got = await api("GET", `/chats/${created.body.id}`);
      expect(got.body.topic).toBe("Local Chat");

      const patched = await api("PATCH", `/chats/${created.body.id}`, { topic: "Updated Chat" });
      expect(patched.body.topic).toBe("Updated Chat");
      expect((await api("POST", `/chats/${created.body.id}/sendActivityNotification`, { activityType: "local" })).status).toBe(202);
      expect((await api("DELETE", `/chats/${created.body.id}`)).status).toBe(204);
    });

    it("creates, lists, counts, deltas, gets, updates, reacts, hosted-content lists, and deletes chat messages", async () => {
      const created = await api("POST", "/chats/chat_general/messages", {
        body: { contentType: "text", content: "Hello chat" },
        hostedContents: [{ id: "chat-hc", contentBytes: "aGk=", contentType: "text/plain" }],
      });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/chats/chat_general/messages");
      expect(listed.body.value[0].id).toBe(created.body.id);

      const count = await api("GET", "/chats/chat_general/messages/$count");
      expect(count.body).toBe("1");

      const delta = await api("GET", "/chats/chat_general/messages/delta");
      expect(delta.body["@odata.deltaLink"]).toContain("deltatoken");

      const got = await api("GET", `/chats/chat_general/messages/${created.body.id}`);
      expect(got.body.body.content).toBe("Hello chat");

      const patched = await api("PATCH", `/chats/chat_general/messages/${created.body.id}`, { importance: "urgent" });
      expect(patched.body.importance).toBe("urgent");
      expect((await api("POST", `/chats/chat_general/messages/${created.body.id}/setReaction`, { reactionType: "heart" })).status).toBe(204);
      expect((await api("POST", `/chats/chat_general/messages/${created.body.id}/unsetReaction`, { reactionType: "heart" })).status).toBe(204);

      const hosted = await api("GET", `/chats/chat_general/messages/${created.body.id}/hostedContents`);
      expect(hosted.body.value[0].id).toBe("chat-hc");
      expect((await api("DELETE", `/chats/chat_general/messages/${created.body.id}`)).status).toBe(204);
    });

    it("creates, lists, gets, updates, and deletes chat members", async () => {
      const created = await api("POST", "/chats/chat_general/members", { userId: "user_new", displayName: "New Person" });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/chats/chat_general/members");
      expect(listed.body.value.some((m: any) => m.id === created.body.id)).toBe(true);

      const got = await api("GET", `/chats/chat_general/members/${created.body.id}`);
      expect(got.body.displayName).toBe("New Person");

      const patched = await api("PATCH", `/chats/chat_general/members/${created.body.id}`, { roles: ["owner"] });
      expect(patched.body.roles).toEqual(["owner"]);
      expect((await api("DELETE", `/chats/chat_general/members/${created.body.id}`)).status).toBe(204);
    });

    it("installs, lists, gets, upgrades, and deletes chat apps", async () => {
      const created = await api("POST", "/chats/chat_general/installedApps", { teamsAppId: "chat_app", displayName: "Chat App" });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/chats/chat_general/installedApps");
      expect(listed.body.value[0].id).toBe(created.body.id);

      const got = await api("GET", `/chats/chat_general/installedApps/${created.body.id}`);
      expect(got.body.teamsApp.id).toBe("chat_app");
      expect((await api("POST", `/chats/chat_general/installedApps/${created.body.id}/upgrade`, { version: "2.0" })).status).toBe(204);
      expect((await api("DELETE", `/chats/chat_general/installedApps/${created.body.id}`)).status).toBe(204);
    });
  });

  describe("Subscriptions, Batch, and Errors", () => {
    it("creates, lists, gets, updates, and deletes subscriptions", async () => {
      const created = await api("POST", "/subscriptions", { changeType: "created", notificationUrl: "https://parlel.test/hook", resource: "/teams/team_general/channels/channel_general/messages" });
      expect(created.status).toBe(201);

      const listed = await api("GET", "/subscriptions");
      expect(listed.body.value[0].id).toBe(created.body.id);

      const got = await api("GET", `/subscriptions/${created.body.id}`);
      expect(got.body.resource).toContain("messages");

      const patched = await api("PATCH", `/subscriptions/${created.body.id}`, { clientState: "state" });
      expect(patched.body.clientState).toBe("state");
      expect((await api("DELETE", `/subscriptions/${created.body.id}`)).status).toBe(204);
    });

    it("executes JSON batch requests", async () => {
      const batch = await api("POST", "/$batch", {
        requests: [
          { id: "1", method: "GET", url: "/me" },
          { id: "2", method: "GET", url: "/teams/team_general" },
        ],
      });
      expect(batch.status).toBe(200);
      expect(batch.body.responses).toHaveLength(2);
      expect(batch.body.responses[0]).toMatchObject({ id: "1", status: 200 });
      expect(batch.body.responses[1].body.displayName).toBe("Parlel Team");
    });

    it("returns Microsoft Graph-shaped errors", async () => {
      const missing = await api("GET", "/teams/missing");
      expect(missing.status).toBe(404);
      expect(missing.body.error).toMatchObject({ code: "ErrorItemNotFound", message: "Team not found" });
      expect(missing.body.error.innerError["client-request-id"]).toBe("test-request");

      const invalid = await api("POST", "/teams/team_general/channels", { description: "missing name" });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("ErrorInvalidRequest");

      const method = await api("PUT", "/teams/team_general", { displayName: "Nope" });
      expect(method.status).toBe(405);
      expect(method.body.error.code).toBe("Request_BadRequest");
    });
  });
});
