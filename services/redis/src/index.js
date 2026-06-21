import { RedisServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "6379");

const server = new RedisServer(PORT);

server.start().then(() => {
  console.log(`Redis service ready on port ${PORT}`);
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
