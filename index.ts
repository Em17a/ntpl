import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL 环境变量未设置");
export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 5),
});
export const db = drizzle(pool, { schema });

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_active_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS room_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      room_code text NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      nickname text NOT NULL,
      joined_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      left_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members(room_code);
    CREATE TABLE IF NOT EXISTS messages (
      id serial PRIMARY KEY,
      room_code text NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      member_id uuid,
      nickname text NOT NULL DEFAULT '',
      kind text NOT NULL DEFAULT 'chat',
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_room_id_idx ON messages(room_code, id);
  `);
}
