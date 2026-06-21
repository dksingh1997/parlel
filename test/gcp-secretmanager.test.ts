import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { request as httpRequest } from "node:http";
import { GcpSecretmanagerServer, crc32c } from "../services/gcp-secretmanager/src/server.js";

// A lightweight, dependency-free fake of Google Cloud Secret Manager exercised
// through the real `@google-cloud/secret-manager` client over its HTTP/1.1 REST
// transport (the google-gax `fallback` mode). Mirrors the structure/style of
// tests/redis.test.ts, tests/postgres.test.ts and tests/cloudtasks.test.ts.

const PORT = 14585;
const PROJECT = "parlel";

process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT = PROJECT;

// A minimal, dependency-free auth client. It satisfies the google-gax (v5)
// fallback transport contract: `fetch()` resolves the response object on EVERY
// status (it never throws on non-2xx). This is required so that gax's REST
// decoder runs and transcodes the google.rpc.Status error body back into the
// canonical gRPC status code (e.g. NOT_FOUND -> 5). The parlel fake never
// validates credentials, so no key material is needed.
const fakeAuthClient = {
  async getRequestHeaders(): Promise<Headers> {
    return new Headers();
  },
  async getClient(): Promise<unknown> {
    return fakeAuthClient;
  },
  async getProjectId(): Promise<string> {
    return PROJECT;
  },
  universeDomain: "googleapis.com",
  fetch(url: string | URL, init: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const u = new URL(typeof url === "string" ? url : url.toString());
      const headers: Record<string, string> = {};
      if (init?.headers) for (const [k, v] of init.headers) headers[k] = v as string;
      const req = httpRequest(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init?.method || "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const status = res.statusCode || 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              arrayBuffer: async () => buffer,
            });
          });
        },
      );
      req.on("error", reject);
      if (init?.body) req.write(init.body);
      req.end();
    });
  },
};

// The low-level gapic SecretManagerServiceClient needs the endpoint explicitly.
const CLIENT_OPTS = {
  projectId: PROJECT,
  fallback: true as const,
  protocol: "http" as const,
  apiEndpoint: "127.0.0.1",
  port: PORT,
  authClient: fakeAuthClient as any,
};

let SecretManagerServiceClient: any;

let server: GcpSecretmanagerServer;
let client: any;

function projectPath(): string {
  return `projects/${PROJECT}`;
}
function secretPath(id: string): string {
  return `projects/${PROJECT}/secrets/${id}`;
}
function versionPath(secretId: string, versionId: string): string {
  return `${secretPath(secretId)}/versions/${versionId}`;
}

