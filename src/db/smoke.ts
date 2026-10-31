import { pool, initDb } from "./client.js";

await initDb();

await pool.query(
  `INSERT INTO companies (name, name_normalized, funding_round, funding_date)
   VALUES ($1, $2, $3, $4)
   ON CONFLICT (name_normalized, funding_date) DO NOTHING`,
  ["Test Startup", "test startup", "Seed", "2026-10-30"]
);

const { rows } = await pool.query("SELECT id, name, status FROM companies");
console.log(rows);

await pool.end();