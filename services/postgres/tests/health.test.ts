import { describe, it, expect } from "vitest";

describe("Postgres Service", () => {
  it("should have valid manifest", async () => {
    const { readFile } = await import("fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf-8")
    );

    expect(manifest.name).toBe("postgres");
    expect(manifest.port).toBe(5432);
    expect(manifest.protocol).toBe("tcp");
    expect(manifest.healthcheck).toBe("SELECT 1");
  });

  it("should have seed script", async () => {
    const { readFile } = await import("fs/promises");
    const seed = await readFile(new URL("../seed/seed.sql", import.meta.url), "utf-8");

    expect(seed).toContain("CREATE TABLE IF NOT EXISTS users");
    expect(seed).toContain("CREATE TABLE IF NOT EXISTS posts");
  });

  it("should have Dockerfile", async () => {
    const { readFile } = await import("fs/promises");
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf-8");

    expect(dockerfile).toContain("FROM node:20-alpine");
    expect(dockerfile).toContain("EXPOSE 5432");
  });
});
