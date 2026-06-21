import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleDriveServer } from "../services/google-drive/src/server.js";

const PORT = 24614;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json | string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: typeof body === "string" ? headers : body ? { "content-type": "application/json", ...headers } : headers,
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: text && contentType.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}

async function createFile(name = "notes.txt", content = "hello", metadata: Json = {}) {
  const created = await api("POST", "/drive/v3/files", { name, mimeType: "text/plain", ...metadata });
  if (content) {
    await api("PATCH", `/upload/drive/v3/files/${created.data.id}?uploadType=media`, content, { "content-type": "text/plain" });
  }
  return (await api("GET", `/drive/v3/files/${created.data.id}`)).data;
}

describe("Google Drive Service", () => {
  let server: GoogleDriveServer;

  beforeAll(async () => {
    server = new GoogleDriveServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server", () => {
    it("starts, serves discovery and health, and resets ephemeral state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.files.has("root")).toBe(true);

      const discovery = await api("GET", "/drive/v3");
      expect(discovery).toMatchObject({ status: 200, data: { kind: "drive#parlel" } });

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "google-drive", files: 1, drives: 0 });

      await createFile("reset.txt");
      expect(server.files.size).toBe(2);
      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toEqual(expect.objectContaining({ status: 200, data: { ok: true } }));
      expect(server.files.size).toBe(1);
    });

    it("returns Google-shaped JSON errors", async () => {
      const missing = await api("GET", "/drive/v3/files/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
      expect(missing.data.error.errors[0]).toMatchObject({ domain: "global", reason: "notFound" });

      const invalid = await api("POST", "/drive/v3/files", "{", { "content-type": "application/json" });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("parseError");
    });
  });

  describe("About and apps", () => {
    it("gets about metadata and lists/gets apps", async () => {
      const about = await api("GET", "/drive/v3/about?fields=*");
      expect(about.status).toBe(200);
      expect(about.data.user.emailAddress).toBe("parlel@example.com");
      expect(about.data.rootFolderId).toBe("root");

      const apps = await api("GET", "/drive/v3/apps");
      expect(apps.data.items.map((a: Json) => a.id)).toContain("drive");

      const app = await api("GET", "/drive/v3/apps/docs");
      expect(app.data).toMatchObject({ kind: "drive#app", id: "docs" });

      const missing = await api("GET", "/drive/v3/apps/missing");
      expect(missing.status).toBe(404);
    });
  });

  describe("Files", () => {
    it("create, get, list, update, download, copy, export, generateIds, generateCseToken, watch, labels, delete", async () => {
      const created = await api("POST", "/drive/v3/files", { name: "Alpha.txt", mimeType: "text/plain", parents: ["root"], properties: { env: "test" } });
      expect(created.status).toBe(200);
      expect(created.data).toMatchObject({ kind: "drive#file", name: "Alpha.txt", mimeType: "text/plain", parents: ["root"] });

      const updatedMedia = await api("PATCH", `/upload/drive/v3/files/${created.data.id}?uploadType=media`, "hello drive", { "content-type": "text/plain" });
      expect(updatedMedia.data.size).toBe("11");

      const media = await api("GET", `/drive/v3/files/${created.data.id}?alt=media`);
      expect(media.status).toBe(200);
      expect(media.text).toBe("hello drive");
      expect(media.headers.get("content-type")).toBe("text/plain");

      const patched = await api("PATCH", `/drive/v3/files/${created.data.id}`, { name: "Beta.txt", starred: true });
      expect(patched.data).toMatchObject({ name: "Beta.txt", starred: true, version: "3" });

      const listed = await api("GET", "/drive/v3/files?q=name%20contains%20'Beta'%20and%20starred%20=%20true&pageSize=1");
      expect(listed.data.files).toHaveLength(1);
      expect(listed.data.files[0].id).toBe(created.data.id);

      const copied = await api("POST", `/drive/v3/files/${created.data.id}/copy`, { name: "Beta Copy.txt" });
      expect(copied.data.name).toBe("Beta Copy.txt");

      const exported = await api("GET", `/drive/v3/files/${created.data.id}/export?mimeType=text/plain`);
      expect(exported.text).toBe("hello drive");

      const download = await api("POST", `/drive/v3/files/${created.data.id}/download`);
      expect(download.data).toMatchObject({ name: `operations/download-${created.data.id}`, done: true, response: { fileId: created.data.id } });

      const operation = await api("GET", `/drive/v3/operations/${encodeURIComponent(download.data.name)}`);
      expect(operation.data).toMatchObject({ name: download.data.name, done: true });

      const ids = await api("GET", "/drive/v3/files/generateIds?count=3&space=drive");
      expect(ids.data.ids).toHaveLength(3);
      expect(ids.data.ids[0]).toMatch(/^file_/);

      const cse = await api("GET", `/drive/v3/files/generateCseToken?fileId=${created.data.id}`);
      expect(cse.data).toEqual({ token: `parlel-cse-token-${created.data.id}`, fileId: created.data.id });

      const watch = await api("POST", `/drive/v3/files/${created.data.id}/watch`, { id: "chan-file", type: "web_hook", address: "https://example.test/hook" });
      expect(watch.data).toMatchObject({ kind: "api#channel", id: "chan-file", resourceId: `files/${created.data.id}` });
      expect(server.channels.has("chan-file")).toBe(true);

      const labels = await api("POST", `/drive/v3/files/${created.data.id}/modifyLabels`, { labelModifications: [{ labelId: "lbl_project", fieldModifications: [{ fieldId: "status", setTextValues: { values: ["ready"] } }] }] });
      expect(labels.data.modifiedLabels[0].id).toBe("lbl_project");

      const labelList = await api("GET", `/drive/v3/files/${created.data.id}/listLabels`);
      expect(labelList.data.labels[0].id).toBe("lbl_project");

      const deleted = await api("DELETE", `/drive/v3/files/${created.data.id}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/drive/v3/files/${created.data.id}`);
      expect(missing.status).toBe(404);
    });

    it("supports multipart create, trash queries, and emptyTrash", async () => {
      const boundary = "parlel-boundary";
      const multipart = [
        `--${boundary}`,
        "content-type: application/json; charset=UTF-8",
        "",
        JSON.stringify({ name: "Multipart.txt", mimeType: "text/plain" }),
        `--${boundary}`,
        "content-type: text/plain",
        "",
        "multipart body",
        `--${boundary}--`,
        "",
      ].join("\r\n");

      const created = await api("POST", "/upload/drive/v3/files?uploadType=multipart", multipart, { "content-type": `multipart/related; boundary=${boundary}` });
      expect(created.data.name).toBe("Multipart.txt");

      const downloaded = await api("GET", `/drive/v3/files/${created.data.id}?alt=media`);
      expect(downloaded.text).toBe("multipart body");

      await api("PATCH", `/drive/v3/files/${created.data.id}`, { trashed: true });
      const trash = await api("GET", "/drive/v3/files?q=trashed%20=%20true");
      expect(trash.data.files.map((f: Json) => f.id)).toContain(created.data.id);

      const emptied = await api("DELETE", "/drive/v3/files/trash");
      expect(emptied.status).toBe(204);
      expect(server.files.has(created.data.id)).toBe(false);
    });
  });

  describe("Permissions", () => {
    it("create, list, get, update, and delete permissions", async () => {
      const file = await createFile("permissions.txt");
      const created = await api("POST", `/drive/v3/files/${file.id}/permissions`, { type: "user", role: "reader", emailAddress: "agent@example.com" });
      expect(created.data).toMatchObject({ kind: "drive#permission", type: "user", role: "reader" });

      const list = await api("GET", `/drive/v3/files/${file.id}/permissions`);
      expect(list.data.permissions.map((p: Json) => p.id)).toContain(created.data.id);

      const got = await api("GET", `/drive/v3/files/${file.id}/permissions/${created.data.id}`);
      expect(got.data.emailAddress).toBe("agent@example.com");

      const updated = await api("PATCH", `/drive/v3/files/${file.id}/permissions/${created.data.id}`, { role: "writer" });
      expect(updated.data.role).toBe("writer");

      const deleted = await api("DELETE", `/drive/v3/files/${file.id}/permissions/${created.data.id}`);
      expect(deleted.status).toBe(204);
      const missing = await api("GET", `/drive/v3/files/${file.id}/permissions/${created.data.id}`);
      expect(missing.status).toBe(404);
    });
  });

  describe("Revisions", () => {
    it("list, get, update, delete revisions, and reject deleting the only revision", async () => {
      const file = await createFile("revisions.txt");
      const initial = await api("GET", `/drive/v3/files/${file.id}/revisions`);
      expect(initial.data.revisions.length).toBeGreaterThanOrEqual(2);

      const firstId = initial.data.revisions[0].id;
      const got = await api("GET", `/drive/v3/files/${file.id}/revisions/${firstId}`);
      expect(got.data.kind).toBe("drive#revision");

      const updated = await api("PATCH", `/drive/v3/files/${file.id}/revisions/${firstId}`, { keepForever: true, published: true });
      expect(updated.data).toMatchObject({ keepForever: true, published: true });

      const deleted = await api("DELETE", `/drive/v3/files/${file.id}/revisions/${firstId}`);
      expect(deleted.status).toBe(204);

      const single = await api("POST", "/drive/v3/files", { name: "single.txt" });
      const only = await api("DELETE", `/drive/v3/files/${single.data.id}/revisions/1`);
      expect(only.status).toBe(400);
      expect(only.data.error.errors[0].reason).toBe("invalidArgument");
    });
  });

  describe("Comments and replies", () => {
    it("create, list, get, update, delete comments and replies", async () => {
      const file = await createFile("comments.txt");
      const comment = await api("POST", `/drive/v3/files/${file.id}/comments`, { content: "Please review", anchor: "line=1" });
      expect(comment.data).toMatchObject({ kind: "drive#comment", content: "Please review", deleted: false });

      const list = await api("GET", `/drive/v3/files/${file.id}/comments`);
      expect(list.data.comments).toHaveLength(1);

      const patched = await api("PATCH", `/drive/v3/files/${file.id}/comments/${comment.data.id}`, { content: "Reviewed" });
      expect(patched.data.content).toBe("Reviewed");

      const reply = await api("POST", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies`, { content: "Done", action: "resolve" });
      expect(reply.data).toMatchObject({ kind: "drive#reply", content: "Done" });

      const replies = await api("GET", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies`);
      expect(replies.data.replies[0].id).toBe(reply.data.id);

      const gotReply = await api("GET", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies/${reply.data.id}`);
      expect(gotReply.data.content).toBe("Done");

      const updatedReply = await api("PATCH", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies/${reply.data.id}`, { content: "Actually done" });
      expect(updatedReply.data.content).toBe("Actually done");

      const gotComment = await api("GET", `/drive/v3/files/${file.id}/comments/${comment.data.id}`);
      expect(gotComment.data.replies[0].content).toBe("Actually done");

      const deletedReply = await api("DELETE", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies/${reply.data.id}`);
      expect(deletedReply.status).toBe(204);

      const deletedComment = await api("DELETE", `/drive/v3/files/${file.id}/comments/${comment.data.id}`);
      expect(deletedComment.status).toBe(204);

      const includeDeleted = await api("GET", `/drive/v3/files/${file.id}/comments?includeDeleted=true`);
      expect(includeDeleted.data.comments[0]).toMatchObject({ deleted: true, content: "" });
    });

    it("validates comment and reply content", async () => {
      const file = await createFile("invalid-comments.txt");
      const badComment = await api("POST", `/drive/v3/files/${file.id}/comments`, {});
      expect(badComment.status).toBe(400);
      const comment = await api("POST", `/drive/v3/files/${file.id}/comments`, { content: "ok" });
      const badReply = await api("POST", `/drive/v3/files/${file.id}/comments/${comment.data.id}/replies`, {});
      expect(badReply.status).toBe(400);
    });
  });

  describe("Shared drives", () => {
    it("create, list, get, update, hide, unhide, and delete drives", async () => {
      const created = await api("POST", "/drive/v3/drives?requestId=req-1", { name: "Team Drive" });
      expect(created.data).toMatchObject({ kind: "drive#drive", name: "Team Drive", hidden: false });

      const list = await api("GET", "/drive/v3/drives");
      expect(list.data.drives.map((d: Json) => d.id)).toContain(created.data.id);

      const got = await api("GET", `/drive/v3/drives/${created.data.id}`);
      expect(got.data.name).toBe("Team Drive");

      const updated = await api("PATCH", `/drive/v3/drives/${created.data.id}`, { name: "Renamed Drive" });
      expect(updated.data.name).toBe("Renamed Drive");

      const hidden = await api("POST", `/drive/v3/drives/${created.data.id}/hide`);
      expect(hidden.data.hidden).toBe(true);

      const unhidden = await api("POST", `/drive/v3/drives/${created.data.id}/unhide`);
      expect(unhidden.data.hidden).toBe(false);

      const deleted = await api("DELETE", `/drive/v3/drives/${created.data.id}`);
      expect(deleted.status).toBe(204);
    });

    it("supports legacy teamdrives create, list, get, update, and delete", async () => {
      const created = await api("POST", "/drive/v3/teamdrives?requestId=team-1", { name: "Legacy Team" });
      expect(created.data).toMatchObject({ kind: "drive#teamDrive", name: "Legacy Team" });

      const list = await api("GET", "/drive/v3/teamdrives");
      expect(list.data.teamDrives.map((d: Json) => d.id)).toContain(created.data.id);

      const got = await api("GET", `/drive/v3/teamdrives/${created.data.id}`);
      expect(got.data.name).toBe("Legacy Team");

      const updated = await api("PATCH", `/drive/v3/teamdrives/${created.data.id}`, { name: "Legacy Renamed" });
      expect(updated.data.name).toBe("Legacy Renamed");

      const deleted = await api("DELETE", `/drive/v3/teamdrives/${created.data.id}`);
      expect(deleted.status).toBe(204);
    });
  });

  describe("Changes and channels", () => {
    it("gets start page tokens, lists changes, watches changes, and stops channels", async () => {
      const start = await api("GET", "/drive/v3/changes/startPageToken");
      expect(start.data.startPageToken).toBe("1");

      const file = await createFile("changes.txt");
      const changes = await api("GET", "/drive/v3/changes?pageToken=1");
      expect(changes.data.changes.some((c: Json) => c.fileId === file.id)).toBe(true);
      expect(changes.data.newStartPageToken).toBeDefined();

      const watch = await api("POST", "/drive/v3/changes/watch", { id: "chan-changes", type: "web_hook", address: "https://example.test/changes" });
      expect(watch.data).toMatchObject({ kind: "api#channel", id: "chan-changes", resourceId: "changes" });
      expect(server.channels.has("chan-changes")).toBe(true);

      const stopped = await api("POST", "/drive/v3/channels/stop", { id: "chan-changes", resourceId: "changes" });
      expect(stopped).toMatchObject({ status: 200, data: {} });
      expect(server.channels.has("chan-changes")).toBe(false);

      const invalid = await api("GET", "/drive/v3/changes?pageToken=bad");
      expect(invalid.status).toBe(400);
    });
  });

  describe("Access proposals", () => {
    it("list, get, and resolve file-scoped access proposals", async () => {
      const file = await createFile("proposal.txt");
      server.accessProposals.set("proposal-1", { kind: "drive#accessProposal", id: "proposal-1", fileId: file.id, requesterEmailAddress: "agent@example.com", rolesAndViews: [{ role: "reader" }], requestMessage: "please" });

      const list = await api("GET", `/drive/v3/files/${file.id}/accessproposals`);
      expect(list.data.accessProposals).toHaveLength(1);

      const got = await api("GET", `/drive/v3/files/${file.id}/accessproposals/proposal-1`);
      expect(got.data.requesterEmailAddress).toBe("agent@example.com");

      const resolved = await api("POST", `/drive/v3/files/${file.id}/accessproposals/proposal-1:resolve`, { action: "ACCEPT" });
      expect(resolved).toMatchObject({ status: 200, data: {} });
      expect(server.accessProposals.get("proposal-1")?.resolved).toBe(true);

      const missing = await api("GET", `/drive/v3/files/${file.id}/accessproposals/missing`);
      expect(missing.status).toBe(404);
    });
  });

  describe("Approvals", () => {
    it("start, list, get, approve, decline, cancel, comment, and reassign approvals", async () => {
      const file = await createFile("approval.txt");
      const started = await api("POST", `/drive/v3/files/${file.id}/approvals:start`, { comment: "Please approve" });
      expect(started.data).toMatchObject({ kind: "drive#approval", fileId: file.id, state: "pending" });

      const list = await api("GET", `/drive/v3/files/${file.id}/approvals`);
      expect(list.data.approvals.map((a: Json) => a.id)).toContain(started.data.id);

      const got = await api("GET", `/drive/v3/files/${file.id}/approvals/${started.data.id}`);
      expect(got.data.comment).toBe("Please approve");

      const commented = await api("POST", `/drive/v3/files/${file.id}/approvals/${started.data.id}:comment`, { comment: "Looks good" });
      expect(commented.data.comment).toBe("Looks good");

      const reassigned = await api("POST", `/drive/v3/files/${file.id}/approvals/${started.data.id}:reassign`, { assignedApprovers: [{ emailAddress: "owner@example.com" }] });
      expect(reassigned.data.assignedApprovers[0].emailAddress).toBe("owner@example.com");

      const approved = await api("POST", `/drive/v3/files/${file.id}/approvals/${started.data.id}:approve`, {});
      expect(approved.data.state).toBe("approved");

      const declined = await api("POST", `/drive/v3/files/${file.id}/approvals/${started.data.id}:decline`, {});
      expect(declined.data.state).toBe("declined");

      const cancelled = await api("POST", `/drive/v3/files/${file.id}/approvals/${started.data.id}:cancel`, {});
      expect(cancelled.data.state).toBe("cancelled");
    });
  });
});
