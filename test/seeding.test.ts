// Seeding & fixtures tests. Proves seed() on stripe + redis, the control-plane
// POST /services/:slug/seed endpoint (incl. 501 graceful degrade), that seeded
// objects are retrievable through the real API surface, and that the launcher
// loads parlel.fixtures.json on boot.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneServer } from "../src/control-plane.mjs";
import { StripeServer } from "../services/stripe/src/server.js";
import { RedisServer } from "../services/redis/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

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

describe("seed() — unit", () => {
  it("redis seeds string keys (flat map and {keys})", () => {
    const r = new RedisServer(0);
    expect(r.seed({ a: "1", b: "2" })).toEqual({ keys: 2 });
    expect(r.store.get("a")).toEqual({ type: "string", value: "1" });
    r.reset();
    expect(r.seed({ keys: { c: 3 } })).toEqual({ keys: 1 });
    expect(r.store.get("c")).toEqual({ type: "string", value: "3" });
  });

  it("stripe seeds customers/products/prices and honors provided ids", () => {
    const s = new StripeServer(0);
    const counts = s.seed({
      customers: [{ id: "cus_test", email: "seed@parlel.dev" }],
      products: [{ id: "prod_test", name: "Pro" }],
      prices: [{ id: "price_test", product: "prod_test", unit_amount: 2000 }],
    });
    expect(counts).toEqual({ customers: 1, products: 1, prices: 1 });
    expect(s.customers.get("cus_test").email).toBe("seed@parlel.dev");
    expect(s.prices.get("price_test").unit_amount).toBe(2000);
  });
});

describe("seed() — control plane + real API retrieval", () => {
  let cp: ControlPlaneServer;
  let stripe: StripeServer;
  let redis: RedisServer;
  let cpPort: number;
  let stripePort: number;

  beforeAll(async () => {
    ({ server: cp, port: cpPort } = await startOn((p) => new ControlPlaneServer(p)));
    ({ server: stripe, port: stripePort } = await startOn((p) => new StripeServer(p)));
    ({ server: redis } = await startOn((p) => new RedisServer(p)));
    cp.register("stripe", stripe, { name: "stripe", port: stripePort, protocol: "http" });
    cp.register("redis", redis, { name: "redis", protocol: "tcp" });
  });
  afterAll(async () => {
    await stripe.stop();
    await redis.stop();
    await cp.stop();
  });
  beforeEach(() => {
    stripe.reset();
    redis.reset();
  });

  it("POST /services/stripe/seed then retrieve via the real Stripe REST surface", async () => {
    const seed = await fetch(`http://127.0.0.1:${cpPort}/services/stripe/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customers: [{ id: "cus_seeded", email: "x@y.com" }] }),
    });
    expect(seed.status).toBe(200);
    expect((await seed.json()).seeded).toEqual({ customers: 1, products: 0, prices: 0 });

    // Retrieve through the actual Stripe API path.
    const get = await fetch(`http://127.0.0.1:${stripePort}/v1/customers/cus_seeded`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.id).toBe("cus_seeded");
    expect(body.email).toBe("x@y.com");
  });

  it("POST /services/redis/seed loads keys", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/services/redis/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ greeting: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(redis.store.get("greeting")).toEqual({ type: "string", value: "hello" });
  });

  it("returns 501 for a service without seed()", async () => {
    // Register a bare object with no seed().
    cp.register("noseed", { reset() {}, port: 1 }, { name: "noseed", protocol: "http" });
    const res = await fetch(`http://127.0.0.1:${cpPort}/services/noseed/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(501);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${cpPort}/services/stripe/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("fixtures on boot", () => {
  let dir: string;
  let proc: any;
  let controlPort: number;

  afterAll(async () => {
    if (proc && !proc.killed) proc.kill("SIGINT");
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("launcher loads parlel.fixtures.json and seeds services", async () => {
    controlPort = await getFreePort();
    dir = await mkdtemp(join(tmpdir(), "parlel-fixtures-"));
    await writeFile(
      join(dir, "parlel.fixtures.json"),
      JSON.stringify({ stripe: { customers: [{ id: "cus_boot", email: "boot@parlel.dev" }] } }),
    );

    proc = spawn("node", [join(REPO, "src", "launch.mjs"), "stripe"], {
      cwd: dir,
      env: {
        ...process.env,
        PARLEL_CONTROL_PORT: String(controlPort),
        PARLEL_RECORD: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ready = await waitFor(proc, /ready —/, 8000);
    expect(ready).toBe(true);

    // Ask the control plane for stripe's actual bound port (don't assume 4757).
    const svcRes = await fetch(`http://127.0.0.1:${controlPort}/services/stripe`).catch(() => null);
    expect(svcRes && svcRes.status).toBe(200);
    const svc = await svcRes!.json();
    const actualStripePort = svc.port;
    expect(typeof actualStripePort).toBe("number");

    // Retrieve the seeded customer through the real Stripe API surface.
    const get = await fetch(`http://127.0.0.1:${actualStripePort}/v1/customers/cus_boot`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    }).catch(() => null);
    expect(get && get.status).toBe(200);
    const body = await get!.json();
    expect(body.id).toBe("cus_boot");
    expect(body.email).toBe("boot@parlel.dev");
  });
});

// Resolve true when a matching line appears on the child's stdout/stderr.
function waitFor(proc: any, re: RegExp, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const onData = (buf: Buffer) => {
      if (re.test(buf.toString())) finish(true);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    setTimeout(() => finish(false), timeoutMs);
  });
}
