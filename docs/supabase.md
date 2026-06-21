# Supabase

Lightweight, dependency-free Supabase emulator covering the Auth (GoTrue) and
REST (PostgREST) surfaces over HTTP/JSON.

| Key | Value |
|-----|-------|
| Port | 54321 |
| Protocol | REST API (HTTP + JSON) |
| Size | small |

## Default Connection

```
http://localhost:54321
```

| Surface | Base path |
|---------|-----------|
| Auth (GoTrue) | `/auth/v1/` |
| REST (PostgREST) | `/rest/v1/` |

## Supported Operations

### Auth (`/auth/v1`)

| Operation | Notes |
|-----------|-------|
| Sign up / create user | Registers a user in the in-memory user map |
| Token / session | Returns a session for a registered user |

### REST (`/rest/v1/{table}`)

| Operation | Request |
|-----------|---------|
| Insert row | `POST /rest/v1/{table}` |
| Select rows | `GET /rest/v1/{table}` |
| Update row | `PATCH /rest/v1/{table}` |
| Delete row | `DELETE /rest/v1/{table}` |

## Usage

app connects with an **unmodified** `@supabase/supabase-js` client (or raw REST)
— no Parlel code in the app.

```bash

```

```typescript
import { createClient } from "@supabase/supabase-js";

// Unmodified real client, pointed at the bridge hostname
// (or `localhost` if you run the bridge outside Docker and publish ports)
const supabase = createClient("http://localhost:54321", "parlel-anon-key");

await supabase.from("todos").insert({ title: "Ship it" });
const { data } = await supabase.from("todos").select("*");
```

## Auth (GoTrue)

The Auth surface speaks the Supabase GoTrue wire protocol under `/auth/v1/`, so
`@supabase/supabase-js`'s `supabase.auth.*` methods work against the fake. State
is in-memory and ephemeral; access tokens are JWT-shaped
(`header.payload.signature`) strings generated deterministically (not
cryptographically verifiable).

| Operation | Request | Response |
|-----------|---------|----------|
| Sign up | `POST /auth/v1/signup` `{ email, password }` | `{ access_token, refresh_token, token_type:"bearer", expires_in, expires_at, user }` |
| Sign in (password) | `POST /auth/v1/token?grant_type=password` `{ email, password }` | `{ access_token, refresh_token, token_type:"bearer", expires_in, user }` |
| Refresh session | `POST /auth/v1/token?grant_type=refresh_token` `{ refresh_token }` | new session `{ access_token, refresh_token, user }` |
| Get user | `GET /auth/v1/user` (`Authorization: Bearer <access_token>`) | the GoTrue `user` object |
| Sign out | `POST /auth/v1/logout` (`Authorization: Bearer <access_token>`) | `204 No Content` (session revoked) |

The `user` object follows the GoTrue shape:
`{ id, aud:"authenticated", role:"authenticated", email, email_confirmed_at, app_metadata, user_metadata, created_at, updated_at, … }`.

Error shapes mirror GoTrue: invalid credentials return
`400 { error:"invalid_grant", error_description:"Invalid login credentials" }`,
missing email on signup returns `422`, and an invalid/missing bearer on
`GET /auth/v1/user` returns `401 { code:401, error_code:"bad_jwt", msg }`.

```typescript
import { createClient } from "@supabase/supabase-js";
const supabase = createClient("http://localhost:54321", "parlel-anon-key");

const { data } = await supabase.auth.signUp({ email: "su@parlel.dev", password: "Secret1!" });
await supabase.auth.signInWithPassword({ email: "su@parlel.dev", password: "Secret1!" });
const { data: { user } } = await supabase.auth.getUser();
await supabase.auth.signOut();
```

## Access via Parlel Sandbox

your unmodified client or REST calls at that hostname (or `localhost` if you run
the bridge outside Docker and publish ports).

## Surface coverage

This emulator faithfully replicates the API surface most application code and agents exercise. Anything below the supported lines is either an intentional design choice for a fast, zero-cost local emulator (✓ By design) or a candidate for a future release (⟳ Roadmap) — never a silent inaccuracy.

Legend: ✅ fully supported · ◐ accepted (stored, not strictly enforced) · ✓ by design · ⟳ on the roadmap.

| Feature | Status |
|---------|--------|
| Auth sign-up + password sign-in + session | Supported |
| Auth refresh-token exchange | Supported |
| Auth `GET /auth/v1/user` (Bearer) + `logout` | Supported |
| REST insert / select / update / delete | Supported |
| Real JWT signing / verification (RS256/JWKS) | Tokens are JWT-shaped, not verifiable |
| OAuth / magic links / OTP / email delivery | Not delivered |
| PostgREST filters / RLS / realtime | Not evaluated |
| Storage / edge functions | Not supported |

<!-- parlel:testenv:start -->

## Configuration — `test.env`

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=parlel-anon-key
SUPABASE_SERVICE_ROLE_KEY=parlel-service-role-key
```

<!-- parlel:testenv:end -->
