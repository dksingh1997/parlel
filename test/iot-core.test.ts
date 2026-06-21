import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { IotCoreServer } from "../services/iot-core/src/server.js";

const PORT = 14743;
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
  return { status: res.status, json };
}

let server: IotCoreServer;

beforeAll(async () => {
  server = new IotCoreServer(PORT);
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(async () => {
  await fetch(ENDPOINT + "/_parlel/reset", { method: "POST" });
});

async function mkThing(name = "thing1") {
  return call("POST", `/things/${name}`, { attributePayload: { attributes: { color: "red" } } });
}

describe("iot-core", () => {
  it("health ok", async () => {
    const res = await fetch(ENDPOINT + "/_parlel/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("iot-core");
  });

  it("default port 4743", () => {
    expect(new IotCoreServer().port).toBe(4743);
  });

  it("creates and describes a thing", async () => {
    const c = await mkThing("t1");
    expect(c.status).toBe(200);
    expect(c.json.thingArn).toContain("thing/t1");
    const d = await call("GET", "/things/t1");
    expect(d.status).toBe(200);
    expect(d.json.thingName).toBe("t1");
    expect(d.json.attributes.color).toBe("red");
  });

  it("rejects duplicate thing", async () => {
    await mkThing("dup");
    const again = await mkThing("dup");
    expect(again.status).toBe(409);
  });

  it("lists things", async () => {
    await mkThing("a");
    await mkThing("b");
    const list = await call("GET", "/things");
    expect(list.json.things.length).toBe(2);
  });

  it("deletes a thing", async () => {
    await mkThing("d1");
    const del = await call("DELETE", "/things/d1");
    expect(del.status).toBe(200);
    const d = await call("GET", "/things/d1");
    expect(d.status).toBe(404);
  });

  it("updates a shadow and computes delta", async () => {
    await mkThing("s1");
    const upd = await call("POST", "/things/s1/shadow", {
      state: { desired: { temp: 72 } },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.version).toBe(1);
    expect(upd.json.state.desired.temp).toBe(72);
    // Desired but not reported -> delta.
    expect(upd.json.state.delta.temp).toBe(72);
  });

  it("reported state clears delta", async () => {
    await mkThing("s2");
    await call("POST", "/things/s2/shadow", { state: { desired: { temp: 72 } } });
    const upd = await call("POST", "/things/s2/shadow", { state: { reported: { temp: 72 } } });
    expect(upd.json.version).toBe(2);
    expect(upd.json.state.delta).toBeUndefined();
    expect(upd.json.state.reported.temp).toBe(72);
  });

  it("gets a shadow", async () => {
    await mkThing("s3");
    await call("POST", "/things/s3/shadow", { state: { reported: { on: true } } });
    const g = await call("GET", "/things/s3/shadow");
    expect(g.status).toBe(200);
    expect(g.json.state.reported.on).toBe(true);
  });

  it("get shadow before any update is 404", async () => {
    await mkThing("s4");
    const g = await call("GET", "/things/s4/shadow");
    expect(g.status).toBe(404);
  });

  it("deletes a shadow", async () => {
    await mkThing("s5");
    await call("POST", "/things/s5/shadow", { state: { reported: { on: true } } });
    const del = await call("DELETE", "/things/s5/shadow");
    expect(del.status).toBe(200);
    const g = await call("GET", "/things/s5/shadow");
    expect(g.status).toBe(404);
  });

  it("named shadow support", async () => {
    await mkThing("s6");
    const upd = await call("POST", "/things/s6/shadow?name=cfg", { state: { desired: { x: 1 } } });
    expect(upd.status).toBe(200);
    const g = await call("GET", "/things/s6/shadow?name=cfg");
    expect(g.json.state.desired.x).toBe(1);
    // Default shadow should still be empty/404.
    const gd = await call("GET", "/things/s6/shadow");
    expect(gd.status).toBe(404);
  });
});
