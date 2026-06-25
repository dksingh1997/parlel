// Conformance meta-test — asserts every service implements the Parlel emulator
// contract the launcher, probe, and control plane rely on. This is the guard that
// prevents convention drift as the catalog grows (the apigateway-stub problem).
//
// Contract (see SKILL.md / CONTRIBUTING.md):
//   - services/<slug>/manifest.json is valid (name, port, protocol) and the port
//     is unique across the whole catalog.
//   - services/<slug>/src/server.js exports a `<Name>Server` class.
//   - That class implements `start()`, `stop()`, and `reset()` as functions.
//   - `reset()` is callable on a constructed instance without throwing (idempotent,
//     no I/O) — this is what makes per-test isolation and the control plane work.
//
// We validate the contract statically (no port binding) for the whole catalog, and
// then do a live boot → /health → reset() smoke test for a representative sample of
// HTTP services to prove the contract holds end to end.

import { describe, it, expect, beforeAll } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../src/test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, "..", "services");

// Manifest-only stubs that are intentionally NOT launchable services (no
// src/server.js). Mirrors scripts/probe.mjs NOT_A_SERVICE. The real impls are the
// versioned variants (apigateway-v1 / apigateway-v2).
const NOT_A_SERVICE = new Set(["apigateway"]);

// HTTP services chosen to span categories/authors for the live smoke test. Kept
// small so the suite stays fast and avoids port churn; the static checks cover all.
const LIVE_SAMPLE = [
  "stripe",
  "openai",
  "s3",
  "sendgrid",
  "elasticsearch",
  "supabase",
  "pinecone",
  "github",
];

type Manifest = {
  name?: string;
  port?: number;
  protocol?: string;
  category?: string;
  healthcheck?: string;
};

type Svc = {
  slug: string;
  manifest: Manifest;
  hasServer: boolean;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function loadServices(): Promise<Svc[]> {
  const entries = await readdir(SERVICES_DIR, { withFileTypes: true });
  const out: Svc[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (NOT_A_SERVICE.has(e.name)) continue;
    const slug = e.name;
    const manifestPath = join(SERVICES_DIR, slug, "manifest.json");
    let manifest: Manifest = {};
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      manifest = {};
    }
    const hasServer = await fileExists(join(SERVICES_DIR, slug, "src", "server.js"));
    out.push({ slug, manifest, hasServer });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// Pick the exported server class the same way src/launch.mjs does (/Server$/, else default).
function pickServerClass(mod: Record<string, unknown>): unknown {
  const candidate = Object.entries(mod).find(
    ([key, value]) => typeof value === "function" && /Server$/.test(key),
  );
  if (candidate) return candidate[1];
  if (typeof mod.default === "function") return mod.default;
  return null;
}

let services: Svc[];

beforeAll(async () => {
  services = await loadServices();
});

describe("catalog manifests", () => {
  it("loads a non-trivial number of services", () => {
    expect(services.length).toBeGreaterThan(200);
  });

  it("every service has a valid manifest (name, port, protocol)", () => {
    const bad: string[] = [];
    for (const s of services) {
      const m = s.manifest;
      const ok =
        typeof m.name === "string" &&
        m.name.length > 0 &&
        typeof m.protocol === "string" &&
        (m.protocol === "embedded" || typeof m.port === "number");
      if (!ok) bad.push(s.slug);
    }
    expect(bad, `services with invalid manifest: ${bad.join(", ")}`).toEqual([]);
  });

  it("manifest name matches the directory slug", () => {
    const mismatched = services
      .filter((s) => s.manifest.name && s.manifest.name !== s.slug)
      .map((s) => `${s.slug} (name=${s.manifest.name})`);
    expect(mismatched, `slug/name mismatches: ${mismatched.join(", ")}`).toEqual([]);
  });

  it("every service has a non-empty category (powers `parlel ls <category>`)", () => {
    const missing = services
      .filter((s) => typeof s.manifest.category !== "string" || s.manifest.category.length === 0)
      .map((s) => s.slug);
    expect(missing, `services missing category: ${missing.join(", ")}`).toEqual([]);
  });

  it("ports are unique across the whole catalog", () => {
    const byPort = new Map<number, string[]>();
    for (const s of services) {
      const port = s.manifest.port;
      if (typeof port !== "number") continue;
      const arr = byPort.get(port) || [];
      arr.push(s.slug);
      byPort.set(port, arr);
    }
    const collisions = [...byPort.entries()]
      .filter(([, slugs]) => slugs.length > 1)
      .map(([port, slugs]) => `port ${port}: ${slugs.join(", ")}`);
    expect(collisions, `port collisions:\n${collisions.join("\n")}`).toEqual([]);
  });
});

describe("emulator contract (static)", () => {
  it("every networked service ships src/server.js", () => {
    const missing = services
      .filter((s) => s.manifest.protocol !== "embedded" && !s.hasServer)
      .map((s) => s.slug);
    expect(missing, `networked services missing src/server.js: ${missing.join(", ")}`).toEqual([]);
  });

  it("every server.js exports a *Server class with start/stop/reset", async () => {
    const problems: string[] = [];
    for (const s of services) {
      if (!s.hasServer) continue;
      const modPath = join(SERVICES_DIR, s.slug, "src", "server.js");
      let mod: Record<string, unknown>;
      try {
        mod = (await import(modPath)) as Record<string, unknown>;
      } catch (err) {
        problems.push(`${s.slug}: import failed (${(err as Error).message})`);
        continue;
      }
      const Ctor = pickServerClass(mod) as { prototype?: Record<string, unknown> } | null;
      if (typeof Ctor !== "function") {
        problems.push(`${s.slug}: no *Server class exported`);
        continue;
      }
      for (const method of ["start", "stop", "reset"]) {
        if (typeof Ctor.prototype?.[method] !== "function") {
          problems.push(`${s.slug}: missing ${method}()`);
        }
      }
    }
    expect(problems, `contract problems:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("emulator contract (live smoke test)", () => {
  for (const slug of LIVE_SAMPLE) {
    it(`${slug}: boots, answers /health, and reset() is callable`, async () => {
      const modPath = join(SERVICES_DIR, slug, "src", "server.js");
      const mod = (await import(modPath)) as Record<string, unknown>;
      const Ctor = pickServerClass(mod) as new (port: number, options?: object) => {
        start(): Promise<void>;
        stop(): Promise<void>;
        reset(): void;
      };
      expect(typeof Ctor).toBe("function");

      const port = await getFreePort();
      const server = new Ctor(port, {});
      await server.start();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        // Any non-5xx response means the health surface is alive.
        expect(res.status).toBeLessThan(500);
        // reset() must be callable on a running instance without throwing.
        expect(() => server.reset()).not.toThrow();
      } finally {
        await server.stop();
      }
    });
  }
});
