import { KafkaServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "9092");

const server = new KafkaServer(PORT);

server.start().then(() => {
  console.log(`Kafka service ready on port ${PORT}`);
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
