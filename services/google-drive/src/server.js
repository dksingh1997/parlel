// parlel/google-drive - lightweight, dependency-free fake of Google Drive API v3.
// Compatible with the `googleapis` Drive client when its rootUrl is pointed at
// this server. State is in-memory and ephemeral. Reset with reset() or
// POST /_parlel/reset.

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";

class ApiError extends Error {
  constructor(code, message, reason = "badRequest", status) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status || statusForCode(code);
  }
}

function statusForCode(code) {
  return {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "ALREADY_EXISTS",
    410: "GONE",
    500: "INTERNAL",
  }[code] || "UNKNOWN";
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function matchesQuery(file, q = "") {
  const query = String(q || "").trim();
  if (!query) return true;
  const clauses = query.split(/\s+and\s+/i).map((part) => part.trim()).filter(Boolean);
  return clauses.every((clause) => {
    let match = clause.match(/^trashed\s*=\s*(true|false)$/i);
    if (match) return Boolean(file.trashed) === (match[1].toLowerCase() === "true");
    match = clause.match(/^starred\s*=\s*(true|false)$/i);
    if (match) return Boolean(file.starred) === (match[1].toLowerCase() === "true");
    match = clause.match(/^mimeType\s*=\s*'([^']+)'$/i);
    if (match) return file.mimeType === match[1];
    match = clause.match(/^name\s*=\s*'([^']+)'$/i);
    if (match) return file.name === match[1];
    match = clause.match(/^name\s+contains\s+'([^']+)'$/i);
    if (match) return file.name.includes(match[1]);
    match = clause.match(/^'([^']+)'\s+in\s+parents$/i);
    if (match) return (file.parents || []).includes(match[1]);
    match = clause.match(/^fullText\s+contains\s+'([^']+)'$/i);
    if (match) return Buffer.from(file.content || "").toString("utf8").includes(match[1]);
    return true;
  });
}

export class GoogleDriveServer {
  constructor(port = 4614, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.userEmail = options.userEmail || "parlel@example.com";
    this.server = null;
    this.reset();
  }

  reset() {
    this.files = new Map();
    this.drives = new Map();
    this.permissions = new Map();
    this.revisions = new Map();
    this.comments = new Map();
    this.replies = new Map();
    this.channels = new Map();
    this.accessProposals = new Map();
    this.approvals = new Map();
    this.changes = [];
    this.changeId = 1;
    this.apps = new Map([
      ["drive", { kind: "drive#app", id: "drive", name: "Google Drive", objectType: "file", supportsCreate: true, supportsImport: true, installed: true }],
      ["docs", { kind: "drive#app", id: "docs", name: "Google Docs", objectType: "document", supportsCreate: true, supportsImport: true, installed: true }],
    ]);
    const root = this.makeFile({ id: "root", name: "My Drive", mimeType: "application/vnd.google-apps.folder", parents: [], ownedByMe: true }, Buffer.alloc(0), false);
    this.files.set(root.id, root);
    this.permissions.set(root.id, new Map([["owner", this.makePermission({ id: "owner", type: "user", role: "owner", emailAddress: this.userEmail })]]));
    this.revisions.set(root.id, [this.makeRevision(root, true)]);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, error instanceof ApiError ? error : new ApiError(500, error.message || "Internal error", "backendError"));
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
    const pathname = url.pathname;
    res.setHeader("x-google-drive-emulator", "parlel");

    if (pathname === "/_parlel/health") return this.sendJson(res, 200, { status: "ok", service: "google-drive", files: this.files.size, drives: this.drives.size });
    if (pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }
    if (pathname === "/" || pathname === "/drive/v3" || pathname === "/v3") return this.sendJson(res, 200, { kind: "drive#parlel" });

