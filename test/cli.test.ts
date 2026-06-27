// CLI tests. Two layers:
//   1. Unit — pure exported helpers (parseArgs, listServices, filterServices, formatTable).
//   2. Integration — spawn the REAL `parlel` CLI (src/cli.mjs) and exercise the full
//      detached lifecycle: up -d → status → seed → inspect → reset → logs → down.
// Uses an isolated PARLEL_STATE_DIR and a free control port so it never collides.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, listServices, filterServices, formatTable } from "../src/cli.mjs";
import { getFreePort } from "../src/test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const CLI = join(REPO, "src", "cli.mjs");

// Run the CLI once, capture stdout/stderr/exit. Strip ANSI for assertions.
function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code: code ?? 0, out: strip(out), err: strip(err) }));
  });
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── unit ──────────────────────────────────────────────────────────────────────
describe("cli — parseArgs", () => {
  it("parses command, args, and flags", () => {
    expect(parseArgs(["up", "stripe", "redis", "-d"])).toEqual({
      command: "up",
      args: ["stripe", "redis"],
      flags: { detach: true },
    });
    expect(parseArgs(["status", "--json"])).toEqual({ command: "status", args: [], flags: { json: true } });
    expect(parseArgs(["--version"])).toEqual({ command: null, args: [], flags: { version: true } });
    expect(parseArgs(["up", "--port", "4733"])).toEqual({ command: "up", args: [], flags: { port: 4733 } });
    expect(parseArgs(["up", "--port=4733"])).toEqual({ command: "up", args: [], flags: { port: 4733 } });
    expect(parseArgs([])).toEqual({ command: null, args: [], flags: {} });
  });
});

describe("cli — listServices + filterServices", () => {
  it("lists the catalog with port/protocol/category", async () => {
    const all = await listServices();
    expect(all.length).toBeGreaterThan(200);
    const stripe = all.find((s) => s.slug === "stripe");
    expect(stripe).toMatchObject({ slug: "stripe", port: 4757, protocol: "http", category: "payments" });
    // apigateway stub is excluded.
    expect(all.find((s) => s.slug === "apigateway")).toBeUndefined();
    // every service has a category (manifests were backfilled).
    expect(all.every((s) => typeof s.category === "string" && s.category.length > 0)).toBe(true);
  });

  it("filters by category, slug, and protocol", async () => {
    const all = await listServices();
    const payments = filterServices(all, "payments");
    expect(payments.length).toBeGreaterThan(5);
    expect(payments.every((s) => s.category === "payments")).toBe(true);
    expect(payments.find((s) => s.slug === "stripe")).toBeTruthy();

    const tcp = filterServices(all, "tcp");
    expect(tcp.every((s) => s.protocol === "tcp")).toBe(true);
    expect(tcp.find((s) => s.slug === "postgres")).toBeTruthy();

    expect(filterServices(all, "stripe").map((s) => s.slug)).toContain("stripe");
    expect(filterServices(all, "")).toHaveLength(all.length);
  });
});

describe("cli — formatTable", () => {
  it("aligns columns and is ANSI-width aware", () => {
    const t = formatTable(["A", "BB"], [["x", "yy"], ["longer", "z"]]);
    const lines = strip(t).split("\n");
    expect(lines).toHaveLength(3);
    // header + 2 rows; columns padded to widest cell.
    expect(lines[1]).toContain("x");
    expect(lines[2]).toContain("longer");
  });
});

