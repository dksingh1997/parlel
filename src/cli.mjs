#!/usr/bin/env node
// Parlel — command-line interface.
//
// `parlel <command> [args]` — the muscle-memory front door to Parlel.
//
//   parlel up [services...] [-d]   start services (foreground, or -d detached)
//   parlel down                    stop the detached fleet
//   parlel status                  table of running services (via control plane)
//   parlel ls [filter]             list all available services + ports
//   parlel reset [slug]            wipe state (one service, or all)
//   parlel inspect <slug>          show a service's detail / request log / state
//   parlel seed <file>             load a fixtures JSON into running services
//   parlel logs [-f]               show (or follow) the detached fleet log
//   parlel doctor                  preflight: node, control plane, ports, docker
//   parlel help | --version
//
// Pure Node built-ins only — same zero-dependency rule as the emulators.

import { readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVICES_DIR = join(ROOT, "services");
const LAUNCHER = join(__dirname, "launch.mjs");

const STATE_DIR = process.env.PARLEL_STATE_DIR || join(homedir(), ".parlel");
const STATE_FILE = join(STATE_DIR, "daemon.json");
const LOG_FILE = join(STATE_DIR, "daemon.log");

const DEFAULT_CONTROL_PORT = Number(process.env.PARLEL_CONTROL_PORT) || 4600;

// Manifest-only stubs that are not launchable services (mirrors probe.mjs).
const NOT_A_SERVICE = new Set(["apigateway"]);

// ── tiny output helpers ──────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const color = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => color("2", s);
const bold = (s) => color("1", s);
const green = (s) => color("32", s);
const red = (s) => color("31", s);
const yellow = (s) => color("33", s);
const cyan = (s) => color("36", s);

function out(line = "") {
  process.stdout.write(line + "\n");
}
function err(line = "") {
  process.stderr.write(line + "\n");
}

// ── arg parsing ──────────────────────────────────────────────────────────────
// Returns { command, args, flags }. Flags: -d/--detach, -f/--follow, --help,
// --version, --port <n>, --json. Everything else is a positional arg.
export function parseArgs(argv) {
  const flags = {};
  const args = [];
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-d" || a === "--detach") flags.detach = true;
    else if (a === "-f" || a === "--follow") flags.follow = true;
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--port") flags.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) flags.port = Number(a.slice(7));
    else if (command === null && !a.startsWith("-")) command = a;
    else args.push(a);
  }
  return { command, args, flags };
}

// ── service catalog (for `ls`) ───────────────────────────────────────────────
export async function listServices() {
  const out = [];
  for (const slug of (await readdir(SERVICES_DIR)).sort()) {
    if (NOT_A_SERVICE.has(slug)) continue;
    try {
      const m = JSON.parse(await readFile(join(SERVICES_DIR, slug, "manifest.json"), "utf8"));
      out.push({ slug, port: m.port ?? null, protocol: m.protocol || "tcp", category: m.category || "other" });
    } catch {
      /* skip unreadable manifest */
    }
  }
  return out;
}

// Filter by substring against slug, category, or protocol — so `ls payments`,
// `ls stripe`, and `ls http` all work.
export function filterServices(services, term) {
  if (!term) return services;
  const t = term.toLowerCase();
  return services.filter(
    (s) => s.slug.includes(t) || (s.category && s.category.includes(t)) || s.protocol.includes(t),
  );
}

// ── table formatting ─────────────────────────────────────────────────────────
// rows: array of arrays (strings). headers: array of strings.
export function formatTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(String(r[i] ?? "")).length)),
  );
  const pad = (s, w) => {
    const visible = stripAnsi(String(s)).length;
    return String(s) + " ".repeat(Math.max(0, w - visible));
  };
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  const head = line(headers.map((h) => bold(h)));
  const body = rows.map(line);
  return [head, ...body].join("\n");
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// ── daemon state ─────────────────────────────────────────────────────────────
async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
async function clearState() {
  await rm(STATE_FILE, { force: true });
}
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Resolve the control-plane port: explicit flag > daemon state > env/default.
async function resolveControlPort(flags) {
  if (flags?.port) return flags.port;
  const state = await readState();
  if (state?.controlPort && pidAlive(state.pid)) return state.controlPort;
  return DEFAULT_CONTROL_PORT;
}

