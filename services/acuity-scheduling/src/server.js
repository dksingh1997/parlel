import { createServer } from "node:http";

// ---------------------------------------------------------------------------
// parlel/acuity-scheduling — dependency-free in-memory fake of the Acuity
// Scheduling API. Basic auth (userId:apiKey). Appointment shape mirrors the
// real API: { id, firstName, lastName, email, datetime, type, ... }.
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

// Build the real Acuity `forms` response shape from a POST/PUT `fields` array.
// Real shape: [{ id, name, values: [{ value, name, fieldID, id }] }].
function buildForms(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return [];
  let valueId = 100000;
  return [
    {
      id: 1,
      name: "Example Intake Form",
      values: fields.map((f) => ({
        value: f && f.value !== undefined ? String(f.value) : "",
        name: f && f.name ? String(f.name) : `Field ${f && f.id !== undefined ? f.id : ""}`,
        fieldID: f && f.id !== undefined ? Number(f.id) : 0,
        id: (valueId += 1),
      })),
    },
  ];
}

export class AcuitySchedulingServer {
  constructor(port = 4850, options = {}) {
    this.port = port;
    this.host = options.host || "127.0.0.1";
    this.requireAuth = options.requireAuth !== false;
    this.server = null;
    this.reset();
  }

  reset() {
    this.appointments = new Map();
    this.appointmentTypes = new Map();
    this._apptCounter = 0;
    this._typeCounter = 0;
    this.me = {
      id: 100001,
      firstName: "Parlel",
      lastName: "User",
      name: "Parlel User",
      email: "user@parlel.dev",
      phone: "",
      currency: "USD",
      country: "US",
      timezone: "UTC",
      plan: "Powerhouse",
    };
    this._seed();
  }

  _seed() {
    this._createType({ name: "Initial Consultation", duration: 30, price: "0.00" });
    this._createType({ name: "Follow-up", duration: 60, price: "50.00" });
  }

  _createType(props) {
    this._typeCounter += 1;
    const id = this._typeCounter;
    const type = {
      id,
      name: props.name || "Appointment",
      active: true,
      description: props.description || "",
      duration: props.duration || 30,
      price: props.price || "0.00",
      category: props.category || "",
      color: "#9CCD6C",
      private: false,
      type: "service",
    };
    this.appointmentTypes.set(id, type);
    return type;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.send(res, 500, { status_code: 500, message: error.message || "Internal server error", error: "internal" });
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("server", "parlel-acuity-scheduling");

    if (req.method === "OPTIONS") return this.send(res, 204, null);

    if (req.method === "GET" && parts.length === 0) return this.send(res, 200, this.root());
    if (req.method === "GET" && parts[0] === "health") return this.send(res, 200, { status: "ok" });
    if (parts[0] === "__parlel") return this.handleControl(req, res, parts);

    // Acuity surface is under /api/v1
    if (!(parts[0] === "api" && parts[1] === "v1")) {
      return this.send(res, 404, { status_code: 404, message: "not found", error: "not_found" });
    }

    const route = parts.slice(2);

    // GET /api/v1/meta — public metadata, no auth required (real API: security: []).
    if (req.method === "GET" && route[0] === "meta" && route.length === 1) {
      return this.send(res, 200, { hooks: [] });
    }

    if (!this.isAuthorized(req)) {
      return this.send(res, 401, { status_code: 401, message: "Unauthorized", error: "unauthorized" });
    }

    // GET /api/v1/me
    if (req.method === "GET" && route[0] === "me" && route.length === 1) {
      return this.send(res, 200, clone(this.me));
    }

    // GET /api/v1/appointment-types
    if (req.method === "GET" && route[0] === "appointment-types" && route.length === 1) {
      return this.send(res, 200, Array.from(this.appointmentTypes.values()).map(clone));
    }

    // GET /api/v1/availability/dates?month=
    if (route[0] === "availability" && route[1] === "dates" && route.length === 2 && req.method === "GET") {
      const month = url.searchParams.get("month") || "2024-06";
      const dates = [`${month}-01`, `${month}-02`, `${month}-03`].map((date) => ({ date }));
      return this.send(res, 200, dates);
    }

    // GET /api/v1/availability/times?date=&appointmentTypeID=
    if (route[0] === "availability" && route[1] === "times" && route.length === 2 && req.method === "GET") {
      const date = url.searchParams.get("date") || "2024-06-01";
      const times = [`${date}T09:00:00-0000`, `${date}T09:30:00-0000`].map((time) => ({ time }));
      return this.send(res, 200, times);
    }

    // /api/v1/appointments ...
    if (route[0] === "appointments") {
      if (route.length === 1) {
        if (req.method === "GET") {
          // Real API: canceled appointments are excluded unless ?canceled=true or ?showall=true.
          const showCanceled = url.searchParams.get("canceled") === "true";
          const showAll = url.searchParams.get("showall") === "true";
          const list = Array.from(this.appointments.values()).filter((appt) => {
            if (showAll) return true;
            return showCanceled ? appt.canceled === true : appt.canceled !== true;
          });
          return this.send(res, 200, list.map(clone));
        }
        if (req.method === "POST") {
          return this.createAppointment(res, body);
        }
      }

      const apptId = Number(route[1]);
      const appt = this.appointments.get(apptId);

      // GET /api/v1/appointments/:id
      if (route.length === 2 && req.method === "GET") {
        if (!appt) return this.notFound(res);
        return this.send(res, 200, clone(appt));
      }
      // PUT /api/v1/appointments/:id
      if (route.length === 2 && req.method === "PUT") {
        if (!appt) return this.notFound(res);
        if (isPlainObject(body)) {
          // Real API white-list (datetime is NOT updatable here — reschedule is separate).
          for (const k of ["firstName", "lastName", "phone", "email", "certificate", "notes"]) {
            if (typeof body[k] === "string") appt[k] = body[k];
          }
          if (Array.isArray(body.fields)) appt.forms = buildForms(body.fields);
          if (Array.isArray(body.labels)) appt.labels = clone(body.labels);
          if (typeof body.smsOptIn === "boolean") appt.smsOptIn = body.smsOptIn;
        }
        return this.send(res, 200, clone(appt));
      }
      // PUT /api/v1/appointments/:id/cancel
      if (route.length === 3 && route[2] === "cancel" && req.method === "PUT") {
        if (!appt) return this.notFound(res);
        appt.canceled = true;
        return this.send(res, 200, clone(appt));
      }
    }

    return this.notFound(res);
  }

