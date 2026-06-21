import { MongodbServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "27017");

const server = new MongodbServer(PORT);

server.start().then(() => {
  console.log(`parlel mongodb service ready on port ${PORT}`);
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
