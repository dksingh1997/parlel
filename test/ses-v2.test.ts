import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SesV2Server } from "../services/ses-v2/src/server.js";

const PORT = 14746;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json };
}

let server: SesV2Server;

beforeAll(async () => {
  server = new SesV2Server(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

describe("ses-v2", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("ses-v2");
  });

  it("default port 4746", () => {
    expect(new SesV2Server().port).toBe(4746);
  });

  it("sends a simple email and captures it", async () => {
    const res = await call("POST", "/v2/email/outbound-emails", {
      FromEmailAddress: "from@example.com",
      Destination: { ToAddresses: ["to@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Hi" },
          Body: { Text: { Data: "Hello there" } },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.MessageId).toBeTruthy();

    const sent = await call("GET", "/_parlel/sent");
    expect(sent.json.sent.length).toBe(1);
    expect(sent.json.sent[0].Subject).toBe("Hi");
    expect(sent.json.sent[0].Body).toBe("Hello there");
  });

  it("sends a raw email", async () => {
    const raw = Buffer.from("Subject: Raw\r\n\r\nbody").toString("base64");
    const res = await call("POST", "/v2/email/outbound-emails", {
      FromEmailAddress: "from@example.com",
      Destination: { ToAddresses: ["to@example.com"] },
      Content: { Raw: { Data: raw } },
    });
    expect(res.status).toBe(200);
    const sent = await call("GET", "/_parlel/sent");
    expect(sent.json.sent[0].RawData).toBe(raw);
  });

  it("rejects email without content", async () => {
    const res = await call("POST", "/v2/email/outbound-emails", {
      FromEmailAddress: "from@example.com",
      Destination: { ToAddresses: ["to@example.com"] },
      Content: {},
    });
    expect(res.status).toBe(400);
  });

  it("creates and gets an email identity", async () => {
    const c = await call("POST", "/v2/email/identities", { EmailIdentity: "me@example.com" });
    expect(c.status).toBe(200);
    expect(c.json.IdentityType).toBe("EMAIL_ADDRESS");
    const g = await call("GET", "/v2/email/identities/me@example.com");
    expect(g.status).toBe(200);
    expect(g.json.VerifiedForSendingStatus).toBe(true);
  });

  it("creates a domain identity with DKIM tokens", async () => {
    const c = await call("POST", "/v2/email/identities", { EmailIdentity: "example.com" });
    expect(c.json.IdentityType).toBe("DOMAIN");
    expect(c.json.DkimAttributes.Tokens.length).toBeGreaterThan(0);
  });

  it("lists and deletes email identities", async () => {
    await call("POST", "/v2/email/identities", { EmailIdentity: "a@example.com" });
    await call("POST", "/v2/email/identities", { EmailIdentity: "b@example.com" });
    const list = await call("GET", "/v2/email/identities");
    expect(list.json.EmailIdentities.length).toBe(2);
    const del = await call("DELETE", "/v2/email/identities/a@example.com");
    expect(del.status).toBe(200);
    const list2 = await call("GET", "/v2/email/identities");
    expect(list2.json.EmailIdentities.length).toBe(1);
  });

  it("manages suppression list", async () => {
    const put = await call("PUT", "/v2/email/suppression/addresses/bounce@example.com", {
      Reason: "BOUNCE",
    });
    expect(put.status).toBe(200);
    const get = await call("GET", "/v2/email/suppression/addresses/bounce@example.com");
    expect(get.status).toBe(200);
    expect(get.json.SuppressedDestination.Reason).toBe("BOUNCE");

    const list = await call("GET", "/v2/email/suppression/addresses");
    expect(list.json.SuppressedDestinationSummaries.length).toBe(1);

    const del = await call("DELETE", "/v2/email/suppression/addresses/bounce@example.com");
    expect(del.status).toBe(200);
    const get2 = await call("GET", "/v2/email/suppression/addresses/bounce@example.com");
    expect(get2.status).toBe(404);
  });

  it("404 on missing identity", async () => {
    const g = await call("GET", "/v2/email/identities/nobody@example.com");
    expect(g.status).toBe(404);
  });
});
