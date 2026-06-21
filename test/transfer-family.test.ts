import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { TransferFamilyServer } from "../services/transfer-family/src/server.js";

const PORT = 14718;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "TransferService";

async function tf(operation: string, body: unknown) {
  const res = await fetch(`${ENDPOINT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `${PREFIX}.${operation}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* */
  }
  return { status: res.status, json };
}

describe("Transfer Family Service", () => {
  let server: TransferFamilyServer;

  beforeAll(async () => {
    server = new TransferFamilyServer(PORT);
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

    it("uses default port 4718", () => {
      const s = new TransferFamilyServer();
      expect(s.port).toBe(4718);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("transfer-family");
    });

    it("supports POST /_parlel/reset", async () => {
      await tf("CreateServer", { Protocols: ["SFTP"] });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.servers.size).toBe(0);
    });
  });

  describe("Servers", () => {
    it("creates a server with s- id", async () => {
      const res = await tf("CreateServer", { Protocols: ["SFTP"], Domain: "S3" });
      expect(res.status).toBe(200);
      expect(res.json.ServerId).toMatch(/^s-/);
    });

    it("lists and describes servers", async () => {
      const created = await tf("CreateServer", { Protocols: ["SFTP"] });
      const serverId = created.json.ServerId;
      const list = await tf("ListServers", {});
      expect(list.json.Servers.length).toBe(1);
      const desc = await tf("DescribeServer", { ServerId: serverId });
      expect(desc.json.Server.ServerId).toBe(serverId);
      expect(desc.json.Server.State).toBe("ONLINE");
    });

    it("stops a server", async () => {
      const created = await tf("CreateServer", { Protocols: ["SFTP"] });
      const serverId = created.json.ServerId;
      await tf("StopServer", { ServerId: serverId });
      const desc = await tf("DescribeServer", { ServerId: serverId });
      expect(desc.json.Server.State).toBe("OFFLINE");
    });

    it("deletes a server", async () => {
      const created = await tf("CreateServer", { Protocols: ["SFTP"] });
      const serverId = created.json.ServerId;
      const del = await tf("DeleteServer", { ServerId: serverId });
      expect(del.status).toBe(200);
      const desc = await tf("DescribeServer", { ServerId: serverId });
      expect(desc.status).toBe(400);
      expect(desc.json.__type).toBe("ResourceNotFoundException");
    });

    it("errors describing a missing server", async () => {
      const res = await tf("DescribeServer", { ServerId: "s-ghost" });
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("ResourceNotFoundException");
    });
  });

  describe("Users", () => {
    let serverId: string;

    beforeEach(async () => {
      const created = await tf("CreateServer", { Protocols: ["SFTP"] });
      serverId = created.json.ServerId;
    });

    it("creates, lists and describes a user", async () => {
      const created = await tf("CreateUser", {
        ServerId: serverId,
        UserName: "alice",
        Role: "arn:aws:iam::000000000000:role/transfer",
        HomeDirectory: "/bucket/alice",
      });
      expect(created.status).toBe(200);
      expect(created.json.UserName).toBe("alice");

      const list = await tf("ListUsers", { ServerId: serverId });
      expect(list.json.Users.length).toBe(1);

      const desc = await tf("DescribeUser", { ServerId: serverId, UserName: "alice" });
      expect(desc.json.User.HomeDirectory).toBe("/bucket/alice");
    });

    it("rejects a duplicate user", async () => {
      await tf("CreateUser", { ServerId: serverId, UserName: "bob", Role: "r" });
      const dup = await tf("CreateUser", { ServerId: serverId, UserName: "bob", Role: "r" });
      expect(dup.status).toBe(400);
      expect(dup.json.__type).toBe("ResourceExistsException");
    });

    it("deletes a user", async () => {
      await tf("CreateUser", { ServerId: serverId, UserName: "carol", Role: "r" });
      const del = await tf("DeleteUser", { ServerId: serverId, UserName: "carol" });
      expect(del.status).toBe(200);
      const list = await tf("ListUsers", { ServerId: serverId });
      expect(list.json.Users.length).toBe(0);
    });
  });
});
