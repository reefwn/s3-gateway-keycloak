import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/db/schema";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error("DATABASE_URL is required for database access");
    }

    pool = new Pool({ connectionString, max: 10 });
  }

  return pool;
}

export function getDatabase() {
  return drizzle(getPool(), { schema });
}
