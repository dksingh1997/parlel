import { describe, it, expect } from "vitest";

describe("Redis Service", () => {
  it("should have valid manifest", async () => {
    const { readFile } = await import("fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf-8")
    );

    expect(manifest.name).toBe("redis");
    expect(manifest.port).toBe(6379);
    expect(manifest.protocol).toBe("tcp");
    expect(manifest.healthcheck).toBe("PING");
  });

  it("should have redis config", async () => {
    const { readFile } = await import("fs/promises");
    const config = await readFile(new URL("../conf/redis.conf", import.meta.url), "utf-8");

    expect(config).toContain("maxmemory 128mb");
    expect(config).toContain("bind 0.0.0.0");
    expect(config).toContain("protected-mode no");
  });

  it("should have Dockerfile", async () => {
    const { readFile } = await import("fs/promises");
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf-8");

    expect(dockerfile).toContain("FROM node:20-alpine");
    expect(dockerfile).toContain("EXPOSE 6379");
  });
});
