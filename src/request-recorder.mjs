// Parlel — universal request recorder.
//
// Captures every HTTP request an emulator receives into a per-service capped
// ring buffer, WITHOUT modifying any emulator code. The launcher calls
// `attachRecorder(server, buffer)` on an emulator's node:http.Server right after
// it starts; we prepend a `request` listener that wraps res.end to capture the
// status and (optionally) the response, plus method/path/headers/body/timing.
//
// This answers the question developers actually have — "did my code call the API
// the way I think it did?" — and powers test assertions like
// "Stripe received exactly one POST /v1/charges with amount=2000".
//
// Opt out entirely with PARLEL_RECORD=0. Pure Node, zero dependencies.

const DEFAULT_CAP = Number(process.env.PARLEL_RECORD_CAP) || 1000;
// Cap captured body sizes so a large upload can't blow up memory.
const MAX_BODY = Number(process.env.PARLEL_RECORD_MAX_BODY) || 64 * 1024;

export function recordingEnabled() {
  return process.env.PARLEL_RECORD !== "0";
}

// A fixed-size ring buffer of recorded requests for one service.
export class RequestLog {
  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
    this.entries = [];
    this.seq = 0;
  }

  push(entry) {
    entry.seq = ++this.seq;
    this.entries.push(entry);
    if (this.entries.length > this.cap) this.entries.shift();
    return entry;
  }

  // since: filter by timestamp (ms epoch). limit: cap returned count (newest-last).
  query({ since, method, path, limit } = {}) {
    let out = this.entries;
    if (since != null) out = out.filter((e) => e.ts >= since);
    if (method) out = out.filter((e) => e.method === String(method).toUpperCase());
    if (path) out = out.filter((e) => e.path === path || e.path.startsWith(path));
    if (limit != null && out.length > limit) out = out.slice(out.length - limit);
    return out;
  }

  clear() {
    this.entries = [];
  }
}

// Attach recording to a live node:http.Server. Idempotent per server (guarded by
// a symbol). Returns the RequestLog the entries land in.
const ATTACHED = Symbol("parlelRecorderAttached");

export function attachRecorder(server, log, { captureBody = true } = {}) {
  if (!server || typeof server.prependListener !== "function") return log;
  if (server[ATTACHED]) return log;
  server[ATTACHED] = true;

  server.prependListener("request", (req, res) => {
    const startedAt = Date.now();
    const start = process.hrtime.bigint();

    // Capture request body without consuming it for the real handler: tee the
    // 'data' events. We attach a passive listener; the emulator's own body
    // reading still receives the chunks.
    let reqBody = "";
    let reqBytes = 0;
    if (captureBody) {
      req.on("data", (chunk) => {
        reqBytes += chunk.length;
        if (reqBody.length < MAX_BODY) {
          reqBody += chunk.toString("utf8", 0, Math.min(chunk.length, MAX_BODY - reqBody.length));
        }
      });
    }

    // Wrap res.end to capture status + response body + duration.
    let resBody = "";
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    if (captureBody) {
      res.write = (chunk, ...rest) => {
        appendResChunk(chunk);
        return origWrite(chunk, ...rest);
      };
    }
    res.end = (chunk, ...rest) => {
      if (captureBody && chunk) appendResChunk(chunk);
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      try {
        log.push({
          ts: startedAt,
          method: req.method,
          path: pathOf(req),
          query: queryOf(req),
          headers: redactHeaders(req.headers),
          requestBody: captureBody ? truncate(reqBody) : undefined,
          requestBytes: reqBytes,
          status: res.statusCode,
          responseBody: captureBody ? truncate(resBody) : undefined,
          durationMs: Math.round(durationMs * 1000) / 1000,
        });
      } catch {
        /* never let recording break the response */
      }
      return origEnd(chunk, ...rest);
    };

    function appendResChunk(chunk) {
      if (resBody.length >= MAX_BODY) return;
      const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      resBody += s.slice(0, MAX_BODY - resBody.length);
    }
  });

  return log;
}

function pathOf(req) {
  const raw = req.url || "/";
  const qi = raw.indexOf("?");
  return qi === -1 ? raw : raw.slice(0, qi);
}

function queryOf(req) {
  const raw = req.url || "";
  const qi = raw.indexOf("?");
  if (qi === -1) return {};
  return Object.fromEntries(new URLSearchParams(raw.slice(qi + 1)).entries());
}

// Redact obvious secrets so the request log is safe to surface.
function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === "authorization" || key === "cookie" || key === "x-api-key" || key.includes("secret")) {
      out[k] = "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncate(s) {
  if (typeof s !== "string") return s;
  return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "…[truncated]" : s;
}

export { DEFAULT_CAP as REQUEST_LOG_DEFAULT_CAP };
