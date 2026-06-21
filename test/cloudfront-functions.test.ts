import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudfrontFunctionsServer } from "../services/cloudfront-functions/src/server.js";

const PORT = 14713;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function jhr(method: string, path: string, body?: unknown) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function extract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

describe("CloudFront Functions Service", () => {
  let server: CloudfrontFunctionsServer;

  beforeAll(async () => {
    server = new CloudfrontFunctionsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("listens on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("uses default port 4713", () => {
      const s = new CloudfrontFunctionsServer();
      expect(s.port).toBe(4713);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("cloudfront-functions");
    });

    it("supports POST /_parlel/reset", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "reset-fn", FunctionCode: "" });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.functions.size).toBe(0);
    });
  });

  describe("Functions", () => {
    const code = "function handler(event){ event.request.uri = '/index.html'; return event.request; }";

    it("creates a function", async () => {
      const res = await jhr("POST", "/2020-05-31/function", {
        Name: "my-fn",
        FunctionConfig: { Comment: "c", Runtime: "cloudfront-js-2.0" },
        FunctionCode: code,
      });
      expect(res.status).toBe(201);
      expect(res.text).toContain("my-fn");
      expect(res.text).toContain("UNPUBLISHED");
    });

    it("rejects duplicate function", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "dup-fn", FunctionCode: code });
      const dup = await jhr("POST", "/2020-05-31/function", { Name: "dup-fn", FunctionCode: code });
      expect(dup.status).toBe(409);
      expect(dup.text).toContain("FunctionAlreadyExists");
    });

    it("lists functions", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "list-fn", FunctionCode: code });
      const res = await jhr("GET", "/2020-05-31/function");
      expect(res.text).toContain("list-fn");
    });

    it("describes a function", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "desc-fn", FunctionCode: code });
      const res = await jhr("GET", "/2020-05-31/function/desc-fn");
      expect(res.status).toBe(200);
      expect(res.text).toContain("desc-fn");
    });

    it("publishes a function", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "pub-fn", FunctionCode: code });
      const res = await jhr("POST", "/2020-05-31/function/pub-fn/publish");
      expect(res.status).toBe(200);
      expect(res.text).toContain("DEPLOYED");
      expect(res.text).toContain("LIVE");
    });

    it("tests a function and runs the handler", async () => {
      await jhr("POST", "/2020-05-31/function", { Name: "test-fn", FunctionCode: code });
      const res = await jhr("POST", "/2020-05-31/test-function", {
        Name: "test-fn",
        EventObject: JSON.stringify({ request: { uri: "/", method: "GET", headers: {} } }),
      });
      expect(res.status).toBe(200);
      const output = extract(res.text, "FunctionOutput")!;
      expect(output).toContain("/index.html");
    });

    it("errors describing a missing function", async () => {
      const res = await jhr("GET", "/2020-05-31/function/ghost");
      expect(res.status).toBe(404);
      expect(res.text).toContain("NoSuchFunctionExists");
    });
  });

  describe("Key value stores", () => {
    it("creates and lists a key value store", async () => {
      const res = await jhr("POST", "/2020-05-31/key-value-store", {
        Name: "my-kvs",
        Comment: "store",
      });
      expect(res.status).toBe(201);
      expect(res.text).toContain("my-kvs");
      expect(res.text).toContain("READY");

      const list = await jhr("GET", "/2020-05-31/key-value-store");
      expect(list.text).toContain("my-kvs");
    });

    it("puts and gets keys in a store", async () => {
      await jhr("POST", "/2020-05-31/key-value-store", { Name: "kv-data" });
      const put = await jhr("PUT", "/2020-05-31/key-value-store/kv-data/keys/color", {
        Value: "blue",
      });
      expect(put.status).toBe(200);
      const get = await jhr("GET", "/2020-05-31/key-value-store/kv-data/keys/color");
      expect(get.status).toBe(200);
      const json = JSON.parse(get.text);
      expect(json.Value).toBe("blue");
    });

    it("errors getting a missing key", async () => {
      await jhr("POST", "/2020-05-31/key-value-store", { Name: "kv-missing" });
      const res = await jhr("GET", "/2020-05-31/key-value-store/kv-missing/keys/nope");
      expect(res.status).toBe(404);
      expect(res.text).toContain("EntityNotFound");
    });
  });
});
