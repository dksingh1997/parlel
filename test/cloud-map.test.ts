import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { CloudMapServer } from "../services/cloud-map/src/server.js";

const PORT = 14717;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const PREFIX = "Route53AutoNaming_v20170314";

async function cm(operation: string, body: unknown) {
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

describe("Cloud Map Service", () => {
  let server: CloudMapServer;

  beforeAll(async () => {
    server = new CloudMapServer(PORT);
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

    it("uses default port 4717", () => {
      const s = new CloudMapServer();
      expect(s.port).toBe(4717);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(json.service).toBe("cloud-map");
    });

    it("supports POST /_parlel/reset", async () => {
      await cm("CreateHttpNamespace", { Name: "reset-ns" });
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.namespaces.size).toBe(0);
    });
  });

  describe("Namespaces", () => {
    it("creates an HTTP namespace", async () => {
      const res = await cm("CreateHttpNamespace", { Name: "my-http-ns" });
      expect(res.status).toBe(200);
      expect(res.json.OperationId).toBeTruthy();
      const list = await cm("ListNamespaces", {});
      expect(list.json.Namespaces.length).toBe(1);
      expect(list.json.Namespaces[0].Type).toBe("HTTP");
    });

    it("creates a private DNS namespace", async () => {
      const res = await cm("CreatePrivateDnsNamespace", { Name: "my-dns-ns", Vpc: "vpc-123" });
      expect(res.status).toBe(200);
      const list = await cm("ListNamespaces", {});
      expect(list.json.Namespaces[0].Type).toBe("DNS_PRIVATE");
    });

    it("rejects a duplicate namespace", async () => {
      await cm("CreateHttpNamespace", { Name: "dup-ns" });
      const dup = await cm("CreateHttpNamespace", { Name: "dup-ns" });
      expect(dup.status).toBe(400);
      expect(dup.json.__type).toBe("NamespaceAlreadyExists");
    });

    it("gets a namespace by id", async () => {
      await cm("CreateHttpNamespace", { Name: "get-ns" });
      const list = await cm("ListNamespaces", {});
      const id = list.json.Namespaces[0].Id;
      const got = await cm("GetNamespace", { Id: id });
      expect(got.json.Namespace.Name).toBe("get-ns");
    });
  });

  describe("Services & instances", () => {
    let namespaceId: string;

    beforeEach(async () => {
      await cm("CreateHttpNamespace", { Name: "svc-ns" });
      const list = await cm("ListNamespaces", {});
      namespaceId = list.json.Namespaces[0].Id;
    });

    it("creates and lists a service", async () => {
      const created = await cm("CreateService", { Name: "my-svc", NamespaceId: namespaceId });
      expect(created.status).toBe(200);
      expect(created.json.Service.Id).toBeTruthy();
      const list = await cm("ListServices", {
        Filters: [{ Name: "NAMESPACE_ID", Values: [namespaceId] }],
      });
      expect(list.json.Services.length).toBe(1);
    });

    it("registers and discovers an instance", async () => {
      const created = await cm("CreateService", { Name: "disc-svc", NamespaceId: namespaceId });
      const serviceId = created.json.Service.Id;
      const reg = await cm("RegisterInstance", {
        ServiceId: serviceId,
        InstanceId: "inst-1",
        Attributes: { AWS_INSTANCE_IPV4: "10.0.0.1", AWS_INSTANCE_PORT: "8080" },
      });
      expect(reg.status).toBe(200);
      expect(reg.json.OperationId).toBeTruthy();

      const list = await cm("ListInstances", { ServiceId: serviceId });
      expect(list.json.Instances.length).toBe(1);

      const disc = await cm("DiscoverInstances", {
        NamespaceName: "svc-ns",
        ServiceName: "disc-svc",
      });
      expect(disc.json.Instances.length).toBe(1);
      expect(disc.json.Instances[0].Attributes.AWS_INSTANCE_IPV4).toBe("10.0.0.1");
    });

    it("deregisters an instance", async () => {
      const created = await cm("CreateService", { Name: "dereg-svc", NamespaceId: namespaceId });
      const serviceId = created.json.Service.Id;
      await cm("RegisterInstance", {
        ServiceId: serviceId,
        InstanceId: "inst-x",
        Attributes: { AWS_INSTANCE_IPV4: "10.0.0.5" },
      });
      const dereg = await cm("DeregisterInstance", { ServiceId: serviceId, InstanceId: "inst-x" });
      expect(dereg.status).toBe(200);
      const list = await cm("ListInstances", { ServiceId: serviceId });
      expect(list.json.Instances.length).toBe(0);
    });

    it("errors registering to a missing service", async () => {
      const res = await cm("RegisterInstance", {
        ServiceId: "srv-ghost",
        InstanceId: "inst-1",
        Attributes: {},
      });
      expect(res.status).toBe(400);
      expect(res.json.__type).toBe("ServiceNotFound");
    });
  });
});
