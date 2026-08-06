import "server-only";

import { randomUUID } from "node:crypto";

import { auditEvents } from "@/db/schema";
import { getDatabase } from "@/db/client";

export type AuditContext = Readonly<{
  actorSub: string;
  username?: string | null;
  email?: string | null;
  action: string;
  bucket?: string | null;
  objectKey?: string | null;
  prefix?: string | null;
  details?: Record<string, string | number | boolean | null> | null;
  correlationId: string;
  sourceIp?: string | null;
  userAgent?: string | null;
}>;

export type AuditOutcome = "success" | "failure" | "unknown";

export const auditRepository = {
  async writeAttempt(context: AuditContext) {
    const [event] = await getDatabase()
      .insert(auditEvents)
      .values({ id: randomUUID(), eventKind: "attempt", ...context })
      .returning();

    return event;
  },

  async writeOutcome(input: Readonly<{
    attemptId: string;
    outcome: AuditOutcome;
    errorClass?: string;
    context: AuditContext;
  }>) {
    const [event] = await getDatabase()
      .insert(auditEvents)
      .values({
        id: randomUUID(),
        attemptId: input.attemptId,
        eventKind: "outcome",
        outcome: input.outcome,
        errorClass: input.errorClass,
        ...input.context
      })
      .returning();

    return event;
  }
};
