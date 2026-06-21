<div align="center">

# Parlel

**250+ service emulators on local Docker — Stripe, Postgres, Slack, S3, OpenAI and more, speaking real wire protocols.**

A verification layer for AI coding agents (and a "mock everything locally" tool for everyone else).

[![CI](https://github.com/dksingh1997/parlel/actions/workflows/ci.yml/badge.svg)](https://github.com/dksingh1997/parlel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Services](https://img.shields.io/badge/services-250%2B-green)

</div>

---

```bash
SERVICES="postgres,redis,stripe,openai,slack" docker compose up
```

That's it. Five real services are now listening on `localhost` — Postgres on
5432, Redis on 6379, Stripe on 4757, and so on. Point your app at them with
**unmodified real drivers** and run your code. No accounts, no API keys, no cost,
no side effects.

## Why

Code that talks to databases, payment APIs, queues and SaaS needs testing. Today
you either:

- **Mock everything** — fast, but mocks lie and miss real bugs.
- **Use the real services** — accurate, but slow, costs money, needs secrets,
  and has side effects (real charges, real emails).

Parlel is the third option: **real wire protocols, in-memory, instant, free.**
The Postgres emulator speaks the actual Postgres protocol — `psycopg`/`pg`
connect unmodified. The Stripe emulator speaks the real Stripe REST API —
`stripe-node` works as-is. Your code is identical to production; only the
endpoint changes.

This is especially useful for **AI coding agents**: an agent can spin up exactly
the services its code touches, run it, assert, and tear down — all locally, all
free, with zero risk to production.

## Quick start

**With Docker Compose (pick your services):**

```bash
git clone https://github.com/dksingh1997/parlel && cd parlel

# start just what you need
SERVICES="postgres,redis,stripe" docker compose up

# or everything
SERVICES=all docker compose up
```

**With plain `docker run`:**

```bash
docker build -t parlel .
docker run -p 5432:5432 -p 4757:4757 -e SERVICES="postgres,stripe" parlel
```

**Without Docker (pure Node, no install needed):**

```bash
SERVICES="postgres,redis,stripe" node src/launch.mjs
```

Then use the services with your normal drivers:

```python
import psycopg, redis, stripe

db    = psycopg.connect("postgres://parlel:parlel@localhost:5432/parlel")
cache = redis.Redis(host="localhost", port=6379)
stripe.api_base = "http://localhost:4757"
stripe.api_key  = "sk_test_parlel"
```

```js
import pg from "pg";
import Stripe from "stripe";

const db = new pg.Client("postgres://parlel:parlel@localhost:5432/parlel");
const stripe = new Stripe("sk_test_parlel", { host: "localhost", port: 4757, protocol: "http" });
```

See [`examples/`](./examples) for a runnable end-to-end flow, and
[`.env.example`](./.env.example) for every service's port + seeded test
credentials.

## What's included

250+ services across these categories:

| Category | Count | Examples |
|----------|------:|----------|
| AWS | 59 | S3, DynamoDB, SQS, SNS, Lambda, SES, Kinesis |
| Payments | 20 | Stripe, PayPal, Braintree, Adyen, Square, Razorpay |
| Dev / Source | 19 | GitHub, GitLab, Vercel, Sentry, CircleCI |
| AI | 18 | OpenAI, Anthropic, Cohere, Mistral, Groq |
| Email | 15 | SendGrid, Mailgun, Resend, Postmark, SES |
| Forms | 10 | Typeform, Jotform, Tally, Google Forms |
| Analytics | 10 | Mixpanel, Amplitude, PostHog, Segment |
| Productivity | 10 | Jira, Notion, Slack, Linear, Asana, Trello |
| Storage | 10 | S3, GCS, Azure Blob, Dropbox, Cloudinary |
| Social | 10 | X/Twitter, LinkedIn, Instagram, Reddit, Discord |
| CRM | 10 | Salesforce, HubSpot, Pipedrive, Freshsales |
| Auth | 9 | Auth0, Clerk, Cognito, Keycloak, Okta |
| Search | 7 | Elasticsearch, Meilisearch, Qdrant, Pinecone |
| Databases | 6 | Postgres, MySQL, MongoDB, Redis, Cassandra, Supabase |
| Azure / GCP / Google / Microsoft | 20 | Key Vault, Pub/Sub, BigQuery, Sheets, Teams |
| Messaging | 4 | Kafka, RabbitMQ, EventBridge |
| Marketing / SaaS / … | 11 | Mailchimp, Klaviyo, Shopify, Zendesk |

**TCP services** (real wire protocols, reached with native drivers): Postgres,
Redis, MySQL, MongoDB, Kafka, RabbitMQ, Cassandra. Everything else is HTTP.

<details>
<summary>Full service list</summary>

See [`.env.example`](./.env.example) for all 250 services with their ports and
seeded credentials, and [`docs/`](./docs) for a per-service API reference.

</details>

## Real protocols, not stubs

Each emulator implements the actual wire protocol or REST contract, verified
against the real client libraries. The test suite connects with `pg`, `redis`,
`mysql2`, `mongodb`, `kafkajs`, `amqplib`, `cassandra-driver`, the AWS SDK,
Stripe, and more — and asserts real round-trips.

```bash
npm install      # dev deps: the real driver libraries + vitest
npm test         # per-service fidelity tests
npm run probe    # boot a set and health-check every service
```

## Configuration

- **`SERVICES`** — comma-separated slugs, or `all`. Defaults to `postgres,redis`.
- **Ports** — each service uses its canonical port (see `.env.example`).
- **Credentials** — seeded test values (e.g. `sk_test_parlel`); any non-empty
  value is accepted, so you rarely need to change them.

## How it works

```
your app / agent  ──▶  localhost:<port>  ──▶  in-memory emulator (real protocol)
   (unchanged)         (no bridge, no proxy)      (ephemeral, zero side effects)
```

Each emulator is dependency-free Node holding state in memory. State is
ephemeral — restart for a clean slate. No data ever leaves your machine.

## Add a service

Adding an emulator is a manifest + a `server.js` + a test. See
[CONTRIBUTING.md](./CONTRIBUTING.md) — it takes about five minutes.

## Roadmap

- MCP server so agents can drive services by tool call.
- Record / replay against real upstreams.
- More services (open an issue to request one).

## License

[MIT](./LICENSE).
