import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/adyen — a tiny, dependency-free fake of the Adyen Checkout API v71.
//
// Header-authenticated (X-API-Key) JSON API. State is in-memory and ephemeral.
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

function pspReference() {
  // Adyen psp references are 16-char uppercase alphanumerics.
  return randomBytes(8).toString("hex").toUpperCase().slice(0, 16);
}

// Adyen service-error envelope.
function adyenError(message, errorCode = "702", status = 422, errorType = "validation") {
  return {
    status,
    body: {
      status,
      errorCode,
      message,
      errorType,
      pspReference: pspReference(),
    },
  };
}

export class AdyenServer {
  constructor(port = 4869, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.payments = new Map();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, adyenError(error.message || "error", "905", 500, "internal").body);
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
    res.setHeader("server", "parlel-adyen");

    if (req.method === "OPTIONS") return this.send(res, 204, null);
    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });

    if (parts[0] === "__parlel") {
      if (req.method === "POST" && parts[1] === "reset") {
        this.reset();
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, adyenError("not found", "000", 404).body);
    }

    if (this.requireAuth && !this.isAuthorized(req)) {
      return this.send(res, 401, { status: 401, errorCode: "000", message: "HTTP Status Response - Unauthorized", errorType: "security" });
    }

    if (parts[0] !== "v71") return this.send(res, 404, adyenError("not found", "000", 404).body);
    const route = parts.slice(1);

    // POST /v71/payments
    if (route[0] === "payments" && route.length === 1 && req.method === "POST") {
      return this.payment(res, body);
    }
    // POST /v71/payments/details
    if (route[0] === "payments" && route[1] === "details" && route.length === 2 && req.method === "POST") {
      return this.paymentDetails(res, body);
    }
    // POST /v71/payments/:pspReference/cancels
    if (route[0] === "payments" && route[2] === "cancels" && route.length === 3 && req.method === "POST") {
      return this.cancel(res, route[1], body);
    }
    // POST /v71/payments/:pspReference/captures
    if (route[0] === "payments" && route[2] === "captures" && route.length === 3 && req.method === "POST") {
      return this.capture(res, route[1], body);
    }
    // POST /v71/payments/:pspReference/refunds
    if (route[0] === "payments" && route[2] === "refunds" && route.length === 3 && req.method === "POST") {
      return this.refund(res, route[1], body);
    }
    // POST /v71/paymentMethods
    if (route[0] === "paymentMethods" && route.length === 1 && req.method === "POST") {
      return this.paymentMethods(res, body);
    }

    return this.send(res, 404, adyenError(`unknown endpoint /${route.join("/")}`, "000", 404).body);
  }

  payment(res, body) {
    if (!isPlainObject(body) || !body.amount || !body.paymentMethod || !body.merchantAccount) {
      return this.send(res, 422, adyenError("Required field 'amount', 'paymentMethod' or 'merchantAccount' is missing").body);
    }
    if (!body.reference) {
      return this.send(res, 422, adyenError("Required field 'reference' is missing.", "130").body);
    }
    if (!body.returnUrl) {
      return this.send(res, 422, adyenError("Return URL is missing.", "14_030").body);
    }
    const psp = pspReference();
    const record = {
      pspReference: psp,
      resultCode: "Authorised",
      merchantReference: body.reference || null,
      amount: body.amount,
      paymentMethod: { type: body.paymentMethod.type || "scheme", brand: body.paymentMethod.brand || "visa" },
      additionalData: { cardSummary: "1111" },
    };
    this.payments.set(psp, record);
    return this.send(res, 200, {
      pspReference: psp,
      resultCode: "Authorised",
      merchantReference: body.reference,
      amount: body.amount,
      additionalData: { cardSummary: "1111" },
    });
  }

  paymentDetails(res, body) {
    if (!isPlainObject(body) || !body.details) {
      return this.send(res, 422, adyenError("Required field 'details' is missing").body);
    }
    const psp = pspReference();
    return this.send(res, 200, {
      pspReference: psp,
      resultCode: "Authorised",
      merchantReference: body.merchantReference || null,
    });
  }

  paymentMethods(res, body) {
    if (!isPlainObject(body) || !body.merchantAccount) {
      return this.send(res, 422, adyenError("Required field 'merchantAccount' is missing").body);
    }
    return this.send(res, 200, {
      paymentMethods: [
        { type: "scheme", name: "Cards", brands: ["visa", "mc", "amex"] },
        { type: "ideal", name: "iDEAL" },
        { type: "paypal", name: "PayPal" },
      ],
    });
  }

  cancel(res, psp, body) {
    if (!isPlainObject(body) || !body.merchantAccount) {
      return this.send(res, 422, adyenError("Required field 'merchantAccount' is missing").body);
    }
    return this.send(res, 201, {
      paymentPspReference: psp,
      pspReference: pspReference(),
      status: "received",
      merchantAccount: body.merchantAccount,
      reference: body.reference || undefined,
    });
  }

  capture(res, psp, body) {
    if (!isPlainObject(body) || !body.amount || !body.merchantAccount) {
      return this.send(res, 422, adyenError("Required field 'amount' or 'merchantAccount' is missing").body);
    }
    return this.send(res, 201, {
      amount: body.amount,
      merchantAccount: body.merchantAccount,
      paymentPspReference: psp,
      pspReference: pspReference(),
      status: "received",
      reference: body.reference || undefined,
    });
  }

  refund(res, psp, body) {
    if (!isPlainObject(body) || !body.amount || !body.merchantAccount) {
      return this.send(res, 422, adyenError("Required field 'amount' or 'merchantAccount' is missing").body);
    }
    return this.send(res, 201, {
      amount: body.amount,
      merchantAccount: body.merchantAccount,
      paymentPspReference: psp,
      pspReference: pspReference(),
      status: "received",
      reference: body.reference || undefined,
      merchantRefundReason: body.merchantRefundReason || undefined,
    });
  }

  root() {
    return { name: "adyen", version: "1", protocol: "adyen-checkout-v71", documentation: "/docs/adyen.md" };
  }

  isAuthorized(req) {
    const key = req.headers["x-api-key"];
    return typeof key === "string" && key.length > 0;
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
          this.send(res, 400, adyenError("malformed JSON body", "702", 400).body);
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, adyenError("malformed body", "000", 400).body);
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
