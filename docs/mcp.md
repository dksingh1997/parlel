# MCP server

Parlel ships an [MCP](https://modelcontextprotocol.io) server so AI agents can
drive the emulators by tool call — start services, run code against them, and
**read the request log to verify what the code actually did**, all locally and
free. See [AGENTS.md](../AGENTS.md) for the agent-facing workflow.

The server is pure Node, zero dependencies. It speaks newline-delimited JSON-RPC
2.0 over stdio and manages its own in-process fleet, so nothing needs to be
running first.

## Run it

```bash
npx parlel-mcp           # zero install
# or, in a clone:
node src/mcp.mjs
npm run mcp
```

stdout is the JSON-RPC stream; all logs go to stderr.

## Connect it to a client

### Claude Desktop

Add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "parlel": {
      "command": "npx",
      "args": ["-y", "parlel-mcp"]
    }
  }
}
```

From a clone, use the absolute path instead:

```json
{
  "mcpServers": {
    "parlel": {
      "command": "node",
      "args": ["/absolute/path/to/parlel/src/mcp.mjs"]
    }
  }
}
```

### Cursor / other MCP clients

Most clients accept the same `command` + `args` shape. Point them at
`npx -y parlel-mcp` (or `node /path/to/parlel/src/mcp.mjs`). Restart the client so
it performs the MCP handshake.

## Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `parlel_list_services` | `{ filter? }` | Catalog of 250+ services (slug, port, protocol, category). `filter` matches slug, category, or protocol. |
| `parlel_start_services` | `{ slugs }` | Starts emulators; returns `{ started: [{ slug, port, connection_string }], failed, embedded }`. |
| `parlel_stop_services` | `{ slugs? }` | Stops some (or, omitting `slugs`, all). |
| `parlel_status` | `{}` | Running services with port/uptime/caps/connection string. |
| `parlel_get_requests` | `{ slug, method?, path? }` | The recorded request log for a running HTTP service. |
| `parlel_reset` | `{ slug? }` | Resets one service, or all running services. |
| `parlel_seed` | `{ slug, data }` | Preloads fixture data (per-service shape). |
| `parlel_inspect` | `{ slug }` | Detail + recent requests + state. |

## Configuration

- **`PARLEL_CONTROL_PORT`** — port for the embedded control plane the MCP server
  uses for request logs / connection strings (default `4600`).
- **`PARLEL_RECORD=0`** — disable request recording (then `parlel_get_requests`
  reports "recording is off").

## Verifying it works (raw protocol)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/mcp.mjs
```

You should see the `initialize` result (serverInfo `parlel`) followed by the
`tools/list` result listing the eight `parlel_*` tools.
