import { PostgresServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "5432");
const USER = process.env.POSTGRES_USER || "parlel";
const PASSWORD = process.env.POSTGRES_PASSWORD || "parlel";
const DATABASE = process.env.POSTGRES_DB || "parlel";

const server = new PostgresServer(PORT, { user: USER, password: PASSWORD, database: DATABASE });

server.start().then(() => {
  console.log(`Postgres service ready on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await server.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await server.stop();
  process.exit(0);
});
