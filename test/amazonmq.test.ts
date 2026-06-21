import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AmazonmqServer } from "../services/amazonmq/src/server.js";

const PORT = 14738;
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(ENDPOINT + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { status: res.status, json, headers: res.headers };
}

let server: AmazonmqServer;

beforeAll(async () => {
  server = new AmazonmqServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

describe("amazonmq", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("amazonmq");
  });

  it("default port 4738", () => {
    expect(new AmazonmqServer().port).toBe(4738);
  });

  it("creates a RabbitMQ broker", async () => {
    const res = await call("POST", "/v1/brokers", {
      brokerName: "broker1",
      engineType: "RABBITMQ",
      deploymentMode: "SINGLE_INSTANCE",
      hostInstanceType: "mq.t3.micro",
      publiclyAccessible: false,
      users: [{ username: "admin", password: "secret9chars!", consoleAccess: true }],
    });
    expect(res.status).toBe(200);
    expect(res.json.brokerId).toMatch(/^b-/);
    expect(res.json.brokerArn).toContain("arn:aws:mq");
  });

  it("describes a broker", async () => {
    const c = await call("POST", "/v1/brokers", {
      brokerName: "broker2",
      engineType: "ACTIVEMQ",
      deploymentMode: "SINGLE_INSTANCE",
      hostInstanceType: "mq.t3.micro",
      publiclyAccessible: false,
    });
    const id = c.json.brokerId;
    const d = await call("GET", `/v1/brokers/${id}`);
    expect(d.status).toBe(200);
    expect(d.json.brokerName).toBe("broker2");
    expect(d.json.engineType).toBe("ACTIVEMQ");
    expect(d.json.brokerState).toBe("RUNNING");
    expect(d.json.brokerInstances.length).toBeGreaterThan(0);
    expect(d.json.authenticationStrategy).toBe("SIMPLE");
    expect(d.json.securityGroups).toBeDefined();
    expect(d.json.subnetIds).toBeDefined();
    expect(d.json.encryptionOptions).toBeDefined();
    expect(d.json.logs).toBeDefined();
    expect(d.json.maintenanceWindowStartTime).toBeDefined();
    expect(d.json.configurations).toBeDefined();
  });

  it("lists brokers", async () => {
    await call("POST", "/v1/brokers", { brokerName: "b-a", engineType: "RABBITMQ", deploymentMode: "SINGLE_INSTANCE", hostInstanceType: "mq.t3.micro", publiclyAccessible: false });
    await call("POST", "/v1/brokers", { brokerName: "b-b", engineType: "RABBITMQ", deploymentMode: "SINGLE_INSTANCE", hostInstanceType: "mq.t3.micro", publiclyAccessible: false });
    const list = await call("GET", "/v1/brokers");
    expect(list.status).toBe(200);
    expect(list.json.brokerSummaries.length).toBe(2);
  });

  it("rejects duplicate broker name", async () => {
    await call("POST", "/v1/brokers", { brokerName: "dup", engineType: "RABBITMQ", deploymentMode: "SINGLE_INSTANCE", hostInstanceType: "mq.t3.micro", publiclyAccessible: false });
    const again = await call("POST", "/v1/brokers", { brokerName: "dup", engineType: "RABBITMQ", deploymentMode: "SINGLE_INSTANCE", hostInstanceType: "mq.t3.micro", publiclyAccessible: false });
    expect(again.status).toBe(409);
    expect(again.json.__type).toBe("ConflictException");
  });

  it("deletes a broker", async () => {
    const c = await call("POST", "/v1/brokers", { brokerName: "del", engineType: "RABBITMQ", deploymentMode: "SINGLE_INSTANCE", hostInstanceType: "mq.t3.micro", publiclyAccessible: false });
    const id = c.json.brokerId;
    const del = await call("DELETE", `/v1/brokers/${id}`);
    expect(del.status).toBe(200);
    expect(del.json.brokerId).toBe(id);
    const d = await call("GET", `/v1/brokers/${id}`);
    expect(d.status).toBe(404);
  });

  it("creates and lists configurations", async () => {
    const c = await call("POST", "/v1/configurations", { name: "cfg1", engineType: "RABBITMQ" });
    expect(c.status).toBe(200);
    expect(c.json.id).toMatch(/^c-/);
    expect(c.json.latestRevision.revision).toBe(1);
    const list = await call("GET", "/v1/configurations");
    expect(list.json.configurations.length).toBe(1);
  });

  it("404 for missing broker", async () => {
    const res = await call("GET", "/v1/brokers/b-missing");
    expect(res.status).toBe(404);
    expect(res.json.__type).toBe("NotFoundException");
  });

  describe("User CRUD", () => {
    let brokerId: string;

    beforeEach(async () => {
      const c = await call("POST", "/v1/brokers", {
        brokerName: "user-broker",
        engineType: "RABBITMQ",
        deploymentMode: "SINGLE_INSTANCE",
        hostInstanceType: "mq.t3.micro",
        publiclyAccessible: false,
        users: [{ username: "admin", password: "secret9chars!" }],
      });
      brokerId = c.json.brokerId;
    });

    it("lists users via /v1/brokers/{id}/users", async () => {
      const res = await call("GET", `/v1/brokers/${brokerId}/users`);
      expect(res.status).toBe(200);
      expect(res.json.brokerId).toBe(brokerId);
      expect(res.json.users.length).toBe(1);
      expect(res.json.users[0].username).toBe("admin");
    });

    it("creates a user", async () => {
      const res = await call("POST", `/v1/brokers/${brokerId}/users/newuser`, {
        password: "newpass12chars!",
        consoleAccess: true,
        groups: ["admin"],
      });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({});
      const list = await call("GET", `/v1/brokers/${brokerId}/users`);
      expect(list.json.users.length).toBe(2);
    });

    it("describes a user", async () => {
      const res = await call("GET", `/v1/brokers/${brokerId}/users/admin`);
      expect(res.status).toBe(200);
      expect(res.json.username).toBe("admin");
      expect(res.json.brokerId).toBe(brokerId);
      expect(res.json.pending).toBeDefined();
    });

    it("updates a user", async () => {
      const res = await call("PUT", `/v1/brokers/${brokerId}/users/admin`, {
        consoleAccess: true,
        groups: ["updated-group"],
      });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({});
      const d = await call("GET", `/v1/brokers/${brokerId}/users/admin`);
      expect(d.json.consoleAccess).toBe(true);
      expect(d.json.groups).toEqual(["updated-group"]);
    });

    it("deletes a user", async () => {
      const res = await call("DELETE", `/v1/brokers/${brokerId}/users/admin`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({});
      const list = await call("GET", `/v1/brokers/${brokerId}/users`);
      expect(list.json.users.length).toBe(0);
    });

    it("404 for missing user", async () => {
      const res = await call("GET", `/v1/brokers/${brokerId}/users/ghost`);
      expect(res.status).toBe(404);
      expect(res.json.__type).toBe("NotFoundException");
    });

    it("409 for duplicate user creation", async () => {
      const res = await call("POST", `/v1/brokers/${brokerId}/users/admin`, { password: "secret9chars!" });
      expect(res.status).toBe(409);
      expect(res.json.__type).toBe("ConflictException");
    });

    it("400 for missing password on create", async () => {
      const res = await call("POST", `/v1/brokers/${brokerId}/users/nopw`, {});
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("BadRequestException");
    });

    it("404 for users on missing broker", async () => {
      const res = await call("GET", "/v1/brokers/b-missing/users");
      expect(res.status).toBe(404);
    });
  });

  describe("UpdateBroker", () => {
    it("updates broker fields", async () => {
      const c = await call("POST", "/v1/brokers", {
        brokerName: "upd",
        engineType: "RABBITMQ",
        deploymentMode: "SINGLE_INSTANCE",
        hostInstanceType: "mq.t3.micro",
        publiclyAccessible: false,
      });
      const id = c.json.brokerId;
      const res = await call("PUT", `/v1/brokers/${id}`, {
        engineVersion: "3.12",
        hostInstanceType: "mq.m5.large",
        autoMinorVersionUpgrade: false,
      });
      expect(res.status).toBe(200);
      expect(res.json.brokerId).toBe(id);
      expect(res.json.engineVersion).toBe("3.12");
      expect(res.json.hostInstanceType).toBe("mq.m5.large");
      expect(res.json.autoMinorVersionUpgrade).toBe(false);
    });

    it("404 for updating missing broker", async () => {
      const res = await call("PUT", "/v1/brokers/b-missing", { engineVersion: "3.12" });
      expect(res.status).toBe(404);
    });
  });

  describe("RebootBroker", () => {
    it("reboots a broker", async () => {
      const c = await call("POST", "/v1/brokers", {
        brokerName: "reb",
        engineType: "RABBITMQ",
        deploymentMode: "SINGLE_INSTANCE",
        hostInstanceType: "mq.t3.micro",
        publiclyAccessible: false,
      });
      const id = c.json.brokerId;
      const res = await call("POST", `/v1/brokers/${id}/reboot`);
      expect(res.status).toBe(200);
      // Broker still running after reboot
      const d = await call("GET", `/v1/brokers/${id}`);
      expect(d.json.brokerState).toBe("RUNNING");
    });

    it("404 for rebooting missing broker", async () => {
      const res = await call("POST", "/v1/brokers/b-missing/reboot");
      expect(res.status).toBe(404);
    });
  });

  describe("Configuration CRUD", () => {
    it("describes a configuration", async () => {
      const c = await call("POST", "/v1/configurations", { name: "cfg-desc", engineType: "RABBITMQ" });
      const id = c.json.id;
      const d = await call("GET", `/v1/configurations/${id}`);
      expect(d.status).toBe(200);
      expect(d.json.name).toBe("cfg-desc");
      expect(d.json.engineType).toBe("RABBITMQ");
      expect(d.json.description).toBe("");
    });

    it("updates a configuration (bumps revision)", async () => {
      const c = await call("POST", "/v1/configurations", { name: "cfg-upd", engineType: "RABBITMQ" });
      const id = c.json.id;
      const u = await call("PUT", `/v1/configurations/${id}`, { data: "base64data", description: "v2 config" });
      expect(u.status).toBe(200);
      expect(u.json.latestRevision.revision).toBe(2);
      expect(u.json.latestRevision.description).toBe("v2 config");
    });

    it("deletes a configuration", async () => {
      const c = await call("POST", "/v1/configurations", { name: "cfg-del", engineType: "RABBITMQ" });
      const id = c.json.id;
      const d = await call("DELETE", `/v1/configurations/${id}`);
      expect(d.status).toBe(200);
      expect(d.json.configurationId).toBe(id);
      const desc = await call("GET", `/v1/configurations/${id}`);
      expect(desc.status).toBe(404);
    });

    it("404 for missing configuration", async () => {
      const res = await call("GET", "/v1/configurations/c-missing");
      expect(res.status).toBe(404);
    });
  });

  describe("Error shapes", () => {
    it("returns correct error envelope with x-amzn-errortype header", async () => {
      const res = await call("GET", "/v1/brokers/b-nonexistent");
      expect(res.status).toBe(404);
      expect(res.json.__type).toBe("NotFoundException");
      expect(res.json.errorAttribute).toBe("");
      expect(res.json.message).toContain("not found");
      expect(res.headers.get("x-amzn-errortype")).toBe("NotFoundException");
    });

    it("rejects missing required broker fields", async () => {
      const res = await call("POST", "/v1/brokers", { brokerName: "incomplete" });
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("BadRequestException");
    });

    it("rejects invalid JSON body", async () => {
      const res = await fetch(ENDPOINT + "/v1/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.__type).toBe("BadRequestException");
    });

    it("404 for unknown paths", async () => {
      const res = await call("GET", "/v1/unknown");
      expect(res.status).toBe(404);
    });
  });
});
