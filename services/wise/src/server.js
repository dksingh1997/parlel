import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/wise — a tiny, dependency-free fake of the Wise (TransferWise) API.
//
// Bearer-token authenticated JSON API. State is in-memory and ephemeral.
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

function now() {
  return new Date().toISOString();
}

function wiseError(message, status = 400) {
  return { errors: [{ code: "VALIDATION", message }] };
}

export class WiseServer {
  constructor(port = 4867, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.quotes = new Map();
    this.transfers = new Map();
    this.counter = 1000;
    this._seed();
  }

  nextId() {
    this.counter += 1;
    return this.counter;
  }

  _seed() {
    this.profiles = [
      { id: 1, type: "personal", details: { firstName: "Parlel", lastName: "Tester" } },
      { id: 2, type: "business", details: { name: "Parlel Inc", registrationNumber: "12345" } },
    ];
    this.accounts = [
      { id: 5001, profile: 1, currency: "USD", country: "US", type: "aba", accountHolderName: "Parlel Tester", details: { accountNumber: "12345678", routingNumber: "111000025" } },
    ];
    this.borderless = [
      {
        id: 7001,
        profileId: 1,
        balances: [
          { id: 8001, currency: "USD", amount: { value: 1000.0, currency: "USD" }, reservedAmount: { value: 0, currency: "USD" }, bankDetails: null },
          { id: 8002, currency: "EUR", amount: { value: 500.0, currency: "EUR" }, reservedAmount: { value: 0, currency: "EUR" }, bankDetails: null },
        ],
      },
    ];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, wiseError(error.message || "error", 500));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-wise");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, wiseError("not found", 404));
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, { error: "unauthorized", error_description: "Bearer token required" });
    }

    if (parts[0] !== "v1") return this.send(res, 404, wiseError("not found", 404));
    const route = parts.slice(1);

    // GET /v1/profiles
    if (route[0] === "profiles" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.profiles));
    }

    // /v1/quotes
    if (route[0] === "quotes") {
      if (route.length === 1 && req.method === "POST") return this.createQuote(res, body);
      if (route.length === 2 && req.method === "GET") {
        const q = this.quotes.get(Number(route[1])) || this.quotes.get(route[1]);
        if (!q) return this.send(res, 404, wiseError("quote not found", 404));
        return this.send(res, 200, clone(q));
      }
    }

    // /v1/transfers
    if (route[0] === "transfers") {
      if (route.length === 1 && req.method === "POST") return this.createTransfer(res, body);
      if (route.length === 1 && req.method === "GET") {
        return this.send(res, 200, Array.from(this.transfers.values()).map(clone));
      }
      if (route.length === 2 && req.method === "GET") {
        const t = this.transfers.get(Number(route[1])) || this.transfers.get(route[1]);
        if (!t) return this.send(res, 404, wiseError("transfer not found", 404));
        return this.send(res, 200, clone(t));
      }
    }

    // GET /v1/accounts
    if (route[0] === "accounts" && route.length === 1 && req.method === "GET") {
      return this.send(res, 200, clone(this.accounts));
    }

    // GET /v1/borderless-accounts?profileId=
    if (route[0] === "borderless-accounts" && route.length === 1 && req.method === "GET") {
      const profileId = url.searchParams.get("profileId");
      let data = this.borderless;
      if (profileId) data = data.filter((b) => String(b.profileId) === String(profileId));
      return this.send(res, 200, clone(data));
    }

    return this.send(res, 404, wiseError(`unknown endpoint /${route.join("/")}`, 404));
  }

  createQuote(res, body) {
    if (!isPlainObject(body) || !body.source || !body.target) {
      return this.send(res, 400, wiseError("source and target are required"));
    }
    const id = this.nextId();
    const rate = 1.1342;
    const sourceAmount = typeof body.sourceAmount === "number" ? body.sourceAmount : (typeof body.targetAmount === "number" ? body.targetAmount / rate : 100);
    const targetAmount = typeof body.targetAmount === "number" ? body.targetAmount : Math.round(sourceAmount * rate * 100) / 100;
    const quote = {
      id,
      source: body.source,
      target: body.target,
      sourceCurrency: body.source,
      targetCurrency: body.target,
      rate,
      sourceAmount: Math.round(sourceAmount * 100) / 100,
      targetAmount: Math.round(targetAmount * 100) / 100,
      type: "BALANCE_PAYOUT",
      rateType: "FIXED",
      createdTime: now(),
      profile: body.profile || 1,
      payOut: "BANK_TRANSFER",
    };
    this.quotes.set(id, quote);
    return this.send(res, 200, clone(quote));
  }

  createTransfer(res, body) {
    if (!isPlainObject(body) || !body.targetAccount || !body.quoteUuid && !body.quote) {
      return this.send(res, 400, wiseError("targetAccount and quote are required"));
    }
    const id = this.nextId();
    const transfer = {
      id,
      user: 1,
      targetAccount: body.targetAccount,
      sourceAccount: body.sourceAccount || null,
      quote: body.quote || body.quoteUuid,
      quoteUuid: body.quoteUuid || body.quote,
      status: "incoming_payment_waiting",
      reference: (body.details && body.details.reference) || "",
      rate: 1.1342,
      created: now(),
      details: body.details || { reference: "" },
      customerTransactionId: body.customerTransactionId || null,
    };
    this.transfers.set(id, transfer);
    return this.send(res, 200, clone(transfer));
  }

  root() {
    return { name: "wise", version: "1", protocol: "wise-http", documentation: "/docs/wise.md" };
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
          this.send(res, 400, wiseError("malformed JSON body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, wiseError("malformed body"));
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
