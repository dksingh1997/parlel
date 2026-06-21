import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { YoutubeServer } from "../services/youtube/src/server.js";

const PORT = 14803;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "parlel.test.yttoken";
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

describe("YouTube Service", () => {
  let server: YoutubeServer;

  beforeAll(async () => {
    server = new YoutubeServer(PORT);
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
      expect(root.body.name).toBe("youtube");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing credentials with 401", async () => {
      const res = await api("GET", "/youtube/v3/channels?part=snippet&mine=true", undefined, {});
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(401);
    });

    it("accepts ?key= query auth", async () => {
      const res = await api("GET", "/youtube/v3/videos?part=snippet&id=parlelVid001&key=parlel", undefined, {});
      expect(res.status).toBe(200);
    });
  });

  describe("Channels", () => {
    it("GET /youtube/v3/channels?mine=true returns the channel list shape", async () => {
      const res = await api("GET", "/youtube/v3/channels?part=snippet,contentDetails,statistics&mine=true");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("youtube#channelListResponse");
      expect(res.body.items.length).toBe(1);
      expect(res.body.pageInfo.totalResults).toBe(1);
      expect(res.body.items[0].snippet.title).toBe("Parlel Channel");
    });
  });

  describe("Videos", () => {
    it("GET /youtube/v3/videos?id=... returns the video", async () => {
      const res = await api("GET", "/youtube/v3/videos?part=snippet,statistics&id=parlelVid001");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("youtube#videoListResponse");
      expect(res.body.items[0].id).toBe("parlelVid001");
    });
  });

  describe("Search", () => {
    it("GET /youtube/v3/search?q=... returns searchResult items", async () => {
      const res = await api("GET", "/youtube/v3/search?part=snippet&q=parlel");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("youtube#searchListResponse");
      expect(res.body.items[0].id.kind).toBe("youtube#video");
      expect(res.body.items[0].id.videoId).toBeTruthy();
    });
  });

  describe("Playlists", () => {
    it("POST /youtube/v3/playlists creates a playlist", async () => {
      const res = await api("POST", "/youtube/v3/playlists?part=snippet,status", {
        snippet: { title: "My Playlist", description: "test" },
        status: { privacyStatus: "public" },
      });
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("youtube#playlist");
      expect(res.body.snippet.title).toBe("My Playlist");
      expect(res.body.id).toMatch(/^PL/);
    });

    it("rejects playlist without title", async () => {
      const res = await api("POST", "/youtube/v3/playlists?part=snippet", { snippet: {} });
      expect(res.status).toBe(400);
    });

    it("GET /youtube/v3/playlistItems returns items", async () => {
      const res = await api("GET", "/youtube/v3/playlistItems?part=snippet&playlistId=PLparlel");
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("youtube#playlistItemListResponse");
      expect(res.body.items[0].snippet.resourceId.videoId).toBeTruthy();
    });
  });

  describe("parlel control", () => {
    it("resets state", async () => {
      await api("POST", "/youtube/v3/playlists?part=snippet", { snippet: { title: "x" } });
      await api("POST", "/__parlel/reset");
      const res = await api("GET", "/__parlel/playlists");
      expect(res.body.count).toBe(0);
    });
  });
});
