import "server-only";

import { randomUUID } from "node:crypto";

import { getPool } from "@/db/client";

const LEASE_DURATION_MS = 5 * 60 * 1000;

export type TransferType = "upload" | "download";

export type TransferLease =
  | Readonly<{ granted: true; id: string; expiresAt: Date }>
  | Readonly<{ granted: false }>;

export const transferRepository = {
  async acquire(input: Readonly<{
    actorSub: string;
    type: TransferType;
    limit: number;
    now?: Date;
  }>): Promise<TransferLease> {
    const now = input.now ?? new Date();
    const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
    const client = await getPool().connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.actorSub}:${input.type}`]);
      await client.query("DELETE FROM active_transfers WHERE expires_at <= $1", [now]);

      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM active_transfers WHERE actor_sub = $1 AND type = $2 AND expires_at > $3",
        [input.actorSub, input.type, now]
      );

      if (Number(active.rows[0]?.count ?? 0) >= input.limit) {
        await client.query("COMMIT");
        return { granted: false };
      }

      const id = randomUUID();
      await client.query(
        "INSERT INTO active_transfers (id, actor_sub, type, expires_at) VALUES ($1, $2, $3, $4)",
        [id, input.actorSub, input.type, expiresAt]
      );
      await client.query("COMMIT");

      return { granted: true, id, expiresAt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },

  async release(id: string): Promise<void> {
    await getPool().query("DELETE FROM active_transfers WHERE id = $1", [id]);
  },

  async cleanupExpired(now = new Date()): Promise<number> {
    const result = await getPool().query("DELETE FROM active_transfers WHERE expires_at <= $1", [now]);

    return result.rowCount ?? 0;
  }
};
