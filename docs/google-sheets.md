# Google Sheets

Lightweight, dependency-free in-memory fake of the Google Sheets API v4 for testing `googleapis` client code with zero cost and zero side effects.

Default port: `4613`

## Implemented Operations

### Internal parlel Endpoints

| Operation | Endpoint |
| --- | --- |
| Health check | `GET /_parlel/health` |
| Reset state | `POST /_parlel/reset` |
| Discovery ping | `GET /`, `GET /v4`, `GET /sheets/v4` |

### Spreadsheets

| googleapis method | Endpoint |
| --- | --- |
| `sheets.spreadsheets.create` | `POST /v4/spreadsheets` |
| `sheets.spreadsheets.get` | `GET /v4/spreadsheets/{spreadsheetId}` |
| `sheets.spreadsheets.getByDataFilter` | `POST /v4/spreadsheets/{spreadsheetId}:getByDataFilter` |
| `sheets.spreadsheets.batchUpdate` | `POST /v4/spreadsheets/{spreadsheetId}:batchUpdate` |

### Sheets

| googleapis method | Endpoint |
| --- | --- |
| `sheets.spreadsheets.sheets.copyTo` | `POST /v4/spreadsheets/{spreadsheetId}/sheets/{sheetId}:copyTo` |

### Values

| googleapis method | Endpoint |
| --- | --- |
| `sheets.spreadsheets.values.get` | `GET /v4/spreadsheets/{spreadsheetId}/values/{range}` |
| `sheets.spreadsheets.values.update` | `PUT /v4/spreadsheets/{spreadsheetId}/values/{range}` |
| `sheets.spreadsheets.values.append` | `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append` |

> `values.update`, `values.append`, `values.batchUpdate`, and
> `values.batchUpdateByDataFilter` require a `valueInputOption` (`RAW` or
> `USER_ENTERED`), exactly like the real API. A missing or unsupported value
> returns `400 INVALID_ARGUMENT`. `values.append` returns `tableRange` as the
> detected table range *before* the append (an empty string when no table is
> found at the search range), matching `spreadsheets.values.append`.
| `sheets.spreadsheets.values.clear` | `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:clear` |
| `sheets.spreadsheets.values.batchGet` | `GET /v4/spreadsheets/{spreadsheetId}/values:batchGet` |
| `sheets.spreadsheets.values.batchUpdate` | `POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdate` |
| `sheets.spreadsheets.values.batchClear` | `POST /v4/spreadsheets/{spreadsheetId}/values:batchClear` |
| `sheets.spreadsheets.values.batchGetByDataFilter` | `POST /v4/spreadsheets/{spreadsheetId}/values:batchGetByDataFilter` |
| `sheets.spreadsheets.values.batchUpdateByDataFilter` | `POST /v4/spreadsheets/{spreadsheetId}/values:batchUpdateByDataFilter` |
| `sheets.spreadsheets.values.batchClearByDataFilter` | `POST /v4/spreadsheets/{spreadsheetId}/values:batchClearByDataFilter` |

### Developer Metadata

| googleapis method | Endpoint |
| --- | --- |
| `sheets.spreadsheets.developerMetadata.get` | `GET /v4/spreadsheets/{spreadsheetId}/developerMetadata/{metadataId}` |
| `sheets.spreadsheets.developerMetadata.search` | `POST /v4/spreadsheets/{spreadsheetId}/developerMetadata:search` |

### Supported `spreadsheets.batchUpdate` Request Types

`addSheet`, `duplicateSheet`, `deleteSheet`, `updateSheetProperties`, `updateSpreadsheetProperties`, `updateCells`, `appendCells`, `repeatCell`, `copyPaste`, `setBasicFilter`, `clearBasicFilter`, `appendDimension`, `createDeveloperMetadata`, `updateDeveloperMetadata`, and `deleteDeveloperMetadata` mutate in-memory state.

Formatting and UI-oriented request types such as `autoResizeDimensions`, `mergeCells`, `unmergeCells`, `updateBorders`, filter view requests, chart requests, protected range requests, slicer requests, and similar batch requests are accepted as no-ops and return an empty reply object. This keeps common application code compatible without modeling visual-only Sheets behavior.

## Quick Start

Start the server from the repo:

