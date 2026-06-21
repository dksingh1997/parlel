import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ImdsServer } from "../services/imds/src/server.js";

const PORT = 14719;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${ENDPOINT}${path}`, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, text };
}

describe("IMDS Service", () => {
  let server: ImdsServer;

  beforeAll(async () => {
    server = new ImdsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses default port 4719", () => {
      const s = new ImdsServer();
      expect(s.port).toBe(4719);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("imds");
    });

    it("supports POST /_parlel/reset", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });

  describe("IMDSv1 metadata", () => {
    it("lists meta-data keys", async () => {
      const res = await get("/latest/meta-data/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("instance-id");
      expect(res.text).toContain("placement/");
    });

    it("returns the instance id", async () => {
      const res = await get("/latest/meta-data/instance-id");
      expect(res.status).toBe(200);
      expect(res.text).toBe("i-1234567890abcdef0");
    });

    it("returns local ipv4", async () => {
      const res = await get("/latest/meta-data/local-ipv4");
      expect(res.text).toBe("172.16.0.10");
    });

    it("returns the placement region", async () => {
      const res = await get("/latest/meta-data/placement/region");
      expect(res.text).toBe("us-east-1");
    });

    it("returns 404 for unknown metadata", async () => {
      const res = await get("/latest/meta-data/does-not-exist");
      expect(res.status).toBe(404);
    });
  });

  describe("IAM security credentials", () => {
    it("lists role names", async () => {
      const res = await get("/latest/meta-data/iam/security-credentials/");
      expect(res.status).toBe(200);
      expect(res.text).toContain("parlel-role");
    });

    it("returns a credentials document for a role", async () => {
      const res = await get("/latest/meta-data/iam/security-credentials/parlel-role");
      expect(res.status).toBe(200);
      const creds = JSON.parse(res.text);
      expect(creds.Code).toBe("Success");
      expect(creds.AccessKeyId).toBeTruthy();
      expect(creds.SecretAccessKey).toBeTruthy();
      expect(creds.Token).toBeTruthy();
      expect(creds.Expiration).toBeTruthy();
    });

    it("returns 404 for an unknown role", async () => {
      const res = await get("/latest/meta-data/iam/security-credentials/ghost-role");
      expect(res.status).toBe(404);
    });
  });

  describe("IMDSv2 token flow", () => {
    it("issues a token and authorizes metadata GETs", async () => {
      const tokenRes = await fetch(`${ENDPOINT}/latest/api/token`, {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
      });
      expect(tokenRes.status).toBe(200);
      const token = await tokenRes.text();
      expect(token.length).toBeGreaterThan(10);

      const res = await get("/latest/meta-data/instance-id", {
        "X-aws-ec2-metadata-token": token,
      });
      expect(res.status).toBe(200);
      expect(res.text).toBe("i-1234567890abcdef0");
    });

    it("rejects token PUT without TTL header", async () => {
      const tokenRes = await fetch(`${ENDPOINT}/latest/api/token`, { method: "PUT" });
      expect(tokenRes.status).toBe(400);
    });

    it("rejects metadata GETs with an invalid token", async () => {
      const res = await get("/latest/meta-data/instance-id", {
        "X-aws-ec2-metadata-token": "not-a-real-token",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("instance identity document", () => {
    it("returns the dynamic identity document", async () => {
      const res = await get("/latest/dynamic/instance-identity/document");
      expect(res.status).toBe(200);
      const doc = JSON.parse(res.text);
      expect(doc.accountId).toBe("000000000000");
      expect(doc.region).toBe("us-east-1");
      expect(doc.instanceId).toBe("i-1234567890abcdef0");
    });
  });
});