// Raw HTTP helper for the internal endpoints + wire-level assertions.
function rawRequest(opts: {
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method: opts.method || "GET",
        path: opts.path,
        headers: opts.headers || {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function resetServer(): Promise<void> {
  await rawRequest({ method: "POST", path: "/_parlel/reset" });
}

async function createSecret(id: string, secret: Record<string, unknown> = {}): Promise<any> {
  const [s] = await client.createSecret({
    parent: projectPath(),
    secretId: id,
    secret: { replication: { automatic: {} }, ...secret },
  });
  return s;
}

async function addVersion(secretId: string, data: string | Buffer): Promise<any> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const [v] = await client.addSecretVersion({
    parent: secretPath(secretId),
    payload: { data: buf },
  });
  return v;
}

describe("GCP Secret Manager Service", () => {
  beforeAll(async () => {
    server = new GcpSecretmanagerServer(PORT, { projectId: PROJECT });
    await server.start();
    const mod: any = await import("@google-cloud/secret-manager");
    SecretManagerServiceClient = mod.v1.SecretManagerServiceClient;
    client = new SecretManagerServiceClient(CLIENT_OPTS);
    await new Promise((r) => setTimeout(r, 100));
  }, 20000);

  afterAll(async () => {
    if (client) await client.close();
    await server.stop();
  });

  beforeEach(async () => {
    await resetServer();
  });

  // -----------------------------------------------------------------------
  // Internal parlel endpoints
  // -----------------------------------------------------------------------
  describe("parlel internal endpoints", () => {
    it("health reports ok and counts", async () => {
      const res = await rawRequest({ path: "/_parlel/health" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("gcp-secretmanager");
      expect(body.secrets).toBe(0);
      expect(body.versions).toBe(0);
    });

    it("reset clears state", async () => {
      await createSecret("rs");
      await addVersion("rs", "v1");
      let health = JSON.parse((await rawRequest({ path: "/_parlel/health" })).body);
      expect(health.secrets).toBe(1);
      expect(health.versions).toBe(1);
      await resetServer();
      health = JSON.parse((await rawRequest({ path: "/_parlel/health" })).body);
      expect(health.secrets).toBe(0);
      expect(health.versions).toBe(0);
    });

    it("dump returns secrets and versions", async () => {
      await createSecret("ds");
      await addVersion("ds", "payload");
      const res = await rawRequest({ path: "/_parlel/dump" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.secrets).toHaveLength(1);
      expect(body.secrets[0].versions).toHaveLength(1);
    });

    it("unknown path returns 404", async () => {
      const res = await rawRequest({ path: "/nope" });
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // CreateSecret
  // -----------------------------------------------------------------------
  describe("CreateSecret", () => {
    it("creates a secret with automatic replication", async () => {
      const [s] = await client.createSecret({
        parent: projectPath(),
        secretId: "db-password",
        secret: { replication: { automatic: {} } },
      });
      expect(s.name).toBe(secretPath("db-password"));
      expect(s.replication.automatic).toBeTruthy();
      expect(s.createTime).toBeTruthy();
      expect(s.etag).toBeTruthy();
    });

    it("creates a secret with user-managed replication", async () => {
      const [s] = await client.createSecret({
        parent: projectPath(),
        secretId: "um-secret",
        secret: {
          replication: {
            userManaged: { replicas: [{ location: "us-central1" }, { location: "us-east1" }] },
          },
        },
      });
      expect(s.replication.userManaged.replicas).toHaveLength(2);
      expect(s.replication.userManaged.replicas[0].location).toBe("us-central1");
    });

    it("creates a secret with labels and annotations", async () => {
      const [s] = await client.createSecret({
        parent: projectPath(),
        secretId: "labeled",
        secret: {
          replication: { automatic: {} },
          labels: { env: "prod", team: "platform" },
          annotations: { owner: "parlel" },
        },
      });
      expect(s.labels.env).toBe("prod");
      expect(s.annotations.owner).toBe("parlel");
    });

    it("rejects duplicate secret id with ALREADY_EXISTS-style rejection", async () => {
      await createSecret("dup");
      await expect(createSecret("dup")).rejects.toBeTruthy();
    });

    it("rejects invalid secret id", async () => {
      await expect(
        client.createSecret({
          parent: projectPath(),
          secretId: "bad id with spaces!",
          secret: { replication: { automatic: {} } },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("defaults to automatic replication when omitted", async () => {
      const [s] = await client.createSecret({
        parent: projectPath(),
        secretId: "no-rep",
        secret: {},
      });
      expect(s.replication.automatic).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // GetSecret
  // -----------------------------------------------------------------------
  describe("GetSecret", () => {
    it("gets an existing secret", async () => {
      await createSecret("gs");
      const [s] = await client.getSecret({ name: secretPath("gs") });
      expect(s.name).toBe(secretPath("gs"));
    });

    it("404 for unknown secret", async () => {
      await expect(client.getSecret({ name: secretPath("missing") })).rejects.toMatchObject({
        code: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // ListSecrets
  // -----------------------------------------------------------------------
  describe("ListSecrets", () => {
    it("lists all secrets sorted by name", async () => {
      await createSecret("alpha");
      await createSecret("beta");
      await createSecret("gamma");
      const [secrets] = await client.listSecrets({ parent: projectPath() });
      expect(secrets.map((s: any) => s.name)).toEqual([
        secretPath("alpha"),
        secretPath("beta"),
        secretPath("gamma"),
      ]);
    });

    it("returns empty list when no secrets", async () => {
      const [secrets] = await client.listSecrets({ parent: projectPath() });
      expect(secrets).toHaveLength(0);
    });

    it("paginates with pageSize", async () => {
      for (let i = 0; i < 5; i += 1) await createSecret(`p${i}`);
      const iterable = client.listSecretsAsync({ parent: projectPath(), pageSize: 2 });
      const collected: any[] = [];
      for await (const s of iterable) collected.push(s);
      expect(collected).toHaveLength(5);
    });

    it("filters by name substring", async () => {
      await createSecret("prod-key");
      await createSecret("dev-key");
      const [secrets] = await client.listSecrets({
        parent: projectPath(),
        filter: "name:prod",
      });
      expect(secrets).toHaveLength(1);
      expect(secrets[0].name).toBe(secretPath("prod-key"));
    });
  });

  // -----------------------------------------------------------------------
  // UpdateSecret
  // -----------------------------------------------------------------------
  describe("UpdateSecret", () => {
    it("updates labels via update mask", async () => {
      await createSecret("upd", { labels: { a: "1" } });
      const [s] = await client.updateSecret({
        secret: { name: secretPath("upd"), labels: { a: "1", b: "2" } },
        updateMask: { paths: ["labels"] },
      });
      expect(s.labels.b).toBe("2");
    });

    it("requires an update mask", async () => {
      await createSecret("nomask");
      await expect(
        client.updateSecret({ secret: { name: secretPath("nomask"), labels: { x: "y" } } }),
      ).rejects.toBeTruthy();
    });

    it("rejects updating an immutable field", async () => {
      await createSecret("immutable");
      await expect(
        client.updateSecret({
          secret: { name: secretPath("immutable"), name2: "x" },
          updateMask: { paths: ["replication"] },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });

    it("404 when updating unknown secret", async () => {
      await expect(
        client.updateSecret({
          secret: { name: secretPath("ghost"), labels: { a: "1" } },
          updateMask: { paths: ["labels"] },
        }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // DeleteSecret
  // -----------------------------------------------------------------------
  describe("DeleteSecret", () => {
    it("deletes a secret", async () => {
      await createSecret("del");
      await client.deleteSecret({ name: secretPath("del") });
      await expect(client.getSecret({ name: secretPath("del") })).rejects.toMatchObject({
        code: 5,
      });
    });

    it("404 deleting unknown secret", async () => {
      await expect(client.deleteSecret({ name: secretPath("nope") })).rejects.toMatchObject({
        code: 5,
      });
    });
  });

  // -----------------------------------------------------------------------
  // AddSecretVersion
  // -----------------------------------------------------------------------
  describe("AddSecretVersion", () => {
    it("adds a version and assigns incrementing ids", async () => {
      await createSecret("av");
      const v1 = await addVersion("av", "first");
      const v2 = await addVersion("av", "second");
      expect(v1.name).toBe(versionPath("av", "1"));
      expect(v2.name).toBe(versionPath("av", "2"));
      expect(v1.state).toBe("ENABLED");
    });

    it("404 adding version to unknown secret", async () => {
      await expect(
        client.addSecretVersion({
          parent: secretPath("ghost"),
          payload: { data: Buffer.from("x") },
        }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("accepts a valid client-supplied crc32c checksum", async () => {
      await createSecret("crc-ok");
      const data = Buffer.from("checksum-me", "utf8");
      const [v] = await client.addSecretVersion({
        parent: secretPath("crc-ok"),
        payload: { data, dataCrc32c: crc32c(data) },
      });
      expect(v.clientSpecifiedPayloadChecksum).toBe(true);
    });

    it("rejects a corrupted crc32c checksum", async () => {
      await createSecret("crc-bad");
      const data = Buffer.from("checksum-me", "utf8");
      await expect(
        client.addSecretVersion({
          parent: secretPath("crc-bad"),
          payload: { data, dataCrc32c: crc32c(data) + 1 },
        }),
      ).rejects.toMatchObject({ code: 3 });
    });
  });

  // -----------------------------------------------------------------------
  // GetSecretVersion
  // -----------------------------------------------------------------------
  describe("GetSecretVersion", () => {
    it("gets a version by id", async () => {
      await createSecret("gv");
      await addVersion("gv", "data");
      const [v] = await client.getSecretVersion({ name: versionPath("gv", "1") });
      expect(v.name).toBe(versionPath("gv", "1"));
      expect(v.state).toBe("ENABLED");
    });

    it("resolves the 'latest' alias", async () => {
      await createSecret("gvl");
      await addVersion("gvl", "one");
      await addVersion("gvl", "two");
      const [v] = await client.getSecretVersion({ name: versionPath("gvl", "latest") });
      expect(v.name).toBe(versionPath("gvl", "2"));
    });

    it("404 for unknown version", async () => {
      await createSecret("gvx");
      await expect(
        client.getSecretVersion({ name: versionPath("gvx", "99") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // ListSecretVersions
  // -----------------------------------------------------------------------
  describe("ListSecretVersions", () => {
    it("lists versions newest-first", async () => {
      await createSecret("lv");
      await addVersion("lv", "a");
      await addVersion("lv", "b");
      await addVersion("lv", "c");
      const [versions] = await client.listSecretVersions({ parent: secretPath("lv") });
      expect(versions.map((v: any) => v.name)).toEqual([
        versionPath("lv", "3"),
        versionPath("lv", "2"),
        versionPath("lv", "1"),
      ]);
    });

    it("404 listing versions of unknown secret", async () => {
      await expect(
        client.listSecretVersions({ parent: secretPath("nosecret") }),
      ).rejects.toMatchObject({ code: 5 });
    });

    it("paginates versions", async () => {
      await createSecret("lvp");
      for (let i = 0; i < 4; i += 1) await addVersion("lvp", `d${i}`);
      const collected: any[] = [];
      for await (const v of client.listSecretVersionsAsync({
        parent: secretPath("lvp"),
        pageSize: 2,
      })) {
        collected.push(v);
      }
      expect(collected).toHaveLength(4);
    });
  });

  // -----------------------------------------------------------------------
  // AccessSecretVersion
  // -----------------------------------------------------------------------
  describe("AccessSecretVersion", () => {
    it("returns the stored payload data", async () => {
      await createSecret("acc");
      await addVersion("acc", "super-secret-value");
      const [resp] = await client.accessSecretVersion({ name: versionPath("acc", "1") });
      expect(resp.name).toBe(versionPath("acc", "1"));
      expect(Buffer.from(resp.payload.data).toString("utf8")).toBe("super-secret-value");
    });

    it("returns the payload crc32c", async () => {
      await createSecret("acccrc");
      const data = Buffer.from("crc-payload", "utf8");
      await addVersion("acccrc", data);
      const [resp] = await client.accessSecretVersion({ name: versionPath("acccrc", "1") });
      expect(String(resp.payload.dataCrc32c)).toBe(String(crc32c(data)));
    });

    it("accesses the 'latest' version", async () => {
      await createSecret("acclatest");
      await addVersion("acclatest", "old");
      await addVersion("acclatest", "new");
      const [resp] = await client.accessSecretVersion({
        name: versionPath("acclatest", "latest"),
      });
      expect(Buffer.from(resp.payload.data).toString("utf8")).toBe("new");
    });

    it("preserves binary payloads exactly", async () => {
      await createSecret("accbin");
      const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
      await addVersion("accbin", bin);
      const [resp] = await client.accessSecretVersion({ name: versionPath("accbin", "1") });
      expect(Buffer.from(resp.payload.data).equals(bin)).toBe(true);
    });

    it("FAILED_PRECONDITION accessing a disabled version", async () => {
      await createSecret("accdis");
      await addVersion("accdis", "v");
      await client.disableSecretVersion({ name: versionPath("accdis", "1") });
      await expect(
        client.accessSecretVersion({ name: versionPath("accdis", "1") }),
      ).rejects.toMatchObject({ code: 9 });
    });
  });

  // -----------------------------------------------------------------------
  // Enable / Disable / Destroy
  // -----------------------------------------------------------------------
  describe("DisableSecretVersion / EnableSecretVersion", () => {
    it("disables then re-enables a version", async () => {
      await createSecret("ed");
      await addVersion("ed", "v");
      const [disabled] = await client.disableSecretVersion({ name: versionPath("ed", "1") });
      expect(disabled.state).toBe("DISABLED");
      const [enabled] = await client.enableSecretVersion({ name: versionPath("ed", "1") });
      expect(enabled.state).toBe("ENABLED");
    });

    it("404 disabling unknown version", async () => {
      await createSecret("edx");
      await expect(
        client.disableSecretVersion({ name: versionPath("edx", "5") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  describe("DestroySecretVersion", () => {
    it("destroys a version and clears the payload", async () => {
      await createSecret("dv");
      await addVersion("dv", "doomed");
      const [destroyed] = await client.destroySecretVersion({ name: versionPath("dv", "1") });
      expect(destroyed.state).toBe("DESTROYED");
      expect(destroyed.destroyTime).toBeTruthy();
      await expect(
        client.accessSecretVersion({ name: versionPath("dv", "1") }),
      ).rejects.toMatchObject({ code: 9 });
    });

    it("rejects destroying an already-destroyed version", async () => {
      await createSecret("dv2");
      await addVersion("dv2", "x");
      await client.destroySecretVersion({ name: versionPath("dv2", "1") });
      await expect(
        client.destroySecretVersion({ name: versionPath("dv2", "1") }),
      ).rejects.toMatchObject({ code: 9 });
    });

    it("'latest' skips destroyed versions", async () => {
      await createSecret("dvl");
      await addVersion("dvl", "one");
      await addVersion("dvl", "two");
      await client.destroySecretVersion({ name: versionPath("dvl", "2") });
      const [resp] = await client.accessSecretVersion({ name: versionPath("dvl", "latest") });
      expect(Buffer.from(resp.payload.data).toString("utf8")).toBe("one");
    });
  });

  // -----------------------------------------------------------------------
  // IAM
  // -----------------------------------------------------------------------
  describe("IAM policies", () => {
    it("returns a default empty policy", async () => {
      await createSecret("iam1");
      const [policy] = await client.getIamPolicy({ resource: secretPath("iam1") });
      expect(policy.bindings).toEqual([]);
      expect(policy.version).toBe(1);
    });

    it("sets and gets a policy", async () => {
      await createSecret("iam2");
      const bindings = [
        { role: "roles/secretmanager.secretAccessor", members: ["user:dev@parlel.dev"] },
      ];
      const [set] = await client.setIamPolicy({
        resource: secretPath("iam2"),
        policy: { bindings },
      });
      expect(set.bindings[0].role).toBe("roles/secretmanager.secretAccessor");
      const [got] = await client.getIamPolicy({ resource: secretPath("iam2") });
      expect(got.bindings[0].members).toEqual(["user:dev@parlel.dev"]);
    });

    it("testIamPermissions grants requested permissions", async () => {
      await createSecret("iam3");
      const [resp] = await client.testIamPermissions({
        resource: secretPath("iam3"),
        permissions: ["secretmanager.versions.access", "secretmanager.secrets.get"],
      });
      expect(resp.permissions).toEqual([
        "secretmanager.versions.access",
        "secretmanager.secrets.get",
      ]);
    });

    it("404 getting policy on unknown secret", async () => {
      await expect(
        client.getIamPolicy({ resource: secretPath("nopolicy") }),
      ).rejects.toMatchObject({ code: 5 });
    });
  });

  // -----------------------------------------------------------------------
  // Regional binding (projects/*/locations/*) resolves to the same store
  // -----------------------------------------------------------------------
  describe("regional resource bindings", () => {
    it("a global secret is reachable via its regional name", async () => {
      await createSecret("regional");
      await addVersion("regional", "regional-value");
      const regionalVersion = `projects/${PROJECT}/locations/us-central1/secrets/regional/versions/1`;
      const [resp] = await client.accessSecretVersion({ name: regionalVersion });
      expect(Buffer.from(resp.payload.data).toString("utf8")).toBe("regional-value");
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end lifecycle
  // -----------------------------------------------------------------------
  describe("end-to-end lifecycle", () => {
    it("create -> add -> access -> rotate -> destroy", async () => {
      await createSecret("api-key");
      await addVersion("api-key", "key-v1");
      let [resp] = await client.accessSecretVersion({ name: versionPath("api-key", "latest") });
      expect(Buffer.from(resp.payload.data).toString()).toBe("key-v1");

      // Rotate: add a new version; latest now points to it.
      await addVersion("api-key", "key-v2");
      [resp] = await client.accessSecretVersion({ name: versionPath("api-key", "latest") });
      expect(Buffer.from(resp.payload.data).toString()).toBe("key-v2");

      // Disable old version, then destroy it.
      await client.disableSecretVersion({ name: versionPath("api-key", "1") });
      await client.destroySecretVersion({ name: versionPath("api-key", "1") });
      const [v1] = await client.getSecretVersion({ name: versionPath("api-key", "1") });
      expect(v1.state).toBe("DESTROYED");

      // List shows both versions.
      const [versions] = await client.listSecretVersions({ parent: secretPath("api-key") });
      expect(versions).toHaveLength(2);
    });
  });
});
