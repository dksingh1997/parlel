// Parlel — Fleet.
//
// The reusable engine that starts/stops emulator instances on their canonical
// ports, wires up the request recorder and control plane, and seeds fixtures.
// Shared by the launcher (src/launch.mjs) and the MCP server (src/mcp.mjs) so
// they behave identically.
//
// Pure Node built-ins only — same zero-dependency rule as the emulators.

import { readFile, readdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneServer, CONTROL_PLANE_DEFAULT_PORT } from "./control-plane.mjs";
import { RequestLog, attachRecorder, recordingEnabled } from "./request-recorder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, "..", "services");

// Expand a list of names (or ["all"]) into a concrete, de-duped service list.
export async function resolveServiceNames(names) {
  let list = (names || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (list.length === 1 && list[0] === "all") {
    list = (await readdir(SERVICES_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
  return [...new Set(list)];
}

async function manifestFor(name) {
  try {
    return JSON.parse(await readFile(join(SERVICES_DIR, name, "manifest.json"), "utf8"));
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

export class Fleet {
  // log: optional (line, service?) => void sink. Defaults to a no-op so the MCP
  // server never writes to stdout (which would corrupt its JSON-RPC stream).
  constructor({ log } = {}) {
    this.log = typeof log === "function" ? log : () => {};
    this.running = new Map(); // slug -> server instance
    this.controlPlane = null;
  }

  // Start the additive control-plane admin server. Opt out with PARLEL_CONTROL=0.
  // Non-fatal: a bind failure just means no admin API.
  async startControlPlane(port = Number(process.env.PARLEL_CONTROL_PORT) || CONTROL_PLANE_DEFAULT_PORT) {
    if (process.env.PARLEL_CONTROL === "0") return null;
    if (!(await isPortFree(port))) {
      this.log(`control plane port ${port} in use — skipping admin API`);
      return null;
    }
    const cp = new ControlPlaneServer(port);
    try {
      await cp.start();
      this.controlPlane = cp;
      this.log(`control plane → localhost:${port}`);
      return cp;
    } catch (err) {
      this.log(`control plane failed to start: ${err?.message || err} — continuing without it`);
      return null;
    }
  }

  // Start one service on its canonical port. Returns
  // { ok, slug, port, protocol, connection_string?, reason? }.
  async startService(name) {
    const slug = String(name).trim().toLowerCase();
    if (this.running.has(slug)) {
      const port = this.running.get(slug).port;
      return { ok: true, slug, port, already: true };
    }
    const manifest = await manifestFor(slug);
    if (!manifest) return { ok: false, slug, reason: `unknown service (no services/${slug}/manifest.json)` };

    const port = manifest.port;
    const protocol = manifest.protocol || "tcp";
    if (protocol === "embedded" || !port) {
      return { ok: true, slug, port: null, protocol, embedded: true };
    }
    if (!(await isPortFree(port))) {
      return { ok: false, slug, port, protocol, reason: `port ${port} already in use` };
    }
    try {
      const mod = await import(join(SERVICES_DIR, slug, "src", "server.js"));
      const Ctor = pickServerClass(mod);
      if (!Ctor) throw new Error("no server class exported");
      const options =
        slug === "postgres" || slug === "mysql"
          ? { user: "parlel", password: "parlel", database: "parlel" }
          : {};
      const server = new Ctor(port, options);
      await Promise.race([
        Promise.resolve(server.start()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("start timed out")), 8000)),
      ]);

      // Install the request recorder on the emulator's HTTP server (no emulator
      // code changes). Only HTTP/https services have a recordable surface.
      let reqLog = null;
      if (recordingEnabled() && (protocol === "http" || protocol === "https") && server.server) {
        reqLog = new RequestLog();
        attachRecorder(server.server, reqLog);
      }
      this.controlPlane?.register(slug, server, manifest, reqLog);
      this.running.set(slug, server);
      this.log(`✓ ${slug} → localhost:${port}`);
      const detail = this.controlPlane?.describe(slug);
      return {
        ok: true,
        slug,
        port,
        protocol,
        connection_string: detail?.connection_string ?? null,
      };
    } catch (err) {
      return { ok: false, slug, port, protocol, reason: err?.message || String(err) };
    }
  }

  async startMany(names) {
    const results = [];
    for (const name of await resolveServiceNames(names)) {
      results.push(await this.startService(name));
    }
    return results;
  }

  async stopService(slug) {
    slug = String(slug).trim().toLowerCase();
    const server = this.running.get(slug);
    if (!server) return { ok: false, slug, reason: "not running" };
    try {
      await server.stop?.();
    } catch {
      /* ignore */
    }
    this.controlPlane?.unregister(slug);
    this.running.delete(slug);
    return { ok: true, slug };
  }

  async stopAll() {
    const slugs = [...this.running.keys()];
    for (const slug of slugs) await this.stopService(slug);
    try {
      await this.controlPlane?.stop();
    } catch {
      /* ignore */
    }
    this.controlPlane = null;
    return slugs;
  }

  // Seed a running service. Returns { ok, slug, seeded? , reason? }.
  seedService(slug, data) {
    slug = String(slug).trim().toLowerCase();
    const server = this.running.get(slug);
    if (!server) return { ok: false, slug, reason: "not running" };
    if (typeof server.seed !== "function") return { ok: false, slug, reason: "does not support seed" };
    try {
      const seeded = server.seed(data);
      return { ok: true, slug, seeded: seeded ?? null };
    } catch (err) {
      return { ok: false, slug, reason: err?.message || String(err) };
    }
  }

  // Load a declarative fixtures object ({ slug: data, ... }) into running services.
  loadFixtures(fixtures) {
    const out = [];
    for (const [slug, data] of Object.entries(fixtures || {})) {
      out.push(this.seedService(slug, data));
    }
    return out;
  }

  list() {
    return this.controlPlane ? this.controlPlane.list() : [...this.running.keys()].map((slug) => ({ slug }));
  }

  getServer(slug) {
    return this.running.get(String(slug).trim().toLowerCase());
  }
}
