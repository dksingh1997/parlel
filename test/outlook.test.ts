import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OutlookServer } from "../services/outlook/src/server.js";

const PORT = 24620;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json", "client-request-id": "test-client-id" } : { "client-request-id": "test-client-id" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const isJson = res.headers.get("content-type")?.includes("json");
  return { status: res.status, data: text && isJson ? JSON.parse(text) : null, text };
}

function message(subject: string, content = "hello", extra: Json = {}) {
  return {
    subject,
    body: { contentType: "text", content },
    toRecipients: [{ emailAddress: { name: "Agent", address: "agent@example.com" } }],
    ...extra,
  };
}

describe("Outlook Service", () => {
  let server: OutlookServer;

  beforeAll(async () => {
    server = new OutlookServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  describe("Server", () => {
    it("starts on the requested port", () => {
      expect(server.port).toBe(PORT);
    });

    it("has empty ephemeral stores after reset", async () => {
      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toEqual({ status: 200, data: { ok: true }, text: JSON.stringify({ ok: true }) });
      expect(server.messages.size).toBe(0);
      expect(server.mailFolders.has("inbox")).toBe(true);
      expect(server.masterCategories.has("cat_blue")).toBe(true);
    });

    it("returns health and root metadata", async () => {
      const health = await api("GET", "/_parlel/health");
      expect(health.status).toBe(200);
      expect(health.data.service).toBe("outlook");

      expect((await api("GET", "/")).data.emulator).toBe("parlel");
      const root = await api("GET", "/v1.0");
      expect(root.data.emulator).toBe("parlel");
      expect((await api("GET", "/beta/me")).data.mail).toBe("parlel@example.com");
    });
  });

  describe("Users and mailbox settings", () => {
    it("gets me and users/{id}", async () => {
      expect((await api("GET", "/v1.0/me")).data.mail).toBe("parlel@example.com");
      expect((await api("GET", "/v1.0/users/parlel@example.com")).data.userPrincipalName).toBe("parlel@example.com");
    });

    it("gets and patches mailboxSettings", async () => {
      const patched = await api("PATCH", "/v1.0/me/mailboxSettings", { timeZone: "Pacific Standard Time", dateFormat: "yyyy-MM-dd" });
      expect(patched.status).toBe(200);
      expect(patched.data.timeZone).toBe("Pacific Standard Time");

      const got = await api("GET", "/v1.0/me/mailboxSettings");
      expect(got.data.dateFormat).toBe("yyyy-MM-dd");
    });
  });

  describe("Mail folders and child folders", () => {
    it("lists, creates, gets, patches, and deletes folders", async () => {
      const list = await api("GET", "/v1.0/me/mailFolders?$count=true&$orderby=displayName desc");
      expect(list.status).toBe(200);
      expect(list.data.value.some((f: Json) => f.id === "inbox")).toBe(true);
      expect(list.data["@odata.count"]).toBeGreaterThan(0);

      const created = await api("POST", "/v1.0/me/mailFolders", { displayName: "Projects" });
      expect(created.status).toBe(201);

      const got = await api("GET", `/v1.0/me/mailFolders/${created.data.id}`);
      expect(got.data.displayName).toBe("Projects");

      const patched = await api("PATCH", `/v1.0/me/mailFolders/${created.data.id}`, { displayName: "Projects Updated" });
      expect(patched.data.displayName).toBe("Projects Updated");

      const deleted = await api("DELETE", `/v1.0/me/mailFolders/${created.data.id}`);
      expect(deleted.status).toBe(204);
    });

    it("creates, lists, patches, and deletes child folders", async () => {
      const child = await api("POST", "/v1.0/me/mailFolders/inbox/childFolders", { displayName: "Child" });
      expect(child.status).toBe(201);

      const list = await api("GET", "/v1.0/me/mailFolders/inbox/childFolders");
      expect(list.data.value.some((f: Json) => f.id === child.data.id)).toBe(true);

      expect((await api("GET", `/v1.0/me/mailFolders/inbox/childFolders/${child.data.id}`)).data.displayName).toBe("Child");
      expect((await api("PATCH", `/v1.0/me/mailFolders/inbox/childFolders/${child.data.id}`, { displayName: "Child 2" })).data.displayName).toBe("Child 2");
      expect((await api("DELETE", `/v1.0/me/mailFolders/inbox/childFolders/${child.data.id}`)).status).toBe(204);
    });

    it("rejects deleting default folders", async () => {
      const res = await api("DELETE", "/v1.0/me/mailFolders/inbox");
      expect(res.status).toBe(400);
      expect(res.data.error.code).toBe("ErrorInvalidRequest");
    });
  });

  describe("Messages, OData, and delta", () => {
    it("creates, lists, gets, selects, filters, searches, orders, patches, counts, and deletes messages", async () => {
      const first = await api("POST", "/v1.0/me/messages", message("Alpha", "first body", { parentFolderId: "inbox", isDraft: false, isRead: false }));
      const second = await api("POST", "/v1.0/me/mailFolders/inbox/messages", message("Beta", "second body", { importance: "high", isDraft: true }));
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const list = await api("GET", "/v1.0/me/messages?$top=1&$count=true&$orderby=subject desc");
      expect(list.data.value).toHaveLength(1);
      expect(list.data["@odata.nextLink"]).toContain("$skip=1");
      expect(list.data["@odata.count"]).toBeGreaterThanOrEqual(2);

      const filtered = await api("GET", "/v1.0/me/messages?$filter=importance eq 'high'");
      expect(filtered.data.value.map((m: Json) => m.subject)).toContain("Beta");

      const searched = await api("GET", "/v1.0/me/messages?$search=second");
      expect(searched.data.value).toHaveLength(1);

      const selected = await api("GET", `/v1.0/me/messages/${first.data.id}?$select=subject,isRead`);
      expect(selected.data).toEqual({ id: first.data.id, subject: "Alpha", isRead: false });

      const patched = await api("PATCH", `/v1.0/me/messages/${first.data.id}`, { isRead: true, categories: ["Blue category"] });
      expect(patched.data.isRead).toBe(true);
      expect(patched.data.categories).toEqual(["Blue category"]);

      const count = await api("GET", "/v1.0/me/messages/$count");
      expect(count.text).toMatch(/^\d+$/);

      const folderMessages = await api("GET", "/v1.0/me/mailFolders/inbox/messages");
      expect(folderMessages.data.value.some((m: Json) => m.id === first.data.id)).toBe(true);

      const folderDelta = await api("GET", "/v1.0/me/mailFolders/inbox/messages/delta");
      expect(folderDelta.data["@odata.deltaLink"]).toContain("$deltatoken");

      const delta = await api("GET", "/v1.0/me/messages/delta");
      expect(delta.data["@odata.deltaLink"]).toContain("$deltatoken");

      const deleted = await api("DELETE", `/v1.0/me/messages/${first.data.id}`);
      expect(deleted.status).toBe(204);
      expect((await api("GET", `/v1.0/me/messages/${first.data.id}`)).status).toBe(404);
    });
  });

  describe("Message actions and sendMail", () => {
    it("sendMail returns 202 and stores sent messages", async () => {
      const sent = await api("POST", "/v1.0/me/sendMail", { message: message("SendMail", "sent body"), saveToSentItems: true });
      expect(sent.status).toBe(202);
      const sentItems = await api("GET", "/v1.0/me/mailFolders/sentitems/messages?$filter=subject eq 'SendMail'");
      expect(sentItems.data.value).toHaveLength(1);
    });

    it("sends drafts, replies, replies all, forwards, creates action drafts, moves, and copies", async () => {
      const draft = await api("POST", "/v1.0/me/messages", message("Draft Action", "draft"));
      expect((await api("POST", `/v1.0/me/messages/${draft.data.id}/send`, {})).status).toBe(202);

      const base = await api("POST", "/v1.0/me/messages", message("Actions", "body", { parentFolderId: "inbox", isDraft: false }));
      expect((await api("POST", `/v1.0/me/messages/${base.data.id}/reply`, { comment: "reply" })).status).toBe(202);
      expect((await api("POST", `/v1.0/me/messages/${base.data.id}/replyAll`, { comment: "reply all" })).status).toBe(202);
      expect((await api("POST", `/v1.0/me/messages/${base.data.id}/forward`, { toRecipients: [{ emailAddress: { address: "fwd@example.com" } }] })).status).toBe(202);

      const replyDraft = await api("POST", `/v1.0/me/messages/${base.data.id}/createReply`, {});
      const replyAllDraft = await api("POST", `/v1.0/me/messages/${base.data.id}/createReplyAll`, {});
      const forwardDraft = await api("POST", `/v1.0/me/messages/${base.data.id}/createForward`, { toRecipients: [{ emailAddress: { address: "fwd@example.com" } }] });
      expect(replyDraft.status).toBe(201);
      expect(replyAllDraft.data.subject).toBe("RE: Actions");
      expect(forwardDraft.data.subject).toBe("FW: Actions");

      const moved = await api("POST", `/v1.0/me/messages/${base.data.id}/move`, { destinationId: "archive" });
      expect(moved.status).toBe(201);
      expect(moved.data.parentFolderId).toBe("archive");

      const copied = await api("POST", `/v1.0/me/messages/${base.data.id}/copy`, { destinationId: "inbox" });
      expect(copied.status).toBe(201);
      expect(copied.data.id).not.toBe(base.data.id);
    });
  });

  describe("Attachments", () => {
    it("creates, lists, expands, gets, downloads, and deletes file attachments", async () => {
      const msg = await api("POST", "/v1.0/me/messages", message("Attachment", "body"));
      const attachment = await api("POST", `/v1.0/me/messages/${msg.data.id}/attachments`, { name: "hello.txt", contentType: "text/plain", contentBytes: Buffer.from("hello").toString("base64") });
      expect(attachment.status).toBe(201);
      expect(attachment.data["@odata.type"]).toBe("#microsoft.graph.fileAttachment");

      const list = await api("GET", `/v1.0/me/messages/${msg.data.id}/attachments`);
      expect(list.data.value).toHaveLength(1);

      const expanded = await api("GET", `/v1.0/me/messages/${msg.data.id}?$expand=attachments`);
      expect(expanded.data.attachments[0].name).toBe("hello.txt");

      const got = await api("GET", `/v1.0/me/messages/${msg.data.id}/attachments/${attachment.data.id}`);
      expect(got.data.contentBytes).toBe(Buffer.from("hello").toString("base64"));

      const value = await fetch(`${BASE}/v1.0/me/messages/${msg.data.id}/attachments/${attachment.data.id}/$value`);
      expect(await value.text()).toBe("hello");

      expect((await api("DELETE", `/v1.0/me/messages/${msg.data.id}/attachments/${attachment.data.id}`)).status).toBe(204);
      expect((await api("GET", `/v1.0/me/messages/${msg.data.id}/attachments/${attachment.data.id}`)).status).toBe(404);
    });
  });

  describe("Message rules, categories, subscriptions, and batch", () => {
    it("creates, lists, gets, patches, and deletes inbox message rules", async () => {
      const rule = await api("POST", "/v1.0/me/mailFolders/inbox/messageRules", { displayName: "Star agent", conditions: { senderContains: ["agent"] }, actions: { markImportance: "high" } });
      expect(rule.status).toBe(201);
      expect((await api("GET", "/v1.0/me/mailFolders/inbox/messageRules")).data.value).toHaveLength(1);
      expect((await api("GET", `/v1.0/me/mailFolders/inbox/messageRules/${rule.data.id}`)).data.displayName).toBe("Star agent");
      expect((await api("PATCH", `/v1.0/me/mailFolders/inbox/messageRules/${rule.data.id}`, { isEnabled: false })).data.isEnabled).toBe(false);
      expect((await api("DELETE", `/v1.0/me/mailFolders/inbox/messageRules/${rule.data.id}`)).status).toBe(204);
    });

    it("creates, lists, gets, patches, and deletes master categories", async () => {
      const category = await api("POST", "/v1.0/me/outlook/masterCategories", { displayName: "Urgent", color: "preset1" });
      expect(category.status).toBe(201);
      expect((await api("GET", "/v1.0/me/outlook/masterCategories")).data.value.some((c: Json) => c.displayName === "Urgent")).toBe(true);
      expect((await api("GET", `/v1.0/me/outlook/masterCategories/${category.data.id}`)).data.color).toBe("preset1");
      expect((await api("PATCH", `/v1.0/me/outlook/masterCategories/${category.data.id}`, { color: "preset2" })).data.color).toBe("preset2");
      expect((await api("DELETE", `/v1.0/me/outlook/masterCategories/${category.data.id}`)).status).toBe(204);
    });

    it("creates, lists, gets, patches, and deletes subscriptions", async () => {
      const subscription = await api("POST", "/v1.0/subscriptions", { changeType: "created,updated", notificationUrl: "https://example.com/hook", resource: "me/messages", clientState: "secret" });
      expect(subscription.status).toBe(201);
      expect((await api("GET", "/v1.0/subscriptions")).data.value).toHaveLength(1);
      expect((await api("GET", `/v1.0/subscriptions/${subscription.data.id}`)).data.resource).toBe("me/messages");
      expect((await api("PATCH", `/v1.0/subscriptions/${subscription.data.id}`, { expirationDateTime: "2030-01-01T00:00:00.000Z" })).data.expirationDateTime).toBe("2030-01-01T00:00:00.000Z");
      expect((await api("DELETE", `/v1.0/subscriptions/${subscription.data.id}`)).status).toBe(204);
    });

    it("handles Graph JSON batch requests", async () => {
      const batch = await api("POST", "/v1.0/$batch", {
        requests: [
          { id: "1", method: "GET", url: "/me" },
          { id: "2", method: "POST", url: "/me/messages", body: message("Batch") },
          { id: "3", method: "GET", url: "/me/messages?$filter=subject eq 'Batch'" },
        ],
      });
      expect(batch.status).toBe(200);
      expect(batch.data.responses.map((r: Json) => r.status)).toEqual([200, 201, 200]);
      expect(batch.data.responses[2].body.value[0].subject).toBe("Batch");
    });
  });

  describe("Errors", () => {
    it("returns Microsoft Graph-shaped errors", async () => {
      const missing = await api("GET", "/v1.0/me/messages/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error.code).toBe("ErrorItemNotFound");
      expect(missing.data.error.innerError["client-request-id"]).toBe("test-client-id");

      const invalid = await api("POST", "/v1.0/me/mailFolders", {});
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.message).toContain("displayName");

      const method = await api("PUT", "/v1.0/me/messages", {});
      expect(method.status).toBe(405);
    });
  });
});