  createAppointment(res, body) {
    const data = isPlainObject(body) ? body : {};
    // Real API validates required attributes in order, each with a stable error code.
    // By default appointments are booked as a client (?admin=true relaxes validation).
    const validation =
      this._missing(data, "datetime", "required_datetime", 'The parameter "datetime" is required.') ||
      this._missing(data, "appointmentTypeID", "required_appointment_type_id", 'The parameter "appointmentTypeID" is required.') ||
      this._missing(data, "firstName", "required_first_name", 'Attribute "firstName" is required.') ||
      this._missing(data, "lastName", "required_last_name", 'Attribute "lastName" is required.') ||
      this._missing(data, "email", "required_email", 'Attribute "email" is required.');
    if (validation) {
      return this.send(res, 400, validation);
    }

    const type = this.appointmentTypes.get(Number(data.appointmentTypeID));
    if (!type) {
      return this.send(res, 400, {
        status_code: 400,
        message: `The appointment type "${data.appointmentTypeID}" does not exist.`,
        error: "invalid_appointment_type",
      });
    }

    this._apptCounter += 1;
    const id = 1000000 + this._apptCounter;
    const appointment = {
      id,
      firstName: data.firstName || "",
      lastName: data.lastName || "",
      phone: data.phone || "",
      email: data.email || "",
      date: "June 1, 2024",
      time: "9:00am",
      endTime: "9:30am",
      dateCreated: "January 1, 2024",
      datetime: data.datetime,
      datetimeCreated: "2024-01-01T00:00:00-0000",
      price: type.price,
      paid: "no",
      amountPaid: "0.00",
      type: type.name,
      appointmentTypeID: Number(data.appointmentTypeID),
      classID: null,
      category: type.category || "",
      duration: String(type.duration),
      calendar: "Parlel",
      calendarID: Number(data.calendarID) || 1,
      location: "",
      certificate: typeof data.certificate === "string" ? data.certificate : null,
      confirmationPage: `https://acuityscheduling.com/schedule.php?owner=100001&id[]=${id}&action=appt`,
      formsText: "",
      notes: data.notes || "",
      timezone: data.timezone || "UTC",
      canceled: false,
      forms: buildForms(data.fields),
      labels: Array.isArray(data.labels) ? clone(data.labels) : [],
    };
    this.appointments.set(id, appointment);
    return this.send(res, 200, clone(appointment));
  }

  _missing(data, key, error, message) {
    const value = data[key];
    if (value === undefined || value === null || value === "") {
      return { status_code: 400, message, error };
    }
    return null;
  }

  handleControl(req, res, parts) {
    if (req.method === "POST" && parts[1] === "reset") {
      this.reset();
      return this.send(res, 200, { ok: true });
    }
    return this.notFound(res);
  }

  notFound(res) {
    return this.send(res, 404, { status_code: 404, message: "The requested resource could not be found.", error: "not_found" });
  }

  root() {
    return {
      name: "acuity-scheduling",
      version: "1",
      protocol: "acuity-scheduling-api",
      documentation: "/docs/acuity-scheduling.md",
    };
  }

  isAuthorized(req) {
    if (!this.requireAuth) return true;
    const auth = req.headers.authorization || "";
    return /^Basic\s+\S+/i.test(auth) || /^Bearer\s+\S+/i.test(auth);
  }

  readBody(req, res) {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => {
        if (!data) return resolve({});
        const ct = String(req.headers["content-type"] || "");
        if (ct.includes("application/x-www-form-urlencoded")) {
          const params = new URLSearchParams(data);
          const obj = {};
          for (const [k, v] of params) obj[k] = v;
          return resolve(obj);
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          this.send(res, 400, { status_code: 400, message: "Bad request body", error: "invalid_json" });
          resolve(SENTINEL_BAD_JSON);
        }
      });
      req.on("error", () => {
        this.send(res, 400, { status_code: 400, message: "Bad request body", error: "invalid_json" });
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
