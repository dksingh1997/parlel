# LinkedIn

Lightweight, dependency-free, in-memory fake of the [LinkedIn API](https://learn.microsoft.com/en-us/linkedin/) for testing code that publishes posts and reads member profiles.

Default port: `4799`

## Quick start

```js
import { LinkedinServer } from "./services/linkedin/src/server.js";

const server = new LinkedinServer(4799);
await server.start();
// ... run your app/tests ...
await server.stop();
```

Point your LinkedIn client (or raw `fetch`) at `http://127.0.0.1:4799`:

```js
const res = await fetch("http://127.0.0.1:4799/v2/ugcPosts", {
  method: "POST",
  headers: {
    Authorization: "Bearer parlel-test-token",
    "Content-Type": "application/json",
    "X-Restli-Protocol-Version": "2.0.0",
  },
  body: JSON.stringify({
    author: "urn:li:person:parlelMember001",
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text: "Hello from parlel!" },
        shareMediaCategory: "NONE",
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  }),
});
const { id } = await res.json(); // urn:li:ugcPost:<id>
```

## Implemented operations

All `/v2/*` and `/rest/*` routes require `Authorization: Bearer <token>` (any non-empty token accepted). The `X-Restli-Protocol-Version` header is accepted. State is in-memory and ephemeral; created posts are captured.

- `POST /v2/ugcPosts` — create a UGC post (legacy). Returns `201 { id: "urn:li:ugcPost:<id>" }` and an `x-restli-id` header.
- `POST /rest/posts` — create a post (versioned API). Returns `201` with empty body and an `x-restli-id: urn:li:share:<id>` header.
- `GET /v2/me` — current member profile (`{ id, localizedFirstName, localizedLastName, firstName, lastName }`).
- `GET /v2/userinfo` — OpenID Connect claims (`{ sub, name, email, given_name, family_name, picture, locale }`).

### Service & inspection operations (parlel extensions)

- `GET /` — service metadata.
- `GET /health` — health check.
- `POST /__parlel/reset` — reset all in-memory state.
- `GET /__parlel/posts` — list captured posts (`{ posts: [], count }`).

## Access via MCP / preview URL

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
| --- | --- |
| `ugcPosts` create | ✅ Supported |
| `/rest/posts` create | ✅ Supported |
| `/v2/me` profile | ✅ Supported |
| `/v2/userinfo` OpenID | ✅ Supported |
| `x-restli-id` response header | ✅ Supported |
| Bearer token validity / scope enforcement | ✓ By design — Any non-empty credential is accepted — no real secrets needed |
| Media / image / video asset upload | ⟳ Roadmap |
| Organization / company page posting | ⟳ Roadmap |
| Real publishing to LinkedIn | ⟳ Roadmap — Intentionally unsupported (fake captures only) |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
LINKEDIN_ACCESS_TOKEN=parlel
LINKEDIN_BASE_URL=http://localhost:4799
```

<!-- parlel:testenv:end -->
