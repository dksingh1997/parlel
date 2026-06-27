# AGENTS.md — using Parlel as an AI coding agent

Parlel is a **verification layer**. When you write code that talks to a database,
a payment API, a queue, or any SaaS, you normally can't run it safely — real
services cost money, need secrets, and have side effects; mocks lie. Parlel gives
you the third option: **250+ local emulators speaking the real wire protocols**,
so your unmodified code runs against `localhost`, for free, with zero side
effects, and you can **read back exactly what your code did** to verify it.

## The loop

```
start the services your code touches
        ↓
point your unmodified driver at the returned connection string
        ↓
run your code
        ↓
read the request log → assert what your code actually sent
        ↓
reset between iterations · stop when done
```

## With the MCP server (recommended for agents)

If the Parlel MCP server is connected (see [docs/mcp.md](./docs/mcp.md)), you have
these tools. They manage an in-process fleet — nothing needs to be running first.

| Tool | Use it to |
|------|-----------|
| `parlel_list_services({filter?})` | Discover what's available (filter by `payments`, `ai`, `databases`, a slug, or a protocol). |
| `parlel_start_services({slugs})` | Start emulators; returns the **connection string** for each. |
| `parlel_seed({slug, data})` | Preload fixtures so a service isn't empty (e.g. a customer to charge). |
| `parlel_get_requests({slug, method?, path?})` | **The verify step.** Read every request the emulator received. |
| `parlel_reset({slug?})` | Clean slate between iterations / test cases. |
| `parlel_inspect({slug})` | Detail + recent requests + state for one service. |
| `parlel_status()` | What's currently running. |
| `parlel_stop_services({slugs?})` | Tear down (omit `slugs` for all). |

### Worked example — verifying Stripe code

1. `parlel_start_services({ slugs: ["stripe"] })`
   → `{ started: [{ slug: "stripe", port: 4757, connection_string: "http://127.0.0.1:4757" }] }`
2. (optional) `parlel_seed({ slug: "stripe", data: { customers: [{ id: "cus_test", email: "a@b.com" }] } })`
3. Run the code under test, pointing the Stripe SDK at the connection string:
   ```js
   const stripe = new Stripe("sk_test_parlel", { host: "127.0.0.1", port: 4757, protocol: "http" });
   await stripe.charges.create({ amount: 2000, currency: "usd", customer: "cus_test" });
   ```
4. **Verify** what the code actually sent:
   `parlel_get_requests({ slug: "stripe", method: "POST", path: "/v1/charges" })`
   → assert exactly one POST to `/v1/charges` with `amount=2000`.
5. `parlel_reset({ slug: "stripe" })` before the next case.
6. `parlel_stop_services()` when finished.

## Without MCP (CLI or library)

The same loop from a shell — see [docs/cli.md](./docs/cli.md):

```bash
parlel up stripe postgres -d        # start (detached)
# ... run your code against localhost ...
parlel inspect stripe               # see the request log
parlel reset                        # clean slate
parlel down                         # stop
```

Or with plain Node (no install): `SERVICES=stripe,postgres node src/launch.mjs`,
then drive the control plane at `http://localhost:4600` (see
[docs/control-plane.md](./docs/control-plane.md)).

## Rules of thumb

- **Start only what the code touches.** Don't boot all 250 — start `stripe`, or
  `postgres,redis`, etc.
- **Connection strings come from the tool, not your memory.** Use the
  `connection_string` returned by `parlel_start_services` / `parlel_status`.
- **Reset, don't restart.** `parlel_reset` is instant; restarting is slow.
- **The request log is your assertion surface.** "Did my code call the API the way
  I think it did?" — `parlel_get_requests` answers it. Real services can't.
- **State is ephemeral.** Nothing persists across a stop; nothing leaves the
  machine.

## Contributing as an agent

If you add or change an emulator, follow [SKILL.md](./SKILL.md) — the operating
manual for writing code in this repo (plan → implement → test → docs → changelog
→ hygiene).
