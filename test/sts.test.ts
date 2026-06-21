import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { StsServer } from "../services/sts/src/server.js";

const PORT = 14729;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(action: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams({ Action: action, Version: "2011-06-15", ...params });
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : undefined;
}

describe("STS Service", () => {
  let server: StsServer;

  beforeAll(async () => {
    server = new StsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => server.reset());

  it("uses default port 4729", () => {
    expect(new StsServer().port).toBe(4729);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    const json = await res.json();
    expect(json.service).toBe("sts");
  });

  it("GetCallerIdentity returns account/arn/userid", async () => {
    const { status, text } = await call("GetCallerIdentity");
    expect(status).toBe(200);
    expect(pick(text, "Account")).toBe("000000000000");
    expect(text).toContain("<Arn>");
    expect(text).toContain("<UserId>");
  });

  it("AssumeRole returns credentials and assumed role user", async () => {
    const { status, text } = await call("AssumeRole", {
      RoleArn: "arn:aws:iam::000000000000:role/my-role",
      RoleSessionName: "sess1",
    });
    expect(status).toBe(200);
    expect(pick(text, "AccessKeyId")?.startsWith("ASIA")).toBe(true);
    expect(text).toContain("<SecretAccessKey>");
    expect(text).toContain("<SessionToken>");
    expect(text).toContain("assumed-role/my-role/sess1");
  });

  it("AssumeRole requires RoleArn", async () => {
    const { status, text } = await call("AssumeRole", { RoleSessionName: "s" });
    expect(status).toBe(400);
    expect(text).toContain("ValidationError");
  });

  it("GetSessionToken returns credentials", async () => {
    const { text } = await call("GetSessionToken");
    expect(pick(text, "AccessKeyId")?.startsWith("ASIA")).toBe(true);
    expect(text).toContain("<Expiration>");
  });

  it("AssumeRoleWithWebIdentity returns credentials", async () => {
    const { status, text } = await call("AssumeRoleWithWebIdentity", {
      RoleArn: "arn:aws:iam::000000000000:role/web",
      RoleSessionName: "web1",
      WebIdentityToken: "ey.token.sig",
    });
    expect(status).toBe(200);
    expect(text).toContain("assumed-role/web/web1");
    expect(text).toContain("SubjectFromWebIdentityToken");
  });

  it("GetFederationToken returns federated user", async () => {
    const { status, text } = await call("GetFederationToken", { Name: "fed" });
    expect(status).toBe(200);
    expect(text).toContain("federated-user/fed");
  });

  it("DecodeAuthorizationMessage returns a decoded message", async () => {
    const { status, text } = await call("DecodeAuthorizationMessage", { EncodedMessage: "abc123" });
    expect(status).toBe(200);
    expect(text).toContain("DecodedMessage");
  });

  it("rejects unknown actions", async () => {
    const { status, text } = await call("BogusAction");
    expect(status).toBe(400);
    expect(text).toContain("ValidationError");
  });
});
