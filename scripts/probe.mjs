// Boot-and-probe every Parlel service one-by-one.
//
// 1. Reads every services/<slug>/manifest.json (port + protocol + healthcheck).
// 2. The launcher (src/launch.mjs) has already started all of them.
// 3. HTTP services: GET the healthcheck path, expect any HTTP response (2xx ideal).
//    TCP services: open a real driver connection + a minimal round-trip.
//    Embedded (sqlite): marked N/A (no network surface).
// 4. Prints a pass/fail table and exits non-zero if anything failed.

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, "..", "services");
const HOST = "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manifest-only stubs that are intentionally NOT launchable services (no
// src/server.js, and absent from the API catalog). The real implementations are
// the versioned variants (apigateway-v1 / apigateway-v2).
const NOT_A_SERVICE = new Set(["apigateway"]);

async function manifests() {
  const out = [];
  for (const slug of (await readdir(SERVICES_DIR)).sort()) {
    if (NOT_A_SERVICE.has(slug)) continue;
    try {
      const m = JSON.parse(await readFile(join(SERVICES_DIR, slug, "manifest.json"), "utf8"));
      out.push({ slug, port: m.port, protocol: m.protocol || "tcp", healthcheck: m.healthcheck || "/health" });
    } catch {
      out.push({ slug, port: 0, protocol: "?", healthcheck: null, badManifest: true });
    }
  }
  return out;
}

function httpProbe(port, path) {
  return new Promise((resolve) => {
    const p = path.startsWith("/") ? path : `/${path}`;
    const req = http.request({ host: HOST, port, path: p, method: "GET", timeout: 8000 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ ok: res.statusCode < 500, detail: `HTTP ${res.statusCode}` }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, detail: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, detail: e.code || e.message }));
    req.end();
  });
}

function tcpConnect(port) {
  return new Promise((resolve) => {
    const s = createConnection({ host: HOST, port, timeout: 8000 }, () => { s.destroy(); resolve({ ok: true, detail: "tcp connect" }); });
    s.on("timeout", () => { s.destroy(); resolve({ ok: false, detail: "timeout" }); });
    s.on("error", (e) => resolve({ ok: false, detail: e.code || e.message }));
  });
}

// Real-driver round-trips for the 7 TCP services (drivers installed in the image).
async function driverProbe(slug, port) {
  try {
    switch (slug) {
      case "postgres": {
        const { default: pg } = await import("pg");
        const c = new pg.Client({ host: HOST, port, user: "parlel", password: "parlel", database: "parlel" });
        await c.connect(); const r = await c.query("SELECT 1 AS x"); await c.end();
        return { ok: r.rows?.[0]?.x == 1, detail: "psql SELECT 1" };
      }
      case "redis": {
        const { createClient } = await import("redis");
        const c = createClient({ socket: { host: HOST, port } }); await c.connect();
        const pong = await c.ping(); await c.set("k", "v"); const v = await c.get("k"); await c.quit();
        return { ok: pong === "PONG" && v === "v", detail: "PING/SET/GET" };
      }
      case "mysql": {
        const mysql = await import("mysql2/promise");
        const c = await mysql.createConnection({ host: HOST, port, user: "parlel", password: "parlel", database: "parlel" });
        const [rows] = await c.query("SELECT 1 AS x"); await c.end();
        return { ok: rows?.[0]?.x == 1, detail: "SELECT 1" };
      }
      case "mongodb": {
        const { MongoClient } = await import("mongodb");
        const c = new MongoClient(`mongodb://${HOST}:${port}`, { serverSelectionTimeoutMS: 6000 });
        await c.connect(); await c.db("parlel").command({ ping: 1 }); await c.close();
        return { ok: true, detail: "ping" };
      }
      case "kafka": {
        const { Kafka } = await import("kafkajs");
        const k = new Kafka({ brokers: [`${HOST}:${port}`], logLevel: 0 });
        const admin = k.admin(); await admin.connect(); await admin.listTopics(); await admin.disconnect();
        return { ok: true, detail: "admin.listTopics" };
      }
      case "rabbitmq": {
        const amqp = await import("amqplib");
        const conn = await amqp.connect(`amqp://parlel:parlel@${HOST}:${port}`);
        const ch = await conn.createChannel(); await ch.assertQueue("probe"); await ch.close(); await conn.close();
        return { ok: true, detail: "assertQueue" };
      }
      case "cassandra": {
        const cassandra = await import("cassandra-driver");
        const client = new cassandra.Client({ contactPoints: [HOST], localDataCenter: "datacenter1", protocolOptions: { port } });
        await client.connect(); await client.execute("SELECT release_version FROM system.local"); await client.shutdown();
        return { ok: true, detail: "system.local" };
      }
      default:
        return tcpConnect(port);
    }
  } catch (e) {
    return { ok: false, detail: (e.code || e.message || String(e)).slice(0, 80) };
  }
}

async function probe(svc) {
  if (svc.protocol === "embedded") return { ...svc, ok: true, detail: "embedded (no network)", skipped: true };
  if (svc.badManifest || !svc.port) return { ...svc, ok: false, detail: "bad manifest" };
  if (svc.protocol === "http" || svc.protocol === "https") {
    const r = await httpProbe(svc.port, svc.healthcheck);
    return { ...svc, ...r };
  }
  // tcp — try a real driver round-trip, fall back to plain connect
  const r = await driverProbe(svc.slug, svc.port);
  return { ...svc, ...r };
}

async function main() {
  const svcs = await manifests();
  // Give the launcher a moment to bind everything.
  await sleep(Number(process.env.PROBE_WARMUP_MS || 4000));

  const results = [];
  for (const s of svcs) {
    let r = await probe(s);
    // one retry for transient cold-start
    if (!r.ok && !r.skipped) { await sleep(800); r = await probe(s); }
    results.push(r);
    const mark = r.skipped ? "○" : r.ok ? "✓" : "✗";
    process.stdout.write(`${mark} ${s.slug.padEnd(28)} ${String(s.port).padEnd(6)} ${s.protocol.padEnd(9)} ${r.detail}\n`);
  }

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const passed = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log("\n──────────────────────────────────────────");
  console.log(`TOTAL ${results.length}   PASS ${passed.length}   FAIL ${failed.length}   SKIP ${skipped.length}`);
  if (failed.length) {
    console.log("\nFAILURES:");
    for (const f of failed) console.log(`  ✗ ${f.slug} (:${f.port} ${f.protocol}) — ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
