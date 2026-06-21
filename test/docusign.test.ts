import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DocusignServer } from "../services/docusign/src/server.js";

const PORT = 14814;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ACCOUNT = "parlel-account";
const AUTH = { Authorization: `Bearer parlelTestToken` };
const PREFIX = `/restapi/v2.1/accounts/${ACCOUNT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

function envelopeDef(): Json {
  return {
    emailSubject: "Please sign",
    status: "sent",
    documents: [{ documentId: "1", name: "contract.pdf", documentBase64: "JVBERi0=" }],
    recipients: {
      signers: [{ email: "signer@parlel.dev", name: "Signer One", recipientId: "1", routingOrder: "1" }],
    },
  };
}

describe("Docusign Service", () => {
  let server: DocusignServer;

  beforeAll(async () => {
    server = new DocusignServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("docusign");
      expect(health.body).toEqual({ status: "ok" });
    });

    it("supports CORS preflight", async () => {
      const response = await fetch(`${BASE_URL}${PREFIX}/envelopes`, { method: "OPTIONS" });
      expect(response.status).toBe(204);
    });
  });

  describe("Authentication", () => {
    it("rejects missing bearer token", async () => {
      const response = await fetch(`${BASE_URL}${PREFIX}/envelopes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelopeDef()),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("Envelopes", () => {
    it("creates an envelope and returns the summary shape", async () => {
      const result = await api("POST", `${PREFIX}/envelopes`, envelopeDef());
      expect(result.status).toBe(201);
      expect(result.body.envelopeId).toBeTruthy();
      expect(result.body.status).toBe("sent");
      expect(result.body.statusDateTime).toBeTruthy();
      expect(result.body.uri).toContain("/envelopes/");
    });

    it("retrieves an envelope by id", async () => {
      const created = await api("POST", `${PREFIX}/envelopes`, envelopeDef());
      const id = created.body.envelopeId;
      const got = await api("GET", `${PREFIX}/envelopes/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.envelopeId).toBe(id);
      expect(got.body.emailSubject).toBe("Please sign");
    });

    it("returns 404 for an unknown envelope", async () => {
      const result = await api("GET", `${PREFIX}/envelopes/does-not-exist`);
      expect(result.status).toBe(404);
    });

    it("lists recipients", async () => {
      const created = await api("POST", `${PREFIX}/envelopes`, envelopeDef());
      const id = created.body.envelopeId;
      const recipients = await api("GET", `${PREFIX}/envelopes/${id}/recipients`);
      expect(recipients.status).toBe(200);
      expect(recipients.body.signers.length).toBe(1);
      expect(recipients.body.signers[0].email).toBe("signer@parlel.dev");
    });

    it("updates envelope status (void) via PUT", async () => {
      const created = await api("POST", `${PREFIX}/envelopes`, envelopeDef());
      const id = created.body.envelopeId;
      const voided = await api("PUT", `${PREFIX}/envelopes/${id}`, { status: "voided", voidedReason: "test" });
      expect(voided.status).toBe(200);
      expect(voided.body.status).toBe("voided");
      const got = await api("GET", `${PREFIX}/envelopes/${id}`);
      expect(got.body.status).toBe("voided");
    });

    it("creates a draft envelope when status=created", async () => {
      const def = { ...envelopeDef(), status: "created" };
      const result = await api("POST", `${PREFIX}/envelopes`, def);
      expect(result.body.status).toBe("created");
    });
  });

  describe("Control endpoints", () => {
    it("resets state", async () => {
      await api("POST", `${PREFIX}/envelopes`, envelopeDef());
      await api("POST", "/__parlel/reset");
      const after = await api("GET", "/__parlel/envelopes");
      expect(after.body.count).toBe(0);
    });
  });
});
