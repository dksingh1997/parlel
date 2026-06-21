import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// parlel/sharepoint — dependency-free fake of SharePoint via the Microsoft
// Graph API (/v1.0). Implements sites, lists, list items, and drive children
// using the real Graph wire shapes. State is in-memory and ephemeral.
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nowISO() {
  return new Date().toISOString();
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Microsoft Graph error envelope: { error: { code, message, innerError } }
function graphError(code, message) {
  return {
    error: {
      code,
      message,
      innerError: {
        date: nowISO(),
        "request-id": randomUUID(),
        "client-request-id": randomUUID(),
      },
    },
  };
}

export class SharepointServer {
  constructor(port = 4798, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.sites = new Map();
    this.lists = new Map(); // listId -> list (with _siteId)
    this.items = new Map(); // listId -> Map(itemId -> item)
    this.driveChildren = new Map(); // siteId -> [driveItem]
    this.listCounter = 0;
    this.itemCounter = 0;
    this._seedDefaults();
  }

  _seedDefaults() {
    const siteId = "parlel.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222";
    const site = {
      id: siteId,
      name: "Parlel Team Site",
      displayName: "Parlel Team Site",
      webUrl: "https://parlel.sharepoint.com/sites/team",
      createdDateTime: nowISO(),
      lastModifiedDateTime: nowISO(),
      siteCollection: { hostname: "parlel.sharepoint.com" },
    };
    this.sites.set(siteId, site);
    this.sites.set("root", site);
    this._defaultSiteId = siteId;

    this.driveChildren.set(siteId, [
      {
        id: "01ROOTFOLDER0000000000000000001",
        name: "Documents",
        webUrl: "https://parlel.sharepoint.com/sites/team/Shared%20Documents",
        size: 0,
        createdDateTime: nowISO(),
        lastModifiedDateTime: nowISO(),
        folder: { childCount: 0 },
      },
      {
        id: "01ROOTFILE00000000000000000001",
        name: "Welcome.docx",
        webUrl: "https://parlel.sharepoint.com/sites/team/Shared%20Documents/Welcome.docx",
        size: 12345,
        createdDateTime: nowISO(),
        lastModifiedDateTime: nowISO(),
        file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      },
    ]);
  }

  _resolveSiteId(raw) {
    if (raw === "root") return this._defaultSiteId;
    return raw;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, graphError("internalServerError", error.message || "Internal server error"));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("server", "parlel-sharepoint");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts, body);

    if (parts[0] !== "v1.0") {
      return this.send(res, 404, graphError("itemNotFound", "The requested resource does not exist."));
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, graphError("InvalidAuthenticationToken", "Access token is empty."));
    }

    const route = parts.slice(1); // after v1.0
    const base = `http://${this.host}:${this.port}`;

    if (route[0] !== "sites") {
      return this.send(res, 404, graphError("itemNotFound", "The requested resource does not exist."));
    }

    const siteId = this._resolveSiteId(route[1]);

    // GET /v1.0/sites/:siteId
    if (req.method === "GET" && route.length === 2) {
      const site = this.sites.get(siteId);
      if (!site) return this.send(res, 404, graphError("itemNotFound", "The requested site could not be found."));
      return this.send(res, 200, { "@odata.context": `${base}/v1.0/$metadata#sites/$entity`, ...clone(site) });
    }

    // /v1.0/sites/:siteId/lists
    if (route[2] === "lists") {
      return this.handleLists(req, res, route, siteId, body, base);
    }

    // GET /v1.0/sites/:siteId/drive/root/children
    if (req.method === "GET" && route[2] === "drive" && route[3] === "root" && route[4] === "children") {
      const children = this.driveChildren.get(siteId) || [];
      return this.send(res, 200, {
        "@odata.context": `${base}/v1.0/$metadata#sites('${siteId}')/drive/root/children`,
        value: children.map(clone),
      });
    }

    return this.send(res, 404, graphError("itemNotFound", "The requested resource does not exist."));
  }

  handleLists(req, res, route, siteId, body, base) {
    const site = this.sites.get(siteId);
    if (!site) return this.send(res, 404, graphError("itemNotFound", "The requested site could not be found."));

    // /v1.0/sites/:siteId/lists  (length 3)
    if (route.length === 3) {
      if (req.method === "GET") {
        const value = Array.from(this.lists.values())
          .filter((l) => l._siteId === siteId)
          .map((l) => this._publicList(l));
        return this.send(res, 200, {
          "@odata.context": `${base}/v1.0/$metadata#sites('${siteId}')/lists`,
          value,
        });
      }
      if (req.method === "POST") {
        if (!isPlainObject(body) || typeof body.displayName !== "string" || !body.displayName) {
          return this.send(res, 400, graphError("invalidRequest", "displayName is required."));
        }
        this.listCounter += 1;
        const id = randomUUID();
        const list = {
          id,
          _siteId: siteId,
          name: body.name || body.displayName,
          displayName: body.displayName,
          createdDateTime: nowISO(),
          lastModifiedDateTime: nowISO(),
          webUrl: `${site.webUrl}/Lists/${encodeURIComponent(body.displayName)}`,
          list: isPlainObject(body.list) ? clone(body.list) : { template: "genericList" },
        };
        this.lists.set(id, list);
        this.items.set(id, new Map());
        return this.send(res, 201, this._publicList(list));
      }
      return this.send(res, 405, graphError("methodNotAllowed", "Method not allowed."));
    }

    const listId = route[3];
    const list = this.lists.get(listId);

    // /v1.0/sites/:siteId/lists/:listId  (length 4)
    if (route.length === 4) {
      if (!list) return this.send(res, 404, graphError("itemNotFound", "The requested list could not be found."));
      if (req.method === "GET") return this.send(res, 200, this._publicList(list));
      return this.send(res, 405, graphError("methodNotAllowed", "Method not allowed."));
    }

    // /v1.0/sites/:siteId/lists/:listId/items  (length 5)
    if (route.length === 5 && route[4] === "items") {
      if (!list) return this.send(res, 404, graphError("itemNotFound", "The requested list could not be found."));
      const itemMap = this.items.get(listId) || new Map();
      if (req.method === "GET") {
        return this.send(res, 200, {
          "@odata.context": `${base}/v1.0/$metadata#sites('${siteId}')/lists('${listId}')/items`,
          value: Array.from(itemMap.values()).map(clone),
        });
      }
      if (req.method === "POST") {
        this.itemCounter += 1;
        const id = String(this.itemCounter);
        const item = {
          id,
          createdDateTime: nowISO(),
          lastModifiedDateTime: nowISO(),
          webUrl: `${list.webUrl}/${id}`,
          fields: isPlainObject(body) && isPlainObject(body.fields) ? clone(body.fields) : {},
        };
        itemMap.set(id, item);
        this.items.set(listId, itemMap);
        return this.send(res, 201, clone(item));
      }
      return this.send(res, 405, graphError("methodNotAllowed", "Method not allowed."));
    }

    return this.send(res, 404, graphError("itemNotFound", "The requested resource does not exist."));
  }

  _publicList(list) {
    const { _siteId, ...rest } = list;
    return clone(rest);
  }

  handleControl(req, res, parts, body) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    if (req.method === "GET" && parts[1] === "lists") {
      return this.send(res, 200, {
        lists: Array.from(this.lists.values()).map((l) => this._publicList(l)),
        count: this.lists.size,
      });
    }
    return this.send(res, 404, graphError("itemNotFound", "not found"));
  }

  root() {
    return {
      name: "sharepoint",
      version: "1",
      protocol: "microsoft-graph-v1.0",
      documentation: "/docs/sharepoint.md",
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
          this.send(res, 400, graphError("invalidRequest", "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, graphError("invalidRequest", "Bad request body"));
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
