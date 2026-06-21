import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleFormsServer } from "../services/google-forms/src/server.js";

const PORT = 24625;
const BASE_URL = `http://127.0.0.1:${PORT}`;

type Json = Record<string, any>;

async function api(method: string, path: string, body?: Json | string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: typeof body === "string" ? headers : body ? { "content-type": "application/json", ...headers } : headers,
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: text && contentType.includes("json") ? JSON.parse(text) : text, text, headers: res.headers };
}

async function createForm(title = "Feedback", extra: Json = {}) {
  const created = await api("POST", "/v1/forms", { info: { title, documentTitle: `${title} Doc` }, ...extra });
  expect(created.status).toBe(200);
  return created.data;
}

async function batch(formId: string, requests: Json[], extra: Json = {}) {
  const response = await api("POST", `/v1/forms/${formId}:batchUpdate`, { requests, ...extra });
  expect(response.status).toBe(200);
  return response.data;
}

describe("Google Forms Service", () => {
  let server: GoogleFormsServer;

  beforeAll(async () => {
    server = new GoogleFormsServer(PORT);
    await server.start();
    await new Promise((r) => setTimeout(r, 100));
  }, 10000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  describe("Server", () => {
    it("starts, serves discovery and health, supports forms/v1 alias, and resets state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.forms.size).toBe(0);

      const discovery = await api("GET", "/v1");
      expect(discovery).toMatchObject({ status: 200, data: { kind: "forms#parlel" } });

      const alias = await api("GET", "/forms/v1");
      expect(alias.data).toEqual({ kind: "forms#parlel" });

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "google-forms", forms: 0 });
      expect(health.headers.get("x-google-forms-emulator")).toBe("parlel");

      await createForm("Reset me");
      expect(server.forms.size).toBe(1);
      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toEqual(expect.objectContaining({ status: 200, data: { ok: true } }));
      expect(server.forms.size).toBe(0);
    });

    it("returns Google-shaped JSON errors", async () => {
      const missing = await api("GET", "/v1/forms/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
      expect(missing.data.error.errors[0]).toMatchObject({ domain: "global", reason: "notFound" });

      const invalid = await api("POST", "/v1/forms", "{", { "content-type": "application/json" });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("parseError");

      const method = await api("DELETE", "/v1/forms");
      expect(method.status).toBe(405);
      expect(method.data.error.status).toBe("METHOD_NOT_ALLOWED");
    });
  });

  describe("Forms", () => {
    it("create, get, create unpublished, and get through forms/v1 alias", async () => {
      const created = await createForm("Product Survey");
      expect(created.formId).toMatch(/^form_/);
      expect(created.info).toMatchObject({ title: "Product Survey", documentTitle: "Product Survey Doc" });
      expect(created.items).toEqual([]);
      expect(created.responderUri).toContain(created.formId);
      expect(created.publishSettings.publishState).toEqual({ isPublished: true, isAcceptingResponses: true });

      const got = await api("GET", `/v1/forms/${created.formId}`);
      expect(got.status).toBe(200);
      expect(got.data).toMatchObject({ formId: created.formId, info: { title: "Product Survey" } });

      const alias = await api("GET", `/forms/v1/forms/${created.formId}`);
      expect(alias.data.formId).toBe(created.formId);

      const unpublished = await api("POST", "/v1/forms?unpublished=true", { info: { title: "Draft" } });
      expect(unpublished.status).toBe(200);
      expect(unpublished.data.publishSettings.publishState).toEqual({ isPublished: false, isAcceptingResponses: false });
    });

    it("validates create payloads like Forms API", async () => {
      const missingTitle = await api("POST", "/v1/forms", { info: {} });
      expect(missingTitle.status).toBe(400);
      expect(missingTitle.data.error.errors[0].reason).toBe("invalidArgument");

      const disallowed = await api("POST", "/v1/forms", { info: { title: "Bad" }, items: [] });
      expect(disallowed.status).toBe(400);
      expect(disallowed.data.error.message).toContain("Only info.title");
    });

    it("setPublishSettings updates publish state and rejects impossible accepting state", async () => {
      const form = await createForm();
      const unpublished = await api("POST", `/v1/forms/${form.formId}:setPublishSettings`, {
        publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } },
        updateMask: "publishState",
      });
      expect(unpublished.status).toBe(200);
      expect(unpublished.data).toEqual({ formId: form.formId, publishSettings: { publishState: { isPublished: false, isAcceptingResponses: false } } });

      const invalid = await api("POST", `/v1/forms/${form.formId}:setPublishSettings`, {
        publishSettings: { publishState: { isPublished: false, isAcceptingResponses: true } },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("invalidArgument");
    });
  });

  describe("Batch Update", () => {
    it("updateFormInfo, updateSettings, createItem, updateItem, moveItem, and deleteItem", async () => {
      const form = await createForm("Original");

      const first = await batch(form.formId, [
        { updateFormInfo: { info: { title: "Renamed", description: "Tell us what changed", documentTitle: "Ignored" }, updateMask: "title,description,documentTitle" } },
        { updateSettings: { settings: { quizSettings: { isQuiz: true }, emailCollectionType: "RESPONDER_INPUT" }, updateMask: "quizSettings,emailCollectionType" } },
        { createItem: { location: { index: 0 }, item: { title: "Name", questionItem: { question: { textQuestion: {}, required: true } } } } },
        { createItem: { location: { index: 1 }, item: { itemId: "item_static", title: "Choice", questionItem: { question: { questionId: "question_static", choiceQuestion: { type: "RADIO", options: [{ value: "Yes" }, { value: "No" }] } } } } } },
        { createItem: { location: { index: 2 }, item: { title: "Rows", questionGroupItem: { grid: { columns: { type: "RADIO", options: [{ value: "A" }] } }, questions: [{ rowQuestion: { title: "Row 1" } }, { rowQuestion: { title: "Row 2" } }] } } } },
      ], { includeFormInResponse: true });

      expect(first.replies).toHaveLength(5);
      expect(first.replies[2].createItem.itemId).toMatch(/^item_/);
      expect(first.replies[2].createItem.questionId[0]).toMatch(/^question_/);
      expect(first.replies[3].createItem).toEqual({ itemId: "item_static", questionId: ["question_static"] });
      expect(first.replies[4].createItem.questionId).toHaveLength(2);
      expect(first.form.info).toMatchObject({ title: "Renamed", description: "Tell us what changed", documentTitle: "Original Doc" });
      expect(first.form.settings).toMatchObject({ quizSettings: { isQuiz: true }, emailCollectionType: "RESPONDER_INPUT" });

      const second = await batch(form.formId, [
        { updateItem: { location: { index: 1 }, item: { title: "Updated Choice", questionItem: { question: { questionId: "question_static", required: true } } }, updateMask: "title,questionItem.question.required" } },
        { moveItem: { originalLocation: { index: 1 }, newLocation: { index: 0 } } },
        { deleteItem: { location: { index: 2 } } },
      ], { includeFormInResponse: true, writeControl: { requiredRevisionId: first.writeControl.requiredRevisionId } });

      expect(second.replies).toEqual([{}, {}, {}]);
      expect(second.form.items.map((item: Json) => item.title)).toEqual(["Updated Choice", "Name"]);
      expect(second.form.items[0].questionItem.question.required).toBe(true);

      const got = await api("GET", `/v1/forms/${form.formId}`);
      expect(got.data.items).toHaveLength(2);
      expect(got.data.revisionId).toBe(second.writeControl.requiredRevisionId);
    });

    it("validates batchUpdate requests atomically", async () => {
      const form = await createForm("Errors");

      const badRequests = await api("POST", `/v1/forms/${form.formId}:batchUpdate`, { requests: {} });
      expect(badRequests.status).toBe(400);

      const staleRevision = await api("POST", `/v1/forms/${form.formId}:batchUpdate`, { requests: [], writeControl: { requiredRevisionId: "old" } });
      expect(staleRevision.status).toBe(400);
      expect(staleRevision.data.error.message).toContain("revision ID");

      const unsupported = await api("POST", `/v1/forms/${form.formId}:batchUpdate`, { requests: [{ unknownRequest: {} }] });
      expect(unsupported.status).toBe(400);
      expect(unsupported.data.error.message).toContain("Unsupported request type");

      const duplicate = await api("POST", `/v1/forms/${form.formId}:batchUpdate`, {
        requests: [
          { createItem: { location: { index: 0 }, item: { itemId: "dup", title: "One" } } },
          { createItem: { location: { index: 1 }, item: { itemId: "dup", title: "Two" } } },
        ],
      });
      expect(duplicate.status).toBe(400);
      expect((await api("GET", `/v1/forms/${form.formId}`)).data.items).toEqual([]);
    });
  });

  describe("Responses", () => {
    it("parlel-seeds responses, then forms.responses.get and forms.responses.list read them", async () => {
      const form = await createForm("Responses");
      const qid = (await batch(form.formId, [{ createItem: { location: { index: 0 }, item: { title: "Name", questionItem: { question: { textQuestion: {} } } } } }])).replies[0].createItem.questionId[0];

      const first = await api("POST", `/_parlel/forms/${form.formId}/responses`, {
        responseId: "response_a",
        createTime: "2026-06-11T10:00:00Z",
        lastSubmittedTime: "2026-06-11T10:00:00Z",
        respondentEmail: "ada@example.com",
        answers: { [qid]: { questionId: qid, textAnswers: { answers: [{ value: "Ada" }] }, grade: { score: 1 } } },
        totalScore: 1,
      });
      expect(first.status).toBe(200);
      expect(first.data.formId).toBe(form.formId);

      server.addResponse(form.formId, {
        responseId: "response_b",
        lastSubmittedTime: "2026-06-11T11:00:00Z",
        answers: { [qid]: { questionId: qid, textAnswers: { answers: [{ value: "Grace" }] } } },
      });
      server.addResponse(form.formId, { responseId: "response_c", lastSubmittedTime: "2026-06-11T12:00:00Z" });

      const got = await api("GET", `/v1/forms/${form.formId}/responses/response_a`);
      expect(got.status).toBe(200);
      expect(got.data).toMatchObject({ formId: form.formId, responseId: "response_a", respondentEmail: "ada@example.com", totalScore: 1 });
      expect(got.data.answers[qid].textAnswers.answers[0].value).toBe("Ada");

      const listed = await api("GET", `/v1/forms/${form.formId}/responses?pageSize=2`);
      expect(listed.status).toBe(200);
      expect(listed.data.responses.map((r: Json) => r.responseId)).toEqual(["response_a", "response_b"]);
      expect(listed.data.responses[0].formId).toBeUndefined();
      expect(listed.data.nextPageToken).toBe("2");

      const next = await api("GET", `/v1/forms/${form.formId}/responses?pageSize=2&pageToken=${listed.data.nextPageToken}`);
      expect(next.data.responses.map((r: Json) => r.responseId)).toEqual(["response_c"]);

      const filtered = await api("GET", `/v1/forms/${form.formId}/responses?filter=${encodeURIComponent("timestamp >= 2026-06-11T11:00:00Z")}`);
      expect(filtered.data.responses.map((r: Json) => r.responseId)).toEqual(["response_b", "response_c"]);
    });

    it("returns response edge errors", async () => {
      const form = await createForm();
      const missing = await api("GET", `/v1/forms/${form.formId}/responses/missing`);
      expect(missing.status).toBe(404);

      const badFilter = await api("GET", `/v1/forms/${form.formId}/responses?filter=${encodeURIComponent("bad filter")}`);
      expect(badFilter.status).toBe(400);
      expect(badFilter.data.error.errors[0].reason).toBe("invalidArgument");

      const badToken = await api("GET", `/v1/forms/${form.formId}/responses?pageToken=abc`);
      expect(badToken.status).toBe(400);
    });
  });

  describe("Watches", () => {
    it("forms.watches.create, list, renew, and delete", async () => {
      const form = await createForm("Watch me");
      const create = await api("POST", `/v1/forms/${form.formId}/watches`, {
        watchId: "schema-watch",
        watch: { eventType: "SCHEMA", target: { topic: { topicName: "projects/parlel/topics/forms" } } },
      });
      expect(create.status).toBe(200);
      expect(create.data).toMatchObject({ id: "schema-watch", eventType: "SCHEMA", state: "ACTIVE" });
      expect(create.data.expireTime).toBeTruthy();

      const list = await api("GET", `/v1/forms/${form.formId}/watches`);
      expect(list.status).toBe(200);
      expect(list.data.watches.map((watch: Json) => watch.id)).toEqual(["schema-watch"]);

      const renew = await api("POST", `/v1/forms/${form.formId}/watches/schema-watch:renew`, {});
      expect(renew.status).toBe(200);
      expect(renew.data).toMatchObject({ id: "schema-watch", state: "ACTIVE" });

      const deleted = await api("DELETE", `/v1/forms/${form.formId}/watches/schema-watch`);
      expect(deleted).toEqual(expect.objectContaining({ status: 200, data: {} }));
      expect((await api("GET", `/v1/forms/${form.formId}/watches`)).data.watches).toEqual([]);
    });

    it("validates watch limits, ids, required targets, and missing renew/delete", async () => {
      const form = await createForm();
      const badId = await api("POST", `/v1/forms/${form.formId}/watches`, {
        watchId: "Bad_ID",
        watch: { eventType: "RESPONSES", target: { topic: { topicName: "projects/parlel/topics/forms" } } },
      });
      expect(badId.status).toBe(400);

      const badTarget = await api("POST", `/v1/forms/${form.formId}/watches`, { watch: { eventType: "RESPONSES" } });
      expect(badTarget.status).toBe(400);

      await api("POST", `/v1/forms/${form.formId}/watches`, {
        watchId: "resp-watch",
        watch: { eventType: "RESPONSES", target: { topic: { topicName: "projects/parlel/topics/forms" } } },
      });
      const duplicateEvent = await api("POST", `/v1/forms/${form.formId}/watches`, {
        watchId: "resp-copy",
        watch: { eventType: "RESPONSES", target: { topic: { topicName: "projects/parlel/topics/forms" } } },
      });
      expect(duplicateEvent.status).toBe(409);
      expect(duplicateEvent.data.error.status).toBe("ALREADY_EXISTS");

      const missingRenew = await api("POST", `/v1/forms/${form.formId}/watches/missing:renew`, {});
      expect(missingRenew.status).toBe(404);

      const missingDelete = await api("DELETE", `/v1/forms/${form.formId}/watches/missing`);
      expect(missingDelete.status).toBe(404);
    });
  });
});
