import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudfrontServer } from "../services/cloudfront/src/server.js";

const PORT = 14712;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function xhr(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/xml", ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, etag: res.headers.get("etag") };
}

function extract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

function distConfig(enabled = true, comment = "test") {
  return (
    `<DistributionConfig>` +
    `<CallerReference>ref-${Date.now()}-${Math.random()}</CallerReference>` +
    `<Comment>${comment}</Comment>` +
    `<Enabled>${enabled}</Enabled>` +
    `<Origins><Quantity>1</Quantity><Items>` +
    `<Origin><Id>origin-1</Id><DomainName>example.s3.amazonaws.com</DomainName></Origin>` +
    `</Items></Origins>` +
    `</DistributionConfig>`
  );
}

describe("CloudFront Service", () => {
  let server: CloudfrontServer;

  beforeAll(async () => {
    server = new CloudfrontServer(PORT);
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

    it("uses default port 4712", () => {
      const s = new CloudfrontServer();
      expect(s.port).toBe(4712);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("cloudfront");
    });

    it("supports POST /_parlel/reset", async () => {
      await xhr("POST", "/2020-05-31/distribution", distConfig());
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.distributions.size).toBe(0);
    });
  });

  describe("Distributions", () => {
    it("creates a distribution", async () => {
      const res = await xhr("POST", "/2020-05-31/distribution", distConfig());
      expect(res.status).toBe(201);
      expect(res.text).toContain("cloudfront.net");
      expect(res.etag).toBeTruthy();
      const id = extract(res.text, "Id");
      expect(id).toMatch(/^E/);
    });

    it("lists distributions", async () => {
      await xhr("POST", "/2020-05-31/distribution", distConfig(true, "alpha"));
      await xhr("POST", "/2020-05-31/distribution", distConfig(true, "beta"));
      const res = await xhr("GET", "/2020-05-31/distribution");
      expect(res.text).toContain("alpha");
      expect(res.text).toContain("beta");
      expect(res.text).toContain("<Quantity>2</Quantity>");
    });

    it("gets a distribution by id", async () => {
      const created = await xhr("POST", "/2020-05-31/distribution", distConfig(true, "gettable"));
      const id = extract(created.text, "Id")!;
      const res = await xhr("GET", `/2020-05-31/distribution/${id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("gettable");
    });

    it("refuses to delete an enabled distribution", async () => {
      const created = await xhr("POST", "/2020-05-31/distribution", distConfig(true));
      const id = extract(created.text, "Id")!;
      const res = await xhr("DELETE", `/2020-05-31/distribution/${id}`);
      expect(res.status).toBe(409);
      expect(res.text).toContain("DistributionNotDisabled");
    });

    it("deletes a disabled distribution", async () => {
      const created = await xhr("POST", "/2020-05-31/distribution", distConfig(false));
      const id = extract(created.text, "Id")!;
      const res = await xhr("DELETE", `/2020-05-31/distribution/${id}`);
      expect(res.status).toBe(204);
      const get = await xhr("GET", `/2020-05-31/distribution/${id}`);
      expect(get.status).toBe(404);
      expect(get.text).toContain("NoSuchDistribution");
    });

    it("errors getting a missing distribution", async () => {
      const res = await xhr("GET", "/2020-05-31/distribution/ENOTREAL");
      expect(res.status).toBe(404);
      expect(res.text).toContain("NoSuchDistribution");
    });
  });

  describe("Invalidations", () => {
    async function makeDist() {
      const created = await xhr("POST", "/2020-05-31/distribution", distConfig());
      return extract(created.text, "Id")!;
    }

    it("creates and lists invalidations", async () => {
      const id = await makeDist();
      const body =
        `<InvalidationBatch><CallerReference>inv-${Date.now()}</CallerReference>` +
        `<Paths><Quantity>2</Quantity><Items><Path>/index.html</Path><Path>/css/*</Path></Items></Paths>` +
        `</InvalidationBatch>`;
      const res = await xhr("POST", `/2020-05-31/distribution/${id}/invalidation`, body);
      expect(res.status).toBe(201);
      expect(res.text).toContain("/index.html");
      const invId = extract(res.text, "Id")!;
      expect(invId).toMatch(/^I/);

      const list = await xhr("GET", `/2020-05-31/distribution/${id}/invalidation`);
      expect(list.text).toContain(invId);
    });

    it("errors creating invalidation for missing distribution", async () => {
      const res = await xhr(
        "POST",
        "/2020-05-31/distribution/ENOTREAL/invalidation",
        `<InvalidationBatch><CallerReference>x</CallerReference><Paths><Quantity>1</Quantity><Items><Path>/*</Path></Items></Paths></InvalidationBatch>`,
      );
      expect(res.status).toBe(404);
      expect(res.text).toContain("NoSuchDistribution");
    });
  });

  describe("Origin access control", () => {
    it("creates an origin access control", async () => {
      const body =
        `<OriginAccessControlConfig>` +
        `<Name>my-oac</Name><Description>desc</Description>` +
        `<SigningProtocol>sigv4</SigningProtocol><SigningBehavior>always</SigningBehavior>` +
        `<OriginAccessControlOriginType>s3</OriginAccessControlOriginType>` +
        `</OriginAccessControlConfig>`;
      const res = await xhr("POST", "/2020-05-31/origin-access-control", body);
      expect(res.status).toBe(201);
      expect(res.text).toContain("my-oac");

      const list = await xhr("GET", "/2020-05-31/origin-access-control");
      expect(list.text).toContain("my-oac");
    });
  });
});
