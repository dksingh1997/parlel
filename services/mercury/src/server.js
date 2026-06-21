import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/mercury — a tiny, dependency-free fake of the Mercury banking API.
//
// Bearer-authenticated JSON API. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid() {
  return randomUUID();
}

function mercuryError(message, status = 400) {
  return { status, body: { errors: { message } } };
}

export class MercuryServer {
  constructor(port = 4875, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.accounts = new Map();
    this.transactions = new Map(); // accountId -> [txn]
    this.recipients = new Map();
    this._seed();
  }

  _seed() {
    const checkingId = uuid();
    const savingsId = uuid();
    this.accounts.set(checkingId, {
      id: checkingId,
      name: "Parlel Checking",
      accountNumber: "204529912345",
      routingNumber: "084106768",
      availableBalance: 25000.0,
      currentBalance: 25000.0,
      kind: "checking",
      type: "mercury",
      status: "active",
      createdAt: new Date().toISOString(),
    });
    this.accounts.set(savingsId, {
      id: savingsId,
      name: "Parlel Savings",
      accountNumber: "204529967890",
      routingNumber: "084106768",
      availableBalance: 100000.0,
      currentBalance: 100000.0,
      kind: "savings",
      type: "mercury",
      status: "active",
      createdAt: new Date().toISOString(),
    });
    this.transactions.set(checkingId, [
      {
        id: uuid(),
        amount: -120.5,
        counterpartyName: "AWS",
        createdAt: new Date().toISOString(),
        postedAt: new Date().toISOString(),
        status: "sent",
        kind: "externalTransfer",
        note: "Cloud bill",
        bankDescription: "AMAZON WEB SERVICES",
      },
      {
        id: uuid(),
        amount: 5000.0,
        counterpartyName: "Stripe",
        createdAt: new Date().toISOString(),
        postedAt: new Date().toISOString(),
        status: "sent",
        kind: "incomingDomesticWire",
        note: "Payout",
        bankDescription: "STRIPE TRANSFER",
      },
    ]);
    this.transactions.set(savingsId, []);
    const recipientId = uuid();
    this.recipients.set(recipientId, {
      id: recipientId,
      name: "Acme Vendor",
      emails: ["ap@acme.dev"],
      paymentMethod: "ach",
      electronicRoutingInfo: { accountNumber: "11112222", routingNumber: "021000021", electronicAccountType: "businessChecking" },
      status: "active",
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, mercuryError(error.message || "error", 500).body);
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

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-mercury");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, mercuryError("not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, mercuryError("Unauthorized: missing or invalid bearer token", 401).body);
    }

    if (parts[0] !== "api" || parts[1] !== "v1") return this.send(res, 404, mercuryError("not found", 404).body);
    const route = parts.slice(2);

    // GET /api/v1/accounts
    if (route[0] === "accounts" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { accounts: Array.from(this.accounts.values()).map(clone) });
    }
    // GET /api/v1/accounts/:id
    if (route[0] === "accounts" && route.length === 2 && req.method === "GET") {
      const acc = this.accounts.get(route[1]);
      if (!acc) return this.send(res, 404, mercuryError("account not found", 404).body);
      return this.send(res, 200, clone(acc));
    }
    // /api/v1/account/:id/...
    if (route[0] === "account" && route.length >= 2) {
      const accountId = route[1];
      const acc = this.accounts.get(accountId);
      if (!acc) return this.send(res, 404, mercuryError("account not found", 404).body);

      // GET /api/v1/account/:id/transactions
      if (route[2] === "transactions" && route.length === 3 && req.method === "GET") {
        const txns = this.transactions.get(accountId) || [];
        return this.send(res, 200, { total: txns.length, transactions: txns.map(clone) });
      }
      // POST /api/v1/account/:id/request-send-money  (or /transactions)
      if ((route[2] === "request-send-money" || route[2] === "transactions") && route.length === 3 && req.method === "POST") {
        return this.sendMoney(res, acc, body);
      }
    }
    // GET /api/v1/recipients
    if (route[0] === "recipients" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, { recipients: Array.from(this.recipients.values()).map(clone) });
    }

    return this.send(res, 404, mercuryError(`unknown endpoint /${route.join("/")}`, 404).body);
  }

  sendMoney(res, account, body) {
    if (!isPlainObject(body) || typeof body.amount !== "number" || !body.recipientId) {
      return this.send(res, 400, mercuryError("amount and recipientId are required").body);
    }
    const id = uuid();
    const txn = {
      id,
      amount: -Math.abs(body.amount),
      counterpartyId: body.recipientId,
      counterpartyName: (this.recipients.get(body.recipientId) || {}).name || "Recipient",
      createdAt: new Date().toISOString(),
      postedAt: null,
      status: "pending",
      kind: "externalTransfer",
      note: body.note || null,
      paymentMethod: body.paymentMethod || "ach",
    };
    account.availableBalance = Math.round((account.availableBalance - Math.abs(body.amount)) * 100) / 100;
    const list = this.transactions.get(account.id) || [];
    list.unshift(txn);
    this.transactions.set(account.id, list);
    return this.send(res, 200, clone(txn));
  }

  root() {
    return { name: "mercury", version: "1", protocol: "mercury-http", documentation: "/docs/mercury.md" };
  }

  isAuthorized(req) {
    return /^Bearer\s+\S+/i.test(req.headers.authorization || "");
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, mercuryError("malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, mercuryError("malformed body", 400).body);
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) return res.end();
    res.end(JSON.stringify(body));
  }
}
