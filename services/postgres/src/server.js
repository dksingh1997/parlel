import { createServer } from "node:net";
import { PostgresProtocol } from "./protocol.js";
import { SQLExecutor } from "./sql.js";

export class PostgresServer {
  constructor(port = 5432, options = {}) {
    this.port = port;
    this.user = options.user || "parlel";
    this.password = options.password || "parlel";
    this.database = options.database || "parlel";
    this.executor = new SQLExecutor();
    // Surface the connection identity to the executor so current_database() /
    // current_user and information_schema rows report the configured values.
    this.executor.database = this.database;
    this.executor.user = this.user;
    this.server = null;
    this.pid = 1000;
    // Track open client connections so stop() can tear them down cleanly.
    this.sockets = new Set();
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer((socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        let authenticated = false;
        let buffer = Buffer.alloc(0);
        // Extended query protocol state for this connection.
        // statements: name -> { query }, portals: name -> { query, params }
        const statements = new Map();
        const portals = new Map();

        socket.on("data", (data) => {
          buffer = Buffer.concat([buffer, data]);

          while (buffer.length >= 4) {
            if (!authenticated) {
              const length = buffer.readInt32BE(0);
              if (buffer.length < length) break;

              const protocolVersion = buffer.readInt32BE(4);
              
              // SSL request (80877103 = 0x00030000)
              if (protocolVersion === 80877103) {
                // Reject SSL
                socket.write(Buffer.from("N"));
                buffer = buffer.subarray(length);
                continue;
              }

              // Cancel request (80877102 = 0x00020000)
              if (protocolVersion === 80877102) {
                buffer = buffer.subarray(length);
                continue;
              }

              const msg = buffer.subarray(0, length);
              const startup = PostgresProtocol.parseStartupMessage(msg);

              if (startup.params.user === this.user) {
                socket.write(PostgresProtocol.encodeAuthenticationOk());
                socket.write(PostgresProtocol.encodeParameterStatus("server_version", "16.0"));
                socket.write(PostgresProtocol.encodeParameterStatus("server_encoding", "UTF8"));
                socket.write(PostgresProtocol.encodeParameterStatus("client_encoding", "UTF8"));
                socket.write(PostgresProtocol.encodeParameterStatus("DateStyle", "ISO, MDY"));
                socket.write(PostgresProtocol.encodeParameterStatus("TimeZone", "UTC"));
                socket.write(PostgresProtocol.encodeBackendKeyData(this.pid++, 12345));
                socket.write(PostgresProtocol.encodeReadyForQuery());
                authenticated = true;
              } else {
                socket.write(PostgresProtocol.encodeErrorResponse(`role "${startup.params.user}" does not exist`));
                socket.end();
              }

              buffer = buffer.subarray(length);
              continue;
            }

            if (buffer.length < 5) break;
            const type = buffer.readUInt8(0);
            const length = buffer.readInt32BE(1);

            if (buffer.length < length + 1) break;

            const msg = buffer.subarray(0, length + 1);
            buffer = buffer.subarray(length + 1);

            switch (type) {
              case 0x51: // Query
                this.handleQuery(socket, msg);
                break;

              case 0x50: { // Parse
                const parsed = PostgresProtocol.parseParse(msg.subarray(1));
                statements.set(parsed.name || "", { query: parsed.query });
                socket.write(PostgresProtocol.encodeParseComplete());
                break;
              }

              case 0x42: { // Bind
                const bound = PostgresProtocol.parseBind(msg.subarray(1));
                const stmt = statements.get(bound.statement || "") || { query: "" };
                portals.set(bound.portal || "", {
                  query: stmt.query,
                  params: bound.params || [],
                });
                socket.write(PostgresProtocol.encodeBindComplete());
                break;
              }

              case 0x44: { // Describe
                const desc = PostgresProtocol.parseDescribe(msg.subarray(1));
                // Resolve the query for a RowDescription where possible.
                let q = "";
                if (desc.type === "P") {
                  q = (portals.get(desc.name || "") || {}).query || "";
                } else {
                  q = (statements.get(desc.name || "") || {}).query || "";
                }
                if (desc.type === "S") {
                  socket.write(PostgresProtocol.encodeParameterDescription());
                }
                const fields = this.describeFields(q);
                if (fields && fields.length > 0) {
                  socket.write(PostgresProtocol.encodeRowDescription(fields));
                } else {
                  socket.write(PostgresProtocol.encodeNoData());
                }
                break;
              }

              case 0x45: { // Execute
                const ex = PostgresProtocol.parseExecute(msg.subarray(1));
                const portal = portals.get(ex.portal || "") || { query: "", params: [] };
                const sql = this.bindParams(portal.query, portal.params);
                this.runStatement(socket, sql);
                break;
              }

              case 0x53: // Sync
                socket.write(PostgresProtocol.encodeReadyForQuery());
                break;

              case 0x43: // Close
                socket.write(PostgresProtocol.encodeCloseComplete());
                break;

              case 0x48: // Flush
                // Flush doesn't send a response
                break;

              case 0x64: // CopyData
                // Accept but don't process
                break;

              case 0x63: // CopyDone
                socket.write(PostgresProtocol.encodeCommandComplete("COPY"));
                socket.write(PostgresProtocol.encodeReadyForQuery());
                break;

              case 0x66: // CopyFail
                socket.write(PostgresProtocol.encodeErrorResponse("COPY canceled by client"));
                socket.write(PostgresProtocol.encodeReadyForQuery());
                break;

              case 0x58: // Terminate
                socket.end();
                break;

              default:
                socket.write(PostgresProtocol.encodeErrorResponse(`unsupported message type: ${type}`));
                socket.write(PostgresProtocol.encodeReadyForQuery());
            }
          }
        });

        socket.on("error", () => {});
      });

      this.server.listen(this.port, () => {
        console.log(`Postgres server running on port ${this.port}`);
        resolve();
      });
    });
  }

  // Clear all in-memory database state (tables, views, sequences). Open client
  // connections stay up; the next query sees an empty catalog.
  reset() {
    this.executor.reset();
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.sockets.clear();
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }

  handleQuery(socket, msg) {
    const query = PostgresProtocol.parseQuery(msg);

    if (query === "" || query === ";") {
      socket.write(PostgresProtocol.encodeCommandComplete(""));
      socket.write(PostgresProtocol.encodeReadyForQuery());
      return;
    }

    const result = this.executor.execute(query);

    if (result.error) {
      // Default uncoded errors to 42601 (syntax_error), the generic
      // syntax/access-rule class — NOT 42P01 (undefined_table), which would
      // mislabel a syntax error as a missing-relation error to err.code checks.
      socket.write(PostgresProtocol.encodeErrorResponse(result.error, result.code || "42601"));
      socket.write(PostgresProtocol.encodeReadyForQuery());
      return;
    }

    if (result.fields && result.fields.length > 0) {
      socket.write(PostgresProtocol.encodeRowDescription(result.fields));

      for (const row of result.rows) {
        socket.write(PostgresProtocol.encodeDataRow(row, result.fields));
      }
    }

    socket.write(PostgresProtocol.encodeCommandComplete(result.tag));
    socket.write(PostgresProtocol.encodeReadyForQuery());
  }

  // Execute (extended protocol): run a fully-bound statement. Unlike the simple
  // Query flow, the response is terminated by the client's Sync (ReadyForQuery),
  // so we do NOT emit ReadyForQuery here.
  runStatement(socket, query) {
    if (!query || query === ";") {
      socket.write(PostgresProtocol.encodeCommandComplete(""));
      return;
    }

    const result = this.executor.execute(query);

    if (result.error) {
      socket.write(PostgresProtocol.encodeErrorResponse(result.error, result.code || "42601"));
      return;
    }

    if (result.fields && result.fields.length > 0) {
      // RowDescription is sent in response to Describe; pg sends Describe before
      // Execute, but emitting rows here is what the client consumes. We send the
      // data rows (RowDescription already delivered during Describe).
      for (const row of result.rows) {
        socket.write(PostgresProtocol.encodeDataRow(row, result.fields));
      }
    }

    socket.write(PostgresProtocol.encodeCommandComplete(result.tag));
  }

  // Resolve the RowDescription fields for a query without mutating state, used
  // by the Describe step of the extended protocol.
  describeFields(query) {
    if (!query) return [];
    const upper = query.trim().toUpperCase();
    // Only SELECT / RETURNING produce a row description.
    if (!upper.startsWith("SELECT") && !/RETURNING/i.test(query)) return [];
    try {
      // Run against a probe to learn the field shape, then discard side effects
      // by snapshotting and restoring table rows.
      return this.probeFields(query);
    } catch {
      return [];
    }
  }

  // Determine output fields by executing on a transactional snapshot so DML in a
  // Describe never persists. Restores all table rows afterwards.
  probeFields(query) {
    const snapshot = new Map();
    for (const [name, table] of this.executor.tables) {
      snapshot.set(name, table.rows.map((r) => r.slice()));
    }
    const seqSnap = new Map();
    if (this.executor.sequences) {
      for (const [name, seq] of this.executor.sequences) {
        seqSnap.set(name, { ...seq });
      }
    }
    const idSnap = new Map();
    if (this.executor.nextId) {
      for (const [name, val] of this.executor.nextId) idSnap.set(name, val);
    }
    let result;
    try {
      result = this.executor.execute(query);
    } finally {
      for (const [name, rows] of snapshot) {
        const table = this.executor.tables.get(name);
        if (table) table.rows = rows;
      }
      if (this.executor.sequences) {
        this.executor.sequences = seqSnap;
      }
      if (this.executor.nextId) {
        this.executor.nextId = idSnap;
      }
    }
    return result && result.fields ? result.fields : [];
  }

  // Substitute $1, $2, ... placeholders with bound parameter literals. Values
  // are quoted/escaped as SQL literals so they flow through the text executor.
  bindParams(query, params) {
    if (!params || params.length === 0) return query;
    return query.replace(/\$(\d+)/g, (_, n) => {
      const idx = Number(n) - 1;
      if (idx < 0 || idx >= params.length) return _;
      const v = params[idx];
      if (v === null || v === undefined) return "NULL";
      if (Buffer.isBuffer(v)) return `'${v.toString("utf8").replace(/'/g, "''")}'`;
      const s = String(v);
      // Numeric literals pass through unquoted; everything else is a quoted
      // string with single quotes doubled per SQL escaping rules.
      if (/^-?\d+(\.\d+)?$/.test(s)) return s;
      return `'${s.replace(/'/g, "''")}'`;
    });
  }
}
