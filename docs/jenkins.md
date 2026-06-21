# Jenkins

Lightweight, dependency-free, in-memory fake of the **Jenkins REST API** for testing CI automation code. Zero runtime dependencies (Node builtins only); state is in-memory and ephemeral.

Default port: `4877`

## Quick start

```js
import { JenkinsServer } from "./services/jenkins/src/server.js";

const server = new JenkinsServer(4877);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Authenticate with HTTP Basic (`user:apiToken`) — any non-empty pair is accepted:

```bash
curl -u parlel:apiToken http://127.0.0.1:4877/api/json
```

## Access via MCP / preview URL

The service is registered in the parlel pool and reachable through the parlel MCP server and its generated preview URL. Set `JENKINS_URL=http://127.0.0.1:4877`, `JENKINS_USER=parlel`, `JENKINS_API_TOKEN=parlel`, then drive the Jenkins REST surface. The MCP server proxies the HTTP endpoints below so an agent can create jobs and trigger builds without a real Jenkins controller.

## Implemented operations

All endpoints (except `/`, `/health`) require HTTP Basic auth (`user:apiToken`, any non-empty pair). CSRF crumbs are issued but not strictly enforced.

- `GET /api/json` — controller info + job list.
- `GET /job/:name/api/json` — job details (`name, url, buildable, color, nextBuildNumber, builds, lastBuild`).
- `POST /job/:name/build` — trigger a build → `201` with a `Location` header pointing at the queue item.
- `GET /job/:name/lastBuild/api/json` — the most recent build (`number, result, building, timestamp, duration`).
- `POST /createItem?name=` — create a new job (`200`; `400` if it already exists).
- `GET /crumbIssuer/api/json` — issue a CSRF crumb (`{ crumb, crumbRequestField }`).

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
| `GET /api/json`, job get, build trigger, lastBuild, createItem, crumb | ✅ Supported |
| Build number increments + build history | ✅ Supported |
| Real pipeline/Groovy execution, agents, plugins | ⟳ Roadmap — Intentionally unsupported |
| Config XML round-trip (`config.xml`) | ⟳ Roadmap — job created with defaults |
| Build artifacts / console logs | ⟳ Roadmap — Not stored |
| CSRF crumb enforcement | ◐ Crumb issued, not enforced |
| Credential / token validity | ✓ By design — Any non-empty credential is accepted — no real secrets needed |

## Manifest

See `services/jenkins/manifest.json`:

- name: `jenkins`, port: `4877`, protocol: `http`, healthcheck: `/health`, startup ≈ 100ms
- env: `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN`, `JENKINS_BASE_URL`

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
JENKINS_URL=http://localhost:4877
JENKINS_USER=parlel
JENKINS_API_TOKEN=parlel
JENKINS_BASE_URL=http://localhost:4877
```

<!-- parlel:testenv:end -->
