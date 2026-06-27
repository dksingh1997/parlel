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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Fleet, resolveServiceNames } from "./fleet.mjs";

// ── service selection ────────────────────────────────────────────────────────
const argServices = process.argv.slice(2);
const envServices = (process.env.SERVICES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function resolveServices() {
  let names = argServices.length ? argServices : envServices;
  names = await resolveServiceNames(names);
  if (!names.length) {
    // Sensible default for a bare `node src/launch.mjs`.
    names = ["postgres", "redis"];
    log(
      "no SERVICES specified — starting postgres,redis. " +
        'Set SERVICES="stripe,openai,..." or SERVICES=all for more.',
    );
  }
  return names;
}

function log(line, service) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}]${service ? ` ${service}` : ""} ${line}\n`);
}

// Load declarative fixtures (parlel.fixtures.json in cwd, or PARLEL_FIXTURES path)
// and seed() each running service from them. Never fatal.
async function loadFixtures(fleet) {
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
  for (const r of fleet.loadFixtures(fixtures)) {
    if (r.ok) log(`fixtures: seeded ${r.slug}`);
    else log(`fixtures: ${r.slug} — ${r.reason}`, r.slug);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const services = await resolveServices();
  const fleet = new Fleet({ log });
  await fleet.startControlPlane();
  log(`starting ${services.length} service(s)…`);

  let ok = 0;
  for (const name of services) {
    const r = await fleet.startService(name);
    if (r.ok) ok++;
    else log(`✗ failed to start: ${r.reason}`, name);
  }

  await loadFixtures(fleet);

  log(`ready — ${ok}/${services.length} services up`);

  process.on("SIGINT", async () => {
    log("shutting down…");
    await fleet.stopAll();
    process.exit(0);
  });
}

main().catch((err) => {
  log(`fatal: ${err?.message || err}`);
  process.exit(1);
});
