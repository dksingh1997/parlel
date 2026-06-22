import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

export class ElasticsearchServer {
  constructor(port = 9200) {
    this.port = port;
    this.server = null;
    this.reset();
  }

  // Clears all in-memory state back to empty. Used for per-test isolation
  // and by the Parlel control plane. Idempotent, no I/O.
  reset() {
    this.indices = new Map();
  }

  start() {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const path = url.pathname;

        let body = "";
        if (req.method === "POST" || req.method === "PUT") {
          for await (const chunk of req) body += chunk;
        }

        res.setHeader("Content-Type", "application/json");
        res.setHeader("X-elastic-product", "Elasticsearch");

        try {
          if (path === "/") {
            res.writeHead(200);
            res.end(JSON.stringify({
              name: "parlel-node",
              cluster_name: "parlel-cluster",
              cluster_uuid: "parlel-uuid",
              version: { number: "8.0.0", build_flavor: "default" },
            }));
          } else if (path === "/_cluster/health") {
            res.writeHead(200);
            res.end(JSON.stringify({
              cluster_name: "parlel-cluster",
              status: "green",
              timed_out: false,
              number_of_nodes: 1,
              number_of_data_nodes: 1,
              active_primary_shards: 0,
              active_shards: 0,
            }));
          } else if (path.match(/^\/[^/]+$/) && req.method === "PUT") {
            // Create index
            const index = path.slice(1);
            this.indices.set(index, { docs: new Map(), mappings: {} });
            res.writeHead(200);
            res.end(JSON.stringify({ acknowledged: true, shards_acknowledged: true, index }));
          } else if (path.match(/^\/[^/]+\/_doc$/) && req.method === "POST") {
            // Index document
            const index = path.split("/")[1];
            const id = randomBytes(8).toString("hex");
            const doc = JSON.parse(body);
            if (!this.indices.has(index)) {
              this.indices.set(index, { docs: new Map(), mappings: {} });
            }
            this.indices.get(index).docs.set(id, doc);
            res.writeHead(201);
            res.end(JSON.stringify({ _index: index, _id: id, result: "created" }));
          } else if (path.match(/^\/[^/]+\/_doc\/[^/]+$/) && req.method === "GET") {
            // Get document
            const [, index, , id] = path.split("/");
            const idx = this.indices.get(index);
            if (!idx || !idx.docs.has(id)) {
              res.writeHead(404);
              res.end(JSON.stringify({ found: false }));
              return;
            }
            res.writeHead(200);
            res.end(JSON.stringify({ _index: index, _id: id, found: true, _source: idx.docs.get(id) }));
          } else if (path.match(/^\/[^/]+\/_search$/) && req.method === "POST") {
            // Search
            const index = path.split("/")[1];
            const idx = this.indices.get(index);
            if (!idx) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: { type: "index_not_found_exception" } }));
              return;
            }
            const query = JSON.parse(body || "{}");
            const hits = [];
            for (const [id, doc] of idx.docs) {
              hits.push({ _index: index, _id: id, _score: 1, _source: doc });
            }
            res.writeHead(200);
            res.end(JSON.stringify({
              hits: { total: { value: hits.length, relation: "eq" }, hits },
            }));
          } else if (path.match(/^\/[^/]+\/_doc\/[^/]+$/) && req.method === "DELETE") {
            // Delete document
            const [, index, , id] = path.split("/");
            const idx = this.indices.get(index);
            if (idx) idx.docs.delete(id);
            res.writeHead(200);
            res.end(JSON.stringify({ result: "deleted" }));
          } else if (path.match(/^\/[^/]+$/) && req.method === "DELETE") {
            // Delete index
            const index = path.slice(1);
            this.indices.delete(index);
            res.writeHead(200);
            res.end(JSON.stringify({ acknowledged: true }));
          } else if (path.match(/^\/_bulk$/) && req.method === "POST") {
            // Bulk operations
            const lines = body.split("\n").filter(Boolean);
            const items = [];
            for (let i = 0; i < lines.length; i += 2) {
              const action = JSON.parse(lines[i]);
              const doc = lines[i + 1] ? JSON.parse(lines[i + 1]) : null;
              if (action.index) {
                const index = action.index._index;
                const id = action.index._id || randomBytes(8).toString("hex");
                if (!this.indices.has(index)) {
                  this.indices.set(index, { docs: new Map(), mappings: {} });
                }
                this.indices.get(index).docs.set(id, doc);
                items.push({ index: { _index: index, _id: id, status: 201 } });
              }
            }
            res.writeHead(200);
            res.end(JSON.stringify({ took: 1, errors: false, items }));
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: { type: "not_found" } }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: { type: "internal_error", reason: e.message } }));
        }
      });

      this.server.listen(this.port, () => {
        console.log(`Elasticsearch server running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }
}
