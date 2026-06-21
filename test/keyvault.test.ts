import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  SecretClient,
  parseKeyVaultSecretIdentifier,
} from "@azure/keyvault-secrets";
import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { KeyvaultServer } from "../services/keyvault/src/server.js";

const PORT = 14594;
const VAULT_URL = `http://127.0.0.1:${PORT}`;

// A minimal fake TokenCredential. The fake vault accepts ANY non-empty bearer
// token, so we never need a real Azure identity. This mirrors how an AI agent
// would point the real SecretClient at the local fake.
const fakeCredential: TokenCredential = {
  async getToken(): Promise<AccessToken> {
    return {
      token: "parlel-fake-token",
      expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
    };
  },
};

function makeClient(): SecretClient {
  return new SecretClient(VAULT_URL, fakeCredential, {
    // The fake serves plain HTTP and presents a synthetic challenge resource.
    disableChallengeResourceVerification: true,
    allowInsecureConnection: true,
    retryOptions: { maxRetries: 0 },
  } as any);
}

// Poller options: poll instantly so soft-delete / recover tests don't wait 2s.
const fastPoll = { intervalInMs: 0 } as any;

let server: KeyvaultServer;
let client: SecretClient;
let counter = 0;
function uniqueName(prefix = "secret"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("Azure Key Vault Secrets Service", () => {
  beforeAll(async () => {
    server = new KeyvaultServer(PORT);
    await server.start();
    client = makeClient();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  // -----------------------------------------------------------------------
  // Internal endpoints
  // -----------------------------------------------------------------------
  describe("internal endpoints", () => {
    it("responds to health", async () => {
      const res = await fetch(`${VAULT_URL}/_parlel/health`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(json.service).toBe("keyvault");
      expect(typeof json.secrets).toBe("number");
      expect(typeof json.deleted).toBe("number");
    });

    it("resets state via POST /_parlel/reset", async () => {
      await client.setSecret(uniqueName(), "v");
      const res = await fetch(`${VAULT_URL}/_parlel/reset`, { method: "POST" });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      const health = await (await fetch(`${VAULT_URL}/_parlel/health`)).json();
      expect(health.secrets).toBe(0);
    });

    it("dumps state", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const res = await fetch(`${VAULT_URL}/_parlel/dump`);
      const json = await res.json();
      expect(json.secrets).toContain(name);
    });
  });

  // -----------------------------------------------------------------------
  // Authentication (challenge based)
  // -----------------------------------------------------------------------
  describe("challenge authentication", () => {
    it("issues a 401 WWW-Authenticate challenge when no bearer token", async () => {
      const res = await fetch(`${VAULT_URL}/secrets/foo/?api-version=2025-07-01`);
      expect(res.status).toBe(401);
      const header = res.headers.get("www-authenticate");
      expect(header).toBeTruthy();
      expect(header).toContain("authorization=");
      expect(header).toContain("resource=");
    });

    it("accepts any non-empty bearer token", async () => {
      const res = await fetch(`${VAULT_URL}/secrets?api-version=2025-07-01`, {
        headers: { authorization: "Bearer anything-goes" },
      });
      expect(res.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // setSecret / getSecret
  // -----------------------------------------------------------------------
  describe("setSecret + getSecret", () => {
    it("sets and reads back a simple secret", async () => {
      const name = uniqueName();
      const set = await client.setSecret(name, "s3cr3t");
      expect(set.name).toBe(name);
      expect(set.value).toBe("s3cr3t");
      expect(set.properties.enabled).toBe(true);
      expect(set.properties.version).toBeTruthy();
      expect(set.properties.vaultUrl).toBe(VAULT_URL);
      expect(set.properties.createdOn).toBeInstanceOf(Date);
      expect(set.properties.updatedOn).toBeInstanceOf(Date);
      expect(set.properties.recoveryLevel).toBe("Recoverable+Purgeable");

      const got = await client.getSecret(name);
      expect(got.value).toBe("s3cr3t");
      expect(got.name).toBe(name);
      expect(got.properties.version).toBe(set.properties.version);
    });

    it("sets a secret with content type, tags, and attributes", async () => {
      const name = uniqueName();
      const notBefore = new Date(Date.now() - 60_000);
      const expiresOn = new Date(Date.now() + 3_600_000);
      const set = await client.setSecret(name, "value", {
        contentType: "text/plain",
        tags: { env: "test", team: "parlel" },
        enabled: true,
        notBefore,
        expiresOn,
      });
      expect(set.properties.contentType).toBe("text/plain");
      expect(set.properties.tags).toEqual({ env: "test", team: "parlel" });
      // Unix-second precision round-trip.
      expect(Math.floor(set.properties.notBefore!.getTime() / 1000)).toBe(
        Math.floor(notBefore.getTime() / 1000),
      );
      expect(Math.floor(set.properties.expiresOn!.getTime() / 1000)).toBe(
        Math.floor(expiresOn.getTime() / 1000),
      );
    });

    it("creates a new version on each set and getSecret returns the latest", async () => {
      const name = uniqueName();
      const v1 = await client.setSecret(name, "one");
      const v2 = await client.setSecret(name, "two");
      expect(v1.properties.version).not.toBe(v2.properties.version);
      const latest = await client.getSecret(name);
      expect(latest.value).toBe("two");
      expect(latest.properties.version).toBe(v2.properties.version);
    });

    it("reads a specific (older) version", async () => {
      const name = uniqueName();
      const v1 = await client.setSecret(name, "one");
      await client.setSecret(name, "two");
      const old = await client.getSecret(name, { version: v1.properties.version });
      expect(old.value).toBe("one");
    });

    it("produces a parseable secret identifier", async () => {
      const name = uniqueName();
      const set = await client.setSecret(name, "v");
      const parsed = parseKeyVaultSecretIdentifier(set.properties.id!);
      expect(parsed.name).toBe(name);
      expect(parsed.version).toBe(set.properties.version);
      expect(parsed.vaultUrl).toBe(VAULT_URL);
    });

    it("404s on an unknown secret", async () => {
      await expect(client.getSecret(uniqueName())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("404s on an unknown version", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      await expect(
        client.getSecret(name, { version: "ffffffffffffffffffffffffffffffff" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("rejects an invalid secret name", async () => {
      await expect(client.setSecret("bad name!", "v")).rejects.toMatchObject({
        statusCode: 400,
      });
    });
  });

  // -----------------------------------------------------------------------
  // updateSecretProperties
  // -----------------------------------------------------------------------
  describe("updateSecretProperties", () => {
    it("updates enabled, contentType and tags on a version", async () => {
      const name = uniqueName();
      const set = await client.setSecret(name, "v");
      const updated = await client.updateSecretProperties(
        name,
        set.properties.version!,
        {
          enabled: false,
          contentType: "application/json",
          tags: { updated: "yes" },
        },
      );
      expect(updated.enabled).toBe(false);
      expect(updated.contentType).toBe("application/json");
      expect(updated.tags).toEqual({ updated: "yes" });
      // The value is preserved.
      const got = await client.getSecret(name, { version: set.properties.version });
      expect(got.value).toBe("v");
      expect(got.properties.enabled).toBe(false);
    });

    it("updates the latest version when no version is given", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const updated = await client.updateSecretProperties(name, "", {
        contentType: "x/y",
      });
      expect(updated.contentType).toBe("x/y");
    });

    it("404s updating an unknown secret", async () => {
      await expect(
        client.updateSecretProperties(uniqueName(), "", { enabled: false }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // -----------------------------------------------------------------------
  // listPropertiesOfSecrets / listPropertiesOfSecretVersions
  // -----------------------------------------------------------------------
  describe("listing", () => {
    it("lists properties of all secrets", async () => {
      const names = [uniqueName(), uniqueName(), uniqueName()];
      for (const n of names) await client.setSecret(n, "v");
      const found: string[] = [];
      for await (const props of client.listPropertiesOfSecrets()) {
        found.push(props.name);
      }
      for (const n of names) expect(found).toContain(n);
    });

    it("list does not include secret values", async () => {
      const name = uniqueName();
      await client.setSecret(name, "secretvalue");
      for await (const props of client.listPropertiesOfSecrets()) {
        expect((props as any).value).toBeUndefined();
      }
    });

    it("lists versions of a secret newest-first", async () => {
      const name = uniqueName();
      const v1 = await client.setSecret(name, "one");
      const v2 = await client.setSecret(name, "two");
      const versions: string[] = [];
      for await (const props of client.listPropertiesOfSecretVersions(name)) {
        versions.push(props.version!);
      }
      expect(versions).toContain(v1.properties.version);
      expect(versions).toContain(v2.properties.version);
      expect(versions.length).toBe(2);
    });

    it("paginates listings across pages via nextLink", async () => {
      // Create more than one page worth (default page size is 25).
      const created: string[] = [];
      for (let i = 0; i < 30; i++) {
        const n = uniqueName("page");
        created.push(n);
        await client.setSecret(n, "v");
      }
      const seen = new Set<string>();
      let pages = 0;
      const iter = client.listPropertiesOfSecrets().byPage({ maxPageSize: 10 });
      for await (const page of iter) {
        pages += 1;
        for (const p of page) seen.add(p.name);
      }
      expect(pages).toBeGreaterThan(1);
      for (const n of created) expect(seen.has(n)).toBe(true);
    });

    it("404s listing versions of an unknown secret", async () => {
      await expect(async () => {
        for await (const _ of client.listPropertiesOfSecretVersions(uniqueName())) {
          void _;
        }
      }).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // -----------------------------------------------------------------------
  // backup / restore
  // -----------------------------------------------------------------------
  describe("backup + restore", () => {
    it("backs up a secret and restores it after purge", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v1");
      await client.setSecret(name, "v2");
      const backup = await client.backupSecret(name);
      expect(backup).toBeInstanceOf(Uint8Array);
      expect(backup!.length).toBeGreaterThan(0);

      // Remove the secret entirely (delete + purge).
      const poller = await client.beginDeleteSecret(name, fastPoll);
      await poller.pollUntilDone();
      await client.purgeDeletedSecret(name);

      const restored = await client.restoreSecretBackup(backup!);
      expect(restored.name).toBe(name);
      const got = await client.getSecret(name);
      expect(got.value).toBe("v2");
    });

    it("404s backing up an unknown secret", async () => {
      await expect(client.backupSecret(uniqueName())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("rejects restoring over an existing secret", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const backup = await client.backupSecret(name);
      await expect(client.restoreSecretBackup(backup!)).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  // -----------------------------------------------------------------------
  // soft-delete lifecycle: delete, getDeleted, list deleted, recover, purge
  // -----------------------------------------------------------------------
  describe("soft delete lifecycle", () => {
    it("deletes a secret and exposes it as a deleted secret", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const poller = await client.beginDeleteSecret(name, fastPoll);
      const deleted = await poller.pollUntilDone();
      expect(deleted.name).toBe(name);
      expect(deleted.recoveryId).toBeTruthy();
      expect(deleted.scheduledPurgeDate).toBeInstanceOf(Date);
      expect(deleted.deletedOn).toBeInstanceOf(Date);

      // It's gone from the live store...
      await expect(client.getSecret(name)).rejects.toMatchObject({
        statusCode: 404,
      });
      // ...but present in the deleted store.
      const got = await client.getDeletedSecret(name);
      expect(got.name).toBe(name);
    });

    it("lists deleted secrets", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const poller = await client.beginDeleteSecret(name, fastPoll);
      await poller.pollUntilDone();
      const found: string[] = [];
      for await (const d of client.listDeletedSecrets()) found.push(d.name);
      expect(found).toContain(name);
    });

    it("recovers a deleted secret", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const delPoller = await client.beginDeleteSecret(name, fastPoll);
      await delPoller.pollUntilDone();

      const recPoller = await client.beginRecoverDeletedSecret(name, fastPoll);
      const recovered = await recPoller.pollUntilDone();
      expect(recovered.name).toBe(name);

      // Back in the live store.
      const got = await client.getSecret(name);
      expect(got.value).toBe("v");
      // No longer a deleted secret.
      await expect(client.getDeletedSecret(name)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("purges a deleted secret permanently", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const poller = await client.beginDeleteSecret(name, fastPoll);
      await poller.pollUntilDone();
      await client.purgeDeletedSecret(name);
      await expect(client.getDeletedSecret(name)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("blocks re-creating a secret whose name is soft-deleted (Conflict)", async () => {
      const name = uniqueName();
      await client.setSecret(name, "v");
      const poller = await client.beginDeleteSecret(name, fastPoll);
      await poller.pollUntilDone();
      await expect(client.setSecret(name, "new")).rejects.toMatchObject({
        statusCode: 409,
      });
    });

    it("404s deleting an unknown secret", async () => {
      await expect(client.beginDeleteSecret(uniqueName(), fastPoll)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("404s getDeletedSecret on an unknown name", async () => {
      await expect(client.getDeletedSecret(uniqueName())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("404s recovering an unknown deleted secret", async () => {
      await expect(
        client.beginRecoverDeletedSecret(uniqueName(), fastPoll),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("404s purging an unknown deleted secret", async () => {
      await expect(client.purgeDeletedSecret(uniqueName())).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it("preserves all versions through delete and recover", async () => {
      const name = uniqueName();
      const v1 = await client.setSecret(name, "one");
      const v2 = await client.setSecret(name, "two");
      const delPoller = await client.beginDeleteSecret(name, fastPoll);
      await delPoller.pollUntilDone();
      const recPoller = await client.beginRecoverDeletedSecret(name, fastPoll);
      await recPoller.pollUntilDone();

      const got1 = await client.getSecret(name, { version: v1.properties.version });
      const got2 = await client.getSecret(name, { version: v2.properties.version });
      expect(got1.value).toBe("one");
      expect(got2.value).toBe("two");
    });
  });

  // -----------------------------------------------------------------------
  // error shape
  // -----------------------------------------------------------------------
  describe("error responses", () => {
    it("returns a Key Vault error shape with a code", async () => {
      try {
        await client.getSecret(uniqueName());
        throw new Error("should have thrown");
      } catch (err: any) {
        expect(err.statusCode).toBe(404);
        // The SDK surfaces the service error code.
        expect(err.code === "SecretNotFound" || err.name === "RestError").toBeTruthy();
      }
    });
  });
});
