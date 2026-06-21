import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { GoogleSheetsServer } from "../services/google-sheets/src/server.js";

const PORT = 24613;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  return { res, body };
}

async function createSpreadsheet(title = "Test Sheet") {
  const { body } = await api("/v4/spreadsheets", {
    method: "POST",
    body: JSON.stringify({ properties: { title } }),
  });
  return body;
}

describe("Google Sheets Service", () => {
  let server: GoogleSheetsServer;

  beforeAll(async () => {
    server = new GoogleSheetsServer(PORT);
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
    it("starts on the configured port", () => {
      expect(server.port).toBe(PORT);
      expect(server.spreadsheets.size).toBe(0);
    });

    it("serves root discovery and health endpoints", async () => {
      const root = await api("/v4");
      expect(root.res.status).toBe(200);
      expect(root.body.kind).toBe("sheets#parlel");

      const health = await api("/_parlel/health");
      expect(health.body).toEqual({ status: "ok", service: "google-sheets", spreadsheets: 0 });
    });

    it("resets ephemeral state", async () => {
      await createSpreadsheet();
      expect(server.spreadsheets.size).toBe(1);

      const reset = await api("/_parlel/reset", { method: "POST", body: "{}" });
      expect(reset.body).toEqual({ ok: true });
      expect(server.spreadsheets.size).toBe(0);
    });
  });

  describe("Spreadsheets", () => {
    it("create and get", async () => {
      const created = await createSpreadsheet("Budget");
      expect(created.spreadsheetId).toMatch(/^spreadsheet_/);
      expect(created.properties.title).toBe("Budget");
      expect(created.sheets[0].properties.title).toBe("Sheet1");
      expect(created.spreadsheetUrl).toContain(created.spreadsheetId);

      const got = await api(`/v4/spreadsheets/${created.spreadsheetId}`);
      expect(got.res.status).toBe(200);
      expect(got.body.properties.title).toBe("Budget");
    });

    it("get includeGridData and getByDataFilter", async () => {
      const ss = await createSpreadsheet();
      await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B2?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: [["name", "score"], ["Ada", 10]] }),
      });

      const withGrid = await api(`/v4/spreadsheets/${ss.spreadsheetId}?includeGridData=true&ranges=Sheet1!A1:B2`);
      expect(withGrid.body.sheets[0].data[0].rowData[1].values[0].formattedValue).toBe("Ada");

      const filtered = await api(`/v4/spreadsheets/${ss.spreadsheetId}:getByDataFilter`, {
        method: "POST",
        body: JSON.stringify({ includeGridData: true, dataFilters: [{ a1Range: "Sheet1!A1:B2" }] }),
      });
      expect(filtered.res.status).toBe(200);
      expect(filtered.body.sheets[0].data[0].rowData[0].values[1].formattedValue).toBe("score");
    });
  });

  describe("Values", () => {
    it("update, get, append, and clear", async () => {
      const ss = await createSpreadsheet();

      const update = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B2?valueInputOption=RAW&includeValuesInResponse=true`, {
        method: "PUT",
        body: JSON.stringify({ values: [["A", "B"], [1, 2]] }),
      });
      expect(update.body.updatedCells).toBe(4);
      expect(update.body.updatedData.values).toEqual([["A", "B"], [1, 2]]);

      const get = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B3`);
      expect(get.body.values).toEqual([["A", "B"], [1, 2]]);

      const append = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B10:append?valueInputOption=RAW`, {
        method: "POST",
        body: JSON.stringify({ values: [["C", "D"]] }),
      });
      expect(append.body.updates.updatedRange).toBe("Sheet1!A3:B3");

      const cleared = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A2:B2:clear`, { method: "POST", body: "{}" });
      expect(cleared.body.clearedRange).toBe("Sheet1!A2:B2");
      const afterClear = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B3`);
      expect(afterClear.body.values).toEqual([["A", "B"], [], ["C", "D"]]);
    });

    it("supports COLUMNS majorDimension", async () => {
      const ss = await createSpreadsheet();
      await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B2?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ majorDimension: "COLUMNS", values: [["A1", "A2"], ["B1", "B2"]] }),
      });

      const get = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B2?majorDimension=COLUMNS`);
      expect(get.body.values).toEqual([["A1", "A2"], ["B1", "B2"]]);
    });

    it("batchGet, batchUpdate, and batchClear", async () => {
      const ss = await createSpreadsheet();

      const batchUpdate = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: "Sheet1!A1:A2", values: [["x"], ["y"]] }, { range: "Sheet1!C1", values: [["z"]] }] }),
      });
      expect(batchUpdate.body.totalUpdatedCells).toBe(3);
      expect(batchUpdate.body.responses).toHaveLength(2);

      const batchGet = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchGet?ranges=Sheet1!A1:A2&ranges=Sheet1!C1:C1`);
      expect(batchGet.body.valueRanges.map((r: any) => r.values)).toEqual([[["x"], ["y"]], [["z"]]]);

      const batchClear = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchClear`, {
        method: "POST",
        body: JSON.stringify({ ranges: ["Sheet1!A1:A1", "Sheet1!C1:C1"] }),
      });
      expect(batchClear.body.clearedRanges).toEqual(["Sheet1!A1:A1", "Sheet1!C1:C1"]);
    });

    it("batchGetByDataFilter, batchUpdateByDataFilter, and batchClearByDataFilter", async () => {
      const ss = await createSpreadsheet();

      const update = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchUpdateByDataFilter`, {
        method: "POST",
        body: JSON.stringify({ valueInputOption: "RAW", data: [{ dataFilter: { a1Range: "Sheet1!B2:C2" }, values: [["left", "right"]] }] }),
      });
      expect(update.body.totalUpdatedCells).toBe(2);

      const get = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchGetByDataFilter`, {
        method: "POST",
        body: JSON.stringify({ dataFilters: [{ gridRange: { sheetId: ss.sheets[0].properties.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 3 } }] }),
      });
      expect(get.body.valueRanges[0].valueRange.values).toEqual([["left", "right"]]);

      const clear = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchClearByDataFilter`, {
        method: "POST",
        body: JSON.stringify({ dataFilters: [{ a1Range: "Sheet1!B2:C2" }] }),
      });
      expect(clear.body.clearedRanges).toEqual(["Sheet1!B2:C2"]);
    });
  });

  describe("Batch Update", () => {
    it("manages sheets and spreadsheet properties", async () => {
      const ss = await createSpreadsheet("Original");
      const batch = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          includeSpreadsheetInResponse: true,
          requests: [
            { updateSpreadsheetProperties: { properties: { title: "Renamed" }, fields: "title" } },
            { addSheet: { properties: { title: "Data", gridProperties: { rowCount: 20, columnCount: 5 } } } },
            { updateSheetProperties: { properties: { sheetId: ss.sheets[0].properties.sheetId, title: "Raw" }, fields: "title" } },
            { duplicateSheet: { sourceSheetId: ss.sheets[0].properties.sheetId, newSheetName: "Raw Copy" } },
          ],
        }),
      });

      expect(batch.body.replies[0].updateSpreadsheetProperties.properties.title).toBe("Renamed");
      expect(batch.body.replies[1].addSheet.properties.title).toBe("Data");
      expect(batch.body.replies[2].updateSheetProperties.properties.title).toBe("Raw");
      expect(batch.body.replies[3].duplicateSheet.properties.title).toBe("Raw Copy");
      expect(batch.body.updatedSpreadsheet.sheets.map((s: any) => s.properties.title)).toEqual(["Raw", "Data", "Raw Copy"]);
    });

    it("supports cell writes, appendCells, repeatCell, copyPaste, filters, dimensions, and deleteSheet", async () => {
      const ss = await createSpreadsheet();
      const add = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "Scratch" } } }] }),
      });
      const scratchId = add.body.replies[0].addSheet.properties.sheetId;

      const batch = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: [
            { updateCells: { start: { sheetId: ss.sheets[0].properties.sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: "first" } }] }], fields: "userEnteredValue" } },
            { appendCells: { sheetId: ss.sheets[0].properties.sheetId, rows: [{ values: [{ userEnteredValue: { stringValue: "second" } }] }], fields: "userEnteredValue" } },
            { repeatCell: { range: { sheetId: ss.sheets[0].properties.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 3 }, cell: { userEnteredValue: { stringValue: "fill" } }, fields: "userEnteredValue" } },
            { copyPaste: { source: { sheetId: ss.sheets[0].properties.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, destination: { sheetId: ss.sheets[0].properties.sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 } } },
            { setBasicFilter: { filter: { range: { sheetId: ss.sheets[0].properties.sheetId, startRowIndex: 0, endRowIndex: 4 } } } },
            { clearBasicFilter: { sheetId: ss.sheets[0].properties.sheetId } },
            { appendDimension: { sheetId: ss.sheets[0].properties.sheetId, dimension: "ROWS", length: 5 } },
            { autoResizeDimensions: { dimensions: { sheetId: ss.sheets[0].properties.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 2 } } },
            { deleteSheet: { sheetId: scratchId } },
          ],
        }),
      });

      expect(batch.body.replies).toHaveLength(9);
      const values = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:C4`);
      expect(values.body.values).toEqual([["first"], ["second", "fill", "fill"], [], ["first"]]);
      const got = await api(`/v4/spreadsheets/${ss.spreadsheetId}`);
      expect(got.body.sheets).toHaveLength(1);
      expect(got.body.sheets[0].properties.gridProperties.rowCount).toBe(1005);
    });
  });

  describe("Developer Metadata", () => {
    it("adds, gets, searches, updates, and deletes developer metadata", async () => {
      const ss = await createSpreadsheet();
      const add = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ createDeveloperMetadata: { developerMetadata: { metadataKey: "env", metadataValue: "test", visibility: "DOCUMENT" } } }] }),
      });
      const metadataId = add.body.replies[0].createDeveloperMetadata.developerMetadata.metadataId;

      const got = await api(`/v4/spreadsheets/${ss.spreadsheetId}/developerMetadata/${metadataId}`);
      expect(got.body.metadataKey).toBe("env");

      const search = await api(`/v4/spreadsheets/${ss.spreadsheetId}/developerMetadata:search`, {
        method: "POST",
        body: JSON.stringify({ dataFilters: [{ developerMetadataLookup: { metadataKey: "env", metadataValue: "test" } }] }),
      });
      expect(search.body.matchedDeveloperMetadata).toHaveLength(1);

      const update = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ updateDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataId } }], developerMetadata: { metadataValue: "updated" }, fields: "metadataValue" } }] }),
      });
      expect(update.body.replies[0].updateDeveloperMetadata.developerMetadata[0].metadataValue).toBe("updated");

      const del = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ deleteDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataId } }] } }] }),
      });
      expect(del.body.replies[0].deleteDeveloperMetadata.deletedDeveloperMetadata[0].metadataId).toBe(metadataId);
    });
  });

  describe("Sheets.copyTo", () => {
    it("copies a sheet to another spreadsheet", async () => {
      const source = await createSpreadsheet("Source");
      const dest = await createSpreadsheet("Dest");
      await api(`/v4/spreadsheets/${source.spreadsheetId}/values/Sheet1!A1?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: [["copied"]] }) });

      const copy = await api(`/v4/spreadsheets/${source.spreadsheetId}/sheets/${source.sheets[0].properties.sheetId}:copyTo`, {
        method: "POST",
        body: JSON.stringify({ destinationSpreadsheetId: dest.spreadsheetId }),
      });
      expect(copy.body.title).toBe("Sheet1 Copy");

      const got = await api(`/v4/spreadsheets/${dest.spreadsheetId}/values/'Sheet1 Copy'!A1`);
      expect(got.body.values).toEqual([["copied"]]);
    });
  });

  describe("Errors", () => {
    it("returns Google v4 rpc.Status error envelope for missing spreadsheets", async () => {
      const missing = await api("/v4/spreadsheets/missing");
      expect(missing.res.status).toBe(404);
      // Real Sheets v4 uses { error: { code, message, status, details: [...] } }
      // and does NOT emit the legacy { errors: [{ message, domain, reason }] } array.
      expect(missing.body.error).toMatchObject({
        code: 404,
        status: "NOT_FOUND",
        message: "Requested entity was not found.",
      });
      expect(missing.body.error.errors).toBeUndefined();
      expect(missing.body.error.details[0]).toMatchObject({
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "notFound",
        domain: "googleapis.com",
      });
      expect(missing.body.error.details[0].metadata.service).toBe("sheets.googleapis.com");
    });

    it("returns invalid JSON and invalid range errors", async () => {
      const badJson = await api("/v4/spreadsheets", { method: "POST", body: "{" });
      expect(badJson.res.status).toBe(400);
      expect(badJson.body.error.status).toBe("INVALID_ARGUMENT");
      expect(badJson.body.error.details[0].reason).toBe("parseError");

      const ss = await createSpreadsheet();
      const badRange = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Nope!A1`);
      expect(badRange.res.status).toBe(400);
      expect(badRange.body.error.message).toContain("Unable to parse range");
    });

    it("requires valueInputOption on update, append, and values:batchUpdate", async () => {
      const ss = await createSpreadsheet();

      const noOption = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B1`, {
        method: "PUT",
        body: JSON.stringify({ values: [["a", "b"]] }),
      });
      expect(noOption.res.status).toBe(400);
      expect(noOption.body.error.status).toBe("INVALID_ARGUMENT");

      const badOption = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B1?valueInputOption=BOGUS`, {
        method: "PUT",
        body: JSON.stringify({ values: [["a", "b"]] }),
      });
      expect(badOption.res.status).toBe(400);
      expect(badOption.body.error.message).toContain("ValueInputOption");

      const appendNoOption = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:append`, {
        method: "POST",
        body: JSON.stringify({ values: [["x"]] }),
      });
      expect(appendNoOption.res.status).toBe(400);

      const batchNoOption = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ data: [{ range: "Sheet1!A1", values: [["z"]] }] }),
      });
      expect(batchNoOption.res.status).toBe(400);
      expect(batchNoOption.body.error.status).toBe("INVALID_ARGUMENT");
    });

    it("append returns empty tableRange when no table exists and the detected range when it does", async () => {
      const ss = await createSpreadsheet();

      const first = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B10:append?valueInputOption=RAW`, {
        method: "POST",
        body: JSON.stringify({ values: [["h1", "h2"]] }),
      });
      // No prior data => no table found => empty tableRange (matches real API).
      expect(first.body.tableRange).toBe("");
      expect(first.body.updates.updatedRange).toBe("Sheet1!A1:B1");

      const second = await api(`/v4/spreadsheets/${ss.spreadsheetId}/values/Sheet1!A1:B10:append?valueInputOption=RAW`, {
        method: "POST",
        body: JSON.stringify({ values: [["v1", "v2"]] }),
      });
      // Now a one-row table exists at A1:B1 (before this append).
      expect(second.body.tableRange).toBe("Sheet1!A1:B1");
      expect(second.body.updates.updatedRange).toBe("Sheet1!A2:B2");
    });

    it("prevents deleting the last sheet", async () => {
      const ss = await createSpreadsheet();
      const del = await api(`/v4/spreadsheets/${ss.spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: ss.sheets[0].properties.sheetId } }] }),
      });
      expect(del.res.status).toBe(400);
      expect(del.body.error.message).toContain("can't remove all the sheets");
    });
  });
});
