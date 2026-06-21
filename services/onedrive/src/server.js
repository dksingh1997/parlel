// parlel/onedrive - lightweight, dependency-free fake of Microsoft Graph drive.
// Compatible with @microsoft/microsoft-graph-client when its base URL points at
// http://127.0.0.1:4622/v1.0. State is in-memory and ephemeral.

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

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

function etag() {
  return `\"${randomBytes(8).toString("hex")}\"`;
}

function sha1(buffer) {
  return createHash("sha1").update(buffer).digest("hex").toUpperCase();
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
  const normalized = String(filter || "").trim();
  const eq = normalized.match(/^([A-Za-z0-9_/.]+)\s+eq\s+'([^']*)'$/i);
  if (eq) return String(readField(item, eq[1]) ?? "") === eq[2];
  const contains = normalized.match(/^contains\(([A-Za-z0-9_/.]+),'([^']*)'\)$/i);
  if (contains) return String(readField(item, contains[1]) ?? "").toLowerCase().includes(contains[2].toLowerCase());
  return true;
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
    const needle = search.replace(/^\"|\"$/g, "").toLowerCase();
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

export class OnedriveServer {
  constructor(port = 4622, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.userId = options.userId || "user_parlel";
    this.displayName = options.displayName || "Parlel Agent";
    this.mail = options.mail || "agent@parlel.test";
    this.server = null;
    this.reset();
  }

  reset() {
    this.drives = new Map();
    this.items = new Map();
    this.children = new Map();
    this.contents = new Map();
    this.permissions = new Map();
    this.subscriptions = new Map();
    this.uploadSessions = new Map();
    this.operations = new Map();
    this.changes = [];
    this.changeId = 1;

    const drive = {
      id: "drive_parlel",
      driveType: "personal",
      name: "Parlel OneDrive",
      owner: { user: { id: this.userId, displayName: this.displayName, email: this.mail } },
      quota: { deleted: 0, remaining: 1024 * 1024 * 1024, state: "normal", total: 1024 * 1024 * 1024, used: 0 },
      webUrl: "https://onedrive.live.com/parlel",
    };
    this.drives.set(drive.id, drive);
    const root = this.makeItem({ id: "root", name: "root", parentReference: null, folder: { childCount: 0 }, root: {}, specialFolder: { name: "documents" } });
    this.items.set(root.id, root);
    this.children.set(root.id, new Set());
    this.permissions.set(root.id, new Map([["perm_owner", this.makePermission({ id: "perm_owner", roles: ["owner"], grantedTo: { user: { id: this.userId, displayName: this.displayName, email: this.mail } } })]]));
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
    res.setHeader("x-onedrive-emulator", "parlel");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, client-request-id, Range, Content-Range");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (method === "OPTIONS") return this.sendJson(res, 204, null);

    if (url.pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "onedrive", drives: this.drives.size, items: this.items.size });
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (["/", "/v1.0", "/beta"].includes(url.pathname)) return this.sendJson(res, 200, { "@odata.context": "$metadata", service: "onedrive", emulator: "parlel" });

    const bodyBuffer = await this.readBody(req);
    const contentType = req.headers["content-type"] || "";
    const body = this.parseBody(contentType, bodyBuffer);
    if (url.pathname.startsWith("/_parlel/upload/")) return this.handleUploadSession(res, method, splitPath(url.pathname)[2], bodyBuffer, req.headers);
    const prefix = url.pathname.startsWith("/v1.0/") ? "/v1.0/" : url.pathname.startsWith("/beta/") ? "/beta/" : "/";
    const parts = splitPath(url.pathname.slice(prefix.length));
    return this.route(res, method, parts, url.searchParams, body, bodyBuffer, prefix === "/" ? "" : prefix.slice(0, -1), req.headers, req.headers["client-request-id"]);
  }

  route(res, method, parts, q, body, bodyBuffer, basePath = "/v1.0", headers = {}, clientRequestId) {
    if (parts[0] === "$batch" && method === "POST") return this.batch(res, body, basePath);
    if (parts[0] === "subscriptions") return this.routeSubscriptions(res, method, parts.slice(1), q, body, `${basePath}/subscriptions`);
    if (parts[0] === "me") return this.routeUser(res, method, parts.slice(1), q, body, bodyBuffer, basePath, headers, "me");
    if (parts[0] === "users" && parts[1]) return this.routeUser(res, method, parts.slice(2), q, body, bodyBuffer, basePath, headers, parts[1]);
    if (parts[0] === "drives") return this.routeDrives(res, method, parts.slice(1), q, body, bodyBuffer, basePath, headers);
    if (parts[0] === "shares") return this.routeShares(res, method, parts.slice(1), q, body, bodyBuffer, basePath, headers);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeUser(res, method, parts, q, body, bodyBuffer, basePath, headers, userId) {
    this.mustUser(userId);
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, this.user());
    if (parts[0] === "drive") return this.routeDriveRoot(res, method, parts.slice(1), q, body, bodyBuffer, basePath, headers, `${basePath}/${userId === "me" ? "me" : `users/${encodeURIComponent(userId)}`}/drive`);
    if (parts[0] === "drives" && method === "GET") return this.sendJson(res, 200, graphCollection([...this.drives.values()], q, `${basePath}/me/drives`));
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeDrives(res, method, parts, q, body, bodyBuffer, basePath, headers) {
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, graphCollection([...this.drives.values()], q, `${basePath}/drives`));
    if (parts.length === 1 && method === "GET") return this.sendJson(res, 200, this.mustDrive(parts[0]));
    if (parts.length >= 2) {
      this.mustDrive(parts[0]);
      return this.routeDriveRoot(res, method, parts.slice(1), q, body, bodyBuffer, basePath, headers, `${basePath}/drives/${encodeURIComponent(parts[0])}`);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeDriveRoot(res, method, parts, q, body, bodyBuffer, basePath, headers, drivePath) {
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, this.defaultDrive());
    if (parts[0]?.startsWith("root:")) return this.routeColonAddress(res, method, "root", parts, q, body, bodyBuffer, headers, `${drivePath}/root`);
    if (parts[0] === "root") return this.routeItemPath(res, method, parts.slice(1), q, body, bodyBuffer, headers, drivePath, "root");
    if (parts[0] === "items" && parts[1]?.includes(":")) return this.routeColonAddress(res, method, parts[1].split(":")[0], parts.slice(1), q, body, bodyBuffer, headers, `${drivePath}/items/${encodeURIComponent(parts[1].split(":")[0])}`);
    if (parts[0] === "items" && parts[1]) return this.routeItemPath(res, method, parts.slice(2), q, body, bodyBuffer, headers, `${drivePath}/items/${encodeURIComponent(parts[1])}`, parts[1]);
    if (parts[0] === "special" && parts[1]) {
      const special = this.findSpecial(parts[1]);
      if (parts.length === 2 && method === "GET") return this.sendJson(res, 200, special);
      return this.routeItemPath(res, method, parts.slice(2), q, body, bodyBuffer, headers, `${drivePath}/special/${encodeURIComponent(parts[1])}`, special.id);
    }
    if (parts[0] === "recent" && method === "GET") return this.sendJson(res, 200, graphCollection(this.itemList().filter((item) => item.id !== "root"), q, `${drivePath}/recent`));
    if (parts[0] === "sharedWithMe" && method === "GET") return this.sendJson(res, 200, graphCollection(this.itemList().filter((item) => item.remoteItem || item.shared), q, `${drivePath}/sharedWithMe`));
    if (parts[0] === "following" && method === "GET") return this.sendJson(res, 200, graphCollection(this.itemList().filter((item) => item.followed), q, `${drivePath}/following`));
    if (parts[0] === "operations" && parts[1] && method === "GET") return this.getOperation(res, parts[1]);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeItemPath(res, method, parts, q, body, bodyBuffer, headers, itemPath, itemId) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, this.projectItem(this.mustItem(itemId), q));
      if (method === "PATCH") return this.sendJson(res, 200, this.updateItem(itemId, body));
      if (method === "DELETE") return this.deleteItem(res, itemId);
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }

    if (parts[0] === "children") return this.routeChildren(res, method, itemId, parts.slice(1), q, body, bodyBuffer, headers, `${itemPath}/children`);
    if (parts[0] === "content") return this.routeContent(res, method, itemId, q, bodyBuffer, headers);
    if (parts[0] === "createUploadSession" && method === "POST") return this.createUploadSession(res, itemId, body, itemPath);
    if (parts[0] === "copy" && method === "POST") return this.copyItem(res, itemId, body);
    if ((parts[0] === "search" || parts[0]?.startsWith("search(")) && method === "GET") return this.searchItems(res, itemId, this.functionQuery(parts[0], q), itemPath);
    if ((parts[0] === "delta" || parts[0]?.startsWith("delta(")) && method === "GET") return this.delta(res, itemId, q, itemPath);
    if (parts[0] === "permissions") return this.routePermissions(res, method, itemId, parts.slice(1), q, body, `${itemPath}/permissions`);
    if (parts[0] === "thumbnails") return this.routeThumbnails(res, method, itemId, parts.slice(1), q, itemPath);
    if (parts[0] === "invite" && method === "POST") return this.invite(res, itemId, body);
    if (parts[0] === "createLink" && method === "POST") return this.createLink(res, itemId, body);
    if (parts[0] === "follow" && method === "POST") return this.follow(res, itemId, true);
    if (parts[0] === "unfollow" && method === "POST") return this.follow(res, itemId, false);
    if (parts[0] === "preview" && method === "POST") return this.preview(res, itemId);
    if (parts[0] === "restore" && method === "POST") return this.sendJson(res, 200, this.updateItem(itemId, { deleted: undefined }));

    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeColonAddress(res, method, baseItemId, parts, q, body, bodyBuffer, headers, itemPath) {
    const joined = parts.join("/");
    const baseMatch = joined.match(/^[^:]+:(.*)$/);
    if (!baseMatch) throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
    const afterBase = baseMatch[1];
    const secondColon = afterBase.indexOf(":");
    if (secondColon === -1) throw new GraphError(400, "invalidRequest", "Invalid item path");
    return this.routeAddressedPath(res, method, baseItemId, { path: afterBase.slice(0, secondColon), action: afterBase.slice(secondColon + 1).replace(/^\//, "") || null }, q, body, bodyBuffer, headers, itemPath);
  }

  functionQuery(segment, q) {
    if (!segment?.startsWith("search(")) return q;
    const query = new URLSearchParams(q);
    const match = segment.match(/q='([^']*)'/i) || segment.match(/q=\"([^\"]*)\"/i);
    if (match) query.set("q", match[1]);
    return query;
  }

  routeChildren(res, method, parentId, parts, q, body, bodyBuffer, headers, collectionPath) {
    this.mustFolder(parentId);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection(this.childItems(parentId), q, collectionPath));
      if (method === "POST") return this.sendJson(res, 201, this.createChild(parentId, body));
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const child = this.childItems(parentId).find((item) => item.id === parts[0] || item.name === parts[0]);
    if (!child) throw new GraphError(404, "itemNotFound", "Item not found");
    return this.routeItemPath(res, method, parts.slice(1), q, body, bodyBuffer, headers, `${collectionPath}/${encodeURIComponent(child.id)}`, child.id);
  }

  routeAddressedPath(res, method, parentId, colonPath, q, body, bodyBuffer, headers, itemPath) {
    const segments = colonPath.path.split("/").filter(Boolean);
    const targetName = segments.pop();
    const folder = segments.reduce((currentId, name) => this.findChildByName(currentId, name, true).id, parentId);
    const target = targetName ? this.findChildByName(folder, targetName, false) : this.mustItem(folder);
    if (!colonPath.action) {
      if (!target) throw new GraphError(404, "itemNotFound", "Item not found");
      return this.routeItemPath(res, method, [], q, body, bodyBuffer, headers, itemPath, target.id);
    }
    if (colonPath.action === "content" && method === "PUT") {
      const item = target || this.createChild(folder, { name: targetName, file: {} });
      return this.putContent(res, item.id, bodyBuffer, headers);
    }
    if (!target) throw new GraphError(404, "itemNotFound", "Item not found");
    return this.routeItemPath(res, method, [colonPath.action], q, body, bodyBuffer, headers, itemPath, target.id);
  }

  routeContent(res, method, itemId, q, bodyBuffer, headers) {
    this.mustItem(itemId);
    if (method === "GET") return this.getContent(res, itemId);
    if (method === "PUT") return this.putContent(res, itemId, bodyBuffer, headers);
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routePermissions(res, method, itemId, parts, q, body, collectionPath) {
    this.mustItem(itemId);
    const map = this.permissions.get(itemId) || new Map();
    this.permissions.set(itemId, map);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection([...map.values()], q, collectionPath));
      if (method === "POST") {
        const permission = this.makePermission(body);
        map.set(permission.id, permission);
        return this.sendJson(res, 201, permission);
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const permission = map.get(parts[0]);
    if (!permission) throw new GraphError(404, "itemNotFound", "Permission not found");
    if (method === "GET") return this.sendJson(res, 200, permission);
    if (method === "PATCH") {
      Object.assign(permission, body);
      return this.sendJson(res, 200, clone(permission));
    }
    if (method === "DELETE") {
      map.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  routeThumbnails(res, method, itemId, parts, q, itemPath) {
    this.mustItem(itemId);
    if (method !== "GET") throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    const set = { id: "0", small: this.thumbnail(itemId, "small"), medium: this.thumbnail(itemId, "medium"), large: this.thumbnail(itemId, "large") };
    if (parts.length === 0) return this.sendJson(res, 200, graphCollection([set], q, `${itemPath}/thumbnails`));
    if (parts.length === 1 && parts[0] === "0") return this.sendJson(res, 200, set);
    if (parts.length === 2 && parts[0] === "0" && set[parts[1]]) return this.sendJson(res, 200, set[parts[1]]);
    if (parts.length === 3 && parts[0] === "0" && set[parts[1]] && parts[2] === "content") return this.sendText(res, 200, `thumbnail:${itemId}:${parts[1]}`, "image/png");
    throw new GraphError(404, "itemNotFound", "Thumbnail not found");
  }

  routeShares(res, method, parts, q, body, bodyBuffer, basePath, headers) {
    if (!parts[0]) throw new GraphError(404, "itemNotFound", "Shared item not found");
    const item = [...this.items.values()].find((candidate) => candidate.shareId === parts[0] || candidate.webUrl === parts[0] || candidate.id === parts[0]);
    if (!item) throw new GraphError(404, "itemNotFound", "Shared item not found");
    if (parts.length === 1 && method === "GET") return this.sendJson(res, 200, { id: parts[0], name: item.name, driveItem: clone(item) });
    if (parts[1] === "driveItem") return this.routeItemPath(res, method, parts.slice(2), q, body, bodyBuffer, headers, `${basePath}/shares/${encodeURIComponent(parts[0])}/driveItem`, item.id);
    throw new GraphError(404, "Request_ResourceNotFound", "Resource not found");
  }

  routeSubscriptions(res, method, parts, q, body, collectionPath) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, graphCollection([...this.subscriptions.values()], q, collectionPath));
      if (method === "POST") {
        const subscription = { id: body.id || id("sub"), resource: body.resource, changeType: body.changeType || "updated", notificationUrl: body.notificationUrl, clientState: body.clientState, expirationDateTime: body.expirationDateTime || new Date(Date.now() + 3600000).toISOString() };
        this.subscriptions.set(subscription.id, subscription);
        return this.sendJson(res, 201, subscription);
      }
      throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    }
    const subscription = this.subscriptions.get(parts[0]);
    if (!subscription) throw new GraphError(404, "ResourceNotFound", "Subscription not found");
    if (method === "GET") return this.sendJson(res, 200, subscription);
    if (method === "PATCH") {
      Object.assign(subscription, body);
      return this.sendJson(res, 200, clone(subscription));
    }
    if (method === "DELETE") {
      this.subscriptions.delete(parts[0]);
      return this.sendJson(res, 204, null);
    }
    throw new GraphError(405, "Request_BadRequest", "Method not allowed");
  }

  batch(res, body, basePath) {
    const responses = (body.requests || []).map((request) => {
      const fake = { statusCode: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(payload = "") { this.payload = payload; }, writeHead(statusCode, headers = {}) { this.statusCode = statusCode; Object.assign(this.headers, headers); } };
      try {
        const url = new URL(request.url, `http://parlel${basePath}/`);
        const prefix = url.pathname.startsWith("/v1.0/") ? "/v1.0/" : url.pathname.startsWith("/beta/") ? "/beta/" : "/";
        const parts = splitPath(url.pathname.slice(prefix.length));
        this.route(fake, request.method || "GET", parts, url.searchParams, request.body || {}, Buffer.alloc(0), prefix === "/" ? basePath : prefix.slice(0, -1), {}, undefined);
        return { id: request.id, status: fake.statusCode || 200, headers: fake.headers, body: fake.payload ? JSON.parse(fake.payload) : null };
      } catch (error) {
        const graphError = error instanceof GraphError ? error : new GraphError(500, "InternalServerError", error.message || "Internal error");
        return { id: request.id, status: graphError.status, body: this.errorBody(graphError) };
      }
    });
    return this.sendJson(res, 200, { responses });
  }

  defaultDrive() {
    return clone(this.drives.get("drive_parlel"));
  }

  mustDrive(driveId) {
    const drive = this.drives.get(driveId);
    if (!drive) throw new GraphError(404, "itemNotFound", "Drive not found");
    return clone(drive);
  }

  mustUser(userId) {
    if (["me", this.userId, this.mail].includes(userId)) return this.user();
    throw new GraphError(404, "Request_ResourceNotFound", "User not found");
  }

  user() {
    return { id: this.userId, displayName: this.displayName, mail: this.mail, userPrincipalName: this.mail };
  }

  itemList() {
    return [...this.items.values()].map(clone);
  }

  mustItem(itemId) {
    const item = this.items.get(itemId);
    if (!item) throw new GraphError(404, "itemNotFound", "Item not found");
    return item;
  }

  mustFolder(itemId) {
    const item = this.mustItem(itemId);
    if (!item.folder) throw new GraphError(400, "invalidRequest", "Item is not a folder");
    return item;
  }

  findSpecial(name) {
    const item = [...this.items.values()].find((candidate) => candidate.specialFolder?.name?.toLowerCase() === name.toLowerCase());
    if (!item) throw new GraphError(404, "itemNotFound", "Special folder not found");
    return item;
  }

  findChildByName(parentId, name, createFolder) {
    const found = this.childItems(parentId).find((child) => child.name === name);
    if (found) return found;
    if (createFolder) return this.createChild(parentId, { name, folder: {} });
    return null;
  }

  childItems(parentId) {
    return [...(this.children.get(parentId) || new Set())].map((childId) => this.items.get(childId)).filter(Boolean).map(clone);
  }

  makeItem(input = {}, content = Buffer.alloc(0)) {
    const isFolder = Boolean(input.folder) || input.name === "root";
    const item = {
      id: input.id || id("item"),
      name: input.name || "Untitled",
      createdDateTime: input.createdDateTime || now(),
      lastModifiedDateTime: now(),
      eTag: etag(),
      cTag: etag(),
      size: isFolder ? 0 : content.length,
      webUrl: input.webUrl || `https://onedrive.live.com/parlel/${encodeURIComponent(input.name || "Untitled")}`,
      parentReference: input.parentReference === undefined ? { driveId: "drive_parlel", id: "root", path: "/drive/root:" } : input.parentReference,
      createdBy: { user: { id: this.userId, displayName: this.displayName } },
      lastModifiedBy: { user: { id: this.userId, displayName: this.displayName } },
      ...(isFolder ? { folder: { childCount: input.folder?.childCount || 0 } } : { file: { mimeType: input.file?.mimeType || input.file?.contentType || input.mimeType || "application/octet-stream", hashes: { sha1Hash: sha1(content) } } }),
      ...(input.root ? { root: input.root } : {}),
      ...(input.specialFolder ? { specialFolder: input.specialFolder } : {}),
      ...(input.shared ? { shared: input.shared } : {}),
      ...(input.remoteItem ? { remoteItem: input.remoteItem } : {}),
      ...(input.deleted ? { deleted: input.deleted } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.followed ? { followed: true } : {}),
    };
    return item;
  }

  makePermission(input = {}) {
    return {
      id: input.id || id("perm"),
      roles: input.roles || ["read"],
      grantedTo: input.grantedTo || { user: { id: input.email || input.emailAddress || "user_guest", displayName: input.displayName || input.email || "Guest" } },
      invitation: input.invitation,
      link: input.link,
    };
  }

  createChild(parentId, body = {}) {
    this.mustFolder(parentId);
    if (!body.name) throw new GraphError(400, "invalidRequest", "name is required");
    const conflict = this.childItems(parentId).find((item) => item.name === body.name);
    const behavior = body["@microsoft.graph.conflictBehavior"] || "fail";
    if (conflict && behavior === "fail") throw new GraphError(409, "nameAlreadyExists", "An item with the same name already exists");
    if (conflict && behavior === "replace") this.deleteItem({ setHeader() {}, writeHead() {}, end() {} }, conflict.id);
    if (conflict && behavior === "rename") body = { ...body, name: this.renameConflict(parentId, body.name) };
    const item = this.makeItem({ ...body, parentReference: { driveId: "drive_parlel", id: parentId, path: `/drive/root:/${this.mustItem(parentId).name}` } });
    this.items.set(item.id, item);
    this.children.set(item.id, new Set());
    this.contents.set(item.id, Buffer.alloc(0));
    this.permissions.set(item.id, new Map());
    this.children.get(parentId).add(item.id);
    this.touchParent(parentId);
    this.recordChange(item, "created");
    return clone(item);
  }

  updateItem(itemId, body = {}) {
    const item = this.mustItem(itemId);
    if (item.id === "root" && body.name) throw new GraphError(400, "invalidRequest", "Root item cannot be renamed");
    for (const key of ["name", "description", "shared", "remoteItem", "deleted", "followed"]) {
      if (!(key in body)) continue;
      if (body[key] === undefined) delete item[key];
      else item[key] = body[key];
    }
    item.lastModifiedDateTime = now();
    item.eTag = etag();
    this.recordChange(item, "updated");
    return clone(item);
  }

  renameConflict(parentId, name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const names = new Set(this.childItems(parentId).map((item) => item.name));
    let index = 1;
    let candidate = `${base} (${index})${ext}`;
    while (names.has(candidate)) candidate = `${base} (${++index})${ext}`;
    return candidate;
  }

  deleteItem(res, itemId) {
    if (itemId === "root") throw new GraphError(400, "invalidRequest", "Root item cannot be deleted");
    const item = this.mustItem(itemId);
    if (item.folder) for (const childId of [...(this.children.get(itemId) || [])]) this.deleteItem({ setHeader() {}, writeHead() {}, end() {} }, childId);
    for (const childSet of this.children.values()) childSet.delete(itemId);
    this.items.delete(itemId);
    this.children.delete(itemId);
    this.contents.delete(itemId);
    this.permissions.delete(itemId);
    this.recordChange(item, "deleted");
    return this.sendJson(res, 204, null);
  }

  getContent(res, itemId) {
    const item = this.mustItem(itemId);
    if (item.folder) throw new GraphError(400, "invalidRequest", "Folder content cannot be downloaded");
    const content = this.contents.get(itemId) || Buffer.alloc(0);
    return this.sendBuffer(res, 200, content, item.file?.mimeType || "application/octet-stream");
  }

  putContent(res, itemId, bodyBuffer, headers = {}) {
    const item = this.mustItem(itemId);
    if (item.folder) {
      delete item.folder;
      item.file = { mimeType: headers["content-type"] || "application/octet-stream", hashes: {} };
    }
    const content = Buffer.from(bodyBuffer || Buffer.alloc(0));
    this.contents.set(itemId, content);
    item.size = content.length;
    item.file = { ...(item.file || {}), mimeType: headers["content-type"] || item.file?.mimeType || "application/octet-stream", hashes: { sha1Hash: sha1(content) } };
    item.lastModifiedDateTime = now();
    item.eTag = etag();
    this.recordChange(item, "updated");
    return this.sendJson(res, 200, clone(item));
  }

  createUploadSession(res, itemId, body = {}, itemPath) {
    this.mustItem(itemId);
    const sessionId = id("upload");
    const session = { id: sessionId, itemId, buffer: Buffer.alloc(0), name: body.item?.name, expirationDateTime: new Date(Date.now() + 3600000).toISOString() };
    this.uploadSessions.set(sessionId, session);
    return this.sendJson(res, 200, { uploadUrl: `http://${this.host}:${this.port}/_parlel/upload/${sessionId}`, expirationDateTime: session.expirationDateTime, nextExpectedRanges: ["0-"] });
  }

  handleUploadSession(res, method, sessionId, bodyBuffer, headers) {
    const session = this.uploadSessions.get(sessionId);
    if (!session) throw new GraphError(404, "itemNotFound", "Upload session not found");
    if (method === "DELETE") {
      this.uploadSessions.delete(sessionId);
      return this.sendJson(res, 204, null);
    }
    if (method !== "PUT") throw new GraphError(405, "Request_BadRequest", "Method not allowed");
    const range = String(headers["content-range"] || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!range) throw new GraphError(400, "invalidRequest", "Content-Range header is required");
    session.buffer = Buffer.concat([session.buffer, bodyBuffer]);
    const end = Number(range[2]);
    const total = range[3] === "*" ? null : Number(range[3]);
    if (!total || end + 1 < total) return this.sendJson(res, 202, { expirationDateTime: session.expirationDateTime, nextExpectedRanges: [`${end + 1}-`] });
    const item = session.name ? this.createChild(session.itemId, { name: session.name, file: {}, "@microsoft.graph.conflictBehavior": "rename" }) : this.mustItem(session.itemId);
    this.uploadSessions.delete(sessionId);
    return this.putContent(res, item.id, session.buffer, headers);
  }

  copyItem(res, itemId, body = {}) {
    const item = this.mustItem(itemId);
    const parentId = body.parentReference?.id || item.parentReference?.id || "root";
    const copy = this.createChild(parentId, { name: body.name || `Copy of ${item.name}`, folder: item.folder ? {} : undefined, file: item.file ? clone(item.file) : undefined, "@microsoft.graph.conflictBehavior": "rename" });
    if (!item.folder) this.contents.set(copy.id, Buffer.from(this.contents.get(itemId) || Buffer.alloc(0)));
    const operation = { id: id("op"), status: "completed", percentageComplete: 100, resourceId: copy.id, resourceLocation: `/drive/items/${copy.id}` };
    this.operations.set(operation.id, operation);
    res.setHeader("Location", `/v1.0/me/drive/operations/${operation.id}`);
    return this.sendJson(res, 202, operation);
  }

  getOperation(res, operationId) {
    const operation = this.operations.get(operationId);
    if (!operation) throw new GraphError(404, "itemNotFound", "Operation not found");
    return this.sendJson(res, 200, clone(operation));
  }

  searchItems(res, itemId, q, itemPath) {
    this.mustFolder(itemId);
    const needle = (q.get("q") || q.get("search") || "").replace(/^\"|\"$/g, "").toLowerCase();
    const scope = this.descendants(itemId);
    const matches = scope.filter((item) => item.name.toLowerCase().includes(needle) || (this.contents.get(item.id) || Buffer.alloc(0)).toString("utf8").toLowerCase().includes(needle));
    return this.sendJson(res, 200, graphCollection(matches, q, `${itemPath}/search(q='${encodeURIComponent(needle)}')`));
  }

  delta(res, itemId, q, itemPath) {
    this.mustFolder(itemId);
    return this.sendJson(res, 200, graphCollection(this.changes.map((change) => change.item), q, `${itemPath}/delta`, { "@odata.deltaLink": `${itemPath}/delta?$deltatoken=${this.changeId}` }));
  }

  invite(res, itemId, body = {}) {
    this.mustItem(itemId);
    const recipients = body.recipients || [];
    const value = recipients.map((recipient) => {
      const permission = this.makePermission({ roles: body.roles || ["read"], email: recipient.email, invitation: { email: recipient.email, signInRequired: body.requireSignIn !== false } });
      const map = this.permissions.get(itemId) || new Map();
      map.set(permission.id, permission);
      this.permissions.set(itemId, map);
      return permission;
    });
    return this.sendJson(res, 200, { value });
  }

  createLink(res, itemId, body = {}) {
    this.mustItem(itemId);
    const permission = this.makePermission({ roles: [body.scope === "anonymous" ? "read" : body.type || "read"], link: { type: body.type || "view", scope: body.scope || "anonymous", webUrl: `https://1drv.ms/${itemId}` } });
    const map = this.permissions.get(itemId) || new Map();
    map.set(permission.id, permission);
    this.permissions.set(itemId, map);
    this.mustItem(itemId).shareId = permission.id;
    return this.sendJson(res, 201, { permission });
  }

  follow(res, itemId, followed) {
    const item = this.mustItem(itemId);
    item.followed = followed;
    return this.sendJson(res, 200, clone(item));
  }

  preview(res, itemId) {
    this.mustItem(itemId);
    return this.sendJson(res, 200, { getUrl: `http://${this.host}:${this.port}/v1.0/me/drive/items/${itemId}/content`, postParameters: "", postUrl: null });
  }

  thumbnail(itemId, size) {
    return { height: size === "large" ? 800 : size === "medium" ? 176 : 96, width: size === "large" ? 800 : size === "medium" ? 176 : 96, url: `http://${this.host}:${this.port}/v1.0/me/drive/items/${itemId}/thumbnails/0/${size}/content` };
  }

  descendants(parentId) {
    const out = [];
    for (const child of this.childItems(parentId)) {
      out.push(child);
      if (child.folder) out.push(...this.descendants(child.id));
    }
    return out;
  }

  touchParent(parentId) {
    const parent = this.items.get(parentId);
    if (!parent?.folder) return;
    parent.folder.childCount = this.children.get(parentId)?.size || 0;
    parent.lastModifiedDateTime = now();
  }

  recordChange(item, reason) {
    this.changes.push({ id: String(this.changeId++), reason, item: clone(item) });
  }

  projectItem(item, q) {
    let out = clone(item);
    if (q.get("$expand")?.includes("children") && item.folder) out.children = this.childItems(item.id);
    if (q.get("$expand")?.includes("permissions")) out.permissions = [...(this.permissions.get(item.id) || new Map()).values()].map(clone);
    if (q.get("$select")) out = selectFields(out, q.get("$select"));
    return out;
  }

  parseBody(contentType, buffer) {
    if (!buffer.length) return {};
    if (String(contentType).includes("application/json")) {
      try {
        return JSON.parse(buffer.toString("utf8"));
      } catch {
        throw new GraphError(400, "invalidRequest", "Invalid JSON payload");
      }
    }
    return {};
  }

  sendJson(res, status, data) {
    if (status === 204 || data === null) {
      res.writeHead(status);
      return res.end();
    }
    const payload = JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
    return res.end(payload);
  }

  sendText(res, status, text, contentType = "text/plain") {
    res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(text) });
    return res.end(text);
  }

  sendBuffer(res, status, buffer, contentType = "application/octet-stream") {
    res.writeHead(status, { "content-type": contentType, "content-length": buffer.length });
    return res.end(buffer);
  }

  errorBody(error, clientRequestId) {
    return {
      error: {
        code: error.code,
        message: error.message,
        innerError: {
          date: now(),
          "request-id": id("req"),
          ...(clientRequestId ? { "client-request-id": clientRequestId } : {}),
        },
      },
    };
  }

  sendError(res, error, clientRequestId) {
    return this.sendJson(res, error.status || 500, this.errorBody(error, clientRequestId));
  }
}

export default OnedriveServer;
