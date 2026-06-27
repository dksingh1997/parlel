// MCP server tests. Spawns the REAL parlel MCP server (src/mcp.mjs) and drives it
// over stdio JSON-RPC exactly as an MCP client would: initialize handshake →
// tools/list → tools/call. Covers the full agent verify loop (start → seed → run
// real code → get_requests → reset → stop) and the protocol error paths.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../src/test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP = join(__dirname, "..", "src", "mcp.mjs");

// Minimal MCP-over-stdio client for tests.
class McpClient {
  proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number | string, (msg: any) => void>();
  private nextId = 1;

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [MCP], { env: { ...process.env, ...env } }) as ChildProcessWithoutNullStreams;
    this.proc.stdout.on("data", (d) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    this.proc.stderr.on("data", () => {}); // logs go to stderr; ignore
  }

  request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: any) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  writeRaw(line: string) {
    this.proc.stdin.write(line + "\n");
  }

  // Wait for the first reply with id===null (used for the parse-error case).
  onceNullId(): Promise<any> {
    return new Promise((resolve) => {
      this.pending.set(null as any, resolve);
    });
  }

  async call(name: string, args: any = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    return res.result;
  }
  // Parse the JSON text payload from a tool result.
  static payload(result: any) {
    return JSON.parse(result.content[0].text);
  }

  async close() {
    this.proc.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 100));
    if (!this.proc.killed) this.proc.kill("SIGKILL");
  }
}

let client: McpClient;
let controlPort: number;

beforeAll(async () => {
  controlPort = await getFreePort();
  client = new McpClient({ PARLEL_CONTROL_PORT: String(controlPort) });
  // Handshake.
  const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  expect(init.result.serverInfo.name).toBe("parlel");
  client.notify("notifications/initialized");
});

afterAll(async () => {
  await client.close();
});

describe("mcp — protocol", () => {
  it("initialize returns protocol version, tools capability, and instructions", async () => {
    const r = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    expect(r.result.protocolVersion).toBe("2024-11-05");
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.instructions).toContain("parlel_start_services");
  });

  it("echoes a supported newer protocol version", async () => {
    const r = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(r.result.protocolVersion).toBe("2025-06-18");
  });

  it("falls back to a stable version for an unknown one", async () => {
    const r = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    expect(r.result.protocolVersion).toBe("2024-11-05");
  });

  it("tools/list returns all 8 parlel tools with input schemas", async () => {
    const r = await client.request("tools/list");
    const tools = r.result.tools;
    expect(tools).toHaveLength(8);
    const names = tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "parlel_get_requests",
      "parlel_inspect",
      "parlel_list_services",
      "parlel_reset",
      "parlel_seed",
      "parlel_start_services",
      "parlel_status",
      "parlel_stop_services",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("unknown method returns JSON-RPC -32601", async () => {
    const r = await client.request("does/not/exist");
    expect(r.error.code).toBe(-32601);
  });

  it("ping returns an empty result", async () => {
    const r = await client.request("ping");
    expect(r.result).toEqual({});
  });
});

describe("mcp — tools", () => {
  it("parlel_list_services lists and filters the catalog", async () => {
    const all = McpClient.payload(await client.call("parlel_list_services"));
    expect(all.count).toBeGreaterThan(200);
    const payments = McpClient.payload(await client.call("parlel_list_services", { filter: "payments" }));
    expect(payments.services.every((s: any) => s.category === "payments")).toBe(true);
    expect(payments.services.find((s: any) => s.slug === "stripe")).toBeTruthy();
  });

  it("unknown tool returns an isError result (not a protocol error)", async () => {
    const r = await client.call("parlel_does_not_exist");
    expect(r.isError).toBe(true);
  });

  it("parlel_get_requests on a non-running service is a friendly error", async () => {
    const r = await client.call("parlel_get_requests", { slug: "stripe" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not running");
  });

  it("full agent loop: start → seed → run code → get_requests → reset → stop", async () => {
    // start
    const start = McpClient.payload(await client.call("parlel_start_services", { slugs: ["stripe"] }));
    expect(start.started).toHaveLength(1);
    const port = start.started[0].port;
    expect(start.started[0].connection_string).toBe(`http://127.0.0.1:${port}`);

    // seed
    const seed = McpClient.payload(
      await client.call("parlel_seed", { slug: "stripe", data: { customers: [{ id: "cus_mcp", email: "mcp@x.com" }] } }),
    );
    expect(seed.seeded.customers).toBe(1);

    // run "agent code": hit the real Stripe API surface
    const got = await fetch(`http://127.0.0.1:${port}/v1/customers/cus_mcp`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    });
    expect(got.status).toBe(200);
    expect((await got.json()).email).toBe("mcp@x.com");
    await fetch(`http://127.0.0.1:${port}/v1/customers`, {
      method: "POST",
      headers: { Authorization: "Bearer sk_test_parlel", "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=created@x.com",
    });

    // verify loop: get_requests
    const reqs = McpClient.payload(await client.call("parlel_get_requests", { slug: "stripe" }));
    expect(reqs.count).toBe(2);
    const posts = McpClient.payload(await client.call("parlel_get_requests", { slug: "stripe", method: "POST" }));
    expect(posts.count).toBe(1);
    expect(posts.requests[0].path).toBe("/v1/customers");

    // status sees it
    const status = McpClient.payload(await client.call("parlel_status"));
    expect(status.services.find((s: any) => s.slug === "stripe")).toBeTruthy();

    // inspect
    const inspect = McpClient.payload(await client.call("parlel_inspect", { slug: "stripe" }));
    expect(inspect.detail.slug).toBe("stripe");
    expect(inspect.requests.length).toBeGreaterThan(0);

    // reset wipes state
    const reset = McpClient.payload(await client.call("parlel_reset", { slug: "stripe" }));
    expect(reset.reset).toContain("stripe");
    const gone = await fetch(`http://127.0.0.1:${port}/v1/customers/cus_mcp`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    });
    expect(gone.status).toBe(404);

    // stop
    const stop = McpClient.payload(await client.call("parlel_stop_services"));
    expect(stop.stopped).toContain("stripe");

    // status now empty
    const after = McpClient.payload(await client.call("parlel_status"));
    expect(after.services.find((s: any) => s.slug === "stripe")).toBeFalsy();
  });

  it("start reports failures for unknown services", async () => {
    const r = McpClient.payload(await client.call("parlel_start_services", { slugs: ["nope-not-real"] }));
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].slug).toBe("nope-not-real");
  });

  it("start with no slugs is an isError result", async () => {
    const r = await client.call("parlel_start_services", { slugs: [] });
    expect(r.isError).toBe(true);
  });
});
