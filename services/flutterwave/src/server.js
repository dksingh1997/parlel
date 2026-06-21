import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/flutterwave — a tiny, dependency-free fake of the Flutterwave API v3.
//
// Bearer-authenticated JSON API. Responses use the standard Flutterwave
// envelope { status, message, data }. State is in-memory and ephemeral.
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

function token(len = 16) {
  return randomBytes(Math.ceil(len * 0.8)).toString("base64").replace(/[+/=]/g, "").slice(0, len);
}

function fwError(message, status = 400) {
  return { status, body: { status: "error", message, data: null } };
}

export class FlutterwaveServer {
  constructor(port = 4874, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.payments = new Map(); // tx_ref -> payment
    this.transactions = new Map(); // id -> transaction
    this.transfers = new Map();
    this.counter = 100000;
  }

  nextId() {
    this.counter += 1;
    return this.counter;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, fwError(error.message || "error", 500).body);
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
    res.setHeader("server", "parlel-flutterwave");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, fwError("not found", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, { status: "error", message: "Authorization required", data: null });
    }

    if (parts[0] !== "v3") return this.send(res, 404, fwError("not found", 404).body);
    const route = parts.slice(1);

    // POST /v3/payments
    if (route[0] === "payments" && route.length === 1 && req.method === "POST") {
      return this.initiatePayment(res, body);
    }
    // GET /v3/transactions/:id/verify
    if (route[0] === "transactions" && route[2] === "verify" && route.length === 3 && req.method === "GET") {
      return this.verifyTransaction(res, route[1]);
    }
    // POST /v3/transfers ; GET /v3/transfers
    if (route[0] === "transfers" && route.length === 1) {
      if (req.method === "POST") return this.createTransfer(res, body);
      if (req.method === "GET") {
        return this.send(res, 200, { status: "success", message: "Transfers fetched", data: Array.from(this.transfers.values()).map(clone) });
      }
    }
    // GET /v3/transfers/:id
    if (route[0] === "transfers" && route.length === 2 && req.method === "GET") {
      const t = this.transfers.get(Number(route[1]));
      if (!t) return this.send(res, 404, fwError("transfer not found", 404).body);
      return this.send(res, 200, { status: "success", message: "Transfer fetched", data: clone(t) });
    }
    // GET /v3/banks/:country
    if (route[0] === "banks" && route.length === 2 && req.method === "GET") {
      return this.send(res, 200, {
        status: "success",
        message: "Banks fetched successfully",
        data: [
          { id: 132, code: "044", name: "Access Bank" },
          { id: 133, code: "058", name: "GTBank" },
          { id: 134, code: "057", name: "Zenith Bank" },
        ],
      });
    }

    return this.send(res, 404, fwError(`unknown endpoint /${route.join("/")}`, 404).body);
  }

  initiatePayment(res, body) {
    if (!isPlainObject(body) || !body.tx_ref || !body.amount) {
      return this.send(res, 400, fwError("tx_ref and amount are required").body);
    }
    const id = this.nextId();
    const txRef = String(body.tx_ref);
    const link = `https://checkout.flutterwave.com/v3/hosted/pay/${token(20)}`;
    const transaction = {
      id,
      tx_ref: txRef,
      flw_ref: `FLW-${token(16)}`,
      amount: Number(body.amount),
      currency: body.currency || "NGN",
      status: "successful",
      customer: body.customer || {},
      created_at: new Date().toISOString(),
    };
    this.payments.set(txRef, { link, transaction });
    this.transactions.set(id, transaction);
    return this.send(res, 200, {
      status: "success",
      message: "Hosted Link",
      data: { link },
    });
  }

  verifyTransaction(res, id) {
    const transaction = this.transactions.get(Number(id));
    if (!transaction) {
      return this.send(res, 400, fwError("No transaction was found for this id").body);
    }
    return this.send(res, 200, {
      status: "success",
      message: "Transaction fetched successfully",
      data: {
        id: transaction.id,
        tx_ref: transaction.tx_ref,
        flw_ref: transaction.flw_ref,
        amount: transaction.amount,
        currency: transaction.currency,
        status: "successful",
        customer: transaction.customer,
        created_at: transaction.created_at,
      },
    });
  }

  createTransfer(res, body) {
    if (!isPlainObject(body) || !body.account_bank || !body.account_number || !body.amount) {
      return this.send(res, 400, fwError("account_bank, account_number and amount are required").body);
    }
    const id = this.nextId();
    const transfer = {
      id,
      account_number: String(body.account_number),
      bank_code: String(body.account_bank),
      amount: Number(body.amount),
      currency: body.currency || "NGN",
      reference: body.reference || `transfer-${token(8)}`,
      status: "NEW",
      created_at: new Date().toISOString(),
    };
    this.transfers.set(id, transfer);
    return this.send(res, 200, { status: "success", message: "Transfer Queued Successfully", data: clone(transfer) });
  }

  root() {
    return { name: "flutterwave", version: "1", protocol: "flutterwave-v3", documentation: "/docs/flutterwave.md" };
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
          this.send(res, 400, fwError("malformed JSON body", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, fwError("malformed body", 400).body);
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
