import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CognitoServer } from "../services/cognito/src/server.js";

const PORT = 14732;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function idp(op: string, body: Record<string, unknown> = {}) {
  return call("AWSCognitoIdentityProviderService", op, body);
}
async function identity(op: string, body: Record<string, unknown> = {}) {
  return call("AWSCognitoIdentityService", op, body);
}
async function call(service: string, op: string, body: Record<string, unknown>) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${service}.${op}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe("Cognito Service", () => {
  let server: CognitoServer;

  beforeAll(async () => {
    server = new CognitoServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => server.stop());
  beforeEach(() => server.reset());

  it("uses default port 4732", () => {
    expect(new CognitoServer().port).toBe(4732);
  });

  it("exposes health", async () => {
    const res = await fetch(`${ENDPOINT}/_parlel/health`);
    expect((await res.json()).service).toBe("cognito");
  });

  it("creates and describes a user pool", async () => {
    const c = await idp("CreateUserPool", { PoolName: "mypool" });
    expect(c.status).toBe(200);
    const poolId = c.json.UserPool.Id;
    const d = await idp("DescribeUserPool", { UserPoolId: poolId });
    expect(d.json.UserPool.Name).toBe("mypool");
    const l = await idp("ListUserPools", { MaxResults: 10 });
    expect(l.json.UserPools.length).toBe(1);
  });

  it("creates a user pool client", async () => {
    const c = await idp("CreateUserPool", { PoolName: "p" });
    const poolId = c.json.UserPool.Id;
    const cl = await idp("CreateUserPoolClient", { UserPoolId: poolId, ClientName: "web" });
    expect(cl.json.UserPoolClient.ClientId).toBeTruthy();
  });

  it("signs up, authenticates, and returns JWT tokens", async () => {
    const c = await idp("CreateUserPool", { PoolName: "auth" });
    const poolId = c.json.UserPool.Id;
    const cl = await idp("CreateUserPoolClient", { UserPoolId: poolId, ClientName: "app" });
    const clientId = cl.json.UserPoolClient.ClientId;

    const su = await idp("SignUp", {
      ClientId: clientId,
      Username: "bob",
      Password: "Passw0rd!",
      UserAttributes: [{ Name: "email", Value: "bob@example.com" }],
    });
    expect(su.json.UserSub).toBeTruthy();

    const auth = await idp("InitiateAuth", {
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "bob", PASSWORD: "Passw0rd!" },
    });
    expect(auth.status).toBe(200);
    const idToken = auth.json.AuthenticationResult.IdToken;
    expect(idToken.split(".").length).toBe(3);
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString());
    expect(payload["cognito:username"]).toBe("bob");
    expect(payload.token_use).toBe("id");
  });

  it("rejects wrong password", async () => {
    const c = await idp("CreateUserPool", { PoolName: "auth2" });
    const poolId = c.json.UserPool.Id;
    const cl = await idp("CreateUserPoolClient", { UserPoolId: poolId, ClientName: "app" });
    const clientId = cl.json.UserPoolClient.ClientId;
    await idp("SignUp", { ClientId: clientId, Username: "carl", Password: "Right1!", UserAttributes: [] });
    const auth = await idp("InitiateAuth", {
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "carl", PASSWORD: "Wrong1!" },
    });
    expect(auth.status).toBe(400);
    expect(auth.json.__type).toBe("NotAuthorizedException");
  });

  it("admin-creates a user and GetUser works via access token", async () => {
    const c = await idp("CreateUserPool", { PoolName: "admin" });
    const poolId = c.json.UserPool.Id;
    const cl = await idp("CreateUserPoolClient", { UserPoolId: poolId, ClientName: "app" });
    const clientId = cl.json.UserPoolClient.ClientId;
    await idp("AdminCreateUser", {
      UserPoolId: poolId,
      Username: "admin-user",
      TemporaryPassword: "Temp1234!",
      UserAttributes: [{ Name: "email", Value: "a@a.com" }],
    });
    const auth = await idp("AdminInitiateAuth", {
      UserPoolId: poolId,
      ClientId: clientId,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: "admin-user", PASSWORD: "Temp1234!" },
    });
    const at = auth.json.AuthenticationResult.AccessToken;
    const gu = await idp("GetUser", { AccessToken: at });
    expect(gu.json.Username).toBe("admin-user");
  });

  it("serves JWKS and OIDC discovery", async () => {
    const c = await idp("CreateUserPool", { PoolName: "oidc" });
    const poolId = c.json.UserPool.Id;
    const jwks = await (await fetch(`${ENDPOINT}/${poolId}/.well-known/jwks.json`)).json();
    expect(jwks.keys[0].kty).toBe("RSA");
    expect(jwks.keys[0].alg).toBe("RS256");
    const oidc = await (await fetch(`${ENDPOINT}/${poolId}/.well-known/openid-configuration`)).json();
    expect(oidc.jwks_uri).toContain("jwks.json");
  });

  it("supports identity pools and credentials", async () => {
    const c = await identity("CreateIdentityPool", {
      IdentityPoolName: "idp",
      AllowUnauthenticatedIdentities: true,
    });
    const ipid = c.json.IdentityPoolId;
    expect(ipid).toBeTruthy();
    const gid = await identity("GetId", { IdentityPoolId: ipid });
    expect(gid.json.IdentityId).toBeTruthy();
    const creds = await identity("GetCredentialsForIdentity", { IdentityId: gid.json.IdentityId });
    expect(creds.json.Credentials.AccessKeyId).toContain("ASIA");
  });

  it("deletes a user pool", async () => {
    const c = await idp("CreateUserPool", { PoolName: "del" });
    const poolId = c.json.UserPool.Id;
    await idp("DeleteUserPool", { UserPoolId: poolId });
    const d = await idp("DescribeUserPool", { UserPoolId: poolId });
    expect(d.status).toBe(400);
  });
});
