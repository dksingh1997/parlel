#!/usr/bin/env node
// Parlel — MCP server.
//
// Exposes Parlel to AI agents over the Model Context Protocol (newline-delimited
// JSON-RPC 2.0 on stdio). An agent can start exactly the services its code
// touches, run the code, READ THE REQUEST LOG to verify what its code actually
// did, reset between iterations, and tear down — all locally, free, no secrets.
//
// The server manages its own in-process fleet (it imports Fleet directly), so an
// agent needs nothing running beforehand: `parlel_start_services(["stripe"])`
// just works.
//
// Pure Node built-ins only — same zero-dependency rule as the emulators. stdout
// is reserved for the JSON-RPC stream; all logging goes to stderr.

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fleet } from "./fleet.mjs";
import { listServices, filterServices } from "./cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Protocol version we speak. We echo the client's requested version when it is a
// version we recognize; otherwise we offer this stable one.
const PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

function logErr(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

async function serverVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "parlel_list_services",
    description:
      "List the available Parlel service emulators (250+) with port, protocol, and category. Optionally filter by a term matching slug, category (e.g. 'payments', 'ai', 'databases'), or protocol.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string", description: "Optional filter: slug, category, or protocol." } },
    },
  },
  {
    name: "parlel_start_services",
    description:
      "Start one or more service emulators on their canonical localhost ports and return how to connect (connection strings / base URLs). Point your unmodified production driver at these. Use 'all' to start everything.",
    inputSchema: {
      type: "object",
      properties: {
        slugs: { type: "array", items: { type: "string" }, description: "Service slugs to start, e.g. ['stripe','postgres']." },
      },
      required: ["slugs"],
    },
  },
  {
    name: "parlel_stop_services",
    description: "Stop running service emulators. Omit 'slugs' to stop the entire fleet.",
    inputSchema: {
      type: "object",
      properties: { slugs: { type: "array", items: { type: "string" }, description: "Slugs to stop; omit for all." } },
    },
  },
  {
    name: "parlel_status",
    description: "List the currently running services with their port, protocol, uptime, capabilities, and connection string.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "parlel_get_requests",
    description:
      "Read the recorded request log for a running HTTP service — every call the emulator received (method, path, status, body, timing). This closes the verify loop: after running your code, read this to assert what your code actually sent. Optionally filter by method/path.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug, e.g. 'stripe'." },
        method: { type: "string", description: "Optional HTTP method filter, e.g. 'POST'." },
        path: { type: "string", description: "Optional path prefix filter, e.g. '/v1/charges'." },
      },
      required: ["slug"],
    },
  },
  {
    name: "parlel_reset",
    description: "Reset in-memory state to a clean slate. Pass a slug to reset one service, or omit to reset all running services. Use between agent iterations / test cases.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Service to reset; omit for all." } },
    },
  },
  {
    name: "parlel_seed",
    description:
      "Preload fixture data into a running service so it isn't empty (e.g. a Stripe customer to charge). The 'data' shape is per-service — for stripe: { customers:[...], products:[...], prices:[...] }; for redis: { key: value }.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Service slug, e.g. 'stripe'." },
        data: { type: "object", description: "Per-service fixture payload." },
      },
      required: ["slug", "data"],
    },
  },
  {
    name: "parlel_inspect",
    description: "Show a running service's detail: connection string, uptime, capabilities, recent requests, and state (when the emulator exposes it).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Service slug." } },
      required: ["slug"],
    },
  },
];

