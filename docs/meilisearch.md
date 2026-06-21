# Meilisearch

Lightweight, dependency-free, in-memory Meilisearch-compatible HTTP service for parlel-pool tests.

Default port: `7700`

## Quick Start

```js
import { MeiliSearch } from "meilisearch";
import { MeilisearchServer } from "../services/meilisearch/src/server.js";

const server = new MeilisearchServer(7700);
await server.start();

const client = new MeiliSearch({ host: "http://127.0.0.1:7700", apiKey: "masterKey" });
await client.createIndex("movies", { primaryKey: "id" });
await client.index("movies").addDocuments([{ id: 1, title: "Interstellar" }]);
const results = await client.index("movies").search("interstellar");

await server.stop();
```

All state is in-memory and ephemeral. Call `server.reset()` to clear indexes, tasks, dumps, snapshots, and keys back to the default admin key.

## Implemented Operations

### Discovery

| Operation | Endpoint |
| --- | --- |
| Root metadata | `GET /` |
| Health | `GET /health` |
| Version | `GET /version` |
| Global stats | `GET /stats` |

### Indexes

| Operation | Endpoint |
| --- | --- |
| List indexes | `GET /indexes` |
| Create index | `POST /indexes` |
| Get index | `GET /indexes/:uid` |
| Update index primary key | `PATCH /indexes/:uid` |
| Delete index | `DELETE /indexes/:uid` |
| Swap indexes | `POST /swap-indexes` |
| Index stats | `GET /indexes/:uid/stats` |

### Documents

| Operation | Endpoint |
| --- | --- |
| Add or replace documents | `POST /indexes/:uid/documents` |
| Add or partially update documents | `PUT /indexes/:uid/documents` |
| List documents | `GET /indexes/:uid/documents` |
| Fetch documents | `POST /indexes/:uid/documents/fetch` |
| Get document | `GET /indexes/:uid/documents/:id` |
| Delete document | `DELETE /indexes/:uid/documents/:id` |
| Delete documents by ids | `POST /indexes/:uid/documents/delete-batch` |
| Delete documents by filter | `POST /indexes/:uid/documents/delete` |
| Edit documents by function | `POST /indexes/:uid/documents/edit` |
| Delete all documents | `DELETE /indexes/:uid/documents` |
| JSON payloads | `application/json` |
| NDJSON payloads | `application/x-ndjson` |
| CSV payloads | `text/csv` |

### Search

| Operation | Endpoint |
| --- | --- |
| Search by POST | `POST /indexes/:uid/search` |
| Search by GET | `GET /indexes/:uid/search` |
| Multi-search | `POST /multi-search` |
| Facet search | `POST /indexes/:uid/facet-search` |
| Similar documents | `POST /indexes/:uid/similar` |

Search supports `q`, `offset`, `limit`, `filter`, `sort`, `attributesToRetrieve`, `facets`, and simple facet distributions. Filters support simple `=`, `!=`, `>`, `>=`, `<`, `<=` clauses joined with `AND`.

### Settings

| Operation | Endpoint |
| --- | --- |
| Get all settings | `GET /indexes/:uid/settings` |
| Update all settings | `PATCH /indexes/:uid/settings` or `PUT /indexes/:uid/settings` |
| Reset all settings | `DELETE /indexes/:uid/settings` |
| Displayed attributes | `/indexes/:uid/settings/displayed-attributes` |
| Searchable attributes | `/indexes/:uid/settings/searchable-attributes` |
| Filterable attributes | `/indexes/:uid/settings/filterable-attributes` |
| Sortable attributes | `/indexes/:uid/settings/sortable-attributes` |
| Ranking rules | `/indexes/:uid/settings/ranking-rules` |
| Stop words | `/indexes/:uid/settings/stop-words` |
| Synonyms | `/indexes/:uid/settings/synonyms` |
| Distinct attribute | `/indexes/:uid/settings/distinct-attribute` |
| Typo tolerance | `/indexes/:uid/settings/typo-tolerance` |
| Faceting | `/indexes/:uid/settings/faceting` |
| Pagination | `/indexes/:uid/settings/pagination` |
| Proximity precision | `/indexes/:uid/settings/proximity-precision` |
| Separator tokens | `/indexes/:uid/settings/separator-tokens` |
| Non-separator tokens | `/indexes/:uid/settings/non-separator-tokens` |
| Dictionary | `/indexes/:uid/settings/dictionary` |
| Embedders | `/indexes/:uid/settings/embedders` |
| Search cutoff | `/indexes/:uid/settings/search-cutoff-ms` |
| Localized attributes | `/indexes/:uid/settings/localized-attributes` |
| Facet search | `/indexes/:uid/settings/facet-search` |
| Prefix search | `/indexes/:uid/settings/prefix-search` |
| Chat | `/indexes/:uid/settings/chat` |

