// Request-recorder tests. Proves the recorder captures requests an emulator
// receives (method/path/body/headers/status), filters them, redacts secrets, and
// is exposed + cleared through the control plane — all without emulator changes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { ControlPlaneServer } from "../src/control-plane.mjs";
import { RequestLog, attachRecorder } from "../src/request-recorder.mjs";
import { StripeServer } from "../services/stripe/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

async function startOn<T extends { start(): Promise<void> }>(make: (p: number) => T) {
  for (let i = 0; i < 8; i++) {
    const port = await getFreePort();
    const server = make(port);
    try {
      await server.start();
      return { server, port };
    } catch (err: any) {
      if (err?.code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error("could not bind a free port");
}

let cp: ControlPlaneServer;
let stripe: StripeServer;
let log: RequestLog;
let cpPort: number;
let stripePort: number;

const cpBase = () => `http://127.0.0.1:${cpPort}`;
const stripeBase = () => `http://127.0.0.1:${stripePort}`;

async function createCustomer(email: string) {
  return fetch(`${stripeBase()}/v1/customers`, {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_test_parlel",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `email=${encodeURIComponent(email)}`,
  });
}

beforeAll(async () => {
  ({ server: cp, port: cpPort } = await startOn((p) => new ControlPlaneServer(p)));
  ({ server: stripe, port: stripePort } = await startOn((p) => new StripeServer(p)));
  log = new RequestLog();
  attachRecorder((stripe as any).server, log);
  cp.register("stripe", stripe, { name: "stripe", port: stripePort, protocol: "http" }, log);
});

afterAll(async () => {
  await stripe.stop();
  await cp.stop();
});

beforeEach(() => {
  log.clear();
  stripe.reset();
});

describe("recorder — capture", () => {
  it("records a request with method, path, status, and timing", async () => {
    await createCustomer("a@b.com");
    const entries = log.query();
    expect(entries.length).toBe(1);
    const e = entries[0];
    expect(e.method).toBe("POST");
    expect(e.path).toBe("/v1/customers");
    expect(e.status).toBe(200);
    expect(typeof e.durationMs).toBe("number");
    expect(e.ts).toBeGreaterThan(0);
  });

  it("captures request and response bodies", async () => {
    await createCustomer("body@test.com");
    const e = log.query()[0];
    expect(e.requestBody).toContain("email=");
    expect(e.responseBody).toContain("customer");
  });

  it("redacts the Authorization header", async () => {
    await createCustomer("redact@test.com");
    const e = log.query()[0];
    expect(e.headers.authorization).toBe("[redacted]");
  });

  it("does not break the underlying response", async () => {
    const res = await createCustomer("intact@test.com");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("customer");
    expect(body.id).toMatch(/^cus_/);
  });
});

describe("recorder — query filters", () => {
  it("filters by method and path; supports since and limit", async () => {
    const t0 = Date.now();
    await createCustomer("one@test.com");
    await createCustomer("two@test.com");
    await fetch(`${stripeBase()}/v1/customers`, { headers: { Authorization: "Bearer sk_test_parlel" } }); // GET list

    expect(log.query({ method: "POST" }).length).toBe(2);
    expect(log.query({ method: "GET" }).length).toBe(1);
    expect(log.query({ path: "/v1/customers" }).length).toBe(3);
    expect(log.query({ since: t0 }).length).toBe(3);
    expect(log.query({ since: Date.now() + 10000 }).length).toBe(0);
    expect(log.query({ limit: 1 }).length).toBe(1);
  });
});

describe("recorder — ring buffer cap", () => {
  it("never exceeds its capacity", () => {
    const small = new RequestLog(3);
    for (let i = 0; i < 10; i++) small.push({ ts: Date.now(), method: "GET", path: `/${i}` });
    const all = small.query();
    expect(all.length).toBe(3);
    // newest retained
    expect(all[all.length - 1].path).toBe("/9");
  });
});

describe("recorder — control plane integration", () => {
  it("GET /services/:slug/requests returns recorded calls", async () => {
    await createCustomer("cp@test.com");
    const res = await fetch(`${cpBase()}/services/stripe/requests`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("stripe");
    expect(body.count).toBe(1);
    expect(body.requests[0].path).toBe("/v1/customers");
  });

  it("/services entry advertises requests support", async () => {
    const res = await fetch(`${cpBase()}/services/stripe`);
    const body = await res.json();
    expect(body.supports.requests).toBe(true);
  });

  it("POST /services/:slug/reset clears the request log", async () => {
    await createCustomer("clear@test.com");
    expect(log.query().length).toBe(1);
    const res = await fetch(`${cpBase()}/services/stripe/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(log.query().length).toBe(0);
  });

  it("query params (method/path) flow through the control plane", async () => {
    await createCustomer("q1@test.com");
    await fetch(`${stripeBase()}/v1/customers`, { headers: { Authorization: "Bearer sk_test_parlel" } });
    const res = await fetch(`${cpBase()}/services/stripe/requests?method=POST`);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.requests[0].method).toBe("POST");
  });
});