// ── integration (spawned CLI) ─────────────────────────────────────────────────
describe("cli — read-only commands", () => {
  it("--version prints the package version", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("help lists the commands", async () => {
    const r = await runCli(["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    for (const cmd of ["up", "down", "status", "ls", "reset", "inspect", "seed", "doctor"]) {
      expect(r.out).toContain(cmd);
    }
  });

  it("ls payments lists the payments category", async () => {
    const r = await runCli(["ls", "payments"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("stripe");
    expect(r.out).toContain("payments");
  });

  it("unknown command exits non-zero", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown command");
  });

  it("status with no fleet fails gracefully", async () => {
    const r = await runCli(["status", "--port", "65500"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not reachable");
  });

  it("doctor passes on a supported node", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Node");
  });
});

describe("cli — detached lifecycle", () => {
  let stateDir: string;
  let controlPort: number;
  let env: Record<string, string>;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "parlel-cli-"));
    controlPort = await getFreePort();
    env = { PARLEL_STATE_DIR: stateDir, PARLEL_CONTROL_PORT: String(controlPort), PARLEL_RECORD: "1" };
  });

  afterAll(async () => {
    // Best-effort stop, then clean state.
    await runCli(["down"], env);
    await rm(stateDir, { recursive: true, force: true });
  });

  it("up -d → status → seed → inspect → reset → logs → down", async () => {
    // up -d
    const up = await runCli(["up", "stripe", "--port", String(controlPort), "-d"], env);
    expect(up.code, up.err).toBe(0);
    expect(up.out).toContain("fleet started");

    // status
    const status = await runCli(["status", "--port", String(controlPort)], env);
    expect(status.code).toBe(0);
    expect(status.out).toContain("stripe");
    expect(status.out).toContain("http://127.0.0.1:");

    // status --json is valid JSON listing stripe
    const statusJson = await runCli(["status", "--port", String(controlPort), "--json"], env);
    const parsed = JSON.parse(statusJson.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((s: any) => s.slug === "stripe")).toBeTruthy();

    // seed
    const fixFile = join(stateDir, "fix.json");
    await writeFile(fixFile, JSON.stringify({ stripe: { customers: [{ id: "cus_cli", email: "cli@x.com" }] } }));
    const seed = await runCli(["seed", fixFile, "--port", String(controlPort)], env);
    expect(seed.code).toBe(0);
    expect(seed.out).toContain("seeded stripe");

    // Hit the seeded customer via the real Stripe API so inspect has a request to show.
    const stripePort = parsed.find((s: any) => s.slug === "stripe").port;
    const get = await fetch(`http://127.0.0.1:${stripePort}/v1/customers/cus_cli`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    });
    expect(get.status).toBe(200);
    expect((await get.json()).email).toBe("cli@x.com");

    // inspect
    const inspect = await runCli(["inspect", "stripe", "--port", String(controlPort)], env);
    expect(inspect.code).toBe(0);
    expect(inspect.out).toContain("connection:");
    expect(inspect.out).toContain("/v1/customers/cus_cli");

    // reset (and verify the customer is gone)
    const reset = await runCli(["reset", "stripe", "--port", String(controlPort)], env);
    expect(reset.code).toBe(0);
    const gone = await fetch(`http://127.0.0.1:${stripePort}/v1/customers/cus_cli`, {
      headers: { Authorization: "Bearer sk_test_parlel" },
    });
    expect(gone.status).toBe(404);

    // logs
    const logs = await runCli(["logs"], env);
    expect(logs.code).toBe(0);
    expect(logs.out).toContain("control plane");

    // down
    const down = await runCli(["down"], env);
    expect(down.code).toBe(0);
    expect(down.out).toContain("stopped");

    // status now fails (fleet down)
    const after = await runCli(["status", "--port", String(controlPort)], env);
    expect(after.code).toBe(1);
  });

  it("down with no fleet is a no-op (exit 0)", async () => {
    const r = await runCli(["down"], env);
    expect(r.code).toBe(0);
  });

  it("reset unknown service fails", async () => {
    // Bring a fleet up briefly to have a control plane to talk to.
    await runCli(["up", "redis", "--port", String(controlPort), "-d"], env);
    const r = await runCli(["reset", "nope-not-real", "--port", String(controlPort)], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown service");
    await runCli(["down"], env);
  });
});
