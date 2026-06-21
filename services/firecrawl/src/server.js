import { createServer } from "node:http";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/firecrawl — a tiny, dependency-free fake of the Firecrawl API v1.
//
// Speaks the Firecrawl v1 surface (scrape, crawl, crawl-status, map). Scrape
// output is *deterministically derived from the requested URL* so the same URL
// always yields the same markdown/html/metadata. State is in-memory.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Build a deterministic id (uuid-ish) from a seed.
function deterministicId(seed) {
  const h = hash(seed);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join("-");
}

function titleFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/\/$/, "");
    const lastSeg = path.split("/").filter(Boolean).pop();
    if (lastSeg) {
      const words = lastSeg.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]+$/i, "");
      return words.replace(/\b\w/g, (c) => c.toUpperCase()) + " | " + host;
    }
    return host.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Untitled";
  }
}

export class FirecrawlServer {
  constructor(port = 4885, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.crawls = new Map(); // id -> { id, url, status, data }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { success: false, error: error.message || "Internal server error" });
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((error) => {
        this.server = null;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async handle(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const parts = splitPath(url.pathname);
    const body = await this.readBody(req, res);
    if (body === SENTINEL_BAD_JSON) return;

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("server", "parlel-firecrawl");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v1") {
      return this.send(res, 404, { success: false, error: "Not found" });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { success: false, error: "Unauthorized: Invalid token" });
    }

    const route = parts.slice(1);

    // POST /v1/scrape
    if (route[0] === "scrape" && route.length === 1 && req.method === "POST") {
      return this.scrape(res, body);
    }

    // POST /v1/crawl
    if (route[0] === "crawl" && route.length === 1 && req.method === "POST") {
      return this.crawl(res, body);
    }

    // GET /v1/crawl/:id
    if (route[0] === "crawl" && route.length === 2 && req.method === "GET") {
      return this.crawlStatus(res, route[1]);
    }

    // POST /v1/map
    if (route[0] === "map" && route.length === 1 && req.method === "POST") {
      return this.map(res, body);
    }

    return this.send(res, 404, { success: false, error: "Not found" });
  }

  // Deterministic scrape output derived from the requested URL.
  buildScrapeData(rawUrl) {
    const title = titleFromUrl(rawUrl);
    let host = rawUrl;
    let path = "/";
    try {
      const u = new URL(rawUrl);
      host = u.hostname;
      path = u.pathname || "/";
    } catch {
      /* keep raw */
    }
    const description = `Deterministic parlel scrape of ${rawUrl}.`;
    const markdown =
      `# ${title}\n\n` +
      `This is the deterministic markdown rendering of [${rawUrl}](${rawUrl}).\n\n` +
      `- Host: ${host}\n` +
      `- Path: ${path}\n` +
      `- Content hash: ${hash(rawUrl).slice(0, 16)}\n`;
    const html =
      `<!doctype html><html><head><title>${title}</title>` +
      `<meta name="description" content="${description}"></head>` +
      `<body><h1>${title}</h1><p>Deterministic parlel scrape of ${rawUrl}.</p></body></html>`;
    return {
      markdown,
      html,
      metadata: {
        title,
        description,
        sourceURL: rawUrl,
        url: rawUrl,
        statusCode: 200,
        language: "en",
      },
    };
  }

  scrape(res, body) {
    if (!isPlainObject(body) || typeof body.url !== "string" || !body.url) {
      return this.send(res, 400, { success: false, error: "url is required" });
    }
    return this.send(res, 200, { success: true, data: this.buildScrapeData(body.url) });
  }

  crawl(res, body) {
    if (!isPlainObject(body) || typeof body.url !== "string" || !body.url) {
      return this.send(res, 400, { success: false, error: "url is required" });
    }
    const id = deterministicId("crawl:" + body.url);
    const limit = Number(body.limit) || 3;
    // Deterministic set of crawled pages derived from the base URL.
    const base = body.url.replace(/\/$/, "");
    const data = [];
    const paths = ["", "/about", "/pricing", "/blog", "/contact"];
    for (let i = 0; i < Math.min(limit, paths.length); i++) {
      data.push(this.buildScrapeData(base + paths[i]));
    }
    this.crawls.set(id, { id, url: body.url, status: "completed", total: data.length, completed: data.length, data });
    return this.send(res, 200, {
      success: true,
      id,
      url: `http://${this.host}:${this.port}/v1/crawl/${id}`,
    });
  }

  crawlStatus(res, id) {
    const crawl = this.crawls.get(id);
    if (!crawl) {
      return this.send(res, 404, { success: false, error: "Crawl not found" });
    }
    return this.send(res, 200, {
      success: true,
      status: crawl.status,
      total: crawl.total,
      completed: crawl.completed,
      creditsUsed: crawl.total,
      data: crawl.data,
    });
  }

  map(res, body) {
    if (!isPlainObject(body) || typeof body.url !== "string" || !body.url) {
      return this.send(res, 400, { success: false, error: "url is required" });
    }
    const base = body.url.replace(/\/$/, "");
    const paths = ["", "/about", "/pricing", "/blog", "/contact", "/docs", "/login"];
    const links = paths.map((p) => base + (p || "/"));
    return this.send(res, 200, { success: true, links });
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { success: false, error: "not found" });
  }

  root() {
    return {
      name: "firecrawl",
      version: "1",
      protocol: "firecrawl-v1",
      documentation: "/docs/firecrawl.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { success: false, error: "Invalid JSON body" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { success: false, error: "Invalid JSON body" });
        resolve(SENTINEL_BAD_JSON);
      });
    });
  }

  send(res, status, body) {
    res.statusCode = status;
    if (body === null || status === 204) {
      res.end();
      return;
    }
    res.end(JSON.stringify(body));
  }
}