```js
import { GoogleSheetsServer } from "./apps/parlel-pool/services/google-sheets/src/server.js";

const server = new GoogleSheetsServer(4613);
await server.start();
```

Connect with the real `googleapis` client:

```js
import { google } from "googleapis";

const sheets = google.sheets({
  version: "v4",
  auth: "test-token",
});

sheets.context._options.rootUrl = "http://127.0.0.1:4613/";

const created = await sheets.spreadsheets.create({
  requestBody: { properties: { title: "Local test" } },
});

await sheets.spreadsheets.values.update({
  spreadsheetId: created.data.spreadsheetId,
  range: "Sheet1!A1:B1",
  valueInputOption: "RAW",
  requestBody: { values: [["hello", "parlel"]] },
});
```

Reset state between tests:

```sh
curl -X POST http://127.0.0.1:4613/_parlel/reset
```

## Surface Coverage

Legend: ✅ supported · ◐ accepted-not-enforced · ✓ by design · ⟳ roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| Google Sheets API v4 REST paths used by `googleapis` | ✅ supported | Implemented under `/v4`; `/sheets/v4` is also accepted. |
| In-memory spreadsheet, sheet, values, and developer metadata state | ✅ supported | State is ephemeral and resettable. |
| A1 ranges | ✅ supported | Handles common ranges like `Sheet1!A1:B2`, quoted sheet names, whole-row/column-style bounds, and default first-sheet ranges. |
| Grid ranges in data filters | ✅ supported | Used by data-filter value operations and batch requests. |
| `ROWS` and `COLUMNS` major dimensions | ✅ supported | Values are transposed for `COLUMNS`. |
| Grid data in spreadsheet responses | ✅ supported | Returned when `includeGridData=true` or requested by data-filter get. |
| `valueInputOption` required + validated | ✅ supported | `RAW`/`USER_ENTERED` enforced on `values.update`, `values.append`, `values.batchUpdate`, `values.batchUpdateByDataFilter`; missing/unsupported → `400 INVALID_ARGUMENT`. |
| `values.append` `tableRange` semantics | ✅ supported | Returns the detected table range before append; empty string when no table is found. |
| Google v4 error envelope (`error.details[]`) | ✅ supported | Matches the real `google.rpc.Status` shape (see below). |
| `valueRenderOption` / `dateTimeRenderOption` | ◐ accepted-not-enforced | Accepted; values are returned `FORMATTED_VALUE`-style without per-option rendering. |
| Formatting-only batch requests | ✓ by design | Accepted for compatibility; visual formatting is not modeled (returns an empty reply). |
| Auth and IAM (OAuth2 bearer) | ✓ by design | Tokens are ignored. This fake is local-only. |
| Persistence | ✓ by design | State disappears on reset or process exit. |
| Formula evaluation | ✓ by design | Formula strings are stored; they are not calculated. |
| Real Google revision history, sharing, Drive integration | ✓ by design | Outside the Sheets API surface needed for local tests. |

## Error Codes & Shapes

Errors use the Google Sheets API v4 envelope — the shared `google.rpc.Status`
shape with a `details` array, exactly like `sheets.googleapis.com` returns. The
emulator does **not** emit the legacy JSON-API `error.errors[]` array (the real v4
API does not return it either):

```json
{
  "error": {
    "code": 404,
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "notFound",
        "domain": "googleapis.com",
        "metadata": { "service": "sheets.googleapis.com" }
      }
    ]
  }
}
```

The `googleapis` Node client surfaces `error.code`, `error.message`, and
`error.status`, all of which match the real API.

Common returned codes:

| HTTP status | Status | Reason examples |
| --- | --- | --- |
| `400` | `INVALID_ARGUMENT` | `badRequest`, `parseError` (bad JSON, unparseable range, missing/invalid `valueInputOption`) |
| `404` | `NOT_FOUND` | `notFound` (unknown spreadsheet, sheet, or developer metadata) |
| `405` | `METHOD_NOT_ALLOWED` | `methodNotAllowed` |
| `409` | `ALREADY_EXISTS` | `alreadyExists` |
| `500` | `INTERNAL` | `internalError` |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_SHEETS_EMULATOR_HOST=http://localhost:4613
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
