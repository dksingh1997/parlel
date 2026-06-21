import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { XTwitterServer } from "../services/x-twitter/src/server.js";

const PORT = 14800;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.xtoken";
const AUTH = { Authorization: `Bearer ${TOKEN}` };

type Json = Record<string, any>;

interface ApiResult {
  status: number;
  body: Json;
  headers: Headers;
}

async function api(method: string, path: string, body?: Json, headers: Json = AUTH): Promise<ApiResult> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

describe("X / Twitter Service", () => {
  let server: XTwitterServer;

  beforeAll(async () => {
    server = new XTwitterServer(PORT);
    await server.start();
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("returns root and health JSON", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("x-twitter");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing token with 401", async () => {
      const res = await api("GET", "/2/users/me", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.status).toBe(401);
    });
  });

  describe("Users", () => {
    it("GET /2/users/me returns the authed user", async () => {
      const res = await api("GET", "/2/users/me");
      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe("parlel");
      expect(res.body.data.id).toBeTruthy();
    });

    it("GET /2/users/by/username/:username resolves a user", async () => {
      const res = await api("GET", "/2/users/by/username/jack");
      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe("jack");
    });

    it("returns Not Found error for unknown username", async () => {
      const res = await api("GET", "/2/users/by/username/nobodyxyz");
      expect(res.status).toBe(200);
      expect(res.body.errors[0].title).toBe("Not Found Error");
    });
  });

  describe("Tweets", () => {
    it("POST /2/tweets creates a tweet with { data: { id, text } }", async () => {
      const res = await api("POST", "/2/tweets", { text: "Hello from parlel!" });
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.text).toBe("Hello from parlel!");
      expect(res.body.data.edit_history_tweet_ids).toContain(res.body.data.id);
    });

    it("rejects empty tweet text with 400", async () => {
      const res = await api("POST", "/2/tweets", { text: "" });
      expect(res.status).toBe(400);
    });

    it("round-trips create / get / delete", async () => {
      const created = await api("POST", "/2/tweets", { text: "Round trip" });
      const id = created.body.data.id;

      const got = await api("GET", `/2/tweets/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.data.text).toBe("Round trip");

      const deleted = await api("DELETE", `/2/tweets/${id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data.deleted).toBe(true);

      const gone = await api("GET", `/2/tweets/${id}`);
      expect(gone.body.errors[0].title).toBe("Not Found Error");
    });
  });

  describe("Likes", () => {
    it("POST /2/users/:id/likes likes a tweet", async () => {
      const created = await api("POST", "/2/tweets", { text: "Like me" });
      const tweetId = created.body.data.id;
      const res = await api("POST", "/2/users/1000000000000000001/likes", { tweet_id: tweetId });
      expect(res.status).toBe(200);
      expect(res.body.data.liked).toBe(true);
    });

    it("rejects like without tweet_id", async () => {
      const res = await api("POST", "/2/users/1000000000000000001/likes", {});
      expect(res.status).toBe(400);
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/2/tweets", { text: "x" });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/tweets");
      expect(res.body.count).toBe(0);
    });
  });
});
