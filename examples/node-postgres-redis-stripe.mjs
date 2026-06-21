// Example: a tiny order flow against three local Parlel services.
//
// Start the services first:
//   SERVICES="postgres,redis,stripe" docker compose up
//   # or, without Docker:
//   SERVICES="postgres,redis,stripe" node ../src/launch.mjs
//
// Then run this with the real drivers installed (npm i pg redis stripe):
//   node examples/node-postgres-redis-stripe.mjs
//
// Nothing here knows about Parlel — it's plain pg / redis / stripe pointed at
// localhost. The exact same code runs against real Postgres/Redis/Stripe in
// production; only the connection URLs change.

import pg from "pg";
import { createClient } from "redis";
import Stripe from "stripe";

const db = new pg.Client("postgres://parlel:parlel@localhost:5432/parlel");
const cache = createClient({ url: "redis://localhost:6379" });
const stripe = new Stripe("sk_test_parlel", { host: "localhost", port: 4757, protocol: "http" });

await db.connect();
await cache.connect();

// 1. Postgres — create a table + insert an order.
await db.query("CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, email TEXT, amount_cents INT)");
const { rows } = await db.query(
  "INSERT INTO orders (email, amount_cents) VALUES ($1, $2) RETURNING *",
  ["ada@example.com", 4200],
);
const order = rows[0];
console.log("order created:", order);

// 2. Stripe — charge for it.
const intent = await stripe.paymentIntents.create({
  amount: order.amount_cents,
  currency: "usd",
  description: `order ${order.id}`,
});
console.log("payment intent:", intent.id, intent.status);

// 3. Redis — cache the result.
await cache.set(`order:${order.id}`, JSON.stringify({ ...order, payment: intent.id }));
console.log("cached:", await cache.get(`order:${order.id}`));

await db.end();
await cache.quit();
console.log("\n✓ all three services worked locally — no accounts, no cost.");