    const bodyBuffer = await this.readBody(req);
    const isUpload = pathname.startsWith("/upload/drive/v3/") || pathname.startsWith("/upload/v3/");
    const prefix = pathname.startsWith("/drive/v3/") ? "/drive/v3/" : pathname.startsWith("/v3/") ? "/v3/" : pathname.startsWith("/upload/drive/v3/") ? "/upload/drive/v3/" : pathname.startsWith("/upload/v3/") ? "/upload/v3/" : null;
    if (!prefix) throw new ApiError(404, "Not Found", "notFound");
    const parts = splitPath(pathname.slice(prefix.length));
    const parsed = this.parseRequestBody(req.headers["content-type"] || "", bodyBuffer, isUpload, url.searchParams.get("uploadType"));
    return this.route(res, method, parts, url.searchParams, parsed.body, parsed.media);
  }

  route(res, method, parts, q, body, media) {
    const [resource, ...rest] = parts;
    if (resource === "about" && rest.length === 0 && method === "GET") return this.getAbout(res);
    if (resource === "apps") return this.routeApps(res, method, rest);
    if (resource === "files") return this.routeFiles(res, method, rest, q, body, media);
    if (resource === "drives") return this.routeDrives(res, method, rest, q, body);
    if (resource === "teamdrives") return this.routeTeamDrives(res, method, rest, q, body);
    if (resource === "changes") return this.routeChanges(res, method, rest, q, body);
    if (resource === "channels" && rest[0] === "stop" && method === "POST") return this.stopChannel(res, body);
    if (resource === "accessproposals") return this.routeAccessProposals(res, method, rest, q, body);
    if (resource === "operations" && rest.length === 1 && method === "GET") return this.getOperation(res, rest[0]);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeApps(res, method, parts) {
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, { kind: "drive#appList", items: [...this.apps.values()].map(clone) });
    if (parts.length === 1 && method === "GET") {
      const app = this.apps.get(parts[0]);
      if (!app) throw new ApiError(404, "App not found", "notFound");
      return this.sendJson(res, 200, clone(app));
    }
    throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
  }

  routeFiles(res, method, parts, q, body, media) {
    if (parts.length === 0) {
      if (method === "GET") return this.listFiles(res, q);
      if (method === "POST") return this.createFile(res, body, media, q);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    if (parts.length === 1) {
      if (parts[0] === "trash" && method === "DELETE") return this.emptyTrash(res);
      if (parts[0] === "generateIds" && method === "GET") return this.generateIds(res, q);
      if (parts[0] === "generateCseToken" && method === "GET") return this.generateCseToken(res, q);
      if (parts[0] === "emptyTrash" && method === "DELETE") return this.emptyTrash(res);
      if (method === "GET") return this.getFile(res, parts[0], q);
      if (method === "PATCH" || method === "PUT") return this.updateFile(res, parts[0], body, media, q);
      if (method === "DELETE") return this.deleteFile(res, parts[0]);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    const fileId = parts[0];
    if (parts.length === 2) {
      if (parts[1] === "copy" && method === "POST") return this.copyFile(res, fileId, body);
      if (parts[1] === "export" && method === "GET") return this.exportFile(res, fileId, q);
      if (parts[1] === "download" && method === "POST") return this.downloadFile(res, fileId);
      if (parts[1] === "watch" && method === "POST") return this.watchFile(res, fileId, body);
      if (parts[1] === "listLabels" && method === "GET") return this.listFileLabels(res, fileId);
      if (parts[1] === "modifyLabels" && method === "POST") return this.modifyFileLabels(res, fileId, body);
      if (parts[1] === "comments") return this.routeComments(res, method, fileId, [], q, body);
      if (parts[1] === "permissions") return this.routePermissions(res, method, fileId, [], body);
      if (parts[1] === "revisions") return this.routeRevisions(res, method, fileId, [], body);
      if (parts[1] === "accessproposals") return this.routeFileAccessProposals(res, method, fileId, [], body);
      if (parts[1] === "approvals:start" && method === "POST") return this.startApproval(res, fileId, body);
      if (parts[1] === "approvals") return this.routeApprovals(res, method, fileId, [], body);
    }
    if (parts[1] === "comments") return this.routeComments(res, method, fileId, parts.slice(2), q, body);
    if (parts[1] === "permissions") return this.routePermissions(res, method, fileId, parts.slice(2), body);
    if (parts[1] === "revisions") return this.routeRevisions(res, method, fileId, parts.slice(2), body);
    if (parts[1] === "accessproposals") return this.routeFileAccessProposals(res, method, fileId, parts.slice(2), body);
    if (parts[1] === "approvals") return this.routeApprovals(res, method, fileId, parts.slice(2), body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeDrives(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.listDrives(res, q);
      if (method === "POST") return this.createDrive(res, q, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    const driveId = parts[0];
    if (parts.length === 1) {
      if (method === "GET") return this.getDrive(res, driveId);
      if (method === "PATCH") return this.updateDrive(res, driveId, body);
      if (method === "DELETE") return this.deleteDrive(res, driveId);
    }
    if (parts.length === 2 && parts[1] === "hide" && method === "POST") return this.setDriveHidden(res, driveId, true);
    if (parts.length === 2 && parts[1] === "unhide" && method === "POST") return this.setDriveHidden(res, driveId, false);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeChanges(res, method, parts, q, body) {
    if (parts.length === 0 && method === "GET") return this.listChanges(res, q);
    if (parts.length === 1 && parts[0] === "startPageToken" && method === "GET") return this.sendJson(res, 200, { kind: "drive#startPageToken", startPageToken: String(this.changeId) });
    if (parts.length === 1 && parts[0] === "watch" && method === "POST") return this.watchChanges(res, body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeAccessProposals(res, method, parts, q, body) {
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, { kind: "drive#accessProposalList", accessProposals: [...this.accessProposals.values()].map(clone) });
    if (parts.length === 1 && method === "GET") {
      const proposal = this.accessProposals.get(parts[0]);
      if (!proposal) throw new ApiError(404, "Access proposal not found", "notFound");
      return this.sendJson(res, 200, clone(proposal));
    }
    if (parts.length === 2 && parts[1] === "resolve" && method === "POST") {
      const proposal = this.accessProposals.get(parts[0]);
      if (!proposal) throw new ApiError(404, "Access proposal not found", "notFound");
      proposal.resolved = true;
      proposal.action = body.action || "ACCEPT";
      return this.sendJson(res, 200, {});
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeFileAccessProposals(res, method, fileId, parts, body) {
    this.mustFile(fileId);
    const proposals = [...this.accessProposals.values()].filter((proposal) => proposal.fileId === fileId);
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, { kind: "drive#accessProposalList", accessProposals: clone(proposals) });
    const proposalId = parts[0]?.replace(/:resolve$/, "");
    const proposal = this.accessProposals.get(proposalId);
    if (!proposal || proposal.fileId !== fileId) throw new ApiError(404, "Access proposal not found", "notFound");
    if (parts.length === 1 && method === "GET" && parts[0] === proposalId) return this.sendJson(res, 200, clone(proposal));
    if (parts.length === 1 && method === "POST" && parts[0].endsWith(":resolve")) {
      proposal.resolved = true;
      proposal.action = body.action || "ACCEPT";
      return this.sendJson(res, 200, {});
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeApprovals(res, method, fileId, parts, body) {
    this.mustFile(fileId);
    const map = this.approvals.get(fileId) || new Map();
    this.approvals.set(fileId, map);
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, { kind: "drive#approvalList", approvals: [...map.values()].map(clone) });
    const approvalId = parts[0]?.replace(/:(approve|decline|cancel|comment|reassign)$/, "");
    const approval = map.get(approvalId);
    if (!approval) throw new ApiError(404, "Approval not found", "notFound");
    if (parts.length === 1 && method === "GET" && parts[0] === approvalId) return this.sendJson(res, 200, clone(approval));
    if (parts.length === 1 && method === "POST") {
      const action = parts[0].slice(approvalId.length + 1);
      if (!["approve", "decline", "cancel", "comment", "reassign"].includes(action)) throw new ApiError(404, "Not Found", "notFound");
      approval.action = action;
      approval.state = { approve: "approved", decline: "declined", cancel: "cancelled", comment: approval.state, reassign: "pending" }[action];
      approval.comment = body.comment || approval.comment;
      approval.assignedApprovers = body.assignedApprovers || approval.assignedApprovers;
      approval.modifiedTime = now();
      return this.sendJson(res, 200, clone(approval));
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  startApproval(res, fileId, body) {
    this.mustFile(fileId);
    const map = this.approvals.get(fileId) || new Map();
    this.approvals.set(fileId, map);
    const approval = { kind: "drive#approval", id: id("approval"), fileId, state: "pending", comment: body.comment || "", assignedApprovers: body.assignedApprovers || [], createdTime: now(), modifiedTime: now() };
    map.set(approval.id, approval);
    return this.sendJson(res, 200, clone(approval));
  }

  getAbout(res) {
    return this.sendJson(res, 200, {
      kind: "drive#about",
      user: { kind: "drive#user", displayName: "parlel", emailAddress: this.userEmail, me: true, permissionId: "owner" },
      storageQuota: { limit: "0", usage: String([...this.files.values()].reduce((sum, f) => sum + Number(f.size || 0), 0)), usageInDrive: "0", usageInDriveTrash: "0" },
      rootFolderId: "root",
      appInstalled: true,
      canCreateDrives: true,
      importFormats: { "text/plain": ["application/vnd.google-apps.document"] },
      exportFormats: { "application/vnd.google-apps.document": ["text/plain", "application/pdf"] },
      maxImportSizes: { "text/plain": "10485760" },
      maxUploadSize: "10485760",
    });
  }

  makeFile(metadata = {}, content = Buffer.alloc(0), log = true) {
    const fileId = metadata.id || id("file");
    const createdTime = metadata.createdTime || now();
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""));
    const file = {
      kind: "drive#file",
      id: fileId,
      name: metadata.name || "Untitled",
      mimeType: metadata.mimeType || "application/octet-stream",
      parents: metadata.parents || (fileId === "root" ? [] : ["root"]),
      spaces: metadata.spaces || ["drive"],
      starred: Boolean(metadata.starred),
      trashed: Boolean(metadata.trashed),
      explicitlyTrashed: Boolean(metadata.trashed),
      ownedByMe: metadata.ownedByMe !== false,
      driveId: metadata.driveId,
      description: metadata.description || "",
      properties: metadata.properties || {},
      appProperties: metadata.appProperties || {},
      labelInfo: metadata.labelInfo || { labels: [] },
      createdTime,
      modifiedTime: metadata.modifiedTime || createdTime,
      viewedByMeTime: metadata.viewedByMeTime || createdTime,
      version: metadata.version || "1",
      size: String(buf.length),
      md5Checksum: md5(buf),
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
      webContentLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
      content: buf.toString("base64"),
    };
    if (log) this.addChange(file, false);
    return file;
  }

  createFile(res, body, media, q) {
    const file = this.makeFile(body, media || Buffer.alloc(0));
    this.files.set(file.id, file);
    this.permissions.set(file.id, new Map([["owner", this.makePermission({ id: "owner", type: "user", role: "owner", emailAddress: this.userEmail })]]));
    this.revisions.set(file.id, [this.makeRevision(file, true)]);
    return this.sendJson(res, 200, this.publicFile(file));
  }

  getFile(res, fileId, q) {
    const file = this.mustFile(fileId);
    if (q.get("alt") === "media") return this.sendBytes(res, 200, Buffer.from(file.content || "", "base64"), file.mimeType);
    return this.sendJson(res, 200, this.publicFile(file));
  }

  listFiles(res, q) {
    const all = [...this.files.values()].filter((file) => file.id !== "root" && matchesQuery(file, q.get("q")));
    return this.sendPage(res, "drive#fileList", "files", all.map((f) => this.publicFile(f)), q);
  }

  updateFile(res, fileId, body, media, q) {
    const file = this.mustFile(fileId);
    Object.assign(file, { ...body, id: file.id, kind: "drive#file", modifiedTime: now(), version: String(Number(file.version || "1") + 1) });
    if (body.addParents) file.parents = [...new Set([...(file.parents || []), ...String(body.addParents).split(",").filter(Boolean)])];
    if (body.removeParents) file.parents = (file.parents || []).filter((parent) => !String(body.removeParents).split(",").includes(parent));
    if (media) {
      file.content = media.toString("base64");
      file.size = String(media.length);
      file.md5Checksum = md5(media);
    }
    this.revisions.get(file.id).push(this.makeRevision(file, false));
    this.addChange(file, false);
    return this.sendJson(res, 200, this.publicFile(file));
  }

  deleteFile(res, fileId) {
    const file = this.mustFile(fileId);
    this.files.delete(fileId);
    this.permissions.delete(fileId);
    this.revisions.delete(fileId);
    this.comments.delete(fileId);
    this.replies.delete(fileId);
    this.addChange(file, true);
    return this.sendEmpty(res, 204);
  }

  copyFile(res, fileId, body) {
    const source = this.mustFile(fileId);
    const file = this.makeFile({ ...source, ...body, id: body.id, name: body.name || `Copy of ${source.name}`, createdTime: undefined, modifiedTime: undefined, version: "1" }, Buffer.from(source.content || "", "base64"));
    this.files.set(file.id, file);
    this.permissions.set(file.id, new Map([["owner", this.makePermission({ id: "owner", type: "user", role: "owner", emailAddress: this.userEmail })]]));
    this.revisions.set(file.id, [this.makeRevision(file, true)]);
    return this.sendJson(res, 200, this.publicFile(file));
  }

  exportFile(res, fileId, q) {
    const file = this.mustFile(fileId);
    const mimeType = q.get("mimeType") || "text/plain";
    return this.sendBytes(res, 200, Buffer.from(file.content || "", "base64"), mimeType);
  }

  emptyTrash(res) {
    for (const file of [...this.files.values()].filter((f) => f.trashed && f.id !== "root")) this.files.delete(file.id);
    return this.sendEmpty(res, 204);
  }

  generateIds(res, q) {
    const count = Math.max(1, Math.min(1000, Number(q.get("count") || 10)));
    return this.sendJson(res, 200, { kind: "drive#generatedIds", ids: Array.from({ length: count }, () => id("file")), space: q.get("space") || "drive" });
  }

  generateCseToken(res, q) {
    const fileId = q.get("fileId") || id("file");
    return this.sendJson(res, 200, { token: `parlel-cse-token-${fileId}`, fileId });
  }

  downloadFile(res, fileId) {
    this.mustFile(fileId);
    return this.sendJson(res, 200, { name: `operations/download-${fileId}`, done: true, response: { fileId } });
  }

  watchFile(res, fileId, body) {
    this.mustFile(fileId);
    return this.createChannel(res, body, `files/${fileId}`);
  }

  listFileLabels(res, fileId) {
    const file = this.mustFile(fileId);
    return this.sendJson(res, 200, { kind: "drive#labelList", labels: clone(file.labelInfo?.labels || []) });
  }

  modifyFileLabels(res, fileId, body) {
    const file = this.mustFile(fileId);
    const labels = file.labelInfo?.labels || [];
    for (const modification of body.labelModifications || []) {
      const labelId = modification.labelId;
      const existing = labels.find((l) => l.id === labelId);
      if (modification.removeLabel) {
        const idx = labels.findIndex((l) => l.id === labelId);
        if (idx >= 0) labels.splice(idx, 1);
      } else if (existing) {
        Object.assign(existing, modification);
      } else {
        labels.push({ id: labelId, kind: "drive#label", fields: modification.fieldModifications || [] });
      }
    }
    file.labelInfo = { labels };
    return this.sendJson(res, 200, { kind: "drive#modifyLabelsResponse", modifiedLabels: clone(labels) });
  }

  makeDrive(body = {}, requestId) {
    const driveId = body.id || id("drive");
    return { kind: "drive#drive", id: driveId, name: body.name || requestId || "Shared Drive", hidden: Boolean(body.hidden), createdTime: now(), restrictions: body.restrictions || {}, capabilities: { canAddChildren: true, canDeleteDrive: true, canEdit: true } };
  }

  createDrive(res, q, body) {
    const drive = this.makeDrive(body, q.get("requestId"));
    if (this.drives.has(drive.id)) throw new ApiError(409, "Drive already exists", "alreadyExists");
    this.drives.set(drive.id, drive);
    return this.sendJson(res, 200, clone(drive));
  }

  listDrives(res, q) {
    return this.sendPage(res, "drive#driveList", "drives", [...this.drives.values()].map(clone), q);
  }

  routeTeamDrives(res, method, parts, q, body) {
    if (parts.length === 0) {
      if (method === "GET") return this.sendPage(res, "drive#teamDriveList", "teamDrives", [...this.drives.values()].map((drive) => this.publicTeamDrive(drive)), q);
      if (method === "POST") return this.createTeamDrive(res, q, body);
      throw new ApiError(405, "Method Not Allowed", "methodNotAllowed");
    }
    const driveId = parts[0];
    const drive = this.drives.get(driveId);
    if (!drive) throw new ApiError(404, "Team drive not found", "notFound");
    if (method === "GET") return this.sendJson(res, 200, this.publicTeamDrive(drive));
    if (method === "PATCH") return this.updateTeamDrive(res, driveId, body);
    if (method === "DELETE") return this.deleteDrive(res, driveId);
    throw new ApiError(404, "Not Found", "notFound");
  }

  createTeamDrive(res, q, body) {
    const drive = this.makeDrive(body, q.get("requestId"));
    this.drives.set(drive.id, drive);
    return this.sendJson(res, 200, this.publicTeamDrive(drive));
  }

  updateTeamDrive(res, driveId, body) {
    const drive = this.drives.get(driveId);
    if (!drive) throw new ApiError(404, "Team drive not found", "notFound");
    Object.assign(drive, body, { id: drive.id, kind: "drive#drive" });
    return this.sendJson(res, 200, this.publicTeamDrive(drive));
  }

  publicTeamDrive(drive) {
    return { kind: "drive#teamDrive", id: drive.id, name: drive.name, backgroundImageLink: drive.backgroundImageLink, colorRgb: drive.colorRgb };
  }

  getDrive(res, driveId) {
    const drive = this.drives.get(driveId);
    if (!drive) throw new ApiError(404, "Shared drive not found", "notFound");
    return this.sendJson(res, 200, clone(drive));
  }

  updateDrive(res, driveId, body) {
    const drive = this.drives.get(driveId);
    if (!drive) throw new ApiError(404, "Shared drive not found", "notFound");
    Object.assign(drive, body, { id: drive.id, kind: "drive#drive" });
    return this.sendJson(res, 200, clone(drive));
  }

  deleteDrive(res, driveId) {
    if (!this.drives.delete(driveId)) throw new ApiError(404, "Shared drive not found", "notFound");
    return this.sendEmpty(res, 204);
  }

  setDriveHidden(res, driveId, hidden) {
    const drive = this.drives.get(driveId);
    if (!drive) throw new ApiError(404, "Shared drive not found", "notFound");
    drive.hidden = hidden;
    return this.sendJson(res, 200, clone(drive));
  }

  makePermission(body = {}) {
    return { kind: "drive#permission", id: body.id || id("perm"), type: body.type || "user", role: body.role || "reader", emailAddress: body.emailAddress, domain: body.domain, allowFileDiscovery: Boolean(body.allowFileDiscovery), displayName: body.displayName || body.emailAddress || body.domain || body.type || "permission", deleted: false };
  }

  routePermissions(res, method, fileId, parts, body) {
    this.mustFile(fileId);
    const map = this.permissions.get(fileId) || new Map();
    this.permissions.set(fileId, map);
    if (parts.length === 0) {
      if (method === "GET") return this.sendJson(res, 200, { kind: "drive#permissionList", permissions: [...map.values()].map(clone) });
      if (method === "POST") {
        const permission = this.makePermission(body);
        map.set(permission.id, permission);
        return this.sendJson(res, 200, clone(permission));
      }
    }
    if (parts.length === 1) {
      const permission = map.get(parts[0]);
      if (!permission) throw new ApiError(404, "Permission not found", "notFound");
      if (method === "GET") return this.sendJson(res, 200, clone(permission));
      if (method === "PATCH") {
        Object.assign(permission, body, { id: permission.id, kind: "drive#permission" });
        return this.sendJson(res, 200, clone(permission));
      }
      if (method === "DELETE") {
        map.delete(parts[0]);
        return this.sendEmpty(res, 204);
      }
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  makeRevision(file, keepForever = false) {
    const revisions = this.revisions.get(file.id) || [];
    return { kind: "drive#revision", id: String(revisions.length + 1), mimeType: file.mimeType, modifiedTime: file.modifiedTime, keepForever, published: false, size: file.size, md5Checksum: file.md5Checksum, originalFilename: file.name };
  }

  routeRevisions(res, method, fileId, parts, body) {
    this.mustFile(fileId);
    const revisions = this.revisions.get(fileId) || [];
    if (parts.length === 0 && method === "GET") return this.sendJson(res, 200, { kind: "drive#revisionList", revisions: clone(revisions) });
    if (parts.length === 1) {
      const revision = revisions.find((r) => r.id === parts[0]);
      if (!revision) throw new ApiError(404, "Revision not found", "notFound");
      if (method === "GET") return this.sendJson(res, 200, clone(revision));
      if (method === "PATCH") {
        Object.assign(revision, body, { id: revision.id, kind: "drive#revision" });
        return this.sendJson(res, 200, clone(revision));
      }
      if (method === "DELETE") {
        if (revisions.length <= 1) throw new ApiError(400, "Cannot delete the only revision", "invalidArgument");
        revisions.splice(revisions.indexOf(revision), 1);
        return this.sendEmpty(res, 204);
      }
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeComments(res, method, fileId, parts, q, body) {
    this.mustFile(fileId);
    const map = this.comments.get(fileId) || new Map();
    this.comments.set(fileId, map);
    if (parts.length === 0) {
      if (method === "GET") return this.sendPage(res, "drive#commentList", "comments", [...map.values()].filter((c) => !c.deleted || q.get("includeDeleted") === "true").map(clone), q);
      if (method === "POST") {
        if (!body.content) throw new ApiError(400, "Required field: content", "invalidArgument");
        const comment = { kind: "drive#comment", id: id("comment"), content: body.content, quotedFileContent: body.quotedFileContent, anchor: body.anchor, author: { displayName: "parlel", me: true }, createdTime: now(), modifiedTime: now(), deleted: false, resolved: false, replies: [] };
        map.set(comment.id, comment);
        this.replies.set(`${fileId}:${comment.id}`, new Map());
        return this.sendJson(res, 200, clone(comment));
      }
    }
    const comment = map.get(parts[0]);
    if (!comment) throw new ApiError(404, "Comment not found", "notFound");
    if (parts.length === 1) {
      if (method === "GET") return this.sendJson(res, 200, clone(this.withReplies(fileId, comment)));
      if (method === "PATCH") {
        Object.assign(comment, body, { id: comment.id, kind: "drive#comment", modifiedTime: now() });
        return this.sendJson(res, 200, clone(this.withReplies(fileId, comment)));
      }
      if (method === "DELETE") {
        comment.deleted = true;
        comment.content = "";
        return this.sendEmpty(res, 204);
      }
    }
    if (parts[1] === "replies") return this.routeReplies(res, method, fileId, comment, parts.slice(2), q, body);
    throw new ApiError(404, "Not Found", "notFound");
  }

  routeReplies(res, method, fileId, comment, parts, q, body) {
    const key = `${fileId}:${comment.id}`;
    const map = this.replies.get(key) || new Map();
    this.replies.set(key, map);
    if (parts.length === 0) {
      if (method === "GET") return this.sendPage(res, "drive#replyList", "replies", [...map.values()].filter((r) => !r.deleted || q.get("includeDeleted") === "true").map(clone), q);
      if (method === "POST") {
        if (!body.content) throw new ApiError(400, "Required field: content", "invalidArgument");
        const reply = { kind: "drive#reply", id: id("reply"), content: body.content, action: body.action, author: { displayName: "parlel", me: true }, createdTime: now(), modifiedTime: now(), deleted: false };
        map.set(reply.id, reply);
        comment.replies = [...map.values()];
        if (reply.action === "resolve") comment.resolved = true;
        return this.sendJson(res, 200, clone(reply));
      }
    }
    const reply = map.get(parts[0]);
    if (!reply) throw new ApiError(404, "Reply not found", "notFound");
    if (method === "GET") return this.sendJson(res, 200, clone(reply));
    if (method === "PATCH") {
      Object.assign(reply, body, { id: reply.id, kind: "drive#reply", modifiedTime: now() });
      comment.replies = [...map.values()];
      return this.sendJson(res, 200, clone(reply));
    }
    if (method === "DELETE") {
      reply.deleted = true;
      reply.content = "";
      comment.replies = [...map.values()];
      return this.sendEmpty(res, 204);
    }
    throw new ApiError(404, "Not Found", "notFound");
  }

  withReplies(fileId, comment) {
    const replies = [...(this.replies.get(`${fileId}:${comment.id}`) || new Map()).values()].filter((r) => !r.deleted);
    return { ...comment, replies };
  }

  addChange(file, removed) {
    this.changes.push({ kind: "drive#change", changeType: "file", time: now(), fileId: file.id, removed: Boolean(removed), file: removed ? undefined : this.publicFile(file) });
    this.changeId += 1;
  }

  listChanges(res, q) {
    const pageToken = Number(q.get("pageToken") || 1);
    if (Number.isNaN(pageToken) || pageToken < 1) throw new ApiError(400, "Invalid page token", "invalidArgument");
    const start = Math.max(0, pageToken - 1);
    return this.sendJson(res, 200, { kind: "drive#changeList", changes: clone(this.changes.slice(start)), newStartPageToken: String(this.changeId) });
  }

  watchChanges(res, body) {
    return this.createChannel(res, body, "changes");
  }

  createChannel(res, body, resourceId) {
    if (!body.id || !body.type) throw new ApiError(400, "Required channel id and type", "invalidArgument");
    const channel = { kind: "api#channel", id: body.id, resourceId, resourceUri: `https://www.googleapis.com/drive/v3/${resourceId}`, token: body.token, expiration: body.expiration || String(Date.now() + 3600000), type: body.type, address: body.address };
    this.channels.set(channel.id, channel);
    return this.sendJson(res, 200, clone(channel));
  }

  stopChannel(res, body) {
    if (body.id) this.channels.delete(body.id);
    return this.sendJson(res, 200, {});
  }

  getOperation(res, name) {
    return this.sendJson(res, 200, { name, done: true, response: {} });
  }

  mustFile(fileId) {
    const file = this.files.get(fileId);
    if (!file) throw new ApiError(404, "File not found", "notFound");
    return file;
  }

  publicFile(file) {
    const copy = clone(file);
    delete copy.content;
    return copy;
  }

  sendPage(res, kind, key, items, q) {
    const start = Math.max(0, Number(q.get("pageToken") || 0));
    const pageSize = Math.max(1, Math.min(1000, Number(q.get("pageSize") || q.get("maxResults") || items.length || 100)));
    const page = items.slice(start, start + pageSize);
    const out = { kind, [key]: page };
    if (start + pageSize < items.length) out.nextPageToken = String(start + pageSize);
    return this.sendJson(res, 200, out);
  }

  parseRequestBody(contentType, buffer, isUpload, uploadType) {
    if (!buffer.length) return { body: {}, media: null };
    if (isUpload && uploadType === "media") return { body: {}, media: buffer };
    if (isUpload && uploadType === "multipart") return this.parseMultipart(contentType, buffer);
    if (contentType.includes("application/json") || !isUpload) return { body: this.parseJson(buffer), media: null };
    return { body: {}, media: buffer };
  }

  parseMultipart(contentType, buffer) {
    const boundary = contentType.match(/boundary=([^;]+)/i)?.[1]?.replace(/^"|"$/g, "");
    if (!boundary) return { body: {}, media: buffer };
    const raw = buffer.toString("binary");
    const sections = raw.split(`--${boundary}`).filter((part) => part.trim() && part.trim() !== "--");
    let body = {};
    let media = Buffer.alloc(0);
    for (const section of sections) {
      const idx = section.indexOf("\r\n\r\n");
      if (idx < 0) continue;
      const headers = section.slice(0, idx).toLowerCase();
      let content = section.slice(idx + 4).replace(/\r\n$/, "");
      if (content.endsWith("--")) content = content.slice(0, -2);
      if (headers.includes("application/json")) body = this.parseJson(Buffer.from(content, "binary"));
      else media = Buffer.from(content, "binary");
    }
    return { body, media };
  }

  parseJson(buffer) {
    if (!buffer.length) return {};
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid JSON payload received. Unknown name.", "parseError");
    }
  }

  sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=UTF-8");
    res.end(JSON.stringify(body));
  }

  sendBytes(res, status, body, contentType = "application/octet-stream") {
    res.statusCode = status;
    res.setHeader("content-type", contentType);
    res.end(body);
  }

  sendEmpty(res, status) {
    res.statusCode = status;
    res.end();
  }

  sendError(res, error) {
    this.sendJson(res, error.code || 500, {
      error: {
        code: error.code || 500,
        message: error.message || "Internal error",
        status: error.status || statusForCode(error.code || 500),
        errors: [{ message: error.message || "Internal error", domain: "global", reason: error.reason || "backendError" }],
      },
    });
  }
}

export default GoogleDriveServer;
