const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");

const app = express();

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "postgres",
  port: Number(process.env.DB_PORT || 5432),
});

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
});

app.get("/api/users", async (req, res) => {
  let db;

  try {
    db = await pool.connect();
    const result = await db.query("SELECT NOW() AS now");
    const now = result.rows[0].now;

    // Keep one source of truth for time: database time.
    await redis.set("last_call", now.toISOString());

    res.json({ ok: true, time: { now: now.toISOString() } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (db) {
      db.release();
    }
  }
});

app.get("/status", (req, res) => {
  res.json({ status: "ok" });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API running on ${port}`));
