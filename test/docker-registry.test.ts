import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { DockerRegistryServer } from "../services/docker-registry/src/server.js";

const PORT = 14775;
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: BodyInit, headers: Json = {}) {
  const response = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  return { status: response.status, body: parsed, raw: text, headers: response.headers };
}

describe("Docker Registry Service", () => {
  let server: DockerRegistryServer;

  beforeAll(async () => {
    server = new DockerRegistryServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("docker-registry");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("V2 API version check", () => {
    it("GET /v2/ returns 200 with empty object", async () => {
      const res = await api("GET", "/v2/");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
      expect(res.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
    });
  });

  describe("Catalog", () => {
    it("GET /v2/_catalog lists repositories", async () => {
      const res = await api("GET", "/v2/_catalog");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.repositories)).toBe(true);
      expect(res.body.repositories).toContain("library/hello-world");
    });
  });

  describe("Tags", () => {
    it("GET /v2/:name/tags/list lists tags", async () => {
      const res = await api("GET", "/v2/library/hello-world/tags/list");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("library/hello-world");
      expect(res.body.tags).toContain("latest");
    });

    it("404 for unknown repo tags", async () => {
      const res = await api("GET", "/v2/nope/tags/list");
      expect(res.status).toBe(404);
    });
  });

  describe("Manifests", () => {
    it("GET manifest returns Docker-Content-Digest", async () => {
      const res = await api("GET", "/v2/library/hello-world/manifests/latest");
      expect(res.status).toBe(200);
      expect(res.headers.get("docker-content-digest")).toMatch(/^sha256:/);
    });

    it("HEAD manifest returns 200 with digest", async () => {
      const res = await api("HEAD", "/v2/library/hello-world/manifests/latest");
      expect(res.status).toBe(200);
      expect(res.headers.get("docker-content-digest")).toMatch(/^sha256:/);
    });

    it("PUT manifest pushes and is retrievable", async () => {
      const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.v2+json", layers: [] });
      const put = await api("PUT", "/v2/my/app/manifests/v1.0", manifest, {
        "Content-Type": "application/vnd.docker.distribution.manifest.v2+json",
      });
      expect(put.status).toBe(201);
      const digest = put.headers.get("docker-content-digest");
      expect(digest).toMatch(/^sha256:/);

      const tags = await api("GET", "/v2/my/app/tags/list");
      expect(tags.body.tags).toContain("v1.0");

      const got = await api("GET", "/v2/my/app/manifests/v1.0");
      expect(got.status).toBe(200);
      expect(got.headers.get("docker-content-digest")).toBe(digest);
    });

    it("404 for unknown manifest", async () => {
      const res = await api("GET", "/v2/library/hello-world/manifests/missing");
      expect(res.status).toBe(404);
      expect(res.body.errors[0].code).toBe("MANIFEST_UNKNOWN");
    });
  });

  describe("Blob uploads", () => {
    it("POST starts an upload session (202 + Location)", async () => {
      const res = await api("POST", "/v2/my/app/blobs/uploads/");
      expect(res.status).toBe(202);
      expect(res.headers.get("location")).toContain("/blobs/uploads/");
      expect(res.headers.get("docker-upload-uuid")).toBeTruthy();
    });

    it("PUT completes upload and the blob is pullable", async () => {
      const start = await api("POST", "/v2/my/app/blobs/uploads/");
      const location = start.headers.get("location")!;
      const blob = "layer-bytes";
      const put = await api("PUT", `${location}?digest=sha256:abc`, blob, { "Content-Type": "application/octet-stream" });
      expect(put.status).toBe(201);
      const digest = put.headers.get("docker-content-digest");
      expect(digest).toBeTruthy();

      const pull = await api("GET", `/v2/my/app/blobs/${digest}`);
      expect(pull.status).toBe(200);
      expect(pull.raw).toBe(blob);
    });
  });
});
