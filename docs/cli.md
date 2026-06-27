# CLI

The `parlel` command is the front door to Parlel. Zero install:

```bash
npx parlel up postgres redis stripe
```

Or, in a clone, `node src/cli.mjs <command>` (the `parlel` bin maps to it).

Pure Node, zero dependencies — same rule as the emulators.

## Commands

### `parlel up [services...] [-d]`
Start services. Foreground by default (logs stream to your terminal, Ctrl-C to
stop). With `-d` the fleet runs **detached** in the background and `up` returns
once the control plane is healthy.

```bash
parlel up postgres redis stripe     # foreground
parlel up stripe -d                 # detached
SERVICES=postgres,redis parlel up   # services via env also work
```

Detached state is tracked in `~/.parlel/daemon.json` (override the directory with
`PARLEL_STATE_DIR`); logs go to `~/.parlel/daemon.log`.

### `parlel down`
Stop the detached fleet (SIGINT, then SIGKILL if it lingers). No-op if nothing is
running.

### `parlel status [--json]`
Table of running services from the control plane — port, protocol, uptime,
capability flags (`reset`/`dump`/`seed`/`requests`), and a ready-to-use
connection string. `--json` for machine-readable output.

```
SERVICE   PORT  PROTO  UPTIME  CAPS                 CONNECTION
● ec2     4700  http   4s      reset,requests       http://127.0.0.1:4700
● stripe  4757  http   4s      reset,seed,requests  http://127.0.0.1:4757

2 services · control plane :4600
```

### `parlel ls [filter]`
List all available services with their port, protocol, and category. The filter
matches **slug, category, or protocol**:

```bash
parlel ls                # all
parlel ls payments       # everything in the payments category
parlel ls tcp            # the wire-protocol databases
parlel ls stripe         # a single service
```

### `parlel reset [slug]`
Reset state. With a slug, resets one service; without, resets the whole fleet —
the per-test isolation primitive, from the command line.

### `parlel inspect <slug> [--json]`
Show a service's detail, its recent request log, and (if it exposes `dump()`) its
state.

### `parlel seed <file>`
Load a fixtures JSON into running services via the control plane. Same shape as
`parlel.fixtures.json` (see [control-plane.md](./control-plane.md)).

```bash
echo '{"stripe":{"customers":[{"id":"cus_test","email":"a@b.com"}]}}' > fix.json
parlel seed fix.json
```

### `parlel logs [-f]`
Print the detached fleet's log. `-f` follows (tail) until Ctrl-C.

### `parlel doctor`
Preflight: Node version (>= 20), control-plane reachability / port availability,
and whether Docker is present (optional).

### `parlel help` · `parlel --version`

## Configuration

- **`PARLEL_CONTROL_PORT`** — control-plane port the CLI talks to (default `4600`).
- **`PARLEL_STATE_DIR`** — where detached state + logs live (default `~/.parlel`).
- **`--port <n>`** — override the control-plane port for a single command.

## Notes

- `status`, `reset`, `inspect`, and `seed` talk to the **control plane** over
  HTTP, so a fleet must be running (`parlel up -d`, or any launcher with the
  control plane enabled).
- Foreground `parlel up` is equivalent to the old `node src/launch.mjs` — that
  still works for back-compat.
