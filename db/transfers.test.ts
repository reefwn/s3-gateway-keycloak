// @vitest-environment node

import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { transferRepository } from "@/db/transfers";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://s3_browser:s3_browser@localhost:5433/s3_browser";
process.env.DATABASE_URL = databaseUrl;

const client = new Client({ connectionString: databaseUrl });
await client.connect();

beforeEach(async () => {
  await client.query("DELETE FROM active_transfers");
  await client.query("DELETE FROM audit_events");
});

afterAll(async () => {
  await client.end();
});

describe("transferRepository", () => {
  it("caps each actor at five simultaneous transfers of the same type", async () => {
    const leases = await Promise.all(
      Array.from({ length: 5 }, () =>
        transferRepository.acquire({ actorSub: "user-123", type: "upload", limit: 5 })
      )
    );
    const sixth = await transferRepository.acquire({ actorSub: "user-123", type: "upload", limit: 5 });

    expect(leases.every((lease) => lease.granted)).toBe(true);
    expect(sixth).toMatchObject({ granted: false });
  });

  it("tracks upload and download limits independently and releases a completed lease", async () => {
    const upload = await transferRepository.acquire({ actorSub: "user-123", type: "upload", limit: 1 });
    const download = await transferRepository.acquire({ actorSub: "user-123", type: "download", limit: 1 });

    expect(upload.granted).toBe(true);
    expect(download.granted).toBe(true);

    if (!upload.granted) throw new Error("Expected upload lease");
    await transferRepository.release(upload.id);

    await expect(
      transferRepository.acquire({ actorSub: "user-123", type: "upload", limit: 1 })
    ).resolves.toMatchObject({ granted: true });
  });

  it("removes expired leases before evaluating a new request", async () => {
    const now = new Date("2026-08-06T00:00:00.000Z");
    const initial = await transferRepository.acquire({
      actorSub: "user-123",
      type: "download",
      limit: 1,
      now
    });

    expect(initial.granted).toBe(true);
    await transferRepository.cleanupExpired(new Date("2026-08-06T00:06:00.000Z"));

    await expect(
      transferRepository.acquire({ actorSub: "user-123", type: "download", limit: 1, now: new Date("2026-08-06T00:06:00.000Z") })
    ).resolves.toMatchObject({ granted: true });
  });
});
