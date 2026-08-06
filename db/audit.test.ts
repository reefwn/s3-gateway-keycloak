// @vitest-environment node

import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { auditRepository } from "@/db/audit";

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

describe("auditRepository", () => {
  it("writes immutable attempt and outcome records for an S3 operation", async () => {
    const context = {
      actorSub: "user-123",
      username: "alex",
      email: "alex@example.test",
      action: "download",
      bucket: "reports",
      objectKey: "monthly/report.pdf",
      correlationId: "request-123",
      sourceIp: "127.0.0.1",
      userAgent: "Vitest"
    };
    const attempt = await auditRepository.writeAttempt(context);
    const outcome = await auditRepository.writeOutcome({
      attemptId: attempt.id,
      outcome: "success",
      context
    });

    expect(attempt.eventKind).toBe("attempt");
    expect(outcome.eventKind).toBe("outcome");
    expect(outcome.attemptId).toBe(attempt.id);

    const result = await client.query<{ event_kind: string; object_key: string }>(
      "SELECT event_kind, object_key FROM audit_events ORDER BY created_at"
    );

    expect(result.rows).toEqual([
      { event_kind: "attempt", object_key: "monthly/report.pdf" },
      { event_kind: "outcome", object_key: "monthly/report.pdf" }
    ]);
  });
});
