// parlel/teams - lightweight, dependency-free fake of Microsoft Graph Teams and chats.
// Compatible with @microsoft/microsoft-graph-client when its base URL points at
// http://127.0.0.1:4621/v1.0. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

class GraphError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function graphCollection(items, q, collectionPath, extras = {}) {
  let list = [...items];
  const filter = q.get("$filter");
  const search = q.get("$search");
  const orderby = q.get("$orderby");
  const select = q.get("$select");
  const count = q.get("$count") === "true";

  if (filter) list = list.filter((item) => matchesFilter(item, filter));
  if (search) {
    const needle = search.replace(/^"|"$/g, "").toLowerCase();
    list = list.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }
  if (orderby) {
    const [field, dir = "asc"] = orderby.split(/\s+/);
    list.sort((a, b) => String(readField(a, field) || "").localeCompare(String(readField(b, field) || "")) * (dir.toLowerCase() === "desc" ? -1 : 1));
  }

  const total = list.length;
  const top = Math.max(0, Number(q.get("$top") || q.get("top") || total || 100));
  const skip = Math.max(0, Number(q.get("$skip") || q.get("skip") || 0));
  let page = list.slice(skip, skip + top);
  if (select) page = page.map((item) => selectFields(item, select));
  const nextSkip = skip + top;
  const nextLink = nextSkip < total ? `${collectionPath}${collectionPath.includes("?") ? "&" : "?"}$skip=${nextSkip}` : undefined;
  return { "@odata.context": "$metadata#collection", value: page.map(clone), ...(count ? { "@odata.count": total } : {}), ...(nextLink ? { "@odata.nextLink": nextLink } : {}), ...extras };
}

function readField(item, field) {
  return String(field).split("/").reduce((value, key) => value?.[key], item);
}

function selectFields(item, select) {
  const selected = { id: item.id };
  for (const field of select.split(",").map((part) => part.trim()).filter(Boolean)) selected[field] = item[field];
  return selected;
}

function matchesFilter(item, filter) {
  const normalized = filter.trim();
  const eq = normalized.match(/^([A-Za-z0-9_/.]+)\s+eq\s+'([^']*)'$/i);
  if (eq) return String(readField(item, eq[1]) ?? "") === eq[2];
  const contains = normalized.match(/^contains\(([A-Za-z0-9_/.]+),'([^']*)'\)$/i);
  if (contains) return String(readField(item, contains[1]) ?? "").toLowerCase().includes(contains[2].toLowerCase());
  return true;
}

function projectEntity(item, q) {
  const base = clone(item);
  if (q.get("$select")) return selectFields(base, q.get("$select"));
  return base;
}

function identity(input, fallbackId = "user_parlel") {
  const idValue = input?.id || input?.userId || fallbackId;
  const name = input?.displayName || input?.name || idValue;
  return {
    user: {
      id: idValue,
      displayName: name,
      userIdentityType: "aadUser",
    },
  };
}

function member(input = {}, fallbackUserId = "user_parlel") {
  const userId = input.userId || input.id || input.roles?.[0]?.userId || fallbackUserId;
  return {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    id: input.id || id("member"),
    roles: input.roles || [],
    displayName: input.displayName || input.name || userId,
    userId,
    email: input.email || `${userId}@parlel.test`,
    tenantId: input.tenantId || "parlel",
  };
}

export class TeamsServer {
  constructor(port = 4621, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.displayName = options.displayName || "Parlel Agent";
    this.userId = options.userId || "user_parlel";
    this.mail = options.mail || "agent@parlel.test";
    this.server = null;
    this.reset();
  }

  reset() {
    this.users = new Map();
    this.teams = new Map();
    this.channels = new Map();
    this.channelMessages = new Map();
    this.channelReplies = new Map();
    this.teamMembers = new Map();
    this.channelMembers = new Map();
    this.channelTabs = new Map();
    this.teamApps = new Map();
    this.chats = new Map();
    this.chatMessages = new Map();
    this.chatMembers = new Map();
    this.chatApps = new Map();
    this.subscriptions = new Map();
    this._seedDefaults();
  }

