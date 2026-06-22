// Parlel — control plane.
//
// A single, additive admin HTTP server (default localhost:4700) that sits
// ALONGSIDE the emulators. It never touches the emulated wire protocols — it
// only introspects and controls the in-memory emulator instances the launcher
// has already started, via the emulator contract (reset/dump).
//
// This is what makes Parlel usable INSIDE a test suite: a test can reset every
// service to a clean slate between cases without restarting containers.
//
//   GET  /                          — index / API listing
//   GET  /healthz                   — aggregate fleet health
//   GET  /services                  — list registered services (slug, port, protocol, uptime)
//   GET  /services/:slug            — one service's detail (+ connection_string)
//   GET  /services/:slug/state      — dump in-memory state (if the emulator implements dump())
//   POST /services/:slug/reset      — reset one service
//   POST /reset                     — reset ALL services
//
// Pure Node built-ins only — same zero-dependency rule as the emulators.

import { createServer } from "node:http";

const DEFAULT_PORT = 4700;

export class ControlPlaneServer {
  constructor(port = DEFAULT_PORT, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    // slug -> { server, manifest, startedAt }
    this.registry = new Map();
  }

  // Called by the launcher for each emulator it successfully starts.
  register(slug, server, manifest = {}) {
    this.registry.set(slug, { server, manifest, startedAt: Date.now() });
  }

  unregister(slug) {
    this.registry.delete(slug);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.send(res, 500, { error: "internal", detail: String(err?.message || err) });
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
      this.server.close((err) => {
        this.server = null;
        err ? reject(err) : resolve();
      });
    });
  }

  // ── serialization helpers ──────────────────────────────────────────────────
  describe(slug) {
    const entry = this.registry.get(slug);
    if (!entry) return null;
    const { server, manifest, startedAt } = entry;
    const port = manifest.port ?? server.port ?? null;
    const protocol = manifest.protocol || "tcp";
    return {
      slug,
      name: manifest.name || slug,
      port,
      protocol,
      uptime_ms: Date.now() - startedAt,
      supports: {
        reset: typeof server.reset === "function",
        dump: typeof server.dump === "function",
        seed: typeof server.seed === "function",
      },
      connection_string: connectionString(slug, protocol, port, this.host),
    };
  }

  list() {
    return [...this.registry.keys()].sort().map((slug) => this.describe(slug));
  }

  // ── routing ─────────────────────────────────────────────────────────────────
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method || "GET";

    if (method === "OPTIONS") return this.send(res, 204, null);

    // GET /
    if (method === "GET" && parts.length === 0) {
      return this.send(res, 200, {
        name: "parlel-control-plane",
        services: this.registry.size,
        endpoints: [
          "GET /healthz",
          "GET /services",
          "GET /services/:slug",
          "GET /services/:slug/state",
          "POST /services/:slug/reset",
          "POST /reset",
        ],
      });
    }

    // GET /healthz
    if (method === "GET" && parts[0] === "healthz" && parts.length === 1) {
      const services = this.list();
      return this.send(res, 200, {
        status: "ok",
        count: services.length,
        services: services.map((s) => ({ slug: s.slug, port: s.port, protocol: s.protocol })),
      });
    }

    // POST /reset  — reset everything
    if (method === "POST" && parts[0] === "reset" && parts.length === 1) {
      const result = this.resetAll();
      return this.send(res, 200, { ok: true, ...result });
    }

    if (parts[0] === "services") {
      // GET /services
      if (method === "GET" && parts.length === 1) {
        return this.send(res, 200, { services: this.list() });
      }
      const slug = parts[1];
      if (!slug) return this.send(res, 404, { error: "not found" });
      const entry = this.registry.get(slug);
      if (!entry) return this.send(res, 404, { error: "unknown service", slug });

      // GET /services/:slug
      if (method === "GET" && parts.length === 2) {
        return this.send(res, 200, this.describe(slug));
      }
      // GET /services/:slug/state
      if (method === "GET" && parts[2] === "state" && parts.length === 3) {
        if (typeof entry.server.dump !== "function") {
          return this.send(res, 501, { error: "not supported", detail: `${slug} does not implement dump()` });
        }
        let state;
        try {
          state = entry.server.dump();
        } catch (err) {
          return this.send(res, 500, { error: "dump failed", detail: String(err?.message || err) });
        }
        return this.send(res, 200, { slug, state: safeJson(state) });
      }
      // POST /services/:slug/reset
      if (method === "POST" && parts[2] === "reset" && parts.length === 3) {
        if (typeof entry.server.reset !== "function") {
          return this.send(res, 501, { error: "not supported", detail: `${slug} does not implement reset()` });
        }
        try {
          entry.server.reset();
        } catch (err) {
          return this.send(res, 500, { error: "reset failed", detail: String(err?.message || err) });
        }
        return this.send(res, 200, { ok: true, slug });
      }
    }

    return this.send(res, 404, { error: "not found" });
  }

  resetAll() {
    const reset = [];
    const skipped = [];
    const failed = [];
    for (const [slug, entry] of this.registry) {
      if (typeof entry.server.reset !== "function") {
        skipped.push(slug);
        continue;
      }
      try {
        entry.server.reset();
        reset.push(slug);
      } catch {
        failed.push(slug);
      }
    }
    return { reset, skipped, failed };
  }

  send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (body === null || status === 204) return res.end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
}

// Best-effort connection string for the common protocols; null when we can't
// confidently build one (callers fall back to host:port).
function connectionString(slug, protocol, port, host) {
  if (!port) return null;
  switch (slug) {
    case "postgres":
      return `postgres://parlel:parlel@${host}:${port}/parlel`;
    case "mysql":
      return `mysql://parlel:parlel@${host}:${port}/parlel`;
    case "redis":
      return `redis://${host}:${port}`;
    case "mongodb":
      return `mongodb://${host}:${port}`;
    case "rabbitmq":
      return `amqp://parlel:parlel@${host}:${port}`;
    default:
      if (protocol === "http" || protocol === "https") return `${protocol}://${host}:${port}`;
      return `${host}:${port}`;
  }
}

// dump() returns live objects (often Maps); make them JSON-serializable without
// throwing on circular refs.
function safeJson(value) {
  const seen = new WeakSet();
  const replacer = (_key, val) => {
    if (val instanceof Map) return Object.fromEntries(val);
    if (val instanceof Set) return [...val];
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "function") return undefined;
    return val;
  };
  try {
    return JSON.parse(JSON.stringify(value, replacer));
  } catch {
    return { unserializable: true };
  }
}

export { DEFAULT_PORT as CONTROL_PLANE_DEFAULT_PORT };
