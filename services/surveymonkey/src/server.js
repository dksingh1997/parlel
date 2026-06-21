import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/surveymonkey — dependency-free in-memory fake of the SurveyMonkey
// API v3. Bearer auth. List responses use the documented envelope:
//   { data: [...], per_page, page, total, links: {} }
// ---------------------------------------------------------------------------

const SENTINEL_BAD_JSON = Symbol("bad-json");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function smError(httpStatus, code, message) {
  return {
    error: {
      docs: "https://developer.surveymonkey.com/api/v3/",
      message,
      id: String(code),
      name: "Error",
      http_status_code: httpStatus,
    },
  };
}

export class SurveymonkeyServer {
  constructor(port = 4847, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.surveys = new Map();
    this.responses = new Map(); // surveyId -> Map(responseId -> response)
    this._surveyCounter = 0;
    this._respCounter = 0;
    this.me = {
      id: "1000001",
      username: "parlel",
      first_name: "Parlel",
      last_name: "User",
      email: "user@parlel.dev",
      account_type: "enterprise_platform",
      language: "en",
      date_created: "2024-01-01T00:00:00",
      date_last_login: "2024-01-01T00:00:00",
    };
    this._seed();
  }

  _seed() {
    this._createSurvey({ title: "Customer Satisfaction" });
  }

  _createSurvey(props) {
    this._surveyCounter += 1;
    const id = String(310000000 + this._surveyCounter);
    const survey = {
      id,
      title: props.title || "New survey",
      nickname: props.nickname || "",
      category: props.category || "",
      language: "en",
      question_count: 0,
      page_count: 1,
      response_count: 0,
      date_created: "2024-01-01T00:00:00",
      date_modified: "2024-01-01T00:00:00",
      href: `${this._base()}/surveys/${id}`,
    };
    this.surveys.set(id, survey);
    this.responses.set(id, new Map());
    return survey;
  }

  _base() {
    return `http://${this.host}:${this.port}/v3`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, smError(500, 1050, error.message || "Internal server error"));
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
      if (!this.server) return resolve();
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
    res.setHeader("server", "parlel-surveymonkey");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    if (parts[0] !== "v3") return this.send(res, 404, smError(404, 1003, "not found"));

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, smError(401, 1010, "Client authentication failed."));
    }

    const route = parts.slice(1);

    // GET /v3/users/me
    if (req.method === "GET" && route[0] === "users" && route[1] === "me" && route.length === 2) {
      return this.send(res, 200, clone(this.me));
    }

    // /v3/surveys ...
    if (route[0] === "surveys") {
      // GET/POST /v3/surveys
      if (route.length === 1) {
        if (req.method === "GET") {
          const list = Array.from(this.surveys.values()).map((s) => ({
            id: s.id,
            title: s.title,
            nickname: s.nickname,
            href: s.href,
          }));
          return this.send(res, 200, this.listEnvelope(list, url));
        }
        if (req.method === "POST") {
          const survey = this._createSurvey(isPlainObject(body) ? body : {});
          return this.send(res, 201, clone(survey));
        }
        return this.send(res, 405, smError(405, 1020, "method not allowed"));
      }

      const id = route[1];
      const survey = this.surveys.get(id);

      // GET /v3/surveys/:id/details
      if (route[2] === "details" && route.length === 3 && req.method === "GET") {
        if (!survey) return this.send(res, 404, smError(404, 1003, "Survey not found."));
        return this.send(res, 200, { ...clone(survey), pages: [{ id: "1", title: "Page 1", questions: [] }] });
      }

      // /v3/surveys/:id/responses
      if (route[2] === "responses") {
        if (!survey) return this.send(res, 404, smError(404, 1003, "Survey not found."));
        // GET /v3/surveys/:id/responses or /bulk
        if ((route.length === 3) || (route.length === 4 && route[3] === "bulk")) {
          if (req.method === "GET") {
            const list = Array.from(this.responses.get(id).values()).map(clone);
            return this.send(res, 200, this.listEnvelope(list, url));
          }
          if (req.method === "POST") {
            return this.createResponse(res, id, body);
          }
        }
        // GET /v3/surveys/:id/responses/:rid
        if (route.length === 4 && req.method === "GET") {
          const r = this.responses.get(id).get(route[3]);
          if (!r) return this.send(res, 404, smError(404, 1003, "Response not found."));
          return this.send(res, 200, clone(r));
        }
      }

      // GET/PATCH/DELETE /v3/surveys/:id
      if (route.length === 2) {
        if (!survey) return this.send(res, 404, smError(404, 1003, "Survey not found."));
        if (req.method === "GET") return this.send(res, 200, clone(survey));
        if (req.method === "PATCH" || req.method === "PUT") {
          if (isPlainObject(body)) {
            if (typeof body.title === "string") survey.title = body.title;
            if (typeof body.nickname === "string") survey.nickname = body.nickname;
          }
          return this.send(res, 200, clone(survey));
        }
        if (req.method === "DELETE") {
          this.surveys.delete(id);
          this.responses.delete(id);
          return this.send(res, 200, clone(survey));
        }
      }
    }

    return this.send(res, 404, smError(404, 1003, "not found"));
  }

  createResponse(res, surveyId, body) {
    this._respCounter += 1;
    const id = String(120000000 + this._respCounter);
    const response = {
      id,
      survey_id: surveyId,
      total_time: 0,
      response_status: "completed",
      collection_mode: "default",
      date_created: "2024-01-01T00:00:00",
      date_modified: "2024-01-01T00:00:00",
      pages: isPlainObject(body) && Array.isArray(body.pages) ? clone(body.pages) : [],
      href: `${this._base()}/surveys/${surveyId}/responses/${id}`,
    };
    this.responses.get(surveyId).set(id, response);
    const survey = this.surveys.get(surveyId);
    if (survey) survey.response_count += 1;
    return this.send(res, 201, clone(response));
  }

  listEnvelope(data, url) {
    const per_page = Number(url.searchParams.get("per_page")) || 50;
    const page = Number(url.searchParams.get("page")) || 1;
    return {
      data,
      per_page,
      page,
      total: data.length,
      links: { self: `${this._base()}${url.pathname.replace(/^\/v3/, "")}` },
    };
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, smError(404, 1003, "not found"));
  }

  root() {
    return {
      name: "surveymonkey",
      version: "1",
      protocol: "surveymonkey-v3",
      documentation: "/docs/surveymonkey.md",
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
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, smError(400, 1001, "Bad request body"));
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, smError(400, 1001, "Bad request body"));
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