  _seedDefaults() {
    const me = this.user();
    const alice = { id: "user_alice", displayName: "Alice Example", mail: "alice@parlel.test", userPrincipalName: "alice@parlel.test" };
    this.users.set(me.id, me);
    this.users.set(alice.id, alice);
    this.users.set(me.mail, me);
    this.users.set(alice.mail, alice);

    const team = this.makeTeam({ id: "team_general", displayName: "Parlel Team", description: "Default local team" });
    this.teams.set(team.id, team);
    this.teamMembers.set(team.id, new Map([["member_owner", member({ id: "member_owner", userId: me.id, displayName: me.displayName, roles: ["owner"], email: me.mail })]]));
    this.channels.set(team.id, new Map());
    this.teamApps.set(team.id, new Map());
    const channel = this.makeChannel(team.id, { id: "channel_general", displayName: "General", description: "General channel", membershipType: "standard" });
    this.channels.get(team.id).set(channel.id, channel);
    this.channelMessages.set(channel.id, new Map());
    this.channelReplies.set(channel.id, new Map());
    this.channelMembers.set(channel.id, new Map([["member_owner", member({ id: "member_owner", userId: me.id, displayName: me.displayName, roles: ["owner"], email: me.mail })]]));
    this.channelTabs.set(channel.id, new Map());

    const chat = this.makeChat({ id: "chat_general", chatType: "group", topic: "Parlel Chat", members: [member({ userId: me.id, displayName: me.displayName, email: me.mail }), member({ userId: alice.id, displayName: alice.displayName, email: alice.mail })] });
    this.chats.set(chat.id, chat);
    this.chatMessages.set(chat.id, new Map());
    this.chatMembers.set(chat.id, new Map(chat.members.map((m) => [m.id, m])));
    this.chatApps.set(chat.id, new Map());
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof GraphError ? error : new GraphError(500, "InternalServerError", error.message || "Internal error"), req.headers["client-request-id"]);
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

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";
    res.setHeader("x-teams-emulator", "parlel");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, client-request-id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (method === "OPTIONS") return this.sendJson(res, 204, null);

