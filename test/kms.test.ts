import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { KmsServer } from "../services/kms/src/server.js";

const PORT = 14730;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(op: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `TrentService.${op}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("KMS Service", () => {
  let server: KmsServer;

  beforeAll(async () => {
    server = new KmsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4730", () => {
    expect(new KmsServer().port).toBe(4730);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("kms");
  });

  it("creates, describes and lists keys", async () => {
    const c = await call("CreateKey", { Description: "test key" });
    expect(c.status).toBe(200);
    const keyId = c.json.KeyMetadata.KeyId;
    expect(c.json.KeyMetadata.Arn).toContain(":key/");

    const d = await call("DescribeKey", { KeyId: keyId });
    expect(d.json.KeyMetadata.Description).toBe("test key");

    const l = await call("ListKeys");
    expect(l.json.Keys.length).toBe(1);
  });

  it("encrypts and decrypts round-trip", async () => {
    const c = await call("CreateKey");
    const keyId = c.json.KeyMetadata.KeyId;
    const enc = await call("Encrypt", { KeyId: keyId, Plaintext: b64("hello-secret") });
    expect(enc.json.CiphertextBlob).toBeTruthy();
    const dec = await call("Decrypt", { CiphertextBlob: enc.json.CiphertextBlob });
    expect(Buffer.from(dec.json.Plaintext, "base64").toString()).toBe("hello-secret");
  });

  it("generates data keys", async () => {
    const c = await call("CreateKey");
    const keyId = c.json.KeyMetadata.KeyId;
    const dk = await call("GenerateDataKey", { KeyId: keyId, KeySpec: "AES_256" });
    expect(Buffer.from(dk.json.Plaintext, "base64").length).toBe(32);
    const dec = await call("Decrypt", { CiphertextBlob: dk.json.CiphertextBlob });
    expect(dec.json.Plaintext).toBe(dk.json.Plaintext);

    const dkw = await call("GenerateDataKeyWithoutPlaintext", { KeyId: keyId });
    expect(dkw.json.Plaintext).toBeUndefined();
    expect(dkw.json.CiphertextBlob).toBeTruthy();
  });

  it("signs and verifies", async () => {
    const c = await call("CreateKey", { KeyUsage: "SIGN_VERIFY" });
    const keyId = c.json.KeyMetadata.KeyId;
    const msg = b64("message-to-sign");
    const s = await call("Sign", { KeyId: keyId, Message: msg });
    expect(s.json.Signature).toBeTruthy();
    const v = await call("Verify", { KeyId: keyId, Message: msg, Signature: s.json.Signature });
    expect(v.json.SignatureValid).toBe(true);

    const bad = await call("Verify", { KeyId: keyId, Message: b64("tampered"), Signature: s.json.Signature });
    expect(bad.status).toBe(400);
  });

  it("manages aliases", async () => {
    const c = await call("CreateKey");
    const keyId = c.json.KeyMetadata.KeyId;
    await call("CreateAlias", { AliasName: "alias/my-key", TargetKeyId: keyId });
    const l = await call("ListAliases");
    expect(l.json.Aliases.some((a: any) => a.AliasName === "alias/my-key")).toBe(true);

    // Encrypt via alias
    const enc = await call("Encrypt", { KeyId: "alias/my-key", Plaintext: b64("via-alias") });
    const dec = await call("Decrypt", { CiphertextBlob: enc.json.CiphertextBlob });
    expect(Buffer.from(dec.json.Plaintext, "base64").toString()).toBe("via-alias");

    await call("DeleteAlias", { AliasName: "alias/my-key" });
    const l2 = await call("ListAliases");
    expect(l2.json.Aliases.length).toBe(0);
  });

  it("manages key rotation", async () => {
    const c = await call("CreateKey");
    const keyId = c.json.KeyMetadata.KeyId;
    let s = await call("GetKeyRotationStatus", { KeyId: keyId });
    expect(s.json.KeyRotationEnabled).toBe(false);
    await call("EnableKeyRotation", { KeyId: keyId });
    s = await call("GetKeyRotationStatus", { KeyId: keyId });
    expect(s.json.KeyRotationEnabled).toBe(true);
  });

  it("schedules key deletion", async () => {
    const c = await call("CreateKey");
    const keyId = c.json.KeyMetadata.KeyId;
    const d = await call("ScheduleKeyDeletion", { KeyId: keyId, PendingWindowInDays: 7 });
    expect(d.json.KeyState).toBe("PendingDeletion");
    expect(d.json.PendingWindowInDays).toBe(7);
  });

  it("re-encrypts between keys", async () => {
    const k1 = (await call("CreateKey")).json.KeyMetadata.KeyId;
    const k2 = (await call("CreateKey")).json.KeyMetadata.KeyId;
    const enc = await call("Encrypt", { KeyId: k1, Plaintext: b64("reencrypt-me") });
    const re = await call("ReEncrypt", { CiphertextBlob: enc.json.CiphertextBlob, DestinationKeyId: k2 });
    const dec = await call("Decrypt", { CiphertextBlob: re.json.CiphertextBlob });
    expect(Buffer.from(dec.json.Plaintext, "base64").toString()).toBe("reencrypt-me");
  });

  it("returns NotFoundException for missing key", async () => {
    const d = await call("DescribeKey", { KeyId: "nonexistent" });
    expect(d.status).toBe(400);
    expect(d.json.__type).toBe("NotFoundException");
  });
});
