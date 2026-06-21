import { describe, it, expect } from "vitest";

describe("Kafka Service", () => {
  it("should have valid manifest", async () => {
    const { readFile } = await import("fs/promises");
    const manifest = JSON.parse(
      await readFile(new URL("../manifest.json", import.meta.url), "utf-8")
    );

    expect(manifest.name).toBe("kafka");
    expect(manifest.port).toBe(9092);
    expect(manifest.protocol).toBe("tcp");
    expect(manifest.healthcheck).toContain("broker-api-versions");
  });

  it("should have Dockerfile", async () => {
    const { readFile } = await import("fs/promises");
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf-8");

    expect(dockerfile).toContain("FROM node:20-alpine");
    expect(dockerfile).toContain("EXPOSE 9092");
  });
});
