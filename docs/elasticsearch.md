# Elasticsearch

Lightweight, dependency-free Elasticsearch emulator speaking the REST API over
HTTP/JSON.

| Key | Value |
|-----|-------|
| Port | 9200 |
| Protocol | REST API (HTTP + JSON) |
| Size | ~90 KB |
| Startup | fast |

## Default Connection

```
http://localhost:9200
```

## Supported Operations

| Operation | Request |
|-----------|---------|
| Cluster health | `GET /_cluster/health` |
| Create index | `PUT /{index}` |
| Delete index | `DELETE /{index}` |
| Index a document | `PUT/POST /{index}/_doc/{id}` |
| Get a document | `GET /{index}/_doc/{id}` |
| Delete a document | `DELETE /{index}/_doc/{id}` |
| Search | `GET/POST /{index}/_search` |

## Usage

app connects with an **unmodified** HTTP / `@elastic/elasticsearch` client — no
Parlel code in the app.

```bash

```

```typescript
// Unmodified real client, pointed at the bridge hostname
// (or `localhost` if you run the bridge outside Docker and publish ports)
const base = "http://localhost:9200";

await fetch(`${base}/products`, { method: "PUT" });
await fetch(`${base}/products/_doc/1`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Widget", price: 9.99 }),
});
const res = await fetch(`${base}/products/_search`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: { match_all: {} } }),
});
```

Or with the official client:

```typescript
import { Client } from "@elastic/elasticsearch";
const es = new Client({ node: "http://localhost:9200" });
await es.search({ index: "products", query: { match_all: {} } });
```

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Index + document CRUD | Supported |
| `match_all` / basic search | Supported |
| Complex query DSL / aggregations | Not evaluated |
| Mappings / analyzers | Accepted, not enforced |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
ELASTIC_PASSWORD=parlel
xpack.security.enabled=false
```

<!-- parlel:testenv:end -->
