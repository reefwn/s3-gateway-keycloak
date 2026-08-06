import { describe, expect, it, vi } from "vitest";

import { AuditOutcomePersistenceError, beginAuditedStream, runAuditedOperation } from "@/lib/operations/with-audit";

const context = {
  actorSub: "user-123",
  action: "upload",
  bucket: "uploads",
  objectKey: "report.pdf",
  correlationId: "request-123"
};

describe("runAuditedOperation", () => {
  it("does not invoke an operation when its audit attempt cannot be persisted", async () => {
    const operation = vi.fn();
    const audit = {
      writeAttempt: vi.fn().mockRejectedValue(new Error("database unavailable")),
      writeOutcome: vi.fn()
    };

    await expect(runAuditedOperation({ audit, context }, operation)).rejects.toThrow("database unavailable");
    expect(operation).not.toHaveBeenCalled();
  });

  it("records a successful outcome after an operation completes", async () => {
    const audit = {
      writeAttempt: vi.fn().mockResolvedValue({ id: "attempt-123" }),
      writeOutcome: vi.fn().mockResolvedValue({ id: "outcome-123" })
    };

    await expect(runAuditedOperation({ audit, context }, async () => "uploaded")).resolves.toBe("uploaded");
    expect(audit.writeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt-123", outcome: "success", context })
    );
  });

  it("records a failure outcome when an operation throws", async () => {
    const audit = {
      writeAttempt: vi.fn().mockResolvedValue({ id: "attempt-123" }),
      writeOutcome: vi.fn().mockResolvedValue({ id: "outcome-123" })
    };

    await expect(
      runAuditedOperation({ audit, context }, async () => {
        throw new TypeError("S3 unavailable");
      })
    ).rejects.toThrow("S3 unavailable");
    expect(audit.writeOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", errorClass: "TypeError" })
    );
  });

  it("surfaces a persistence error if the operation succeeded but its outcome cannot be audited", async () => {
    const audit = {
      writeAttempt: vi.fn().mockResolvedValue({ id: "attempt-123" }),
      writeOutcome: vi.fn().mockRejectedValue(new Error("database unavailable"))
    };

    await expect(runAuditedOperation({ audit, context }, async () => "uploaded")).rejects.toThrow(
      AuditOutcomePersistenceError
    );
  });
});

describe("beginAuditedStream", () => {
  it("records the terminal stream outcome once, with optional audit details", async () => {
    const audit = {
      writeAttempt: vi.fn().mockResolvedValue({ id: "attempt-stream" }),
      writeOutcome: vi.fn().mockResolvedValue({ id: "outcome-stream" })
    };

    const stream = await beginAuditedStream({ audit, context }, async () => "stream");
    await stream.recordOutcome(undefined, { objectCount: 2, totalSize: 42 });
    await stream.recordOutcome(new Error("ignored"));

    expect(audit.writeOutcome).toHaveBeenCalledTimes(1);
    expect(audit.writeOutcome).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: "attempt-stream",
      outcome: "success",
      context: { ...context, details: { objectCount: 2, totalSize: 42 } }
    }));
  });
});
