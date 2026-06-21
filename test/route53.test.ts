import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Route53Server } from "../services/route53/src/server.js";

const PORT = 14711;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const BASE = `${ENDPOINT}/2013-04-01`;

async function xhr(method: string, path: string, body?: string) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers: { "Content-Type": "application/xml" },
    body,
  });
  const text = await res.text();
  return { status: res.status, text };
}

function extract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

async function createZone(name: string) {
  const body =
    `<CreateHostedZoneRequest>` +
    `<Name>${name}</Name>` +
    `<CallerReference>ref-${Date.now()}-${Math.random()}</CallerReference>` +
    `<HostedZoneConfig><Comment>test</Comment></HostedZoneConfig>` +
    `</CreateHostedZoneRequest>`;
  return xhr("POST", "/2013-04-01/hostedzone", body);
}

describe("Route53 Service", () => {
  let server: Route53Server;

  beforeAll(async () => {
    server = new Route53Server(PORT);
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

    it("uses default port 4711", () => {
      const s = new Route53Server();
      expect(s.port).toBe(4711);
    });

    it("exposes a health endpoint", async () => {
      const res = await fetch(`${ENDPOINT}/_parlel/health`);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.service).toBe("route53");
    });

    it("supports POST /_parlel/reset", async () => {
      await createZone("reset.example.com");
      const res = await fetch(`${ENDPOINT}/_parlel/reset`, { method: "POST" });
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(server.hostedZones.size).toBe(0);
    });
  });

  describe("Hosted zones", () => {
    it("creates a hosted zone with NS/SOA seeded", async () => {
      const res = await createZone("example.com");
      expect(res.status).toBe(201);
      expect(res.text).toContain("<Name>example.com.</Name>");
      const id = extract(res.text, "Id");
      expect(id).toContain("/hostedzone/Z");
    });

    it("lists hosted zones", async () => {
      await createZone("list1.example.com");
      await createZone("list2.example.com");
      const res = await xhr("GET", "/2013-04-01/hostedzone");
      expect(res.status).toBe(200);
      expect(res.text).toContain("list1.example.com.");
      expect(res.text).toContain("list2.example.com.");
    });

    it("gets a hosted zone by id", async () => {
      const created = await createZone("get.example.com");
      const fqId = extract(created.text, "Id")!; // /hostedzone/Z...
      const id = fqId.replace("/hostedzone/", "");
      const res = await xhr("GET", `/2013-04-01/hostedzone/${id}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("get.example.com.");
    });

    it("deletes an empty hosted zone", async () => {
      const created = await createZone("del.example.com");
      const id = extract(created.text, "Id")!.replace("/hostedzone/", "");
      const res = await xhr("DELETE", `/2013-04-01/hostedzone/${id}`);
      expect(res.status).toBe(200);
      const get = await xhr("GET", `/2013-04-01/hostedzone/${id}`);
      expect(get.status).toBe(404);
      expect(get.text).toContain("NoSuchHostedZone");
    });

    it("errors getting a missing hosted zone", async () => {
      const res = await xhr("GET", "/2013-04-01/hostedzone/ZNOTREAL");
      expect(res.status).toBe(404);
      expect(res.text).toContain("NoSuchHostedZone");
    });
  });

  describe("Record sets", () => {
    async function makeZone() {
      const created = await createZone("records.example.com");
      return extract(created.text, "Id")!.replace("/hostedzone/", "");
    }

    it("upserts a record set and lists it", async () => {
      const id = await makeZone();
      const body =
        `<ChangeResourceRecordSetsRequest>` +
        `<ChangeBatch><Changes><Change>` +
        `<Action>UPSERT</Action>` +
        `<ResourceRecordSet>` +
        `<Name>www.records.example.com.</Name>` +
        `<Type>A</Type><TTL>300</TTL>` +
        `<ResourceRecords><ResourceRecord><Value>1.2.3.4</Value></ResourceRecord></ResourceRecords>` +
        `</ResourceRecordSet>` +
        `</Change></Changes></ChangeBatch>` +
        `</ChangeResourceRecordSetsRequest>`;
      const change = await xhr("POST", `/2013-04-01/hostedzone/${id}/rrset`, body);
      expect(change.status).toBe(200);
      expect(change.text).toContain("PENDING");

      const list = await xhr("GET", `/2013-04-01/hostedzone/${id}/rrset`);
      expect(list.text).toContain("www.records.example.com.");
      expect(list.text).toContain("1.2.3.4");
    });

    it("deletes a record set", async () => {
      const id = await makeZone();
      const upsert =
        `<ChangeResourceRecordSetsRequest><ChangeBatch><Changes><Change>` +
        `<Action>CREATE</Action><ResourceRecordSet>` +
        `<Name>api.records.example.com.</Name><Type>A</Type><TTL>60</TTL>` +
        `<ResourceRecords><ResourceRecord><Value>9.9.9.9</Value></ResourceRecord></ResourceRecords>` +
        `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
      await xhr("POST", `/2013-04-01/hostedzone/${id}/rrset`, upsert);

      const del =
        `<ChangeResourceRecordSetsRequest><ChangeBatch><Changes><Change>` +
        `<Action>DELETE</Action><ResourceRecordSet>` +
        `<Name>api.records.example.com.</Name><Type>A</Type><TTL>60</TTL>` +
        `<ResourceRecords><ResourceRecord><Value>9.9.9.9</Value></ResourceRecord></ResourceRecords>` +
        `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
      const delRes = await xhr("POST", `/2013-04-01/hostedzone/${id}/rrset`, del);
      expect(delRes.status).toBe(200);

      const list = await xhr("GET", `/2013-04-01/hostedzone/${id}/rrset`);
      expect(list.text).not.toContain("api.records.example.com.");
    });

    it("refuses to delete a non-empty hosted zone", async () => {
      const id = await makeZone();
      const upsert =
        `<ChangeResourceRecordSetsRequest><ChangeBatch><Changes><Change>` +
        `<Action>CREATE</Action><ResourceRecordSet>` +
        `<Name>x.records.example.com.</Name><Type>A</Type><TTL>60</TTL>` +
        `<ResourceRecords><ResourceRecord><Value>5.5.5.5</Value></ResourceRecord></ResourceRecords>` +
        `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;
      await xhr("POST", `/2013-04-01/hostedzone/${id}/rrset`, upsert);
      const del = await xhr("DELETE", `/2013-04-01/hostedzone/${id}`);
      expect(del.status).toBe(400);
      expect(del.text).toContain("HostedZoneNotEmpty");
    });
  });
});
