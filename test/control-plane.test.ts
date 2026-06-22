// Control-plane tests. Boots two real emulators (stripe HTTP + redis TCP),
// registers them with a ControlPlaneServer, and exercises every admin endpoint —
// including that reset() through the control plane actually wipes emulator state.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ControlPlaneServer } from "../src/control-plane.mjs";
import { StripeServer } from "../services/stripe/src/server.js";
import { RedisServer } from "../services/redis/src/server.js";
import { getFreePort } from "../src/test-helpers.js";

let cp: ControlPlaneServer;
let stripe: StripeServer;
let redis: RedisServer;
let cpPort: number;
let stripePort: number;
let redisPort: number;

const base = () => `http://127.0.0.1:${cpPort}`;

// Allocate a free port and immediately bind the server to it, minimizing the
// window where another process could grab the just-freed port (EADDRINUSE race).
async function startOn<T extends { start(): Promise<void>; port?: number }>(
  make: (port: number) => T,
): Promise<{ server: T; port: number }> {
  for (let attempt = 0; attempt < 8; attempt++) {
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
  throw new Error("could not bind a free port after several attempts");
}

beforeAll(async () => {
  ({ server: cp, port: cpPort } = await startOn((p) => new ControlPlaneServer(p)));
  ({ server: stripe, port: stripePort } = await startOn((p) => new StripeServer(p)));
  ({ server: redis, port: redisPort } = await startOn((p) => new RedisServer(p)));

  cp.register("stripe", stripe, { name: "stripe", port: stripePort, protocol: "http" });
  cp.register("redis", redis, { name: "redis", port: redisPort, protocol: "tcp" });
});

afterAll(async () => {
  await stripe.stop();
  await redis.stop();
  await cp.stop();
});

describe("control plane — discovery", () => {
  it("GET / lists the API", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("parlel-control-plane");
    expect(body.services).toBe(2);
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it("GET /healthz reports the fleet", async () => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.count).toBe(2);
    const slugs = body.services.map((s: any) => s.slug).sort();
    expect(slugs).toEqual(["redis", "stripe"]);
  });

  it("GET /services lists both with metadata", async () => {
    const res = await fetch(`${base()}/services`);
    expect(res.status).toBe(200);
    const { services } = await res.json();
    expect(services).toHaveLength(2);
    const stripeSvc = services.find((s: any) => s.slug === "stripe");
    expect(stripeSvc.protocol).toBe("http");
    expect(stripeSvc.port).toBe(stripePort);
    expect(stripeSvc.supports.reset).toBe(true);
    expect(typeof stripeSvc.uptime_ms).toBe("number");
    expect(stripeSvc.connection_string).toBe(`http://127.0.0.1:${stripePort}`);
  });

  it("GET /services/:slug returns detail + connection string", async () => {
    const res = await fetch(`${base()}/services/redis`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("redis");
    expect(body.connection_string).toBe(`redis://127.0.0.1:${redisPort}`);
  });

  it("GET /services/:slug for unknown service is 404", async () => {
    const res = await fetch(`${base()}/services/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("control plane — reset", () => {
  it("POST /services/:slug/reset wipes that service's state", async () => {
    // Create a customer via the real Stripe surface.
    const create = await fetch(`http://127.0.0.1:${stripePort}/v1/customers`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_test_parlel",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "email=a@b.com",
    });
    expect(create.status).toBe(200);
    expect(stripe.customers.size).toBe(1);

    // Reset via the control plane.
    const reset = await fetch(`${base()}/services/stripe/reset`, { method: "POST" });
    expect(reset.status).toBe(200);
    expect((await reset.json()).ok).toBe(true);

    // State is gone.
    expect(stripe.customers.size).toBe(0);
  });

  it("POST /reset resets the whole fleet", async () => {
    await fetch(`http://127.0.0.1:${stripePort}/v1/customers`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk_test_parlel",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "email=c@d.com",
    });
    expect(stripe.customers.size).toBe(1);

    const res = await fetch(`${base()}/reset`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.reset).toContain("stripe");
    expect(body.reset).toContain("redis");
    expect(stripe.customers.size).toBe(0);
  });
});

describe("control plane — state", () => {
  it("GET /services/:slug/state returns 501 when dump() is absent", async () => {
    // Neither stripe nor redis implements dump() yet — graceful degrade.
    const res = await fetch(`${base()}/services/stripe/state`);
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("not supported");
  });

  it("GET /services/:slug/state serializes dump() output when present", async () => {
    // Attach a dump() at runtime to prove the serialization path (Maps -> objects).
    (stripe as any).dump = () => ({ customers: stripe.customers, count: stripe.customers.size });
    try {
      const res = await fetch(`${base()}/services/stripe/state`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.slug).toBe("stripe");
      expect(body.state).toHaveProperty("customers");
      expect(typeof body.state.customers).toBe("object");
    } finally {
      delete (stripe as any).dump;
    }
  });
});

describe("control plane — unknown routes", () => {
  it("404s an unknown path", async () => {
    const res = await fetch(`${base()}/nope`);
    expect(res.status).toBe(404);
  });
});