    if (url.pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "teams", teams: this.teams.size, chats: this.chats.size });
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (["/", "/v1.0", "/beta"].includes(url.pathname)) return this.sendJson(res, 200, { "@odata.context": "$metadata", service: "teams", emulator: "parlel" });

    const body = this.parseJson(await this.readBody(req));
    const prefix = url.pathname.startsWith("/v1.0/") ? "/v1.0/" : url.pathname.startsWith("/beta/") ? "/beta/" : "/";
    const parts = splitPath(url.pathname.slice(prefix.length));
    return this.route(res, method, parts, url.searchParams, body, prefix === "/" ? "" : prefix.slice(0, -1), req.headers["client-request-id"]);
  }

  route(res, method, parts, q, body, basePath = "/v1.0") {
    if (parts[0] === "$batch" && method === "POST") return this.batch(res, body, basePath);
    if (parts[0] === "subscriptions") return this.routeSubscriptions(res, method, parts.slice(1), q, body, `${basePath}/subscriptions`);
    if (parts[0] === "me") return this.routeUserRoot(res, method, parts.slice(1), q, body, basePath, "me");
    if (parts[0] === "users" && parts[1]) return this.routeUserRoot(res, method, parts.slice(2), q, body, basePath, parts[1]);
    if (parts[0] === "groups" && parts[1] && parts[2] === "team") return this.routeGroupTeam(res, method, parts[1], parts.slice(3), q, body, basePath);
    if (parts[0] === "teams") return this.routeTeams(res, method, parts.slice(1), q, body, `${basePath}/teams`);
    if (parts[0] === "chats") return this.routeChats(res, method, parts.slice(1), q, body, `${basePath}/chats`);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeUserRoot(res, method, parts, q, body, basePath, userId) {
    const user = this.mustUser(userId);
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, clone(user));
    if (parts.length === 1 && parts[0] === "joinedTeams" && method === "GET") return this.sendJson(res, 200, graphCollection(this.joinedTeams(user.id), q, `${basePath}/${userId === "me" ? "me" : `users/${encodeURIComponent(userId)}`}/joinedTeams`));
    if (parts.length === 1 && parts[0] === "chats" && method === "GET") return this.sendJson(res, 200, graphCollection(this.userChats(user.id), q, `${basePath}/me/chats`));
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeGroupTeam(res, method, groupId, parts, q, body, basePath) {
    if (parts.length !== 0) throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
    if (method === "GET") return this.sendJson(res, 200, this.mustTeam(groupId));
    if (method === "PUT") {
      const team = this.createTeam({ id: groupId, ...body });
      return this.sendJson(res, 201, team);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeTeams(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(this.teams.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 202, this.createTeam(body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }

    const teamId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, projectEntity(this.mustTeam(teamId), q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateTeam(teamId, body));
      if (method === "DELETE") return this.deleteTeam(res, teamId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }

    if (parts.length === 2 && parts[1] === "archive" && method === "POST") return this.archiveTeam(res, teamId, true);
    if (parts.length === 2 && parts[1] === "unarchive" && method === "POST") return this.archiveTeam(res, teamId, false);
    if (parts.length === 2 && parts[1] === "sendActivityNotification" && method === "POST") return this.sendJson(res, 202, null);
    if (parts[1] === "channels") return this.routeChannels(res, method, teamId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(teamId)}/channels`);
    if (parts[1] === "members") return this.routeMembers(res, method, this.teamMembers, teamId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(teamId)}/members`);
    if (parts[1] === "installedApps") return this.routeInstalledApps(res, method, this.teamApps, teamId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(teamId)}/installedApps`);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeChannels(res, method, teamId, parts, q, body, collectionPath) {
    this.mustTeam(teamId);
    const channels = this.channels.get(teamId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(channels.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createChannel(teamId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const channelId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, projectEntity(this.mustChannel(teamId, channelId), q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateChannel(teamId, channelId, body));
      if (method === "DELETE") return this.deleteChannel(res, teamId, channelId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts[1] === "messages") return this.routeChannelMessages(res, method, teamId, channelId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(channelId)}/messages`);
    if (parts[1] === "members") return this.routeMembers(res, method, this.channelMembers, channelId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(channelId)}/members`);
    if (parts[1] === "tabs") return this.routeTabs(res, method, channelId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(channelId)}/tabs`);
    if (parts.length === 2 && parts[1] === "completeMigration" && method === "POST") return this.sendJson(res, 204, null);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeChannelMessages(res, method, teamId, channelId, parts, q, body, collectionPath) {
    this.mustChannel(teamId, channelId);
    const messages = this.channelMessages.get(channelId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(messages.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createChannelMessage(channelId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 1 && parts[0] === "delta" && method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(messages.values()), q, collectionPath, { "@odata.deltaLink": `${collectionPath}/delta?$deltatoken=${Date.now()}` }));
    if (parts.length === 1 && parts[0] === "$count" && method === "GET") return this.sendText(res, 200, String(messages.size));

    const messageId = parts[0];
    if (parts.length === 1) {
      const message = this.mustChannelMessage(channelId, messageId);
      if (method === "GET") return this.sendJson(res, 200, this.projectMessage(message, q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateMessage(message, body));
      if (method === "DELETE") return this.deleteMapItem(res, messages, messageId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts[1] === "replies") return this.routeReplies(res, method, channelId, messageId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(messageId)}/replies`);
    if (parts.length === 2 && ["setReaction", "unsetReaction"].includes(parts[1]) && method === "POST") return this.messageReaction(res, this.mustChannelMessage(channelId, messageId), parts[1], body);
    if (parts.length === 2 && parts[1] === "hostedContents" && method === "GET") return this.sendJson(res, 200, graphCollection(this.mustChannelMessage(channelId, messageId).hostedContents || [], q, `${collectionPath}/${encodeURIComponent(messageId)}/hostedContents`));
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeReplies(res, method, channelId, messageId, parts, q, body, collectionPath) {
    this.mustChannelMessage(channelId, messageId);
    if (!this.channelReplies.has(messageId)) this.channelReplies.set(messageId, new Map());
    const replies = this.channelReplies.get(messageId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(replies.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createReply(messageId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const reply = replies.get(parts[0]);
    if (!reply) throw new GraphError(404, "ErrorItemNotFound", "Reply not found");
    if (method === "GET") return this.sendJson(res, 200, this.projectMessage(reply, q));
    if (method === "PATCH") return this.sendJson(res, 200, this.updateMessage(reply, body));
    if (method === "DELETE") return this.deleteMapItem(res, replies, parts[0]);
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeMembers(res, method, store, ownerId, parts, q, body, collectionPath) {
    const members = store.get(ownerId);
    if (!members) throw new GraphError(404, "ErrorItemNotFound", "Resource not found");
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(members.values()), q, collectionPath));
      if (method === "POST") {
        const created = member(body);
        members.set(created.id, created);
        return this.sendJson(res, 201, clone(created));
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const existing = members.get(parts[0]);
    if (!existing) throw new GraphError(404, "ErrorItemNotFound", "Member not found");
    if (method === "GET") return this.sendJson(res, 200, projectEntity(existing, q));
    if (method === "PATCH") {
      Object.assign(existing, body, { id: existing.id });
      return this.sendJson(res, 200, clone(existing));
    }
    if (method === "DELETE") return this.deleteMapItem(res, members, parts[0]);
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeTabs(res, method, channelId, parts, q, body, collectionPath) {
    const tabs = this.channelTabs.get(channelId);
    if (!tabs) throw new GraphError(404, "ErrorItemNotFound", "Channel not found");
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(tabs.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createTab(channelId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const tab = tabs.get(parts[0]);
    if (!tab) throw new GraphError(404, "ErrorItemNotFound", "Tab not found");
    if (method === "GET") return this.sendJson(res, 200, projectEntity(tab, q));
    if (method === "PATCH") {
      Object.assign(tab, body, { id: tab.id });
      return this.sendJson(res, 200, clone(tab));
    }
    if (method === "DELETE") return this.deleteMapItem(res, tabs, parts[0]);
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeInstalledApps(res, method, store, ownerId, parts, q, body, collectionPath) {
    const apps = store.get(ownerId);
    if (!apps) throw new GraphError(404, "ErrorItemNotFound", "Resource not found");
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(apps.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.installApp(apps, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const app = apps.get(parts[0]);
    if (!app) throw new GraphError(404, "ErrorItemNotFound", "Installed app not found");
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, projectEntity(app, q));
      if (method === "DELETE") return this.deleteMapItem(res, apps, parts[0]);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 2 && parts[1] === "upgrade" && method === "POST") {
      app.version = body.version || app.version || "1.0";
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeChats(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(this.chats.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createChat(body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const chatId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, projectEntity(this.mustChat(chatId), q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateChat(chatId, body));
      if (method === "DELETE") return this.deleteChat(res, chatId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts[1] === "messages") return this.routeChatMessages(res, method, chatId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(chatId)}/messages`);
    if (parts[1] === "members") return this.routeMembers(res, method, this.chatMembers, chatId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(chatId)}/members`);
    if (parts[1] === "installedApps") return this.routeInstalledApps(res, method, this.chatApps, chatId, parts.slice(2), q, body, `${collectionPath}/${encodeURIComponent(chatId)}/installedApps`);
    if (parts.length === 2 && parts[1] === "sendActivityNotification" && method === "POST") return this.sendJson(res, 202, null);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeChatMessages(res, method, chatId, parts, q, body, collectionPath) {
    this.mustChat(chatId);
    const messages = this.chatMessages.get(chatId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(messages.values()), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createChatMessage(chatId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 1 && parts[0] === "delta" && method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(messages.values()), q, collectionPath, { "@odata.deltaLink": `${collectionPath}/delta?$deltatoken=${Date.now()}` }));
    if (parts.length === 1 && parts[0] === "$count" && method === "GET") return this.sendText(res, 200, String(messages.size));
    const message = messages.get(parts[0]);
    if (!message) throw new GraphError(404, "ErrorItemNotFound", "Message not found");
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, this.projectMessage(message, q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateMessage(message, body));
      if (method === "DELETE") return this.deleteMapItem(res, messages, parts[0]);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    if (parts.length === 2 && ["setReaction", "unsetReaction"].includes(parts[1]) && method === "POST") return this.messageReaction(res, message, parts[1], body);
    if (parts.length === 2 && parts[1] === "hostedContents" && method === "GET") return this.sendJson(res, 200, graphCollection(message.hostedContents || [], q, `${collectionPath}/${encodeURIComponent(message.id)}/hostedContents`));
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeSubscriptions(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(Array.from(this.subscriptions.values()), q, collectionPath));
      if (method === "POST") {
        if (!body.changeType || !body.notificationUrl || !body.resource) throw new GraphError(400, "ErrorInvalidRequest", "changeType, notificationUrl, and resource are required");
        const subscription = { id: id("sub"), changeType: body.changeType, notificationUrl: body.notificationUrl, resource: body.resource, expirationDateTime: body.expirationDateTime || new Date(Date.now() + 3600000).toISOString(), clientState: body.clientState };
        this.subscriptions.set(subscription.id, subscription);
        return this.sendJson(res, 201, clone(subscription));
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const subscription = this.subscriptions.get(parts[0]);
    if (!subscription) throw new GraphError(404, "ErrorItemNotFound", "Subscription not found");
    if (method === "GET") return this.sendJson(res, 200, clone(subscription));
    if (method === "PATCH") {
      Object.assign(subscription, body, { id: subscription.id });
      return this.sendJson(res, 200, clone(subscription));
    }
    if (method === "DELETE") return this.deleteMapItem(res, this.subscriptions, parts[0]);
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  batch(res, body, basePath) {
    const responses = [];
    for (const request of body.requests || []) {
      try {
        const requestUrl = new URL(request.url, `http://parlel${request.url.startsWith("/") ? "" : "/"}`);
        let payload;
        let status = 200;
        const fakeRes = {
          statusCode: 200,
          headers: {},
          setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
          end: (text = "") => {
            status = fakeRes.statusCode;
            payload = text ? JSON.parse(text) : undefined;
          },
        };
        const prefix = requestUrl.pathname.startsWith("/v1.0/") ? "/v1.0/" : requestUrl.pathname.startsWith("/beta/") ? "/beta/" : "/";
        this.route(fakeRes, request.method || "GET", splitPath(requestUrl.pathname.slice(prefix.length)), requestUrl.searchParams, request.body || {}, basePath);
        responses.push({ id: request.id, status, headers: { "content-type": "application/json" }, body: payload });
      } catch (error) {
        const graphError = error instanceof GraphError ? error : new GraphError(500, "InternalServerError", error.message || "Internal error");
        responses.push({ id: request.id, status: graphError.status, body: { error: this.errorBody(graphError) } });
      }
    }
    return this.sendJson(res, 200, { responses });
  }

  user() {
    return { id: this.userId, displayName: this.displayName, mail: this.mail, userPrincipalName: this.mail };
  }

  makeTeam(input = {}) {
    const created = now();
    return {
      id: input.id || id("team"),
      displayName: input.displayName || input["template@odata.bind"]?.split("/").pop()?.replace(/'/g, "") || "Team",
      description: input.description || "",
      internalId: input.internalId || id("internal"),
      classification: input.classification || null,
      specialization: input.specialization || "none",
      visibility: input.visibility || "private",
      webUrl: input.webUrl || "https://teams.microsoft.com/l/team/local",
      isArchived: input.isArchived || false,
      createdDateTime: input.createdDateTime || created,
    };
  }

  createTeam(body = {}) {
    if (!body.displayName && !body["template@odata.bind"]) throw new GraphError(400, "ErrorInvalidRequest", "displayName is required");
    const team = this.makeTeam(body);
    this.teams.set(team.id, team);
    this.channels.set(team.id, new Map());
    this.teamMembers.set(team.id, new Map([["member_owner", member({ id: "member_owner", userId: this.userId, displayName: this.displayName, roles: ["owner"], email: this.mail })]]));
    this.teamApps.set(team.id, new Map());
    this.createChannel(team.id, { displayName: "General", description: "General channel", membershipType: "standard" });
    return clone(team);
  }

  updateTeam(teamId, body) {
    const team = this.mustTeam(teamId);
    for (const field of ["displayName", "description", "classification", "visibility", "isArchived"]) if (body[field] !== undefined) team[field] = body[field];
    return clone(team);
  }

  deleteTeam(res, teamId) {
    this.mustTeam(teamId);
    for (const channelId of this.channels.get(teamId)?.keys() || []) {
      this.channelMessages.delete(channelId);
      this.channelReplies.delete(channelId);
      this.channelMembers.delete(channelId);
      this.channelTabs.delete(channelId);
    }
    this.teams.delete(teamId);
    this.channels.delete(teamId);
    this.teamMembers.delete(teamId);
    this.teamApps.delete(teamId);
    return this.sendJson(res, 204, null);
  }

  archiveTeam(res, teamId, archived) {
    const team = this.mustTeam(teamId);
    team.isArchived = archived;
    return this.sendJson(res, 202, null);
  }

  makeChannel(teamId, input = {}) {
    const created = now();
    return {
      id: input.id || id("channel"),
      displayName: input.displayName || "Channel",
      description: input.description || "",
      email: input.email || `${teamId}.${input.displayName || "channel"}@parlel.test`,
      webUrl: input.webUrl || "https://teams.microsoft.com/l/channel/local",
      membershipType: input.membershipType || "standard",
      createdDateTime: input.createdDateTime || created,
      isFavoriteByDefault: input.isFavoriteByDefault || false,
    };
  }

  createChannel(teamId, body = {}) {
    if (!body.displayName) throw new GraphError(400, "ErrorInvalidRequest", "displayName is required");
    const channel = this.makeChannel(teamId, body);
    this.channels.get(teamId).set(channel.id, channel);
    this.channelMessages.set(channel.id, new Map());
    this.channelReplies.set(channel.id, new Map());
    this.channelMembers.set(channel.id, new Map());
    this.channelTabs.set(channel.id, new Map());
    return clone(channel);
  }

  updateChannel(teamId, channelId, body) {
    const channel = this.mustChannel(teamId, channelId);
    for (const field of ["displayName", "description", "membershipType", "isFavoriteByDefault"]) if (body[field] !== undefined) channel[field] = body[field];
    return clone(channel);
  }

  deleteChannel(res, teamId, channelId) {
    this.mustChannel(teamId, channelId);
    this.channels.get(teamId).delete(channelId);
    this.channelMessages.delete(channelId);
    this.channelReplies.delete(channelId);
    this.channelMembers.delete(channelId);
    this.channelTabs.delete(channelId);
    return this.sendJson(res, 204, null);
  }

  makeMessage(input = {}, source = "channel") {
    const created = now();
    return {
      id: input.id || id("msg"),
      replyToId: input.replyToId || null,
      etag: input.etag || randomBytes(8).toString("base64url"),
      messageType: input.messageType || "message",
      createdDateTime: input.createdDateTime || created,
      lastModifiedDateTime: input.lastModifiedDateTime || created,
      lastEditedDateTime: input.lastEditedDateTime || null,
      deletedDateTime: null,
      subject: input.subject || null,
      summary: input.summary || null,
      chatId: input.chatId,
      importance: input.importance || "normal",
      locale: input.locale || "en-us",
      webUrl: input.webUrl || `https://teams.microsoft.com/l/message/${source}/local`,
      from: input.from || identity({ id: this.userId, displayName: this.displayName }),
      body: input.body || { contentType: "text", content: input.content || "" },
      attachments: input.attachments || [],
      mentions: input.mentions || [],
      reactions: input.reactions || [],
      hostedContents: input.hostedContents || [],
    };
  }

  createChannelMessage(channelId, body = {}) {
    if (!body.body && !body.content) throw new GraphError(400, "ErrorInvalidRequest", "body is required");
    const message = this.makeMessage(body, "channel");
    this.channelMessages.get(channelId).set(message.id, message);
    this.channelReplies.set(message.id, new Map());
    return this.projectMessage(message, new URLSearchParams());
  }

  createReply(messageId, body = {}) {
    if (!body.body && !body.content) throw new GraphError(400, "ErrorInvalidRequest", "body is required");
    const reply = this.makeMessage({ ...body, replyToId: messageId }, "reply");
    this.channelReplies.get(messageId).set(reply.id, reply);
    return this.projectMessage(reply, new URLSearchParams());
  }

  createChat(body = {}) {
    if (!body.chatType && !body.members) throw new GraphError(400, "ErrorInvalidRequest", "chatType or members is required");
    const chat = this.makeChat(body);
    this.chats.set(chat.id, chat);
    this.chatMessages.set(chat.id, new Map());
    this.chatMembers.set(chat.id, new Map(chat.members.map((m) => [m.id, m])));
    this.chatApps.set(chat.id, new Map());
    return clone(chat);
  }

  makeChat(input = {}) {
    const created = now();
    const members = (input.members || []).map((entry) => member(entry));
    if (!members.length) members.push(member({ userId: this.userId, displayName: this.displayName, email: this.mail }));
    return {
      id: input.id || id("chat"),
      topic: input.topic || null,
      chatType: input.chatType || "oneOnOne",
      createdDateTime: input.createdDateTime || created,
      lastUpdatedDateTime: input.lastUpdatedDateTime || created,
      webUrl: input.webUrl || "https://teams.microsoft.com/l/chat/local",
      onlineMeetingInfo: input.onlineMeetingInfo || null,
      members,
    };
  }

  updateChat(chatId, body) {
    const chat = this.mustChat(chatId);
    for (const field of ["topic", "chatType"]) if (body[field] !== undefined) chat[field] = body[field];
    chat.lastUpdatedDateTime = now();
    return clone(chat);
  }

  deleteChat(res, chatId) {
    this.mustChat(chatId);
    this.chats.delete(chatId);
    this.chatMessages.delete(chatId);
    this.chatMembers.delete(chatId);
    this.chatApps.delete(chatId);
    return this.sendJson(res, 204, null);
  }

  createChatMessage(chatId, body = {}) {
    if (!body.body && !body.content) throw new GraphError(400, "ErrorInvalidRequest", "body is required");
    const message = this.makeMessage({ ...body, chatId }, "chat");
    this.chatMessages.get(chatId).set(message.id, message);
    return this.projectMessage(message, new URLSearchParams());
  }

  updateMessage(message, body) {
    for (const field of ["subject", "summary", "importance", "locale", "body", "attachments", "mentions", "hostedContents"]) if (body[field] !== undefined) message[field] = body[field];
    message.lastModifiedDateTime = now();
    message.lastEditedDateTime = now();
    message.etag = randomBytes(8).toString("base64url");
    return this.projectMessage(message, new URLSearchParams());
  }

  projectMessage(message, q) {
    const base = clone(message);
    if (q.get("$expand")?.includes("hostedContents")) base.hostedContents = message.hostedContents || [];
    if (q.get("$select")) return selectFields(base, q.get("$select"));
    return base;
  }

  createTab(channelId, body = {}) {
    if (!body.displayName) throw new GraphError(400, "ErrorInvalidRequest", "displayName is required");
    const tab = {
      id: body.id || id("tab"),
      displayName: body.displayName,
      webUrl: body.webUrl || "https://teams.microsoft.com/l/entity/local",
      configuration: body.configuration || {},
      teamsApp: body.teamsApp || { id: body.teamsAppId || "app_parlel", displayName: "Parlel App" },
    };
    this.channelTabs.get(channelId).set(tab.id, tab);
    return clone(tab);
  }

  installApp(apps, body = {}) {
    const app = {
      id: body.id || id("installedApp"),
      consentedPermissionSet: body.consentedPermissionSet || {},
      teamsApp: body.teamsApp || { id: body.teamsAppId || body["teamsApp@odata.bind"]?.split("/").pop()?.replace(/'|\)/g, "") || "app_parlel", displayName: body.displayName || "Parlel App" },
      version: body.version || "1.0",
    };
    apps.set(app.id, app);
    return clone(app);
  }

  messageReaction(res, message, action, body = {}) {
    const reactionType = body.reactionType || body.reaction || "like";
    if (action === "setReaction") {
      if (!message.reactions.some((reaction) => reaction.reactionType === reactionType)) {
        message.reactions.push({ reactionType, createdDateTime: now(), user: identity({ id: this.userId, displayName: this.displayName }).user });
      }
    } else {
      message.reactions = message.reactions.filter((reaction) => reaction.reactionType !== reactionType);
    }
    return this.sendJson(res, 204, null);
  }

  joinedTeams(userId) {
    return Array.from(this.teams.values()).filter((team) => Array.from(this.teamMembers.get(team.id)?.values() || []).some((m) => m.userId === userId));
  }

  userChats(userId) {
    return Array.from(this.chats.values()).filter((chat) => Array.from(this.chatMembers.get(chat.id)?.values() || []).some((m) => m.userId === userId));
  }

  mustUser(userId) {
    if (userId === "me") return this.user();
    const user = this.users.get(userId);
    if (!user) throw new GraphError(404, "ErrorItemNotFound", "User not found");
    return user;
  }

  mustTeam(teamId) {
    const team = this.teams.get(teamId);
    if (!team) throw new GraphError(404, "ErrorItemNotFound", "Team not found");
    return team;
  }

  mustChannel(teamId, channelId) {
    const channel = this.channels.get(teamId)?.get(channelId);
    if (!channel) throw new GraphError(404, "ErrorItemNotFound", "Channel not found");
    return channel;
  }

  mustChannelMessage(channelId, messageId) {
    const message = this.channelMessages.get(channelId)?.get(messageId);
    if (!message) throw new GraphError(404, "ErrorItemNotFound", "Message not found");
    return message;
  }

  mustChat(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat) throw new GraphError(404, "ErrorItemNotFound", "Chat not found");
    return chat;
  }

  deleteMapItem(res, map, key) {
    map.delete(key);
    return this.sendJson(res, 204, null);
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    const text = buffer.toString("utf8");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new GraphError(400, "ErrorInvalidRequest", "Invalid JSON payload");
    }
  }

  sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("request-id", id("req"));
    if (payload === null) return res.end();
    const body = JSON.stringify(payload);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    return res.end(body);
  }

  sendText(res, status, text) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    return res.end(text);
  }

  sendError(res, error, clientRequestId) {
    return this.sendJson(res, error.status, { error: this.errorBody(error, clientRequestId) });
  }

  errorBody(error, clientRequestId) {
    return {
      code: error.code,
      message: error.message,
      innerError: {
        date: now(),
        "request-id": id("req"),
        ...(clientRequestId ? { "client-request-id": clientRequestId } : {}),
      },
    };
  }
}
