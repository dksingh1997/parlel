// parlel/cognito — a lightweight, dependency-free fake of AWS Cognito.
//
// Speaks AWS JSON 1.1 for both:
//   * Cognito Identity Provider (X-Amz-Target: AWSCognitoIdentityProviderService.<Op>)
//   * Cognito Identity (X-Amz-Target: AWSCognitoIdentityService.<Op>)
// Also exposes OIDC discovery + JWKS at:
//   GET /<userPoolId>/.well-known/jwks.json
//   GET /<userPoolId>/.well-known/openid-configuration
// Tokens are real JWT-shaped values signed with an RSA key (node:crypto).

import { createServer } from "node:http";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  createSign,
} from "node:crypto";

const JSON_CONTENT_TYPE = "application/x-amz-json-1.1";
const DEFAULT_ACCOUNT_ID = "000000000000";

const ERROR_STATUS = {
  ResourceNotFoundException: 400,
  UserNotFoundException: 400,
  UsernameExistsException: 400,
  NotAuthorizedException: 400,
  InvalidParameterException: 400,
  InvalidPasswordException: 400,
  UserNotConfirmedException: 400,
  CodeMismatchException: 400,
  TooManyRequestsException: 429,
  InternalErrorException: 500,
};

class CognitoError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || ERROR_STATUS[code] || 400;
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class CognitoServer {
  constructor(port = 4732, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.region = options.region || "us-east-1";
    this.accountId = options.accountId || DEFAULT_ACCOUNT_ID;
    this.server = null;
    // Persistent RSA signing key for JWTs / JWKS.
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.kid = randomUUID();
    this.reset();
  }

  reset() {
    this.userPools = new Map(); // poolId -> pool
    this.identityPools = new Map(); // identityPoolId -> idPool
    this.identities = new Map(); // identityId -> { identityPoolId }
    this.poolCounter = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.sendError(res, new CognitoError("InternalErrorException", error.message, 500));
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  requestId() {
    return randomUUID();
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || this.host}`);
    const method = req.method || "GET";

    if (url.pathname === "/_parlel/health") {
      return this.sendJson(res, 200, { status: "ok", service: "cognito", userPools: this.userPools.size });
    }
    if (url.pathname === "/_parlel/reset" && method === "POST") {
      this.reset();
      return this.sendJson(res, 200, { ok: true });
    }

    // JWKS / OIDC discovery endpoints: GET /<poolId>/.well-known/...
    if (method === "GET" && url.pathname.includes("/.well-known/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const poolId = parts[0];
      if (url.pathname.endsWith("jwks.json")) {
        return this.sendJson(res, 200, this.jwks());
      }
      if (url.pathname.endsWith("openid-configuration")) {
        const issuer = `http://${this.host}:${this.port}/${poolId}`;
        return this.sendJson(res, 200, {
          issuer,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          userinfo_endpoint: `${issuer}/oauth2/userInfo`,
          response_types_supported: ["code", "token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "email", "profile"],
        });
      }
    }

    res.setHeader("x-amzn-RequestId", this.requestId());
    res.setHeader("Server", "parlel-cognito");

    if (method !== "POST") {
      return this.sendError(res, new CognitoError("InvalidParameterException", "Only POST is supported.", 405));
    }

    const body = await this.readBody(req);
    const target = (req.headers["x-amz-target"] || "").toString();
    const service = target.split(".")[0];
    const operation = target.includes(".") ? target.split(".").pop() : target;

    let input;
    try {
      input = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return this.sendError(res, new CognitoError("InvalidParameterException", "Request body is not valid JSON.", 400));
    }

    try {
      const output =
        service === "AWSCognitoIdentityService"
          ? this.dispatchIdentity(operation, input)
          : this.dispatchIdp(operation, input);
      return this.sendJson(res, 200, output ?? {});
    } catch (error) {
      if (error instanceof CognitoError) return this.sendError(res, error);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // JWKS / JWT
  // -------------------------------------------------------------------------
  jwks() {
    const jwk = this.publicKey.export({ format: "jwk" });
    return {
      keys: [
        {
          kid: this.kid,
          alg: "RS256",
          kty: "RSA",
          use: "sig",
          n: jwk.n,
          e: jwk.e,
        },
      ],
    };
  }

  signJwt(claims) {
    const header = { alg: "RS256", kid: this.kid, typ: "JWT" };
    const encHeader = base64url(JSON.stringify(header));
    const encPayload = base64url(JSON.stringify(claims));
    const signingInput = `${encHeader}.${encPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const signature = base64url(signer.sign(this.privateKey));
    return `${signingInput}.${signature}`;
  }

  issueTokens(pool, user, clientId) {
    const now = Math.floor(Date.now() / 1000);
    const issuer = `http://${this.host}:${this.port}/${pool.Id}`;
    const sub = user.sub;
    const idToken = this.signJwt({
      sub,
      aud: clientId,
      iss: issuer,
      "cognito:username": user.Username,
      email: user.attributes.email,
      token_use: "id",
      auth_time: now,
      iat: now,
      exp: now + 3600,
    });
    const accessToken = this.signJwt({
      sub,
      iss: issuer,
      client_id: clientId,
      username: user.Username,
      token_use: "access",
      scope: "aws.cognito.signin.user.admin",
      auth_time: now,
      iat: now,
      exp: now + 3600,
    });
    return {
      AccessToken: accessToken,
      IdToken: idToken,
      RefreshToken: base64url(randomBytes(64)),
      ExpiresIn: 3600,
      TokenType: "Bearer",
    };
  }

  // -------------------------------------------------------------------------
  // Identity Provider
  // -------------------------------------------------------------------------
  dispatchIdp(operation, input) {
    switch (operation) {
      case "CreateUserPool": return this.createUserPool(input);
      case "ListUserPools": return this.listUserPools(input);
      case "DescribeUserPool": return this.describeUserPool(input);
      case "DeleteUserPool": return this.deleteUserPool(input);
      case "CreateUserPoolClient": return this.createUserPoolClient(input);
      case "DescribeUserPoolClient": return this.describeUserPoolClient(input);
      case "ListUserPoolClients": return this.listUserPoolClients(input);
      case "AdminCreateUser": return this.adminCreateUser(input);
      case "SignUp": return this.signUp(input);
      case "ConfirmSignUp": return this.confirmSignUp(input);
      case "AdminInitiateAuth": return this.initiateAuth(input, true);
      case "InitiateAuth": return this.initiateAuth(input, false);
      case "GetUser": return this.getUser(input);
      case "AdminGetUser": return this.adminGetUser(input);
      case "ListUsers": return this.listUsers(input);
      default:
        throw new CognitoError("InvalidParameterException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  createUserPool(input) {
    const name = input.PoolName;
    if (!name) throw new CognitoError("InvalidParameterException", "PoolName is required.");
    this.poolCounter += 1;
    const id = `${this.region}_${randomBytes(5).toString("hex")}`;
    const pool = {
      Id: id,
      Name: name,
      Arn: `arn:aws:cognito-idp:${this.region}:${this.accountId}:userpool/${id}`,
      CreationDate: Date.now(),
      Policies: input.Policies || { PasswordPolicy: { MinimumLength: 8 } },
      MfaConfiguration: input.MfaConfiguration || "OFF",
      clients: new Map(),
      users: new Map(),
      AutoVerifiedAttributes: input.AutoVerifiedAttributes || [],
    };
    this.userPools.set(id, pool);
    return { UserPool: this.poolView(pool) };
  }

  poolView(pool) {
    return {
      Id: pool.Id,
      Name: pool.Name,
      Arn: pool.Arn,
      Policies: pool.Policies,
      MfaConfiguration: pool.MfaConfiguration,
      CreationDate: Math.floor(pool.CreationDate / 1000),
      LastModifiedDate: Math.floor(pool.CreationDate / 1000),
      AutoVerifiedAttributes: pool.AutoVerifiedAttributes,
      EstimatedNumberOfUsers: pool.users.size,
    };
  }

  requirePool(id) {
    if (!id) throw new CognitoError("InvalidParameterException", "UserPoolId is required.");
    const pool = this.userPools.get(id);
    if (!pool) throw new CognitoError("ResourceNotFoundException", `User pool ${id} does not exist.`);
    return pool;
  }

  listUserPools() {
    return {
      UserPools: [...this.userPools.values()].map((p) => ({
        Id: p.Id,
        Name: p.Name,
        CreationDate: Math.floor(p.CreationDate / 1000),
        LastModifiedDate: Math.floor(p.CreationDate / 1000),
      })),
    };
  }

  describeUserPool(input) {
    const pool = this.requirePool(input.UserPoolId);
    return { UserPool: this.poolView(pool) };
  }

  deleteUserPool(input) {
    this.requirePool(input.UserPoolId);
    this.userPools.delete(input.UserPoolId);
    return {};
  }

  createUserPoolClient(input) {
    const pool = this.requirePool(input.UserPoolId);
    const clientId = randomBytes(13).toString("hex");
    const client = {
      ClientId: clientId,
      ClientName: input.ClientName || "client",
      UserPoolId: pool.Id,
      CreationDate: Date.now(),
      ExplicitAuthFlows: input.ExplicitAuthFlows || ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      GenerateSecret: input.GenerateSecret || false,
      ClientSecret: input.GenerateSecret ? randomBytes(32).toString("hex") : undefined,
    };
    pool.clients.set(clientId, client);
    return { UserPoolClient: this.clientView(client) };
  }

  clientView(client) {
    const v = {
      ClientId: client.ClientId,
      ClientName: client.ClientName,
      UserPoolId: client.UserPoolId,
      CreationDate: Math.floor(client.CreationDate / 1000),
      LastModifiedDate: Math.floor(client.CreationDate / 1000),
      ExplicitAuthFlows: client.ExplicitAuthFlows,
    };
    if (client.ClientSecret) v.ClientSecret = client.ClientSecret;
    return v;
  }

  findClient(clientId) {
    for (const pool of this.userPools.values()) {
      const c = pool.clients.get(clientId);
      if (c) return { pool, client: c };
    }
    return null;
  }

  describeUserPoolClient(input) {
    const pool = this.requirePool(input.UserPoolId);
    const client = pool.clients.get(input.ClientId);
    if (!client) throw new CognitoError("ResourceNotFoundException", "Client does not exist.");
    return { UserPoolClient: this.clientView(client) };
  }

  listUserPoolClients(input) {
    const pool = this.requirePool(input.UserPoolId);
    return {
      UserPoolClients: [...pool.clients.values()].map((c) => ({
        ClientId: c.ClientId,
        UserPoolId: c.UserPoolId,
        ClientName: c.ClientName,
      })),
    };
  }

  attrsFromList(list) {
    const out = {};
    for (const a of list || []) {
      if (a && a.Name !== undefined) out[a.Name] = a.Value;
    }
    return out;
  }

  attrsToList(attrs) {
    return Object.entries(attrs).map(([Name, Value]) => ({ Name, Value }));
  }

  adminCreateUser(input) {
    const pool = this.requirePool(input.UserPoolId);
    const username = input.Username;
    if (!username) throw new CognitoError("InvalidParameterException", "Username is required.");
    if (pool.users.has(username)) {
      throw new CognitoError("UsernameExistsException", "User already exists.");
    }
    const attrs = this.attrsFromList(input.UserAttributes);
    const user = {
      Username: username,
      sub: randomUUID(),
      password: input.TemporaryPassword || randomBytes(8).toString("hex"),
      attributes: attrs,
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
      created: Date.now(),
      confirmed: true,
    };
    pool.users.set(username, user);
    return { User: this.userInfo(user) };
  }

  userInfo(user) {
    return {
      Username: user.Username,
      Attributes: this.attrsToList({ sub: user.sub, ...user.attributes }),
      UserCreateDate: Math.floor(user.created / 1000),
      UserLastModifiedDate: Math.floor(user.created / 1000),
      Enabled: user.enabled,
      UserStatus: user.status,
    };
  }

  signUp(input) {
    const { pool, client } = this.findClient(input.ClientId) || {};
    if (!client) throw new CognitoError("ResourceNotFoundException", "Client does not exist.");
    const username = input.Username;
    if (!username) throw new CognitoError("InvalidParameterException", "Username is required.");
    if (pool.users.has(username)) {
      throw new CognitoError("UsernameExistsException", "User already exists.");
    }
    const attrs = this.attrsFromList(input.UserAttributes);
    const user = {
      Username: username,
      sub: randomUUID(),
      password: input.Password,
      attributes: attrs,
      status: pool.AutoVerifiedAttributes.length ? "UNCONFIRMED" : "CONFIRMED",
      enabled: true,
      created: Date.now(),
      confirmed: pool.AutoVerifiedAttributes.length === 0,
    };
    pool.users.set(username, user);
    return {
      UserConfirmed: user.confirmed,
      UserSub: user.sub,
      CodeDeliveryDetails: pool.AutoVerifiedAttributes.length
        ? { Destination: attrs.email || "***", DeliveryMedium: "EMAIL", AttributeName: "email" }
        : undefined,
    };
  }

  confirmSignUp(input) {
    const { pool } = this.findClient(input.ClientId) || {};
    if (!pool) throw new CognitoError("ResourceNotFoundException", "Client does not exist.");
    const user = pool.users.get(input.Username);
    if (!user) throw new CognitoError("UserNotFoundException", "User does not exist.");
    user.confirmed = true;
    user.status = "CONFIRMED";
    return {};
  }

  initiateAuth(input, admin) {
    let pool;
    let client;
    if (admin) {
      pool = this.requirePool(input.UserPoolId);
      client = pool.clients.get(input.ClientId);
      if (!client) throw new CognitoError("ResourceNotFoundException", "Client does not exist.");
    } else {
      const found = this.findClient(input.ClientId);
      if (!found) throw new CognitoError("ResourceNotFoundException", "Client does not exist.");
      pool = found.pool;
      client = found.client;
    }
    const flow = input.AuthFlow;
    const params = input.AuthParameters || {};

    if (flow === "REFRESH_TOKEN_AUTH" || flow === "REFRESH_TOKEN") {
      return {
        AuthenticationResult: {
          AccessToken: this.signJwt({ token_use: "access", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
          IdToken: this.signJwt({ token_use: "id", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      };
    }

    const username = params.USERNAME;
    const password = params.PASSWORD;
    const user = pool.users.get(username);
    if (!user) throw new CognitoError("UserNotFoundException", "User does not exist.");
    if (!user.confirmed) throw new CognitoError("UserNotConfirmedException", "User is not confirmed.");
    if (password !== undefined && user.password !== undefined && user.password !== password) {
      throw new CognitoError("NotAuthorizedException", "Incorrect username or password.");
    }
    return { AuthenticationResult: this.issueTokens(pool, user, client.ClientId) };
  }

  resolveUserFromToken(accessToken) {
    if (!accessToken) throw new CognitoError("NotAuthorizedException", "Access token is required.");
    try {
      const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString("utf8"));
      for (const pool of this.userPools.values()) {
        const user = pool.users.get(payload.username);
        if (user) return { pool, user };
      }
    } catch {
      /* fall through */
    }
    throw new CognitoError("NotAuthorizedException", "Invalid access token.");
  }

  getUser(input) {
    const { user } = this.resolveUserFromToken(input.AccessToken);
    return {
      Username: user.Username,
      UserAttributes: this.attrsToList({ sub: user.sub, ...user.attributes }),
    };
  }

  adminGetUser(input) {
    const pool = this.requirePool(input.UserPoolId);
    const user = pool.users.get(input.Username);
    if (!user) throw new CognitoError("UserNotFoundException", "User does not exist.");
    return this.userInfo(user);
  }

  listUsers(input) {
    const pool = this.requirePool(input.UserPoolId);
    return { Users: [...pool.users.values()].map((u) => this.userInfo(u)) };
  }

  // -------------------------------------------------------------------------
  // Identity (Federated Identities)
  // -------------------------------------------------------------------------
  dispatchIdentity(operation, input) {
    switch (operation) {
      case "CreateIdentityPool": return this.createIdentityPool(input);
      case "DescribeIdentityPool": return this.describeIdentityPool(input);
      case "ListIdentityPools": return this.listIdentityPools(input);
      case "DeleteIdentityPool": return this.deleteIdentityPool(input);
      case "GetId": return this.getId(input);
      case "GetCredentialsForIdentity": return this.getCredentialsForIdentity(input);
      default:
        throw new CognitoError("InvalidParameterException", `The action ${operation || "(none)"} is not valid.`, 400);
    }
  }

  createIdentityPool(input) {
    const name = input.IdentityPoolName;
    if (!name) throw new CognitoError("InvalidParameterException", "IdentityPoolName is required.");
    const id = `${this.region}:${randomUUID()}`;
    const pool = {
      IdentityPoolId: id,
      IdentityPoolName: name,
      AllowUnauthenticatedIdentities: input.AllowUnauthenticatedIdentities || false,
    };
    this.identityPools.set(id, pool);
    return { ...pool };
  }

  requireIdentityPool(id) {
    const pool = this.identityPools.get(id);
    if (!pool) throw new CognitoError("ResourceNotFoundException", "Identity pool does not exist.");
    return pool;
  }

  describeIdentityPool(input) {
    return { ...this.requireIdentityPool(input.IdentityPoolId) };
  }

  listIdentityPools() {
    return {
      IdentityPools: [...this.identityPools.values()].map((p) => ({
        IdentityPoolId: p.IdentityPoolId,
        IdentityPoolName: p.IdentityPoolName,
      })),
    };
  }

  deleteIdentityPool(input) {
    this.requireIdentityPool(input.IdentityPoolId);
    this.identityPools.delete(input.IdentityPoolId);
    return {};
  }

  getId(input) {
    this.requireIdentityPool(input.IdentityPoolId);
    const identityId = `${this.region}:${randomUUID()}`;
    this.identities.set(identityId, { identityPoolId: input.IdentityPoolId });
    return { IdentityId: identityId };
  }

  getCredentialsForIdentity(input) {
    const identityId = input.IdentityId;
    if (!identityId) throw new CognitoError("InvalidParameterException", "IdentityId is required.");
    const expiration = Math.floor((Date.now() + 3600 * 1000) / 1000);
    return {
      IdentityId: identityId,
      Credentials: {
        AccessKeyId: "ASIA" + randomBytes(8).toString("hex").toUpperCase(),
        SecretKey: randomBytes(20).toString("base64").replace(/[+/=]/g, "").slice(0, 40),
        SessionToken: base64url(randomBytes(120)),
        Expiration: expiration,
      },
    };
  }

  sendJson(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.end(JSON.stringify(obj));
  }

  sendError(res, error) {
    const code = error.code || "InternalErrorException";
    const status = error.status || ERROR_STATUS[code] || 400;
    res.statusCode = status;
    res.setHeader("Content-Type", JSON_CONTENT_TYPE);
    res.setHeader("x-amzn-errortype", code);
    res.end(JSON.stringify({ __type: code, message: error.message || code, Message: error.message || code }));
  }
}

export default CognitoServer;
