import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { AcuitySchedulingServer } from "../services/acuity-scheduling/src/server.js";

const PORT = 14850;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BASIC = Buffer.from("parlel:parlelApiKey").toString("base64");
const AUTH = { Authorization: `Basic ${BASIC}` };

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json, headers: Json = AUTH) {
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

describe("Acuity Scheduling Service", () => {
  let server: AcuitySchedulingServer;

  beforeAll(async () => {
    server = new AcuitySchedulingServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server lifecycle", () => {
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
    });

    it("returns root and health", async () => {
      const root = await api("GET", "/");
      const health = await api("GET", "/health");
      expect(root.body.name).toBe("acuity-scheduling");
      expect(health.body).toEqual({ status: "ok" });
    });
  });

  describe("Authentication", () => {
    it("rejects missing basic auth with 401", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/me`, { method: "GET" });
      expect(response.status).toBe(401);
    });

    it("accepts Basic (userId:apiKey)", async () => {
      const result = await api("GET", "/api/v1/me");
      expect(result.status).toBe(200);
      expect(result.body.email).toBe("user@parlel.dev");
    });

    it("uses the real 401 unauthorized envelope", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/me`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(401);
      expect(body).toEqual({ status_code: 401, message: "Unauthorized", error: "unauthorized" });
    });
  });

  describe("Appointment types & availability", () => {
    it("lists appointment types", async () => {
      const result = await api("GET", "/api/v1/appointment-types");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body.length).toBeGreaterThanOrEqual(2);
    });

    it("returns availability dates for a month", async () => {
      const result = await api("GET", "/api/v1/availability/dates?month=2024-06&appointmentTypeID=1");
      expect(result.status).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body[0].date).toMatch(/^2024-06/);
    });
  });

  describe("Meta", () => {
    it("returns /meta without auth (public endpoint)", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/meta`, { method: "GET" });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(Array.isArray(body.hooks)).toBe(true);
    });
  });

  describe("Appointments CRUD round-trip", () => {
    it("creates, retrieves, lists, updates and cancels an appointment", async () => {
      const created = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@parlel.dev",
      });
      expect(created.status).toBe(200);
      expect(created.body.firstName).toBe("Alice");
      const id = created.body.id;
      expect(id).toBeTruthy();
      expect(created.body.type).toBe("Initial Consultation");

      const got = await api("GET", `/api/v1/appointments/${id}`);
      expect(got.status).toBe(200);
      expect(got.body.email).toBe("alice@parlel.dev");

      const list = await api("GET", "/api/v1/appointments");
      expect(list.body.length).toBe(1);

      const updated = await api("PUT", `/api/v1/appointments/${id}`, { firstName: "Alicia" });
      expect(updated.body.firstName).toBe("Alicia");

      const cancelled = await api("PUT", `/api/v1/appointments/${id}/cancel`, {});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.canceled).toBe(true);
    });

    it("returns the real Acuity appointment field shape on create", async () => {
      const created = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@parlel.dev",
      });
      const appt = created.body;
      // Fields the real API always returns (OpenAPI examples).
      expect(appt.classID).toBeNull();
      expect(typeof appt.category).toBe("string");
      expect(appt.location).toBe("");
      expect(typeof appt.confirmationPage).toBe("string");
      expect(appt.formsText).toBe("");
      expect(appt.amountPaid).toBe("0.00");
      expect(Array.isArray(appt.labels)).toBe(true);
      expect(Array.isArray(appt.forms)).toBe(true);
      // duration/price are strings in the real API.
      expect(typeof appt.duration).toBe("string");
      expect(typeof appt.price).toBe("string");
    });

    it("builds the real forms[].values shape from POST fields", async () => {
      const created = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@parlel.dev",
        fields: [{ id: 1, value: "Party time!" }],
      });
      expect(created.status).toBe(200);
      expect(created.body.forms.length).toBe(1);
      const value = created.body.forms[0].values[0];
      expect(value.fieldID).toBe(1);
      expect(value.value).toBe("Party time!");
      expect(value.id).toBeTruthy();
    });

    it("excludes canceled appointments from the default list", async () => {
      const created = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@parlel.dev",
      });
      const id = created.body.id;
      await api("PUT", `/api/v1/appointments/${id}/cancel`, {});

      const list = await api("GET", "/api/v1/appointments");
      expect(list.body.length).toBe(0);

      const canceledOnly = await api("GET", "/api/v1/appointments?canceled=true");
      expect(canceledOnly.body.length).toBe(1);

      const all = await api("GET", "/api/v1/appointments?showall=true");
      expect(all.body.length).toBe(1);
    });

    it("does not reschedule via PUT (datetime is not in the update white-list)", async () => {
      const created = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@parlel.dev",
      });
      const id = created.body.id;
      const updated = await api("PUT", `/api/v1/appointments/${id}`, {
        firstName: "Alicia",
        datetime: "2099-12-31T23:59:00-0000",
      });
      expect(updated.body.firstName).toBe("Alicia");
      expect(updated.body.datetime).toBe("2024-06-01T09:00:00-0000");
    });

    it("rejects missing required fields with the real Acuity error codes", async () => {
      const noDatetime = await api("POST", "/api/v1/appointments", {
        appointmentTypeID: 1,
        firstName: "Bob",
        lastName: "McTest",
        email: "bob@parlel.dev",
      });
      expect(noDatetime.status).toBe(400);
      expect(noDatetime.body.error).toBe("required_datetime");

      const noFirstName = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        lastName: "McTest",
        email: "bob@parlel.dev",
      });
      expect(noFirstName.status).toBe(400);
      expect(noFirstName.body.error).toBe("required_first_name");

      const noEmail = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 1,
        firstName: "Bob",
        lastName: "McTest",
      });
      expect(noEmail.status).toBe(400);
      expect(noEmail.body.error).toBe("required_email");
    });

    it("rejects an unknown appointment type with invalid_appointment_type", async () => {
      const result = await api("POST", "/api/v1/appointments", {
        datetime: "2024-06-01T09:00:00-0000",
        appointmentTypeID: 987654321,
        firstName: "Bob",
        lastName: "McTest",
        email: "bob@parlel.dev",
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("invalid_appointment_type");
    });

    it("rejects appointment creation without datetime/type (400)", async () => {
      const result = await api("POST", "/api/v1/appointments", { firstName: "Bob" });
      expect(result.status).toBe(400);
    });

    it("404 unknown appointment", async () => {
      const result = await api("GET", "/api/v1/appointments/999999");
      expect(result.status).toBe(404);
    });
  });
});
