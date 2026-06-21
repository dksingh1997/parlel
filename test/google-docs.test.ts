import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleDocsServer } from "../services/google-docs/src/server.js";

const PORT = 24616;
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

async function createDocument(title = "Test Doc") {
  const created = await api("POST", "/v1/documents", { title });
  expect(created.status).toBe(200);
  return created.data;
}

async function batch(documentId: string, requests: Json[]) {
  const response = await api("POST", `/v1/documents/${documentId}:batchUpdate`, { requests });
  expect(response.status).toBe(200);
  return response.data;
}

describe("Google Docs Service", () => {
  let server: GoogleDocsServer;

  beforeAll(async () => {
    server = new GoogleDocsServer(PORT);
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
    it("starts, serves discovery and health, supports docs/v1 alias, and resets state", async () => {
      expect(server.port).toBe(PORT);
      expect(server.documents.size).toBe(0);

      const discovery = await api("GET", "/v1");
      expect(discovery).toMatchObject({ status: 200, data: { kind: "docs#parlel" } });

      const alias = await api("GET", "/docs/v1");
      expect(alias.data).toEqual({ kind: "docs#parlel" });

      const health = await api("GET", "/_parlel/health");
      expect(health.data).toEqual({ status: "ok", service: "google-docs", documents: 0 });

      await createDocument("Reset me");
      expect(server.documents.size).toBe(1);
      const reset = await api("POST", "/_parlel/reset");
      expect(reset).toEqual(expect.objectContaining({ status: 200, data: { ok: true } }));
      expect(server.documents.size).toBe(0);
    });

    it("returns Google-shaped JSON errors", async () => {
      const missing = await api("GET", "/v1/documents/missing");
      expect(missing.status).toBe(404);
      expect(missing.data.error).toMatchObject({ code: 404, status: "NOT_FOUND" });
      expect(missing.data.error.errors[0]).toMatchObject({ domain: "global", reason: "notFound" });

      const invalid = await api("POST", "/v1/documents", "{", { "content-type": "application/json" });
      expect(invalid.status).toBe(400);
      expect(invalid.data.error.errors[0].reason).toBe("parseError");

      const method = await api("DELETE", "/v1/documents");
      expect(method.status).toBe(405);
      expect(method.data.error.status).toBe("METHOD_NOT_ALLOWED");
    });
  });

  describe("Documents", () => {
    it("create and get documents with Docs-shaped content", async () => {
      const created = await createDocument("Product Notes");
      expect(created.documentId).toMatch(/^doc_/);
      expect(created.title).toBe("Product Notes");
      expect(created.body.content[0].paragraph.elements[0].textRun.content).toBe("\n");
      expect(created.tabs).toEqual([]);

      const got = await api("GET", `/v1/documents/${created.documentId}?suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);
      expect(got.status).toBe(200);
      expect(got.data).toMatchObject({ documentId: created.documentId, title: "Product Notes", suggestionsViewMode: "PREVIEW_WITHOUT_SUGGESTIONS" });
      expect(got.data.tabs).toEqual([]);

      const alias = await api("GET", `/docs/v1/documents/${created.documentId}`);
      expect(alias.data.documentId).toBe(created.documentId);
    });

    it("ignores output-only document ids on create", async () => {
      const first = await api("POST", "/v1/documents", { documentId: "doc_fixed", title: "One" });
      expect(first.status).toBe(200);
      expect(first.data.documentId).not.toBe("doc_fixed");

      const duplicate = await api("POST", "/v1/documents", { documentId: "doc_fixed", title: "Two" });
      expect(duplicate.status).toBe(200);
      expect(duplicate.data.documentId).not.toBe(first.data.documentId);
    });

    it("populates tabs only when includeTabsContent is true", async () => {
      const doc = await createDocument("Tabs gate");
      await batch(doc.documentId, [{ insertText: { location: { index: 1 }, text: "Tabbed content" } }]);

      const legacy = await api("GET", `/v1/documents/${doc.documentId}`);
      expect(legacy.data.body.content[0].paragraph.elements[0].textRun.content).toContain("Tabbed content");
      expect(legacy.data.tabs).toEqual([]);

      const tabs = await api("GET", `/v1/documents/${doc.documentId}?includeTabsContent=true`);
      expect(tabs.data.body).toBeUndefined();
      expect(tabs.data.documentStyle).toBeUndefined();
      expect(tabs.data.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.content).toContain("Tabbed content");
    });
  });

  describe("Text, paragraph, and named range batchUpdate requests", () => {
    it("insertText, deleteContentRange, replaceAllText, styles, bullets, and named ranges", async () => {
      const doc = await createDocument("Batch Text");

      let result = await batch(doc.documentId, [
        { insertText: { location: { index: 1 }, text: "Hello parlel docs\nSecond line\n" } },
        { updateTextStyle: { range: { startIndex: 1, endIndex: 6 }, textStyle: { bold: true }, fields: "bold" } },
        { updateParagraphStyle: { range: { startIndex: 1, endIndex: 19 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
        { createParagraphBullets: { range: { startIndex: 19, endIndex: 31 }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
        { createNamedRange: { name: "greeting", range: { startIndex: 1, endIndex: 6 } } },
      ]);

      expect(result.replies).toHaveLength(5);
      const namedRangeId = result.replies[4].createNamedRange.namedRangeId;
      expect(namedRangeId).toMatch(/^namedRange_/);

      result = await batch(doc.documentId, [
        { replaceAllText: { containsText: { text: "parlel", matchCase: true }, replaceText: "parlel-pool" } },
        { replaceNamedRangeContent: { namedRangeName: "greeting", text: "Hi" } },
        { deleteParagraphBullets: { range: { startIndex: 20, endIndex: 32 } } },
        { deleteContentRange: { range: { startIndex: 3, endIndex: 4 } } },
        { deleteNamedRange: { name: "greeting" } },
      ]);

      expect(result.replies[0].replaceAllText.occurrencesChanged).toBe(1);

      const got = await api("GET", `/v1/documents/${doc.documentId}`);
      const bodyText = got.data.body.content.map((item: Json) => item.paragraph?.elements?.[0]?.textRun?.content || "").join("");
      expect(bodyText).toContain("Hiparlel-pool docs");
      expect(got.data.namedRanges).toEqual({});
      expect(got.data.body.content[0].paragraph.elements[0].textRun.textStyle).toEqual({ bold: true });
      expect(got.data.body.content[0].paragraph.paragraphStyle.namedStyleType).toBe("HEADING_1");
    });

    it("validates text requests and unsupported request types", async () => {
      const doc = await createDocument("Errors");

      const badIndex = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, { requests: [{ insertText: { location: { index: 99 }, text: "x" } }] });
      expect(badIndex.status).toBe(400);
      expect(badIndex.data.error.errors[0].reason).toBe("invalidArgument");

      const lastNewline = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }] });
      expect(lastNewline.status).toBe(400);

      const unsupported = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, { requests: [{ unknownRequest: {} }] });
      expect(unsupported.status).toBe(400);
      expect(unsupported.data.error.message).toContain("Unsupported request type");
    });

    it("applies batchUpdate atomically and validates required revision IDs", async () => {
      const doc = await createDocument("Atomic");

      const failed = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, {
        requests: [
          { insertText: { location: { index: 1 }, text: "should rollback" } },
          { insertText: { location: { index: 99 }, text: "bad" } },
        ],
      });
      expect(failed.status).toBe(400);

      const afterFailed = await api("GET", `/v1/documents/${doc.documentId}`);
      expect(afterFailed.data.body.content[0].paragraph.elements[0].textRun.content).toBe("\n");
      expect(afterFailed.data.revisionId).toBe(doc.revisionId);

      const stale = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, {
        writeControl: { requiredRevisionId: "old-revision" },
        requests: [{ insertText: { location: { index: 1 }, text: "x" } }],
      });
      expect(stale.status).toBe(400);
      expect(stale.data.error.errors[0].reason).toBe("failedPrecondition");

      const updated = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, {
        writeControl: { requiredRevisionId: doc.revisionId },
        requests: [{ insertText: { location: { index: 1 }, text: "ok" } }],
      });
      expect(updated.status).toBe(200);
      expect(updated.data.writeControl.requiredRevisionId).not.toBe(doc.revisionId);
    });
  });

  describe("Objects, layout, and styles", () => {
    it("inline images, replacement, page/section breaks, headers, footers, footnotes, document and section styles", async () => {
      const doc = await createDocument("Objects");

      const result = await batch(doc.documentId, [
        { insertText: { location: { index: 1 }, text: "Image here\n" } },
        { insertInlineImage: { location: { index: 7 }, uri: "https://example.test/image.png", objectSize: { height: { magnitude: 100, unit: "PT" } } } },
        { insertPageBreak: { endOfSegmentLocation: {} } },
        { insertSectionBreak: { endOfSegmentLocation: {}, sectionType: "NEXT_PAGE" } },
        { updateDocumentStyle: { documentStyle: { marginTop: { magnitude: 36, unit: "PT" } }, fields: "marginTop" } },
        { updateSectionStyle: { range: { startIndex: 1, endIndex: 8 }, sectionStyle: { columnSeparatorStyle: "BETWEEN_EACH_COLUMN" }, fields: "columnSeparatorStyle" } },
        { createHeader: { type: "DEFAULT" } },
        { createFooter: { type: "DEFAULT" } },
        { createFootnote: { location: { index: 2 } } },
      ]);

      const imageObjectId = result.replies[1].insertInlineImage.objectId;
      const headerId = result.replies[6].createHeader.headerId;
      const footerId = result.replies[7].createFooter.footerId;
      const footnoteId = result.replies[8].createFootnote.footnoteId;
      expect(imageObjectId).toMatch(/^inlineObject_/);
      expect(headerId).toMatch(/^header_/);
      expect(footerId).toMatch(/^footer_/);
      expect(footnoteId).toMatch(/^footnote_/);

      await batch(doc.documentId, [
        { replaceImage: { imageObjectId, uri: "https://example.test/new.png", imageReplaceMethod: "CENTER_CROP" } },
        { deleteHeader: { headerId } },
        { deleteFooter: { footerId } },
      ]);

      const got = await api("GET", `/v1/documents/${doc.documentId}`);
      expect(got.data.inlineObjects[imageObjectId].inlineObjectProperties.embeddedObject.imageProperties.sourceUri).toBe("https://example.test/new.png");
      expect(got.data.documentStyle.marginTop).toEqual({ magnitude: 36, unit: "PT" });
      expect(got.data.headers).toEqual({});
      expect(got.data.footers).toEqual({});
      expect(got.data.footnotes[footnoteId].footnoteId).toBe(footnoteId);
    });

    it("tabs, named styles, date, person, and rich link request variants", async () => {
      const doc = await createDocument("Tabs and Links");
      const result = await batch(doc.documentId, [
        { addDocumentTab: { tabProperties: { title: "Research" } } },
        { updateNamedStyle: { namedStyleType: "HEADING_2", textStyle: { bold: true }, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "*" } },
        { insertDate: { location: { index: 1 }, date: { year: 2026, month: 6, day: 11 } } },
        { insertPerson: { endOfSegmentLocation: {}, personProperties: { email: "agent@example.com", name: "Agent" } } },
        { insertRichLink: { endOfSegmentLocation: {}, uri: "https://example.test/resource" } },
      ]);

      const tabId = result.replies[0].addDocumentTab.tabProperties.tabId;
      expect(tabId).toMatch(/^tab_/);

      await batch(doc.documentId, [
        { updateDocumentTabProperties: { tabProperties: { tabId, title: "Renamed Research", iconEmoji: "R" }, fields: "title,iconEmoji" } },
        { deleteTab: { tabId } },
      ]);

      const got = await api("GET", `/v1/documents/${doc.documentId}?includeTabsContent=true`);
      const text = got.data.tabs[0].documentTab.body.content.map((item: Json) => item.paragraph?.elements?.[0]?.textRun?.content || "").join("");
      expect(text).toContain("2026-6-11");
      expect(text).toContain("agent@example.com");
      expect(text).toContain("https://example.test/resource");
      expect(got.data.tabs).toHaveLength(1);
      expect(got.data.tabs[0].documentTab.body.content.length).toBeGreaterThan(0);
      expect(got.data.tabs[0].documentTab.namedStyles.styles.find((style: Json) => style.namedStyleType === "HEADING_2").textStyle.bold).toBe(true);
    });

    it("deletePositionedObject removes existing positioned objects and errors for missing ones", async () => {
      const doc = await createDocument("Positioned");
      const stored = server.documents.get(doc.documentId) as any;
      stored.positionedObjects.positioned_1 = { objectId: "positioned_1", positionedObjectProperties: { embeddedObject: { title: "shape" } } };

      const deleted = await batch(doc.documentId, [{ deletePositionedObject: { objectId: "positioned_1" } }]);
      expect(deleted.replies).toEqual([{}]);
      expect(stored.positionedObjects.positioned_1).toBeUndefined();

      const missing = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, { requests: [{ deletePositionedObject: { objectId: "missing" } }] });
      expect(missing.status).toBe(404);
    });
  });

  describe("Tables", () => {
    it("insertTable and table row, column, merge, unmerge, style, header pinning, and delete operations", async () => {
      const doc = await createDocument("Tables");
      await batch(doc.documentId, [{ insertText: { location: { index: 1 }, text: "Before table\n" } }]);
      const stored = server.documents.get(doc.documentId) as any;
      const tableIndex = stored.text.length;

      await batch(doc.documentId, [{ insertTable: { rows: 2, columns: 2, endOfSegmentLocation: {} } }]);
      expect(stored.tables.get(tableIndex)).toMatchObject({ rows: 2, columns: 2 });

      const tableCellLocation = { tableStartLocation: { index: tableIndex }, rowIndex: 0, columnIndex: 0 };
      const tableRange = { tableCellLocation, rowSpan: 1, columnSpan: 1 };
      await batch(doc.documentId, [
        { insertTableRow: { tableCellLocation, insertBelow: true } },
        { insertTableColumn: { tableCellLocation, insertRight: true } },
        { mergeTableCells: { tableRange } },
        { unmergeTableCells: { tableRange } },
        { updateTableCellStyle: { tableRange, tableCellStyle: { backgroundColor: { color: { rgbColor: { red: 1 } } } }, fields: "backgroundColor" } },
        { updateTableColumnProperties: { tableStartLocation: { index: tableIndex }, columnIndices: [0], tableColumnProperties: { widthType: "FIXED_WIDTH" }, fields: "widthType" } },
        { updateTableRowStyle: { tableStartLocation: { index: tableIndex }, rowIndices: [0], tableRowStyle: { minRowHeight: { magnitude: 24, unit: "PT" } }, fields: "minRowHeight" } },
        { pinTableHeaderRows: { tableStartLocation: { index: tableIndex }, pinnedHeaderRowsCount: 1 } },
        { deleteTableRow: { tableCellLocation } },
        { deleteTableColumn: { tableCellLocation } },
      ]);

      expect(stored.tables.get(tableIndex)).toMatchObject({ rows: 2, columns: 2, headerRows: 1 });
      expect(stored.tables.get(tableIndex).cellStyleUpdates).toHaveLength(1);
      expect(stored.tables.get(tableIndex).columnPropertyUpdates).toHaveLength(1);
      expect(stored.tables.get(tableIndex).rowStyleUpdates).toHaveLength(1);

      const got = await api("GET", `/v1/documents/${doc.documentId}`);
      const table = got.data.body.content.find((item: Json) => item.table)?.table;
      expect(table.rows).toBe(2);
      expect(table.columns).toBe(2);

      await batch(doc.documentId, [{ deleteTable: { tableCellLocation } }]);
      expect(stored.tables.has(tableIndex)).toBe(false);
    });

    it("returns notFound for table operations against missing tables", async () => {
      const doc = await createDocument("No table");
      const missing = await api("POST", `/v1/documents/${doc.documentId}:batchUpdate`, {
        requests: [{ insertTableRow: { tableCellLocation: { tableStartLocation: { index: 5 }, rowIndex: 0, columnIndex: 0 } } }],
      });
      expect(missing.status).toBe(404);
      expect(missing.data.error.errors[0].reason).toBe("notFound");
    });
  });
});