// ── MCP server ────────────────────────────────────────────────────────────────
export class ParlelMcpServer {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.fleet = new Fleet({ log: (line) => logErr("[fleet]", line) });
    this.initialized = false;
    this.controlPort = null;
  }

  async start() {
    // Bring up the control plane once so request logs / connection strings work.
    const cp = await this.fleet.startControlPlane();
    this.controlPort = cp?.port ?? null;

    this.rl = createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleLine(trimmed).catch((err) => logErr("[mcp] handler error:", err?.message || err));
    });

    // Clean shutdown when the client disconnects or we're asked to stop.
    const shutdown = async () => {
      try {
        await this.fleet.stopAll();
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    this.input.on("close", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    logErr("[mcp] parlel MCP server ready on stdio");
  }

  send(message) {
    this.output.write(JSON.stringify(message) + "\n");
  }

  reply(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  replyError(id, code, message) {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Parse error — id unknown per JSON-RPC.
      return this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const { id, method, params } = msg;
    // Notifications have no id and expect no response.
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize":
          return this.reply(id, await this.onInitialize(params));
        case "notifications/initialized":
          this.initialized = true;
          return; // notification, no reply
        case "ping":
          return this.reply(id, {});
        case "tools/list":
          return this.reply(id, { tools: TOOLS });
        case "tools/call":
          return this.reply(id, await this.onToolCall(params));
        default:
          if (isNotification) return;
          return this.replyError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (isNotification) return;
      return this.replyError(id, -32603, `Internal error: ${err?.message || err}`);
    }
  }

  async onInitialize(params) {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "parlel", version: await serverVersion() },
      instructions:
        "Parlel runs 250+ local service emulators speaking real wire protocols. " +
        "Workflow: parlel_start_services(['stripe']) → point your unmodified driver at the returned " +
        "connection string → run your code → parlel_get_requests('stripe') to verify what it sent → " +
        "parlel_reset() between iterations → parlel_stop_services() when done.",
    };
  }

  // Wrap a JS value as an MCP text-content tool result.
  static ok(value) {
    return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError: false };
  }
  static err(message) {
    return { content: [{ type: "text", text: message }], isError: true };
  }

  async onToolCall(params) {
    const name = params?.name;
    const args = params?.arguments || {};
    switch (name) {
      case "parlel_list_services": {
        const all = await listServices();
        const filtered = filterServices(all, args.filter);
        return ParlelMcpServer.ok({ count: filtered.length, services: filtered });
      }
      case "parlel_start_services": {
        if (!Array.isArray(args.slugs) || !args.slugs.length) return ParlelMcpServer.err("`slugs` must be a non-empty array.");
        const results = await this.fleet.startMany(args.slugs);
        const started = results.filter((r) => r.ok && !r.embedded);
        const failed = results.filter((r) => !r.ok);
        return ParlelMcpServer.ok({
          started: started.map((r) => ({ slug: r.slug, port: r.port, connection_string: r.connection_string, already: !!r.already })),
          embedded: results.filter((r) => r.embedded).map((r) => r.slug),
          failed: failed.map((r) => ({ slug: r.slug, reason: r.reason })),
        });
      }
      case "parlel_stop_services": {
        if (Array.isArray(args.slugs) && args.slugs.length) {
          const out = [];
          for (const s of args.slugs) out.push(await this.fleet.stopService(s));
          return ParlelMcpServer.ok({ stopped: out });
        }
        const slugs = await this.fleet.stopAll();
        // The control plane was stopped by stopAll(); bring it back for future calls.
        await this.fleet.startControlPlane(this.controlPort || undefined);
        return ParlelMcpServer.ok({ stopped: slugs });
      }
      case "parlel_status": {
        return ParlelMcpServer.ok({ services: this.fleet.list() });
      }
      case "parlel_get_requests": {
        if (!args.slug) return ParlelMcpServer.err("`slug` is required.");
        const port = this.controlPort;
        if (!port) return ParlelMcpServer.err("control plane is not available.");
        const qs = new URLSearchParams();
        if (args.method) qs.set("method", args.method);
        if (args.path) qs.set("path", args.path);
        const res = await fetch(`http://127.0.0.1:${port}/services/${args.slug}/requests?${qs}`);
        if (res.status === 404) return ParlelMcpServer.err(`Service "${args.slug}" is not running.`);
        if (res.status === 501) return ParlelMcpServer.err(`Request recording is off for "${args.slug}".`);
        const body = await res.json();
        return ParlelMcpServer.ok({ slug: args.slug, count: body.count, requests: body.requests });
      }
      case "parlel_reset": {
        if (args.slug) {
          const server = this.fleet.getServer(args.slug);
          if (!server) return ParlelMcpServer.err(`Service "${args.slug}" is not running.`);
          if (typeof server.reset !== "function") return ParlelMcpServer.err(`"${args.slug}" does not support reset.`);
          server.reset();
          return ParlelMcpServer.ok({ reset: [args.slug] });
        }
        const reset = [];
        for (const svc of this.fleet.list()) {
          const server = this.fleet.getServer(svc.slug);
          if (server && typeof server.reset === "function") {
            server.reset();
            reset.push(svc.slug);
          }
        }
        return ParlelMcpServer.ok({ reset });
      }
      case "parlel_seed": {
        if (!args.slug) return ParlelMcpServer.err("`slug` is required.");
        const r = this.fleet.seedService(args.slug, args.data || {});
        if (!r.ok) return ParlelMcpServer.err(`Cannot seed "${args.slug}": ${r.reason}`);
        return ParlelMcpServer.ok({ slug: args.slug, seeded: r.seeded });
      }
      case "parlel_inspect": {
        if (!args.slug) return ParlelMcpServer.err("`slug` is required.");
        const port = this.controlPort;
        const detailRes = port ? await fetch(`http://127.0.0.1:${port}/services/${args.slug}`) : null;
        if (!detailRes || detailRes.status === 404) return ParlelMcpServer.err(`Service "${args.slug}" is not running.`);
        const detail = await detailRes.json();
        let requests = [];
        let state;
        if (detail.supports?.requests) {
          const rq = await fetch(`http://127.0.0.1:${port}/services/${args.slug}/requests?limit=10`);
          if (rq.status === 200) requests = (await rq.json()).requests;
        }
        if (detail.supports?.dump) {
          const st = await fetch(`http://127.0.0.1:${port}/services/${args.slug}/state`);
          if (st.status === 200) state = (await st.json()).state;
        }
        return ParlelMcpServer.ok({ detail, requests, state });
      }
      default:
        return ParlelMcpServer.err(`Unknown tool: ${name}`);
    }
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const server = new ParlelMcpServer();
  server.start().catch((err) => {
    logErr("[mcp] fatal:", err?.message || err);
    process.exit(1);
  });
}
