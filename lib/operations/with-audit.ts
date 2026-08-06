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

export type AuditWriter = Readonly<{
  writeAttempt(context: AuditContext): Promise<{ id: string }>;
  writeOutcome(input: Readonly<{
    attemptId: string;
    outcome: "success" | "failure" | "unknown";
    errorClass?: string;
    context: AuditContext;
  }>): Promise<unknown>;
}>;

export class AuditOutcomePersistenceError extends Error {
  constructor(cause: unknown) {
    super("The completed operation could not be recorded in the audit log", { cause });
    this.name = "AuditOutcomePersistenceError";
  }
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "UnknownError";
}

export async function runAuditedOperation<T>(
  input: Readonly<{ audit: AuditWriter; context: AuditContext }>,
  operation: () => Promise<T>
): Promise<T> {
  const attempt = await input.audit.writeAttempt(input.context);
  let result: T;

  try {
    result = await operation();
  } catch (error) {
    await input.audit.writeOutcome({
      attemptId: attempt.id,
      outcome: "failure",
      errorClass: errorClass(error),
      context: input.context
    });
    throw error;
  }

  try {
    await input.audit.writeOutcome({
      attemptId: attempt.id,
      outcome: "success",
      context: input.context
    });
  } catch (error) {
    throw new AuditOutcomePersistenceError(error);
  }

  return result;
}

/**
 * Records the attempt before a streaming operation starts, then lets the
 * caller record its real terminal outcome when the response stream ends.
 */
export async function beginAuditedStream<T>(
  input: Readonly<{ audit: AuditWriter; context: AuditContext }>,
  operation: () => Promise<T>
): Promise<Readonly<{
  result: T;
  recordOutcome: (error?: unknown, details?: AuditContext["details"]) => Promise<void>;
}>> {
  const attempt = await input.audit.writeAttempt(input.context);
  try {
    const result = await operation();
    let recorded = false;

    return {
      result,
      async recordOutcome(error?: unknown, details?: AuditContext["details"]) {
        if (recorded) return;
        recorded = true;
        await input.audit.writeOutcome({
          attemptId: attempt.id,
          outcome: error ? "failure" : "success",
          errorClass: error ? errorClass(error) : undefined,
          context: { ...input.context, details: details ?? input.context.details }
        });
      }
    };
  } catch (error) {
    await input.audit.writeOutcome({
      attemptId: attempt.id,
      outcome: "failure",
      errorClass: errorClass(error),
      context: input.context
    });
    throw error;
  }
}
