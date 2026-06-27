// Parlel — control plane.
//
// A single, additive admin HTTP server (default localhost:4600) that sits
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
import { dashboardHtml } from "./dashboard.mjs";

// 4600 sits just below the dense 4.7k–4.9k service-port band; the `ec2` emulator
// owns 4700, so the control plane must not default there.
const DEFAULT_PORT = 4600;

export class ControlPlaneServer {
  constructor(port = DEFAULT_PORT, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.server = null;
    // slug -> { server, manifest, startedAt }
    this.registry = new Map();
  }

  // Called by the launcher for each emulator it successfully starts.
  // `log` is an optional RequestLog (request recorder); may be undefined.
  register(slug, server, manifest = {}, log = null) {
    this.registry.set(slug, { server, manifest, startedAt: Date.now(), log });
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
        requests: !!entry.log,
      },
      connection_string: connectionString(slug, protocol, port, this.host),
    };
  }

  list() {
    return [...this.registry.keys()].sort().map((slug) => this.describe(slug));
  }

  apiIndex() {
    return {
      name: "parlel-control-plane",
      services: this.registry.size,
      dashboard: "GET / (in a browser)",
      endpoints: [
        "GET /healthz",
        "GET /services",
        "GET /services/:slug",
        "GET /services/:slug/state",
        "GET /services/:slug/requests",
        "POST /services/:slug/reset",
        "POST /services/:slug/seed",
        "POST /reset",
      ],
    };
  }

  // ── routing ─────────────────────────────────────────────────────────────────
  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method || "GET";

    if (method === "OPTIONS") return this.send(res, 204, null);

    // GET / — serve the HTML dashboard to browsers (Accept: text/html), and the
    // JSON API index to programmatic clients (fetch/curl/SDKs send Accept: */*).
    if (method === "GET" && parts.length === 0) {
      const accept = req.headers.accept || "";
      if (accept.includes("text/html")) return this.sendHtml(res, 200, dashboardHtml());
      return this.send(res, 200, this.apiIndex());
    }

    // GET /api — always the JSON index, regardless of Accept.
    if (method === "GET" && parts[0] === "api" && parts.length === 1) {
      return this.send(res, 200, this.apiIndex());
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
      // GET /services/:slug/requests
      if (method === "GET" && parts[2] === "requests" && parts.length === 3) {
        if (!entry.log) {
          return this.send(res, 501, { error: "not supported", detail: `request recording is off for ${slug}` });
        }
        const q = url.searchParams;
        const requests = entry.log.query({
          since: q.has("since") ? Number(q.get("since")) : undefined,
          method: q.get("method") || undefined,
          path: q.get("path") || undefined,
          limit: q.has("limit") ? Number(q.get("limit")) : undefined,
        });
        return this.send(res, 200, { slug, count: requests.length, requests });
      }
      // POST /services/:slug/reset
      if (method === "POST" && parts[2] === "reset" && parts.length === 3) {
        if (typeof entry.server.reset !== "function") {
          return this.send(res, 501, { error: "not supported", detail: `${slug} does not implement reset()` });
        }
        try {
          entry.server.reset();
          entry.log?.clear();
        } catch (err) {
          return this.send(res, 500, { error: "reset failed", detail: String(err?.message || err) });
        }
        return this.send(res, 200, { ok: true, slug });
      }
      // POST /services/:slug/seed
      if (method === "POST" && parts[2] === "seed" && parts.length === 3) {
        if (typeof entry.server.seed !== "function") {
          return this.send(res, 501, { error: "not supported", detail: `${slug} does not implement seed()` });
        }
        let data;
        try {
          data = await readJsonBody(req);
        } catch {
          return this.send(res, 400, { error: "invalid JSON body" });
        }
        try {
          const result = entry.server.seed(data);
          return this.send(res, 200, { ok: true, slug, seeded: result ?? null });
        } catch (err) {
          return this.send(res, 500, { error: "seed failed", detail: String(err?.message || err) });
        }
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
        entry.log?.clear();
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

  sendHtml(res, status, html) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }
}

// Read and JSON-parse a request body. Empty body → {}.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
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