Each individual setting supports `GET`, `PATCH` or `PUT`, and `DELETE` reset.

### Tasks And Batches

| Operation | Endpoint |
| --- | --- |
| List tasks | `GET /tasks` |
| Get task | `GET /tasks/:uid` |
| Cancel tasks | `POST /tasks/cancel` |
| Delete tasks | `DELETE /tasks` |
| List batches | `GET /batches` |
| Get batch | `GET /batches/:uid` |

Mutating operations complete immediately and return succeeded task summaries. `POST /dumps` also includes `dumpUid`; `POST /snapshots` also includes `snapshotUid`.

### Keys

| Operation | Endpoint |
| --- | --- |
| List API keys | `GET /keys` |

The reset state includes a default admin key with `key: "masterKey"`.

### Maintenance

| Operation | Endpoint |
| --- | --- |
| Create dump | `POST /dumps` |
| Get dump status | `GET /dumps/:uid/status` |
| Create snapshot | `POST /snapshots` |
| Get experimental features | `GET /experimental-features` |
| Update experimental features | `PATCH /experimental-features` |

### Newer Client Surfaces

| Operation | Endpoint |
| --- | --- |
| List dynamic search rules | `POST /dynamic-search-rules` |
| Get dynamic search rule | `GET /dynamic-search-rules/:uid` |
| Update dynamic search rule | `PATCH /dynamic-search-rules/:uid` |
| Delete dynamic search rule | `DELETE /dynamic-search-rules/:uid` |
| List webhooks | `GET /webhooks` |
| Create webhook | `POST /webhooks` |
| Get webhook | `GET /webhooks/:uuid` |
| Update webhook | `PATCH /webhooks/:uuid` |
| Delete webhook | `DELETE /webhooks/:uuid` |
| Get network | `GET /network` |
| Update network | `PATCH /network` |
| List chat workspaces | `GET /chats` |
| Get chat workspace settings | `GET /chats/:workspace/settings` |
| Update chat workspace settings | `PATCH /chats/:workspace/settings` |
| Reset chat workspace settings | `DELETE /chats/:workspace/settings` |
| Stream chat completion | `POST /chats/:workspace/chat/completions` |
| List index fields | `POST /indexes/:uid/fields` |

## Supported Features

| Feature | Status | Notes |
| --- | --- | --- |
| Real Meilisearch HTTP paths used by the `meilisearch` client | Supported | Covers discovery, indexes, documents, search, settings, tasks, batches, keys, dumps, snapshots, and experimental features. |
| In-memory indexes and documents | Supported | Ephemeral state, reset with `server.reset()`. |
| Immediate async task responses | Supported | Mutations return `202` task summaries and completed task records. |
| JSON, NDJSON, and CSV document ingestion | Supported | CSV parser is intentionally minimal and handles comma-separated headers and values. |
| Simple search, filtering, sorting, projection, and facets | Supported | Designed for deterministic app tests, not relevance parity. |
| Dynamic search rules, webhooks, network, chats | Supported | Stored in memory with no external side effects. |
| Authentication and permissions | Intentionally unsupported | API keys are stored and returned, but requests are not authorized. |
| Persistent storage, LMDB, snapshots on disk, dumps on disk | Intentionally unsupported | This fake is side-effect free. |
| Typo ranking, semantic/vector search, hybrid search, real tokenizer behavior | Intentionally unsupported | Settings are accepted and returned, but advanced relevance behavior is not simulated. |
| Network/webhook/task queue timing | Intentionally unsupported | All tasks complete synchronously. |

## Error Shapes

Errors use Meilisearch-style JSON:

```json
{
  "message": "Index movies not found.",
  "code": "index_not_found",
  "type": "invalid_request",
  "link": "https://docs.meilisearch.com/errors#index_not_found"
}
```

Common codes returned by this fake:

| Status | Code |
| --- | --- |
| `400` | `missing_index_uid` |
| `400` | `index_already_exists` |
| `400` | `index_primary_key_no_candidate_found` |
| `400` | `missing_document_id` |
| `400` | `invalid_document` |
| `400` | `missing_facet_name` |
| `400` | `invalid_swap_indexes` |
| `400` | `missing_api_key_name` |
| `404` | `not_found` |
| `404` | `index_not_found` |
| `404` | `document_not_found` |
| `404` | `task_not_found` |
| `404` | `batch_not_found` |
| `404` | `api_key_not_found` |
| `404` | `dump_not_found` |
| `500` | `internal` |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
MEILI_MASTER_KEY=parlel
MEILI_ENV=development
MEILI_NO_ANALYTICS=true
```

<!-- parlel:testenv:end -->