// ── control-plane HTTP client ────────────────────────────────────────────────
function cp(method, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 5000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = buf ? JSON.parse(buf) : null;
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode, json, raw: buf });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("control plane timeout"));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function controlReachable(port) {
  try {
    const r = await cp("GET", port, "/healthz");
    return r.status === 200;
  } catch {
    return false;
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });
}

// ── commands ─────────────────────────────────────────────────────────────────
async function cmdLs(args) {
  const services = filterServices(await listServices(), args[0]);
  if (!services.length) {
    out(dim(args[0] ? `No services match "${args[0]}".` : "No services found."));
    return 0;
  }
  const rows = services.map((s) => [
    s.slug,
    s.port == null ? dim("—") : String(s.port),
    s.protocol,
    dim(s.category || ""),
  ]);
  out(formatTable(["SERVICE", "PORT", "PROTOCOL", "CATEGORY"], rows));
  out(dim(`\n${services.length} service${services.length === 1 ? "" : "s"}`));
  return 0;
}

async function cmdUp(args, flags) {
  const services = args.length ? args : (process.env.SERVICES ? process.env.SERVICES.split(",") : []);
  const env = { ...process.env };
  if (services.length) env.SERVICES = services.join(",");

  if (!flags.detach) {
    // Foreground: hand off to the launcher, inheriting stdio.
    const child = spawn(process.execPath, [LAUNCHER], { env, stdio: "inherit" });
    return await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
  }

  // Detached: refuse if a live daemon already exists.
  const existing = await readState();
  if (existing && pidAlive(existing.pid)) {
    err(yellow(`parlel: a detached fleet is already running (pid ${existing.pid}). Run \`parlel down\` first.`));
    return 1;
  }
  const controlPort = flags.port || DEFAULT_CONTROL_PORT;
  env.PARLEL_CONTROL_PORT = String(controlPort);

  await mkdir(STATE_DIR, { recursive: true });
  const { open } = await import("node:fs/promises");
  const logHandle = await open(LOG_FILE, "w");
  const child = spawn(process.execPath, [LAUNCHER], {
    env,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await writeState({
    pid: child.pid,
    controlPort,
    services,
    startedAt: Date.now(),
    log: LOG_FILE,
  });
  await logHandle.close();

  // Wait for the control plane to come up so `up -d` only returns on success.
  const ok = await waitForControl(controlPort, 8000);
  if (!ok) {
    err(red("parlel: fleet did not become healthy in time — check `parlel logs`."));
    return 1;
  }
  out(green(`parlel: fleet started (pid ${child.pid}), control plane on localhost:${controlPort}.`));
  out(dim("Use `parlel status` to see services, `parlel down` to stop."));
  return 0;
}

async function waitForControl(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await controlReachable(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function cmdDown() {
  const state = await readState();
  if (!state) {
    out(dim("parlel: no detached fleet is running."));
    return 0;
  }
  if (!pidAlive(state.pid)) {
    await clearState();
    out(dim("parlel: detached fleet was not running (cleaned up stale state)."));
    return 0;
  }
  try {
    process.kill(state.pid, "SIGINT");
  } catch {
    /* already gone */
  }
  // Wait for it to actually exit.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && pidAlive(state.pid)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await clearState();
  out(green("parlel: fleet stopped."));
  return 0;
}

async function cmdStatus(flags) {
  const port = await resolveControlPort(flags);
  let r;
  try {
    r = await cp("GET", port, "/services");
  } catch {
    err(red(`parlel: control plane not reachable on localhost:${port}.`));
    err(dim("Is a fleet running? Start one with `parlel up -d`."));
    return 1;
  }
  const services = r.json?.services || [];
  if (flags.json) {
    out(JSON.stringify(services, null, 2));
    return 0;
  }
  if (!services.length) {
    out(dim("No services running."));
    return 0;
  }
  const rows = services.map((s) => [
    green("●") + " " + s.slug,
    String(s.port ?? "—"),
    s.protocol,
    fmtUptime(s.uptime_ms || 0),
    capList(s.supports),
    dim(s.connection_string || ""),
  ]);
  out(formatTable(["SERVICE", "PORT", "PROTO", "UPTIME", "CAPS", "CONNECTION"], rows));
  out(dim(`\n${services.length} service${services.length === 1 ? "" : "s"} · control plane :${port}`));
  return 0;
}

function capList(supports) {
  if (!supports) return "";
  return Object.entries(supports)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(",");
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

async function cmdReset(args, flags) {
  const port = await resolveControlPort(flags);
  const slug = args[0];
  try {
    if (slug) {
      const r = await cp("POST", port, `/services/${slug}/reset`);
      if (r.status === 404) return fail(`unknown service "${slug}"`);
      if (r.status === 501) return fail(`${slug} does not support reset`);
      if (r.status !== 200) return fail(`reset failed (HTTP ${r.status})`);
      out(green(`parlel: reset ${slug}.`));
    } else {
      const r = await cp("POST", port, "/reset");
      if (r.status !== 200) return fail(`reset failed (HTTP ${r.status})`);
      const n = r.json?.reset?.length ?? 0;
      out(green(`parlel: reset ${n} service${n === 1 ? "" : "s"}.`));
    }
    return 0;
  } catch {
    return controlUnreachable(port);
  }
}

async function cmdInspect(args, flags) {
  const slug = args[0];
  if (!slug) return fail("usage: parlel inspect <slug>");
  const port = await resolveControlPort(flags);
  let detail, requests, state;
  try {
    const d = await cp("GET", port, `/services/${slug}`);
    if (d.status === 404) return fail(`unknown service "${slug}"`);
    detail = d.json;
    if (detail?.supports?.requests) {
      const rq = await cp("GET", port, `/services/${slug}/requests?limit=10`);
      requests = rq.json?.requests || [];
    }
    if (detail?.supports?.dump) {
      const st = await cp("GET", port, `/services/${slug}/state`);
      if (st.status === 200) state = st.json?.state;
    }
  } catch {
    return controlUnreachable(port);
  }
  if (flags.json) {
    out(JSON.stringify({ detail, requests, state }, null, 2));
    return 0;
  }
  out(bold(slug) + dim(`  (${detail.protocol} :${detail.port})`));
  out(`  connection: ${cyan(detail.connection_string || "—")}`);
  out(`  uptime:     ${fmtUptime(detail.uptime_ms || 0)}`);
  out(`  supports:   ${capList(detail.supports) || dim("none")}`);
  if (requests) {
    out("");
    out(bold(`  recent requests (${requests.length})`));
    if (!requests.length) out(dim("    none recorded yet"));
    for (const r of requests.slice(-10)) {
      const st = r.status < 400 ? green(String(r.status)) : red(String(r.status));
      out(`    ${r.method.padEnd(6)} ${r.path}  ${st} ${dim((r.durationMs ?? 0) + "ms")}`);
    }
  }
  if (state !== undefined) {
    out("");
    out(bold("  state"));
    out(
      JSON.stringify(state, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
  }
  return 0;
}

async function cmdSeed(args, flags) {
  const file = args[0];
  if (!file) return fail("usage: parlel seed <fixtures.json>");
  let fixtures;
  try {
    fixtures = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    return fail(`cannot read fixtures: ${e.message}`);
  }
  const port = await resolveControlPort(flags);
  let any = false;
  for (const [slug, data] of Object.entries(fixtures)) {
    try {
      const r = await cp("POST", port, `/services/${slug}/seed`, data);
      if (r.status === 200) {
        out(green(`  ✓ seeded ${slug}`) + dim(`  ${JSON.stringify(r.json?.seeded ?? {})}`));
        any = true;
      } else if (r.status === 404) {
        out(yellow(`  • ${slug} not running — skipped`));
      } else if (r.status === 501) {
        out(yellow(`  • ${slug} does not support seed — skipped`));
      } else {
        out(red(`  ✗ ${slug} seed failed (HTTP ${r.status})`));
      }
    } catch {
      return controlUnreachable(port);
    }
  }
  return any ? 0 : 1;
}

async function cmdLogs(flags) {
  const state = await readState();
  if (!state) return fail("no detached fleet — start one with `parlel up -d`");
  const logPath = state.log || LOG_FILE;
  try {
    await stat(logPath);
  } catch {
    return fail("no log file yet");
  }
  if (!flags.follow) {
    out(await readFile(logPath, "utf8"));
    return 0;
  }
  // Follow: print existing, then poll for appended bytes.
  const existing = await readFile(logPath, "utf8");
  process.stdout.write(existing);
  let pos = Buffer.byteLength(existing);
  return await new Promise((resolve) => {
    const timer = setInterval(async () => {
      try {
        const buf = await readFile(logPath);
        if (buf.length > pos) {
          process.stdout.write(buf.subarray(pos));
          pos = buf.length;
        }
      } catch {
        /* file rotated/removed */
      }
    }, 400);
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve(0);
    });
  });
}

async function cmdDoctor() {
  out(bold("parlel doctor"));
  let ok = true;

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 20) {
    out(`  ${green("✓")} Node ${process.versions.node} (>= 20)`);
  } else {
    ok = false;
    out(`  ${red("✗")} Node ${process.versions.node} — Parlel needs >= 20`);
  }

  // Control plane / detached fleet
  const state = await readState();
  if (state && pidAlive(state.pid)) {
    const reachable = await controlReachable(state.controlPort);
    out(
      `  ${reachable ? green("✓") : red("✗")} detached fleet pid ${state.pid}, control plane :${state.controlPort} ${reachable ? "reachable" : "UNREACHABLE"}`,
    );
    if (!reachable) ok = false;
  } else {
    out(`  ${dim("○")} no detached fleet running`);
    const free = await isPortFree(DEFAULT_CONTROL_PORT);
    out(
      `  ${free ? green("✓") : yellow("!")} control-plane port ${DEFAULT_CONTROL_PORT} ${free ? "free" : "in use (will skip admin API)"}`,
    );
  }

  // Docker (optional)
  const docker = await commandExists("docker");
  out(`  ${docker ? green("✓") : dim("○")} docker ${docker ? "available" : "not found (optional — `parlel up` works without it)"}`);

  out("");
  out(ok ? green("All required checks passed.") : red("Some checks failed (see above)."));
  return ok ? 0 : 1;
}

function commandExists(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

// ── helpers for command results ──────────────────────────────────────────────
function fail(msg) {
  err(red(`parlel: ${msg}`));
  return 1;
}
function controlUnreachable(port) {
  err(red(`parlel: control plane not reachable on localhost:${port}.`));
  err(dim("Is a fleet running? Start one with `parlel up -d`."));
  return 1;
}

// ── help / version ───────────────────────────────────────────────────────────
async function version() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    out(pkg.version);
  } catch {
    out("unknown");
  }
  return 0;
}

function help() {
  out(`${bold("parlel")} — 250+ local service emulators speaking real wire protocols

${bold("USAGE")}
  parlel <command> [args]

${bold("COMMANDS")}
  up [services...] [-d]   Start services (foreground, or -d for detached)
  down                    Stop the detached fleet
  status [--json]         Show running services (table)
  ls [filter]             List all available services + ports
  reset [slug]            Reset state for one service, or all
  inspect <slug> [--json] Show a service's detail, request log, and state
  seed <file>             Load a fixtures JSON into running services
  logs [-f]               Show (or follow with -f) the detached fleet log
  doctor                  Preflight checks
  help                    Show this help
  --version               Print version

${bold("EXAMPLES")}
  parlel up postgres redis stripe      # foreground
  parlel up stripe -d                  # detached
  parlel status
  parlel ls payments
  parlel reset stripe
  parlel inspect stripe
  parlel down

${dim("Control plane: http://localhost:4600  (open in a browser for the dashboard)")}
`);
  return 0;
}

// ── router ───────────────────────────────────────────────────────────────────
export async function run(argv) {
  const { command, args, flags } = parseArgs(argv);

  if (flags.version) return version();
  if (flags.help || command === "help" || !command) return help();

  switch (command) {
    case "up":
      return cmdUp(args, flags);
    case "down":
      return cmdDown();
    case "status":
      return cmdStatus(flags);
    case "ls":
    case "list":
      return cmdLs(args);
    case "reset":
      return cmdReset(args, flags);
    case "inspect":
      return cmdInspect(args, flags);
    case "seed":
      return cmdSeed(args, flags);
    case "logs":
      return cmdLogs(flags);
    case "doctor":
      return cmdDoctor();
    default:
      err(red(`parlel: unknown command "${command}"`));
      err(dim("Run `parlel help` for usage."));
      return 1;
  }
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((e) => {
      err(red(`parlel: ${e?.message || e}`));
      process.exit(1);
    });
}
