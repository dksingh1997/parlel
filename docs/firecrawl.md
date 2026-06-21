# Firecrawl

Lightweight, dependency-free, in-memory fake of the **Firecrawl API v1** for testing scraping/crawling integrations. Scrape output is **deterministically derived from the requested URL** — the same URL always yields the same markdown/html/metadata. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4885`

## Quick start

```js
import { FirecrawlServer } from "./services/firecrawl/src/server.js";

const server = new FirecrawlServer(4885);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with `Authorization: Bearer fc-<key>` (any non-empty bearer accepted):

```bash
curl -H "Authorization: Bearer fc-parlel" -H "Content-Type: application/json" \
     -d '{"url":"https://parlel.dev"}' \
     http://127.0.0.1:4885/v1/scrape
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `FIRECRAWL_API_KEY=fc-parlel` and `FIRECRAWL_BASE_URL=http://127.0.0.1:4885`, then call scrape/crawl/map. The MCP server proxies the endpoints below so an agent can exercise scraping flows without hitting the network or a real Firecrawl account.

## Implemented operations

All `/v1/*` routes require `Authorization: Bearer <key>` (any non-empty bearer accepted).

- `POST /v1/scrape` — scrape a URL → `{ success: true, data: { markdown, html, metadata: { title, description, sourceURL, statusCode, ... } } }`. Output is deterministic per URL; title is derived from the URL path.
- `POST /v1/crawl` — start a crawl → `{ success: true, id, url }`. A deterministic set of pages (capped by `limit`) is generated synchronously.
- `GET /v1/crawl/:id` — crawl status → `{ success: true, status: "completed", total, completed, data: [...] }`.
- `POST /v1/map` — map a site's links → `{ success: true, links: [...] }`.

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check (`{ status: "ok" }`).
- `POST /__parlel/reset` — reset all in-memory state.
- `OPTIONS *` — CORS preflight (`204`).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| Scrape (deterministic markdown/html/metadata) | ✅ Supported |
| Crawl start + status (synchronous completion) | ✅ Supported |
| Map (link list) | ✅ Supported |
| Real network fetching / JS rendering / screenshots | ✓ By design — Intentional for a local, zero-cost test emulator |
| Async crawl progression (`scraping` → `completed`) | ◐ Completes immediately |
| `extract` / `search` / structured-data (LLM) endpoints | ⟳ Roadmap |
| Webhooks / batch scrape | ⟳ Roadmap |
| `formats` option (screenshot, links, rawHtml) | ◐ Always returns markdown + html |

## Manifest

See `services/firecrawl/manifest.json`:

- name: `firecrawl`, port: `4885`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
FIRECRAWL_API_KEY=fc-parlel
FIRECRAWL_BASE_URL=http://localhost:4885
```

<!-- parlel:testenv:end -->
