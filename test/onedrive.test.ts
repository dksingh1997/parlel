import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { OnedriveServer } from "../services/onedrive/src/server.js";

const PORT = 24622;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json | string, headers: Record<string, string> = {}): Promise<{ status: number; data: any; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: typeof body === "string" ? headers : body ? { "content-type": "application/json", "client-request-id": "test-client-id", ...headers } : { "client-request-id": "test-client-id", ...headers },
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: text && contentType.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}

async function createFile(name = "notes.txt", content = "hello", parentId = "root") {
  const created = await api("POST", `/v1.0/me/drive/items/${parentId}/children`, { name, file: {}, "@microsoft.graph.conflictBehavior": "rename" });
  await api("PUT", `/v1.0/me/drive/items/${created.data.id}/content`, content, { "content-type": "text/plain" });
  return (await api("GET", `/v1.0/me/drive/items/${created.data.id}`)).data;
}

describe("OneDrive Service", () => {
  let server: OnedriveServer;

  beforeAll(async () => {
    server = new OnedriveServer(PORT);
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
    it("starts, serves metadata and health, and resets ephemeral state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.items.has("root")).toBe(true);

      expect((await api("GET", "/")).data).toMatchObject({ service: "onedrive", emulator: "parlel" });
      expect((await api("GET", "/v1.0")).data.emulator).toBe("parlel");
      expect((await api("GET", "/beta")).data.service).toBe("onedrive");
      expect((await api("OPTIONS", "/v1.0/me/drive")).status).toBe(204);

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "onedrive", drives: 1, items: 1 });

      await createFile("reset.txt");
      expect(server.items.size).toBe(2);
      expect((await api("POST", "/_parlel/reset")).data).toEqual({ ok: true });
      expect(server.items.size).toBe(1);
    });

    it("returns Microsoft Graph-shaped errors", async () => {
      const missing = await api("GET", "/v1.0/me/drive/items/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error.code).toBe("itemNotFound");
      expect(missing.data.error.innerError["client-request-id"]).toBe("test-client-id");

      const invalid = await api("POST", "/v1.0/me/drive/root/children", {});
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.message).toContain("name");

      const method = await api("PUT", "/v1.0/me/drive/root", {});
      expect(method.status).toBe(405);
    });
  });

  describe("Users and drives", () => {
    it("gets me, users/{id}, default drives, and drive collections", async () => {
      expect((await api("GET", "/v1.0/me")).data.mail).toBe("agent@parlel.test");
      expect((await api("GET", "/v1.0/users/agent@parlel.test")).data.userPrincipalName).toBe("agent@parlel.test");

      const drive = await api("GET", "/v1.0/me/drive");
      expect(drive.data).toMatchObject({ id: "drive_parlel", driveType: "personal", name: "Parlel OneDrive" });

      expect((await api("GET", "/v1.0/users/agent@parlel.test/drive")).data.id).toBe("drive_parlel");
      expect((await api("GET", "/v1.0/me/drives")).data.value[0].id).toBe("drive_parlel");
      expect((await api("GET", "/v1.0/drives")).data.value[0].id).toBe("drive_parlel");
      expect((await api("GET", "/v1.0/drives/drive_parlel")).data.name).toBe("Parlel OneDrive");
    });
  });

  describe("Drive items, children, OData, and content", () => {
    it("creates, lists, gets, expands, selects, filters, searches, patches, downloads, and deletes items", async () => {
      const folder = await api("POST", "/v1.0/me/drive/root/children", { name: "Projects", folder: {} });
      expect(folder.status).toBe(201);
      expect(folder.data.folder.childCount).toBe(0);

      const file = await api("POST", `/v1.0/me/drive/items/${folder.data.id}/children`, { name: "Alpha.txt", file: { mimeType: "text/plain" }, description: "first" });
      expect(file.status).toBe(201);

      const duplicate = await api("POST", `/v1.0/me/drive/items/${folder.data.id}/children`, { name: "Alpha.txt", file: {} });
      expect(duplicate.status).toBe(409);
      const renamed = await api("POST", `/v1.0/me/drive/items/${folder.data.id}/children`, { name: "Alpha.txt", file: {}, "@microsoft.graph.conflictBehavior": "rename" });
      expect(renamed.data.name).toBe("Alpha (1).txt");

      const uploaded = await api("PUT", `/v1.0/me/drive/items/${file.data.id}/content`, "hello onedrive", { "content-type": "text/plain" });
      expect(uploaded.data.size).toBe(14);
      expect(uploaded.data.file.hashes.sha1Hash).toMatch(/^[A-F0-9]+$/);

      const downloaded = await api("GET", `/v1.0/me/drive/items/${file.data.id}/content`);
      expect(downloaded.text).toBe("hello onedrive");
      expect(downloaded.headers.get("content-type")).toBe("text/plain");

      const listed = await api("GET", `/v1.0/me/drive/items/${folder.data.id}/children?$top=1&$count=true&$orderby=name desc`);
      expect(listed.data.value).toHaveLength(1);
      expect(listed.data["@odata.count"]).toBe(2);
      expect(listed.data["@odata.nextLink"]).toContain("$skip=1");

      const filtered = await api("GET", `/v1.0/me/drive/items/${folder.data.id}/children?$filter=name eq 'Alpha.txt'`);
      expect(filtered.data.value).toHaveLength(1);

      const searchedCollection = await api("GET", `/v1.0/me/drive/items/${folder.data.id}/children?$search=Alpha`);
      expect(searchedCollection.data.value.map((i: Json) => i.name)).toContain("Alpha.txt");

      const selected = await api("GET", `/v1.0/me/drive/items/${file.data.id}?$select=name,size`);
      expect(selected.data).toEqual({ id: file.data.id, name: "Alpha.txt", size: 14 });

      const expanded = await api("GET", `/v1.0/me/drive/items/${folder.data.id}?$expand=children,permissions`);
      expect(expanded.data.children.map((i: Json) => i.id)).toContain(file.data.id);
      expect(expanded.data.permissions).toEqual([]);

      const patched = await api("PATCH", `/v1.0/me/drive/items/${file.data.id}`, { name: "Beta.txt", description: "updated" });
      expect(patched.data).toMatchObject({ name: "Beta.txt", description: "updated" });

      const childByName = await api("GET", `/v1.0/me/drive/items/${folder.data.id}/children/Beta.txt`);
      expect(childByName.data.id).toBe(file.data.id);

      expect((await api("DELETE", `/v1.0/me/drive/items/${renamed.data.id}`)).status).toBe(204);
      expect((await api("DELETE", "/v1.0/me/drive/root")).status).toBe(400);
      expect((await api("DELETE", `/v1.0/me/drive/items/${file.data.id}`)).status).toBe(204);
      expect((await api("GET", `/v1.0/me/drive/items/${file.data.id}`)).status).toBe(404);
    });

    it("supports colon-addressed item paths and file creation by path", async () => {
      const created = await api("PUT", "/v1.0/me/drive/root:/nested/path.txt:/content", "path body", { "content-type": "text/plain" });
      expect(created.status).toBe(200);
      expect(created.data.name).toBe("path.txt");

      const got = await api("GET", "/v1.0/me/drive/root:/nested/path.txt:");
      expect(got.data.id).toBe(created.data.id);

      const downloaded = await api("GET", "/v1.0/me/drive/root:/nested/path.txt:/content");
      expect(downloaded.text).toBe("path body");
    });
  });

  describe("Actions, upload sessions, search, delta, and collections", () => {
    it("creates upload sessions, copies, previews, follows, restores, searches, and returns delta", async () => {
      const folder = await api("POST", "/v1.0/me/drive/root/children", { name: "Uploads", folder: {} });
      const session = await api("POST", `/v1.0/me/drive/items/${folder.data.id}/createUploadSession`, { item: { name: "large.bin" } });
      expect(session.status).toBe(200);
      expect(session.data.uploadUrl).toContain("/_parlel/upload/");

      const firstChunk = await fetch(session.data.uploadUrl, { method: "PUT", headers: { "content-range": "bytes 0-4/10", "content-type": "application/octet-stream" }, body: "01234" });
      expect(firstChunk.status).toBe(202);
      expect((await firstChunk.json()).nextExpectedRanges).toEqual(["5-"]);

      const finalChunk = await fetch(session.data.uploadUrl, { method: "PUT", headers: { "content-range": "bytes 5-9/10", "content-type": "application/octet-stream" }, body: "56789" });
      expect(finalChunk.status).toBe(200);
      const large = await finalChunk.json();
      expect(large.name).toBe("large.bin");
      expect(large.size).toBe(10);

      const copy = await api("POST", `/v1.0/me/drive/items/${large.id}/copy`, { name: "large-copy.bin", parentReference: { id: "root" } });
      expect(copy.status).toBe(202);
      expect(copy.headers.get("location")).toContain("/operations/");
      const operation = await api("GET", copy.headers.get("location")!);
      expect(operation.data.status).toBe("completed");

      const preview = await api("POST", `/v1.0/me/drive/items/${large.id}/preview`, {});
      expect(preview.data.getUrl).toContain(`/items/${large.id}/content`);

      expect((await api("POST", `/v1.0/me/drive/items/${large.id}/follow`, {})).data.followed).toBe(true);
      expect((await api("GET", "/v1.0/me/drive/following")).data.value.map((i: Json) => i.id)).toContain(large.id);
      expect((await api("POST", `/v1.0/me/drive/items/${large.id}/unfollow`, {})).data.followed).toBe(false);

      await api("PATCH", `/v1.0/me/drive/items/${large.id}`, { deleted: { state: "deleted" } });
      expect((await api("POST", `/v1.0/me/drive/items/${large.id}/restore`, {})).data.deleted).toBeUndefined();

      const search = await api("GET", `/v1.0/me/drive/root/search(q='large')`);
      expect(search.data.value.map((i: Json) => i.name)).toContain("large.bin");

      const recent = await api("GET", "/v1.0/me/drive/recent");
      expect(recent.data.value.length).toBeGreaterThan(0);

      await api("PATCH", `/v1.0/me/drive/items/${large.id}`, { shared: { scope: "users" } });
      const shared = await api("GET", "/v1.0/me/drive/sharedWithMe");
      expect(shared.data.value.map((i: Json) => i.id)).toContain(large.id);

      const delta = await api("GET", "/v1.0/me/drive/root/delta");
      expect(delta.data["@odata.deltaLink"]).toContain("$deltatoken");
      expect(delta.data.value.length).toBeGreaterThan(0);
    });

    it("can cancel upload sessions", async () => {
      const session = await api("POST", "/v1.0/me/drive/root/createUploadSession", { item: { name: "cancel.bin" } });
      const deleted = await fetch(session.data.uploadUrl, { method: "DELETE" });
      expect(deleted.status).toBe(204);
      const put = await fetch(session.data.uploadUrl, { method: "PUT", headers: { "content-range": "bytes 0-0/1" }, body: "x" });
      expect(put.status).toBe(404);
    });
  });

  describe("Permissions, sharing, thumbnails, shares, subscriptions, and batch", () => {
    it("creates, lists, gets, updates, invites, links, and deletes permissions", async () => {
      const file = await createFile("share.txt");
      const permission = await api("POST", `/v1.0/me/drive/items/${file.id}/permissions`, { roles: ["read"], email: "guest@example.com" });
      expect(permission.status).toBe(201);
      expect(permission.data.roles).toEqual(["read"]);

      expect((await api("GET", `/v1.0/me/drive/items/${file.id}/permissions`)).data.value.map((p: Json) => p.id)).toContain(permission.data.id);
      expect((await api("GET", `/v1.0/me/drive/items/${file.id}/permissions/${permission.data.id}`)).data.grantedTo.user.id).toBe("guest@example.com");
      expect((await api("PATCH", `/v1.0/me/drive/items/${file.id}/permissions/${permission.data.id}`, { roles: ["write"] })).data.roles).toEqual(["write"]);

      const invite = await api("POST", `/v1.0/me/drive/items/${file.id}/invite`, { recipients: [{ email: "invite@example.com" }], roles: ["read"], requireSignIn: true });
      expect(invite.data.value[0].invitation.email).toBe("invite@example.com");

      const link = await api("POST", `/v1.0/me/drive/items/${file.id}/createLink`, { type: "view", scope: "anonymous" });
      expect(link.status).toBe(201);
      expect(link.data.permission.link.webUrl).toContain("https://1drv.ms/");

      const share = await api("GET", `/v1.0/shares/${link.data.permission.id}/driveItem`);
      expect(share.data.id).toBe(file.id);

      expect((await api("DELETE", `/v1.0/me/drive/items/${file.id}/permissions/${permission.data.id}`)).status).toBe(204);
      expect((await api("GET", `/v1.0/me/drive/items/${file.id}/permissions/${permission.data.id}`)).status).toBe(404);
    });

    it("lists thumbnail sets, gets thumbnails, and downloads thumbnail content", async () => {
      const file = await createFile("photo.jpg", "image-bytes");
      const list = await api("GET", `/v1.0/me/drive/items/${file.id}/thumbnails`);
      expect(list.data.value[0].small.url).toContain("/thumbnails/0/small/content");

      const set = await api("GET", `/v1.0/me/drive/items/${file.id}/thumbnails/0`);
      expect(set.data.medium.width).toBe(176);

      const small = await api("GET", `/v1.0/me/drive/items/${file.id}/thumbnails/0/small`);
      expect(small.data.height).toBe(96);

      const content = await api("GET", `/v1.0/me/drive/items/${file.id}/thumbnails/0/small/content`);
      expect(content.text).toBe(`thumbnail:${file.id}:small`);
      expect(content.headers.get("content-type")).toBe("image/png");
    });

    it("creates, lists, gets, patches, and deletes subscriptions", async () => {
      const created = await api("POST", "/v1.0/subscriptions", { changeType: "updated", notificationUrl: "https://example.test/hook", resource: "me/drive/root", clientState: "secret" });
      expect(created.status).toBe(201);
      expect((await api("GET", "/v1.0/subscriptions")).data.value).toHaveLength(1);
      expect((await api("GET", `/v1.0/subscriptions/${created.data.id}`)).data.resource).toBe("me/drive/root");
      expect((await api("PATCH", `/v1.0/subscriptions/${created.data.id}`, { clientState: "updated" })).data.clientState).toBe("updated");
      expect((await api("DELETE", `/v1.0/subscriptions/${created.data.id}`)).status).toBe(204);
    });

    it("handles Graph JSON batch requests", async () => {
      const batch = await api("POST", "/v1.0/$batch", {
        requests: [
          { id: "1", method: "GET", url: "/me/drive" },
          { id: "2", method: "POST", url: "/me/drive/root/children", body: { name: "Batch.txt", file: {} } },
          { id: "3", method: "GET", url: "/me/drive/root/children?$filter=name eq 'Batch.txt'" },
        ],
      });
      expect(batch.status).toBe(200);
      expect(batch.data.responses.map((r: Json) => r.status)).toEqual([200, 201, 200]);
      expect(batch.data.responses[2].body.value[0].name).toBe("Batch.txt");
    });
  });
});
