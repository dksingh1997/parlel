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
    log(`✓ ${name} → localhost:${port}`, null);
    return true;
  } catch (err) {
    log(`✗ failed to start: ${err?.message || err}`, name);
    return false;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const services = await resolveServices();
  log(`starting ${services.length} service(s)…`);

  let ok = 0;
  for (const name of services) {
    if (await startService(name)) ok++;
  }

  log(`ready — ${ok}/${services.length} services up`);

  // Keep the process alive while servers are listening.
  process.on("SIGINT", async () => {
    log("shutting down…");
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
