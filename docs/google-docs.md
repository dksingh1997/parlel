# google-docs

Dependency-free local emulator for Google Docs API v1 JSON REST calls. It is designed for `googleapis` Docs clients, raw `fetch`, MCP preview URLs, and AI-agent tests that need `documents.create`, `documents.get`, and `documents.batchUpdate` without calling `https://docs.googleapis.com/v1`.

Default port: `4616`

## Quick start

```js
import { google } from "googleapis";
import { GoogleDocsServer } from "./services/google-docs/src/server.js";

const server = new GoogleDocsServer(4616);
await server.start();

const docs = google.docs({ version: "v1", auth: "not-used-by-parlel" });
docs.context._options.rootUrl = "http://127.0.0.1:4616/";

const created = await docs.documents.create({
  requestBody: { title: "Parlel Notes" },
});

await docs.documents.batchUpdate({
  documentId: created.data.documentId,
  requestBody: {
    requests: [{ insertText: { location: { index: 1 }, text: "Hello from parlel\n" } }],
  },
});

const got = await docs.documents.get({ documentId: created.data.documentId });
console.log(got.data.body.content[0].paragraph.elements[0].textRun.content);

await server.stop();
```

Reset state with `server.reset()` or `POST /_parlel/reset`. Health is available at `GET /_parlel/health`.

## Implemented operations

| googleapis method | HTTP endpoint |
| --- | --- |
| `docs.documents.create` | `POST /v1/documents` |
| `docs.documents.get` | `GET /v1/documents/{documentId}` |
| `docs.documents.batchUpdate` | `POST /v1/documents/{documentId}:batchUpdate` |

The server also accepts `/docs/v1/...` as an alias for raw clients. A simple `googleapis` `rootUrl` override should use the real discovery paths under `/v1/...`.

Implemented `documents.batchUpdate` request variants include `insertText`, `deleteContentRange`, `replaceAllText`, `updateTextStyle`, `createParagraphBullets`, `deleteParagraphBullets`, `updateParagraphStyle`, `createNamedRange`, `deleteNamedRange`, `replaceNamedRangeContent`, `insertInlineImage`, `replaceImage`, `insertTable`, `insertTableRow`, `insertTableColumn`, `deleteTableRow`, `deleteTableColumn`, `deleteTable`, `mergeTableCells`, `unmergeTableCells`, `updateTableCellStyle`, `updateTableColumnProperties`, `updateTableRowStyle`, `insertPageBreak`, `insertSectionBreak`, `updateDocumentStyle`, `updateSectionStyle`, `createHeader`, `deleteHeader`, `createFooter`, `deleteFooter`, `createFootnote`, `deletePositionedObject`, `pinTableHeaderRows`, `addDocumentTab`, `deleteTab`, `updateDocumentTabProperties`, `updateNamedStyle`, `insertDate`, `insertPerson`, and `insertRichLink`.

## Access via MCP / preview URL

When run inside a parlel sandbox, point Google Docs API clients at the preview URL or local base URL, for example `http://127.0.0.1:4616/`. Node `googleapis` users can set `docs.context._options.rootUrl`; raw clients can call `/v1/documents`, `/v1/documents/{documentId}`, and `/v1/documents/{documentId}:batchUpdate` directly. MCP-driven agents can reset state between scenarios with `POST /_parlel/reset`.

## Surface coverage

Legend: ✅ supported · ◐ accepted-not-enforced · ✓ by design · ⟳ roadmap.

| Feature | Status | Notes |
| --- | --- | --- |
| Google Docs API v1 JSON REST paths for `documents.create`, `documents.get`, and `documents.batchUpdate` | ✅ supported | Tested over HTTP with `/v1/...`; `/docs/v1/...` alias is also covered. |
| In-memory documents and resettable state | ✅ supported | Ephemeral documents reset with `server.reset()` or `POST /_parlel/reset`. |
| `documents.create` title handling and output-only field behavior | ✅ supported | Creates a blank document, uses the requested `title`, and ignores caller-supplied `documentId` like the real API. |
| `documents.get` `suggestionsViewMode` and `includeTabsContent` response shape | ✅ supported | `includeTabsContent=true` populates `tabs[].documentTab` instead of legacy `body`/content fields; default responses return legacy fields and `tabs: []`. |
| `documents.batchUpdate` replies and `writeControl.requiredRevisionId` | ✅ supported | Replies map 1:1 to requests, successful writes return the updated revision ID, stale required revisions fail with `400`. |
| Atomic `documents.batchUpdate` validation | ✅ supported | If any request in a batch is invalid, prior mutations from that batch are rolled back. |
| Text, paragraphs, named ranges, images, tables, layout, headers, footers, footnotes, tabs, named styles, dates, people, and rich links | ✅ supported | Lightweight protocol/state model is exercised by the service tests. |
| OAuth bearer tokens, API keys, Google Drive permissions, IAM scopes, and per-user access checks | ◐ accepted-not-enforced | Real Google Docs requires OAuth scopes; the emulator accepts unauthenticated local requests and does not emit real `401 authError` responses. |
| Google Drive file metadata, folder moves, comments, suggestions, collaboration, revision history, and outbound notifications | ✓ by design | Docs API content calls are emulated locally; Drive side effects and collaborative systems are not faked. |
| Full visual document rendering fidelity | ✓ by design | The emulator returns protocol-shaped JSON and does not render Google Docs pages. |
| Rate limiting and quota errors | ✓ by design | The local emulator never throttles. |
| Persistence across process restarts | ✓ by design | State is intentionally in-memory only. |

## Error codes & shapes

Errors use Google JSON API-style envelopes with HTTP status, `error.code`, `error.message`, `error.status`, and a legacy `error.errors[]` reason array:

```json
{
  "error": {
    "code": 404,
    "message": "Requested entity was not found.",
    "status": "NOT_FOUND",
    "errors": [
      {
        "message": "Requested entity was not found.",
        "domain": "global",
        "reason": "notFound"
      }
    ]
  }
}
```

Common codes:

| Status | When |
| --- | --- |
| `400 INVALID_ARGUMENT` | invalid JSON, missing `requests[]`, invalid ranges, unsupported request union, stale `writeControl.requiredRevisionId` (`reason: failedPrecondition`) |
| `404 NOT_FOUND` | unknown document, named range, image, positioned object, table, header, footer, tab, or endpoint (`reason: notFound`) |
| `405 METHOD_NOT_ALLOWED` | known resource path with an unsupported HTTP method (`reason: methodNotAllowed`) |
| `409 ALREADY_EXISTS` | duplicate local tab identifiers (`reason: alreadyExists`) |
| `500 INTERNAL` | unexpected emulator failure (`reason: backendError`) |

Because auth is accepted-not-enforced, the emulator does not emit real Google `401 UNAUTHENTICATED` responses for missing or invalid OAuth credentials.

## Manifest

See `services/google-docs/manifest.json`:

- name: `google-docs`, image: `parlel/google-docs:0.1`
- port: `4616`, protocol: `http`, healthcheck: `/_parlel/health`, startup approximately `100ms`
- env: `GOOGLE_DOCS_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
GOOGLE_DOCS_EMULATOR_HOST=http://localhost:4616
GOOGLE_CLOUD_PROJECT=parlel
GCLOUD_PROJECT=parlel
```

<!-- parlel:testenv:end -->
