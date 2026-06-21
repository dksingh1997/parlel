import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GmailServer } from "../services/gmail/src/server.js";

const PORT = 24610;
const BASE = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

function raw(subject: string, body = "hello", from = "agent@example.com", to = "parlel@example.com") {
  return Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`).toString("base64url");
}

async function api(method: string, path: string, body?: Json): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

describe("Gmail Service", () => {
  let server: GmailServer;

  beforeAll(async () => {
    server = new GmailServer(PORT);
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
      expect(reset).toEqual({ status: 200, data: { ok: true } });
      expect(server.messages.size).toBe(0);
      expect(server.drafts.size).toBe(0);
      expect(server.labels.has("INBOX")).toBe(true);
    });

    it("returns health", async () => {
      const res = await api("GET", "/_parlel/health");
      expect(res.status).toBe(200);
      expect(res.data.service).toBe("gmail");
    });
  });

  describe("Profile and watches", () => {
    it("getProfile", async () => {
      const res = await api("GET", "/gmail/v1/users/me/profile");
      expect(res.status).toBe(200);
      expect(res.data.emailAddress).toBe("parlel@example.com");
    });

    it("watch validates topicName, creates a watch, and stop clears it", async () => {
      const bad = await api("POST", "/gmail/v1/users/me/watch", {});
      expect(bad.status).toBe(400);
      expect(bad.data.error.errors[0].reason).toBe("invalidArgument");

      const watch = await api("POST", "/gmail/v1/users/me/watch", { topicName: "projects/parlel/topics/gmail", labelIds: ["INBOX"] });
      expect(watch.status).toBe(200);
      expect(watch.data.historyId).toBeDefined();
      expect(server.watchConfig?.topicName).toBe("projects/parlel/topics/gmail");

      const stop = await api("POST", "/gmail/v1/users/me/stop");
      expect(stop).toEqual({ status: 200, data: {} });
      expect(server.watchConfig).toBeNull();
    });
  });

  describe("Labels", () => {
    it("list, create, get, patch, update, and delete labels", async () => {
      const list = await api("GET", "/gmail/v1/users/me/labels");
      expect(list.status).toBe(200);
      expect(list.data.labels.some((l: Json) => l.id === "INBOX")).toBe(true);

      const created = await api("POST", "/gmail/v1/users/me/labels", { name: "Projects" });
      expect(created.status).toBe(200);
      expect(created.data.type).toBe("user");

      const got = await api("GET", `/gmail/v1/users/me/labels/${created.data.id}`);
      expect(got.data.name).toBe("Projects");

      const patched = await api("PATCH", `/gmail/v1/users/me/labels/${created.data.id}`, { labelListVisibility: "labelHide" });
      expect(patched.data.labelListVisibility).toBe("labelHide");

      const updated = await api("PUT", `/gmail/v1/users/me/labels/${created.data.id}`, { name: "Projects Updated" });
      expect(updated.data.name).toBe("Projects Updated");

      const deleted = await api("DELETE", `/gmail/v1/users/me/labels/${created.data.id}`);
      expect(deleted.status).toBe(204);
    });

    it("returns real-shaped errors for invalid label operations", async () => {
      const renameSystem = await api("PATCH", "/gmail/v1/users/me/labels/INBOX", { name: "Nope" });
      expect(renameSystem.status).toBe(400);
      expect(renameSystem.data.error.code).toBe(400);
      expect(renameSystem.data.error.status).toBe("INVALID_ARGUMENT");

      const missing = await api("GET", "/gmail/v1/users/me/labels/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error.errors[0].reason).toBe("notFound");
      expect(missing.data.error.status).toBe("NOT_FOUND");
    });

    it("rejects a missing label name with 400", async () => {
      const created = await api("POST", "/gmail/v1/users/me/labels", {});
      expect(created.status).toBe(400);
      expect(created.data.error.status).toBe("INVALID_ARGUMENT");
    });

    it("rejects a duplicate label name with 409 ALREADY_EXISTS", async () => {
      const first = await api("POST", "/gmail/v1/users/me/labels", { name: "Duplicate" });
      expect(first.status).toBe(200);

      const dup = await api("POST", "/gmail/v1/users/me/labels", { name: "Duplicate" });
      expect(dup.status).toBe(409);
      expect(dup.data.error.code).toBe(409);
      expect(dup.data.error.status).toBe("ALREADY_EXISTS");
      expect(dup.data.error.errors[0].reason).toBe("duplicate");
    });
  });

  describe("Messages and attachments", () => {
    it("insert, import, send, list, get, modify, trash, untrash, delete", async () => {
      const inserted = await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("Inserted", "body one"), labelIds: ["INBOX", "UNREAD"] });
      expect(inserted.status).toBe(200);
      expect(inserted.data.labelIds).toContain("INBOX");

      const uploadInserted = await api("POST", "/upload/gmail/v1/users/me/messages/insert", { raw: raw("Upload Inserted", "upload body") });
      expect(uploadInserted.status).toBe(200);
      expect(uploadInserted.data.payload.headers.find((h: Json) => h.name === "Subject").value).toBe("Upload Inserted");

      const imported = await api("POST", "/gmail/v1/users/me/messages/import", { raw: raw("Imported", "body two") });
      expect(imported.status).toBe(200);
      expect(imported.data.payload.headers.find((h: Json) => h.name === "Subject").value).toBe("Imported");

      const sent = await api("POST", "/gmail/v1/users/me/messages/send", { raw: raw("Sent", "body three") });
      expect(sent.status).toBe(200);
      expect(sent.data.labelIds).toContain("SENT");

      const list = await api("GET", "/gmail/v1/users/me/messages?maxResults=2");
      expect(list.status).toBe(200);
      expect(list.data.messages.length).toBe(2);
      expect(list.data.nextPageToken).toBe("2");

      const queried = await api("GET", "/gmail/v1/users/me/messages?q=subject:Imported");
      expect(queried.data.messages).toHaveLength(1);

      const metadata = await api("GET", `/gmail/v1/users/me/messages/${inserted.data.id}?format=metadata&metadataHeaders=Subject`);
      expect(metadata.data.payload.headers).toEqual([{ name: "Subject", value: "Inserted" }]);

      const rawMessage = await api("GET", `/gmail/v1/users/me/messages/${inserted.data.id}?format=raw`);
      expect(rawMessage.data.raw).toBeDefined();

      const full = await api("GET", `/gmail/v1/users/me/messages/${inserted.data.id}`);
      const attachmentId = full.data.payload.parts[1].body.attachmentId;
      const attachment = await api("GET", `/gmail/v1/users/me/messages/${inserted.data.id}/attachments/${attachmentId}`);
      expect(attachment.status).toBe(200);
      expect(attachment.data.data).toBeDefined();

      const modified = await api("POST", `/gmail/v1/users/me/messages/${inserted.data.id}/modify`, { addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
      expect(modified.data.labelIds).toContain("STARRED");
      expect(modified.data.labelIds).not.toContain("UNREAD");

      const trashed = await api("POST", `/gmail/v1/users/me/messages/${inserted.data.id}/trash`);
      expect(trashed.data.labelIds).toContain("TRASH");

      const untrashed = await api("POST", `/gmail/v1/users/me/messages/${inserted.data.id}/untrash`);
      expect(untrashed.data.labelIds).toContain("INBOX");

      const deleted = await api("DELETE", `/gmail/v1/users/me/messages/${inserted.data.id}`);
      expect(deleted.status).toBe(204);

      const missing = await api("GET", `/gmail/v1/users/me/messages/${inserted.data.id}`);
      expect(missing.status).toBe(404);
    });

    it("batchModify and batchDelete", async () => {
      const one = await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("Batch One") });
      const two = await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("Batch Two") });

      const modified = await api("POST", "/gmail/v1/users/me/messages/batchModify", { ids: [one.data.id, two.data.id], addLabelIds: ["IMPORTANT"] });
      expect(modified.status).toBe(204);

      const got = await api("GET", `/gmail/v1/users/me/messages/${one.data.id}`);
      expect(got.data.labelIds).toContain("IMPORTANT");

      const deleted = await api("POST", "/gmail/v1/users/me/messages/batchDelete", { ids: [one.data.id, two.data.id] });
      expect(deleted.status).toBe(204);

      const missing = await api("GET", `/gmail/v1/users/me/messages/${two.data.id}`);
      expect(missing.status).toBe(404);
    });
  });

  describe("Drafts", () => {
    it("create, list, get, update, send, and delete drafts", async () => {
      const created = await api("POST", "/gmail/v1/users/me/drafts", { message: { raw: raw("Draft One") } });
      expect(created.status).toBe(200);
      expect(created.data.message.labelIds).toContain("DRAFT");

      const list = await api("GET", "/gmail/v1/users/me/drafts");
      expect(list.data.drafts.some((d: Json) => d.id === created.data.id)).toBe(true);

      const got = await api("GET", `/gmail/v1/users/me/drafts/${created.data.id}`);
      expect(got.data.id).toBe(created.data.id);

      const updated = await api("PUT", `/gmail/v1/users/me/drafts/${created.data.id}`, { message: { raw: raw("Draft Updated") } });
      expect(updated.data.message.payload.headers.find((h: Json) => h.name === "Subject").value).toBe("Draft Updated");

      const sent = await api("POST", "/gmail/v1/users/me/drafts/send", { id: created.data.id });
      expect(sent.data.labelIds).toContain("SENT");

      const second = await api("POST", "/gmail/v1/users/me/drafts", { message: { raw: raw("Draft Delete") } });
      const deleted = await api("DELETE", `/gmail/v1/users/me/drafts/${second.data.id}`);
      expect(deleted.status).toBe(204);
    });
  });

  describe("Threads", () => {
    it("list, get, modify, trash, untrash, and delete threads", async () => {
      const first = await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("Thread One") });
      const second = await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("Thread Two"), threadId: first.data.threadId });

      const list = await api("GET", "/gmail/v1/users/me/threads");
      expect(list.data.threads.some((t: Json) => t.id === first.data.threadId)).toBe(true);

      const got = await api("GET", `/gmail/v1/users/me/threads/${first.data.threadId}`);
      expect(got.data.messages.map((m: Json) => m.id)).toContain(second.data.id);

      const modified = await api("POST", `/gmail/v1/users/me/threads/${first.data.threadId}/modify`, { addLabelIds: ["STARRED"] });
      expect(modified.data.messages.every((m: Json) => m.labelIds.includes("STARRED"))).toBe(true);

      const trashed = await api("POST", `/gmail/v1/users/me/threads/${first.data.threadId}/trash`);
      expect(trashed.data.messages.every((m: Json) => m.labelIds.includes("TRASH"))).toBe(true);

      const untrashed = await api("POST", `/gmail/v1/users/me/threads/${first.data.threadId}/untrash`);
      expect(untrashed.data.messages.every((m: Json) => m.labelIds.includes("INBOX"))).toBe(true);

      const deleted = await api("DELETE", `/gmail/v1/users/me/threads/${first.data.threadId}`);
      expect(deleted.status).toBe(204);
    });
  });

  describe("History", () => {
    it("lists history with startHistoryId and rejects invalid ids", async () => {
      await api("POST", "/gmail/v1/users/me/messages/insert", { raw: raw("History") });
      const history = await api("GET", "/gmail/v1/users/me/history?startHistoryId=1");
      expect(history.status).toBe(200);
      expect(history.data.history.length).toBeGreaterThan(0);

      const invalid = await api("GET", "/gmail/v1/users/me/history?startHistoryId=nope");
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.status).toBe("INVALID_ARGUMENT");
    });

    it("requires startHistoryId and rejects its omission with 400", async () => {
      const missing = await api("GET", "/gmail/v1/users/me/history");
      expect(missing.status).toBe(400);
      expect(missing.data.error.status).toBe("INVALID_ARGUMENT");
      expect(missing.data.error.errors[0].reason).toBe("invalidArgument");
    });
  });

  describe("Settings", () => {
    it("gets and updates autoForwarding, imap, language, pop, and vacation", async () => {
      for (const [name, patch] of [
        ["autoForwarding", { enabled: true, disposition: "archive" }],
        ["imap", { enabled: true }],
        ["language", { displayLanguage: "fr" }],
        ["pop", { accessWindow: "allMail" }],
        ["vacation", { enableAutoReply: true, responseSubject: "Away" }],
      ] as const) {
        const updated = await api("PUT", `/gmail/v1/users/me/settings/${name}`, patch);
        expect(updated.status).toBe(200);
        const got = await api("GET", `/gmail/v1/users/me/settings/${name}`);
        expect(got.data).toMatchObject(patch);
      }
    });

    it("creates, lists, gets, and deletes filters, forwarding addresses, and delegates", async () => {
      const filter = await api("POST", "/gmail/v1/users/me/settings/filters", { criteria: { from: "a@example.com" }, action: { addLabelIds: ["STARRED"] } });
      expect(filter.data.id).toBeDefined();
      expect((await api("GET", "/gmail/v1/users/me/settings/filters")).data.filter).toHaveLength(1);
      expect((await api("GET", `/gmail/v1/users/me/settings/filters/${filter.data.id}`)).data.criteria.from).toBe("a@example.com");
      expect((await api("DELETE", `/gmail/v1/users/me/settings/filters/${filter.data.id}`)).status).toBe(204);

      const forwarding = await api("POST", "/gmail/v1/users/me/settings/forwardingAddresses", { forwardingEmail: "fwd@example.com" });
      expect(forwarding.data.verificationStatus).toBe("accepted");
      expect((await api("GET", "/gmail/v1/users/me/settings/forwardingAddresses")).data.forwardingAddress).toHaveLength(1);
      expect((await api("GET", "/gmail/v1/users/me/settings/forwardingAddresses/fwd@example.com")).data.forwardingEmail).toBe("fwd@example.com");
      expect((await api("DELETE", "/gmail/v1/users/me/settings/forwardingAddresses/fwd@example.com")).status).toBe(204);

      const delegate = await api("POST", "/gmail/v1/users/me/settings/delegates", { delegateEmail: "delegate@example.com" });
      expect(delegate.data.delegateEmail).toBe("delegate@example.com");
      expect((await api("GET", "/gmail/v1/users/me/settings/delegates")).data.delegate).toHaveLength(1);
      expect((await api("GET", "/gmail/v1/users/me/settings/delegates/delegate@example.com")).data.verificationStatus).toBe("accepted");
      expect((await api("DELETE", "/gmail/v1/users/me/settings/delegates/delegate@example.com")).status).toBe(204);
    });
  });

  describe("Send-as and S/MIME", () => {
    it("create, list, get, patch, update, verify, and delete send-as aliases", async () => {
      const created = await api("POST", "/gmail/v1/users/me/settings/sendAs", { sendAsEmail: "alias@example.com", displayName: "Alias" });
      expect(created.data.sendAsEmail).toBe("alias@example.com");

      const list = await api("GET", "/gmail/v1/users/me/settings/sendAs");
      expect(list.data.sendAs.some((s: Json) => s.sendAsEmail === "alias@example.com")).toBe(true);

      expect((await api("GET", "/gmail/v1/users/me/settings/sendAs/alias@example.com")).data.displayName).toBe("Alias");
      expect((await api("PATCH", "/gmail/v1/users/me/settings/sendAs/alias@example.com", { signature: "sig" })).data.signature).toBe("sig");
      expect((await api("PUT", "/gmail/v1/users/me/settings/sendAs/alias@example.com", { displayName: "Alias 2" })).data.displayName).toBe("Alias 2");
      expect((await api("POST", "/gmail/v1/users/me/settings/sendAs/alias@example.com/verify")).status).toBe(200);
      expect((await api("DELETE", "/gmail/v1/users/me/settings/sendAs/alias@example.com")).status).toBe(204);
    });

    it("insert, list, get, setDefault, and delete smimeInfo", async () => {
      const smime = await api("POST", "/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo", { pem: "CERT" });
      expect(smime.data.id).toBeDefined();
      expect((await api("GET", "/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo")).data.smimeInfo).toHaveLength(1);
      expect((await api("GET", `/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo/${smime.data.id}`)).data.pem).toBe("CERT");
      expect((await api("POST", `/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo/${smime.data.id}/setDefault`)).status).toBe(200);
      expect((await api("GET", `/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo/${smime.data.id}`)).data.isDefault).toBe(true);
      expect((await api("DELETE", `/gmail/v1/users/me/settings/sendAs/parlel@example.com/smimeInfo/${smime.data.id}`)).status).toBe(204);
    });
  });

  describe("CSE settings", () => {
    it("create, list, get, patch, and delete CSE identities", async () => {
      const identity = await api("POST", "/gmail/v1/users/me/settings/cse/identities", { emailAddress: "secure@example.com", primaryKeyPairId: "kp1" });
      expect(identity.data.emailAddress).toBe("secure@example.com");
      expect((await api("GET", "/gmail/v1/users/me/settings/cse/identities")).data.cseIdentity).toHaveLength(1);
      expect((await api("GET", "/gmail/v1/users/me/settings/cse/identities/secure@example.com")).data.primaryKeyPairId).toBe("kp1");
      expect((await api("PATCH", "/gmail/v1/users/me/settings/cse/identities/secure@example.com", { primaryKeyPairId: "kp2" })).data.primaryKeyPairId).toBe("kp2");
      expect((await api("DELETE", "/gmail/v1/users/me/settings/cse/identities/secure@example.com")).status).toBe(204);
    });

    it("create, list, get, disable, enable, and obliterate CSE keypairs", async () => {
      const keyPair = await api("POST", "/gmail/v1/users/me/settings/cse/keypairs", { keyPairId: "kp1", pem: "KEY" });
      expect(keyPair.data.state).toBe("enabled");
      expect((await api("GET", "/gmail/v1/users/me/settings/cse/keypairs")).data.cseKeyPairs).toHaveLength(1);
      expect((await api("GET", "/gmail/v1/users/me/settings/cse/keypairs/kp1")).data.pem).toBe("KEY");
      expect((await api("PATCH", "/gmail/v1/users/me/settings/cse/keypairs/kp1", { pem: "NEW" })).status).toBe(405);
      expect((await api("POST", "/gmail/v1/users/me/settings/cse/keypairs/kp1/disable")).data.state).toBe("disabled");
      expect((await api("POST", "/gmail/v1/users/me/settings/cse/keypairs/kp1/enable")).data.state).toBe("enabled");
      expect((await api("POST", "/gmail/v1/users/me/settings/cse/keypairs/kp1/obliterate")).status).toBe(200);
      expect((await api("GET", "/gmail/v1/users/me/settings/cse/keypairs/kp1")).status).toBe(404);
    });
  });
});
