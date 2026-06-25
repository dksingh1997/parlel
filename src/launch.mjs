#!/usr/bin/env node
// Parlel — local launcher.
//
// Starts the requested service emulators, each on its canonical port, with
// plain Node (the emulators are dependency-free — no npm install needed).
//
// Usage:
//   node src/launch.mjs postgres redis stripe
//   SERVICES=postgres,redis,stripe node src/launch.mjs
//   SERVICES=all node src/launch.mjs
//
// Point your app's existing config at localhost:<port> and use unmodified real
// drivers (psycopg, stripe-node, redis, ...). Same code as production; only the
// endpoint changes.

import { readFile, readdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneServer, CONTROL_PLANE_DEFAULT_PORT } from "./control-plane.mjs";
import { RequestLog, attachRecorder, recordingEnabled } from "./request-recorder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, "..", "services");

// ── service selection ────────────────────────────────────────────────────────
const argServices = process.argv.slice(2);
const envServices = (process.env.SERVICES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function resolveServices() {
  let names = argServices.length ? argServices : envServices;
  names = names.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 1 && names[0] === "all") {
    names = (await readdir(SERVICES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
  if (!names.length) {
    // Sensible default for a bare `node src/launch.mjs`.
    names = ["postgres", "redis"];
    log(
      "no SERVICES specified — starting postgres,redis. " +
        'Set SERVICES="stripe,openai,..." or SERVICES=all for more.',
    );
  }
  return [...new Set(names)];
}

// ── helpers ──────────────────────────────────────────────────────────────────
function log(line, service) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}]${service ? ` ${service}` : ""} ${line}\n`);
}

async function manifestFor(name) {
  try {
    return JSON.parse(
      await readFile(join(SERVICES_DIR, name, "manifest.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

// Each emulator exports a `*Server` class (or a default). Pick it.
function pickServerClass(mod) {
  const candidates = Object.entries(mod).filter(
    ([key, value]) => typeof value === "function" && /Server$/.test(key),
  );
  if (candidates.length) return candidates[0][1];
  if (typeof mod.default === "function") return mod.default;
  return null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

const running = [];
const startedByName = new Map();
let controlPlane = null;

async function startService(name) {
  const manifest = await manifestFor(name);
  if (!manifest) {
    log(`unknown service (no services/${name}/manifest.json)`, name);
    return false;
  }
  const port = manifest.port;
  const protocol = manifest.protocol || "tcp";
  if (protocol === "embedded" || !port) {
    log(`embedded service (no network port) — skipping listener`, name);
    return true;
  }
  if (!(await isPortFree(port))) {
    log(`port ${port} already in use — skipping`, name);
    return false;
  }
  try {
    const mod = await import(join(SERVICES_DIR, name, "src", "server.js"));
    const Ctor = pickServerClass(mod);
    if (!Ctor) throw new Error("no server class exported");
    // Postgres/MySQL take seeded credentials; everything else defaults.
    const options =
      name === "postgres" || name === "mysql"
        ? { user: "parlel", password: "parlel", database: "parlel" }
        : {};
    const server = new Ctor(port, options);
    await Promise.race([
      Promise.resolve(server.start()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("start timed out")), 8000),
      ),
    ]);
    running.push(server);
    // Install the request recorder on the emulator's HTTP server (no emulator
    // code changes). Only HTTP/https services have a recordable request surface.
    let reqLog = null;
    if (recordingEnabled() && (protocol === "http" || protocol === "https") && server.server) {
      reqLog = new RequestLog();
      attachRecorder(server.server, reqLog);
    }
    controlPlane?.register(name, server, manifest, reqLog);
    startedByName.set(name, server);
    log(`✓ ${name} → localhost:${port}`, null);
    return true;
  } catch (err) {
    log(`✗ failed to start: ${err?.message || err}`, name);
    return false;
  }
}

// Start the control plane (additive admin port). Opt out with PARLEL_CONTROL=0.
// Port via PARLEL_CONTROL_PORT (default 4600). A bind failure is non-fatal —
// the emulators still run; only the admin surface is unavailable.
async function startControlPlane() {
  if (process.env.PARLEL_CONTROL === "0") return null;
  const port = Number(process.env.PARLEL_CONTROL_PORT) || CONTROL_PLANE_DEFAULT_PORT;
  if (!(await isPortFree(port))) {
    log(`control plane port ${port} in use — skipping admin API`);
    return null;
  }
  const cp = new ControlPlaneServer(port);
  try {
    await cp.start();
    log(`control plane → localhost:${port}`);
    return cp;
  } catch (err) {
    log(`control plane failed to start: ${err?.message || err} — continuing without it`);
    return null;
  }
}

// Load declarative fixtures (parlel.fixtures.json in cwd, or PARLEL_FIXTURES
// path) and seed() each running service from them. A service without seed(),
// or not currently running, is skipped with a log line — never fatal.
async function loadFixtures() {
  const path = process.env.PARLEL_FIXTURES || join(process.cwd(), "parlel.fixtures.json");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return; // no fixtures file — nothing to do
  }
  let fixtures;
  try {
    fixtures = JSON.parse(raw);
  } catch (err) {
    log(`fixtures: ${path} is not valid JSON (${err?.message || err}) — skipping`);
    return;
  }
  for (const [name, data] of Object.entries(fixtures)) {
    const server = startedByName.get(name);
    if (!server) {
      log(`fixtures: ${name} not running — skipping its fixtures`, name);
      continue;
    }
    if (typeof server.seed !== "function") {
      log(`fixtures: ${name} does not implement seed() — skipping`, name);
      continue;
    }
    try {
      server.seed(data);
      log(`fixtures: seeded ${name}`, null);
    } catch (err) {
      log(`fixtures: seeding ${name} failed: ${err?.message || err}`, name);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const services = await resolveServices();
  controlPlane = await startControlPlane();
  log(`starting ${services.length} service(s)…`);

  let ok = 0;
  for (const name of services) {
    if (await startService(name)) ok++;
  }

  await loadFixtures();

  log(`ready — ${ok}/${services.length} services up`);

  // Keep the process alive while servers are listening.
  process.on("SIGINT", async () => {
    log("shutting down…");
    try {
      await controlPlane?.stop();
    } catch {
      /* ignore */
    }
    for (const s of running) {
      try {
        await s.stop?.();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  });
}

main().catch((err) => {
  log(`fatal: ${err?.message || err}`);
  process.exit(1);
});
