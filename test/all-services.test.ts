// All-services boot test. Boots EVERY networked service one by one on a free
// port, registers it with a control plane, and asserts the control plane (and
// therefore `parlel status`) reports it healthy with correct metadata. This is
// the broad "does the whole catalog still come up" guard.
//
// Services are booted in-process on getFreePort() ports (not their fixed
// canonical ports) so 250 servers don't fight over fixed ports or the control
// plane's own port. Each is started, health-probed, registered, then stopped —
// so peak resource use stays low.

import { describe, it, expect, beforeAll } from "vitest";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlaneServer } from "../src/control-plane.mjs";
import { getFreePort } from "../src/test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = join(__dirname, "..", "services");

// Mirrors probe.mjs / cli.mjs: manifest-only stub, not launchable.
const NOT_A_SERVICE = new Set(["apigateway"]);

type Svc = { slug: string; protocol: string; port: number | null };

async function loadCatalog(): Promise<Svc[]> {
  const out: Svc[] = [];
  for (const slug of (await readdir(SERVICES_DIR)).sort()) {
    if (NOT_A_SERVICE.has(slug)) continue;
    try {
      const m = JSON.parse(await readFile(join(SERVICES_DIR, slug, "manifest.json"), "utf8"));
      out.push({ slug, protocol: m.protocol || "tcp", port: m.port ?? null });
    } catch {
      /* skip */
    }
  }
  return out;
}

function pickServerClass(mod: Record<string, unknown>): unknown {
  const c = Object.entries(mod).find(([k, v]) => typeof v === "function" && /Server$/.test(k));
  if (c) return c[1];
  if (typeof mod.default === "function") return mod.default;
  return null;
}

async function hasServerFile(slug: string): Promise<boolean> {
  try {
    await stat(join(SERVICES_DIR, slug, "src", "server.js"));
    return true;
  } catch {
    return false;
  }
}

let catalog: Svc[];

beforeAll(async () => {
  catalog = await loadCatalog();
});

describe("all services boot and register with the control plane", () => {
  it("every networked service starts on a free port and is reported healthy", async () => {
    const cpPort = await getFreePort();
    const cp = new ControlPlaneServer(cpPort);
    await cp.start();

    const failures: string[] = [];
    const registered: string[] = [];

    try {
      for (const svc of catalog) {
        if (svc.protocol === "embedded") continue; // no network listener
        if (!(await hasServerFile(svc.slug))) {
          failures.push(`${svc.slug}: no src/server.js`);
          continue;
        }
        let server: any;
        let boundPort = 0;
        try {
          const mod = (await import(join(SERVICES_DIR, svc.slug, "src", "server.js"))) as Record<string, unknown>;
          const Ctor = pickServerClass(mod) as any;
          if (typeof Ctor !== "function") {
            failures.push(`${svc.slug}: no *Server class`);
            continue;
          }
          // postgres/mysql take seeded creds, matching the launcher.
          const opts =
            svc.slug === "postgres" || svc.slug === "mysql"
              ? { user: "parlel", password: "parlel", database: "parlel" }
              : {};
          // Allocate-and-bind with retry: under full-suite load a just-freed port
          // can be grabbed before start() binds it (EADDRINUSE race). Retry a few
          // times before declaring a real failure.
          for (let attempt = 0; attempt < 6 && !boundPort; attempt++) {
            const port = await getFreePort();
            const candidate = new Ctor(port, opts);
            try {
              await candidate.start();
              server = candidate;
              boundPort = port;
            } catch (err: any) {
              if (err?.code === "EADDRINUSE") {
                try {
                  await candidate.stop?.();
                } catch {
                  /* ignore */
                }
                continue;
              }
              throw err;
            }
          }
          if (!boundPort) {
            failures.push(`${svc.slug}: could not bind a free port after retries`);
            continue;
          }

          // Register and confirm the control plane describes it correctly.
          cp.register(svc.slug, server, { name: svc.slug, port: boundPort, protocol: svc.protocol });
          const res = await fetch(`http://127.0.0.1:${cpPort}/services/${svc.slug}`);
          if (res.status !== 200) {
            failures.push(`${svc.slug}: control plane returned ${res.status}`);
          } else {
            const body = await res.json();
            if (body.slug !== svc.slug) failures.push(`${svc.slug}: slug mismatch (${body.slug})`);
            if (typeof body.uptime_ms !== "number") failures.push(`${svc.slug}: no uptime`);
            registered.push(svc.slug);
          }
        } catch (e: any) {
          failures.push(`${svc.slug}: ${(e?.message || e).toString().slice(0, 80)}`);
        } finally {
          // Stop immediately so we never hold 250 servers at once.
          try {
            await server?.stop?.();
          } catch {
            /* ignore */
          }
          cp.unregister(svc.slug);
        }
      }
    } finally {
      await cp.stop();
    }

    // Expect the vast majority to boot; report any that didn't.
    expect(registered.length).toBeGreaterThan(230);
    expect(failures, `services that failed to boot/register:\n${failures.join("\n")}`).toEqual([]);
  }, 120000);

  it("the CLI catalog matches the on-disk services (minus the apigateway stub)", async () => {
    const { listServices } = await import("../src/cli.mjs");
    const cliList = await listServices();
    const cliSlugs = new Set(cliList.map((s: any) => s.slug));
    const diskSlugs = catalog.map((s) => s.slug);
    const missing = diskSlugs.filter((s) => !cliSlugs.has(s));
    expect(missing, `services on disk but missing from CLI ls: ${missing.join(", ")}`).toEqual([]);
    // Every CLI entry has port (or null for embedded) + protocol + category.
    for (const s of cliList) {
      expect(typeof s.protocol).toBe("string");
      expect(typeof s.category).toBe("string");
    }
  });
});
