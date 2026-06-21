import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/plaid — a tiny, dependency-free fake of the Plaid API.
//
// Speaks the JSON wire protocol used by the official `plaid` node client.
// Auth is via client_id + secret in the JSON body (any non-empty values are
// accepted). State is in-memory and ephemeral. Errors use the Plaid error
// envelope { error_type, error_code, error_message, display_message, request_id }.
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

function token(len = 24) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len);
}

function requestId() {
  return token(16);
}

function plaidError(error_type, error_code, error_message, status = 400) {
  return {
    status,
    body: {
      error_type,
      error_code,
      error_message,
      display_message: null,
      request_id: requestId(),
    },
  };
}

export class PlaidServer {
  constructor(port = 4866, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.items = new Map();
    this.publicTokens = new Map();
    this.accessTokens = new Map();
    this.counter = 0;
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}-${token(20)}`;
  }

  _seedAccounts() {
    return [
      {
        account_id: this.nextId("acc"),
        balances: { available: 100.0, current: 110.0, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
        mask: "0000",
        name: "Plaid Checking",
        official_name: "Plaid Gold Standard 0% Interest Checking",
        type: "depository",
        subtype: "checking",
      },
      {
        account_id: this.nextId("acc"),
        balances: { available: 200.0, current: 210.0, limit: null, iso_currency_code: "USD", unofficial_currency_code: null },
        mask: "1111",
        name: "Plaid Saving",
        official_name: "Plaid Silver Standard 0.1% Interest Saving",
        type: "depository",
        subtype: "savings",
      },
    ];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, plaidError("API_ERROR", "INTERNAL_SERVER_ERROR", error.message || "error", 500).body);
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
    res.setHeader("server", "parlel-plaid");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, plaidError("INVALID_REQUEST", "INVALID_FIELD", "not found", 404).body);
    }

    if (req.method !== "POST") {
      return this.send(res, 405, plaidError("INVALID_REQUEST", "INVALID_API_KEYS", "method not allowed", 405).body);
    }

    // Auth: client_id + secret in body.
    if (this.requireAuth) {
      const clientId = body && body.client_id;
      const secret = body && body.secret;
      if (!clientId || !secret) {
        return this.send(res, 400, plaidError(
          "INVALID_INPUT",
          "INVALID_API_KEYS",
          "invalid client_id or secret provided",
        ).body);
      }
    }

    const route = parts.join("/");

    if (route === "link/token/create") return this.linkTokenCreate(res, body);
    if (route === "item/public_token/exchange") return this.exchange(res, body);
    if (route === "accounts/get") return this.accountsGet(res, body);
    if (route === "accounts/balance/get") return this.accountsGet(res, body);
    if (route === "transactions/get") return this.transactionsGet(res, body);
    if (route === "auth/get") return this.authGet(res, body);
    if (route === "identity/get") return this.identityGet(res, body);
    if (route === "item/get") return this.itemGet(res, body);

    return this.send(res, 404, plaidError("INVALID_REQUEST", "INVALID_FIELD", `unknown endpoint /${route}`, 404).body);
  }

  linkTokenCreate(res, body) {
    if (!isPlainObject(body) || !body.user || !body.client_name) {
      return this.send(res, 400, plaidError("INVALID_REQUEST", "INVALID_FIELD", "user and client_name are required").body);
    }
    const link_token = `link-sandbox-${token(24)}`;
    const expiration = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    return this.send(res, 200, { link_token, expiration, request_id: requestId() });
  }

  exchange(res, body) {
    const publicToken = body && body.public_token;
    if (!publicToken) {
      return this.send(res, 400, plaidError("INVALID_INPUT", "INVALID_PUBLIC_TOKEN", "public_token is required").body);
    }
    const item_id = this.nextId("item");
    const access_token = `access-sandbox-${token(24)}`;
    const item = {
      item_id,
      institution_id: "ins_109508",
      available_products: ["balance", "auth", "identity", "transactions"],
      billed_products: ["auth", "transactions"],
      webhook: "",
      error: null,
    };
    const accounts = this._seedAccounts();
    this.items.set(item_id, { item, accounts });
    this.accessTokens.set(access_token, item_id);
    return this.send(res, 200, { access_token, item_id, request_id: requestId() });
  }

  _resolveItem(body) {
    const access_token = body && body.access_token;
    if (!access_token) return { error: plaidError("INVALID_INPUT", "INVALID_ACCESS_TOKEN", "access_token is required") };
    const item_id = this.accessTokens.get(access_token);
    if (!item_id) return { error: plaidError("INVALID_INPUT", "INVALID_ACCESS_TOKEN", "could not find matching item", 400) };
    return { record: this.items.get(item_id) };
  }

  accountsGet(res, body) {
    const { record, error } = this._resolveItem(body);
    if (error) return this.send(res, error.status, error.body);
    return this.send(res, 200, {
      accounts: clone(record.accounts),
      item: clone(record.item),
      request_id: requestId(),
    });
  }

  transactionsGet(res, body) {
    const { record, error } = this._resolveItem(body);
    if (error) return this.send(res, error.status, error.body);
    const accountId = record.accounts[0].account_id;
    const transactions = [
      {
        transaction_id: this.nextId("txn"),
        account_id: accountId,
        amount: 12.5,
        iso_currency_code: "USD",
        date: "2024-01-15",
        name: "Coffee Shop",
        merchant_name: "Blue Bottle",
        pending: false,
        category: ["Food and Drink", "Restaurants", "Coffee Shop"],
        payment_channel: "in store",
      },
      {
        transaction_id: this.nextId("txn"),
        account_id: accountId,
        amount: 89.4,
        iso_currency_code: "USD",
        date: "2024-01-14",
        name: "Grocery Store",
        merchant_name: "Whole Foods",
        pending: false,
        category: ["Shops", "Supermarkets and Groceries"],
        payment_channel: "in store",
      },
    ];
    return this.send(res, 200, {
      accounts: clone(record.accounts),
      transactions,
      total_transactions: transactions.length,
      item: clone(record.item),
      request_id: requestId(),
    });
  }

  authGet(res, body) {
    const { record, error } = this._resolveItem(body);
    if (error) return this.send(res, error.status, error.body);
    const numbers = {
      ach: record.accounts.map((a, i) => ({
        account_id: a.account_id,
        account: `1000000000${i}`,
        routing: "011401533",
        wire_routing: "021000021",
      })),
      eft: [],
      international: [],
      bacs: [],
    };
    return this.send(res, 200, {
      accounts: clone(record.accounts),
      numbers,
      item: clone(record.item),
      request_id: requestId(),
    });
  }

  identityGet(res, body) {
    const { record, error } = this._resolveItem(body);
    if (error) return this.send(res, error.status, error.body);
    const accounts = record.accounts.map((a) => ({
      ...clone(a),
      owners: [
        {
          names: ["Alberta Bobbeth Charleson"],
          phone_numbers: [{ data: "1112223333", primary: true, type: "home" }],
          emails: [{ data: "accountholder0@example.com", primary: true, type: "primary" }],
          addresses: [
            {
              data: { city: "Malakoff", region: "NY", street: "2992 Cameron Road", postal_code: "14236", country: "US" },
              primary: true,
            },
          ],
        },
      ],
    }));
    return this.send(res, 200, {
      accounts,
      item: clone(record.item),
      request_id: requestId(),
    });
  }

  itemGet(res, body) {
    const { record, error } = this._resolveItem(body);
    if (error) return this.send(res, error.status, error.body);
    return this.send(res, 200, {
      item: clone(record.item),
      status: { transactions: null, last_webhook: null },
      request_id: requestId(),
    });
  }

  root() {
    return {
      name: "plaid",
      version: "1",
      protocol: "plaid-http",
      documentation: "/docs/plaid.md",
    };
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
          this.send(res, 400, plaidError("INVALID_REQUEST", "INVALID_BODY", "malformed JSON body").body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, plaidError("INVALID_REQUEST", "INVALID_BODY", "malformed body").body);
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
