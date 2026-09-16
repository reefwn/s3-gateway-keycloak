// @vitest-environment node

import { PassThrough, Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  class AuditOutcomePersistenceError extends Error {}

  return {
    AccessDeniedError,
    AuditOutcomePersistenceError,
    actor: { sub: "operator-123", username: "operator", email: "operator@example.test", role: "readonly" },
    auditRepository: { writeAttempt: vi.fn(), writeOutcome: vi.fn() },
    requireCapability: vi.fn(),
    loadConfig: vi.fn(),
    getS3Service: vi.fn(),
    transferAcquire: vi.fn(),
    transferRelease: vi.fn(),
    beginAuditedStream: vi.fn(),
    recordOutcome: vi.fn(),
    service: { getPreviewObject: vi.fn() }
  };
});

vi.mock("@/db/audit", () => ({ auditRepository: mocks.auditRepository }));
vi.mock("@/db/transfers", () => ({ transferRepository: { acquire: mocks.transferAcquire, release: mocks.transferRelease } }));
vi.mock("@/lib/auth/require", () => ({ AccessDeniedError: mocks.AccessDeniedError, requireCapability: mocks.requireCapability }));
vi.mock("@/lib/config", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("@/lib/operations/with-audit", () => ({
  AuditOutcomePersistenceError: mocks.AuditOutcomePersistenceError,
  beginAuditedStream: mocks.beginAuditedStream
}));
vi.mock("@/lib/s3/client", () => ({ getS3Service: mocks.getS3Service }));

import { GET } from "@/app/api/object-preview/[bucket]/[...key]/route";

const context = { params: Promise.resolve({ bucket: "reports", key: ["2026", "report.pdf"] }) };

describe("GET /api/object-preview/[bucket]/[...key]", () => {
  beforeEach(() => {
    mocks.requireCapability.mockReset();
    mocks.loadConfig.mockReset();
    mocks.getS3Service.mockReset();
    mocks.transferAcquire.mockReset();
    mocks.transferRelease.mockReset();
    mocks.beginAuditedStream.mockReset();
    mocks.recordOutcome.mockReset();
    mocks.service.getPreviewObject.mockReset();

    mocks.requireCapability.mockResolvedValue(mocks.actor);
    mocks.loadConfig.mockReturnValue({ transferLimit: 3 });
    mocks.getS3Service.mockReturnValue(mocks.service);
    mocks.transferAcquire.mockResolvedValue({ granted: true, id: "lease-123", expiresAt: new Date("2026-09-15T00:00:00.000Z") });
    mocks.transferRelease.mockResolvedValue(undefined);
    mocks.recordOutcome.mockResolvedValue(undefined);
    mocks.beginAuditedStream.mockImplementation(async (_input: unknown, operation: () => Promise<unknown>) => ({
      result: await operation(),
      recordOutcome: mocks.recordOutcome
    }));
  });

  it("leases, audits, and returns an inline preview stream", async () => {
    mocks.service.getPreviewObject.mockResolvedValue({
      body: Readable.from([Buffer.from("pdf")]),
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="report.pdf"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="report.pdf"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.requireCapability).toHaveBeenCalledWith("download");
    expect(mocks.transferAcquire).toHaveBeenCalledWith({ actorSub: "operator-123", type: "download", limit: 3 });
    expect(mocks.service.getPreviewObject).toHaveBeenCalledWith("reports", "2026/report.pdf");
    expect(mocks.beginAuditedStream).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: "preview", bucket: "reports", objectKey: "2026/report.pdf" }) }),
      expect.any(Function)
    );

    await response.arrayBuffer();
    await vi.waitFor(() => expect(mocks.recordOutcome).toHaveBeenCalledWith(undefined));
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
  });

  it("does not lease a preview for an actor without download capability", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new mocks.AccessDeniedError());

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.status).toBe(404);
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
    expect(mocks.service.getPreviewObject).not.toHaveBeenCalled();
  });

  it("rejects a preview when the download lease is unavailable", async () => {
    mocks.transferAcquire.mockResolvedValueOnce({ granted: false });

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.status).toBe(429);
    expect(mocks.service.getPreviewObject).not.toHaveBeenCalled();
  });

  it("releases the lease without querying S3 when recording the preview attempt fails", async () => {
    mocks.beginAuditedStream.mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.status).toBe(500);
    expect(mocks.service.getPreviewObject).not.toHaveBeenCalled();
    expect(mocks.transferRelease).toHaveBeenCalledWith("lease-123");
  });

  it("records a preview stream error and releases its lease exactly once", async () => {
    const stream = new PassThrough();
    mocks.service.getPreviewObject.mockResolvedValue({
      body: stream,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="report.pdf"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });

    await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);
    const error = new Error("preview stream failed");
    stream.emit("error", error);
    stream.emit("close");

    await vi.waitFor(() => expect(mocks.recordOutcome).toHaveBeenCalledTimes(1));
    expect(mocks.recordOutcome).toHaveBeenCalledWith(error);
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
  });

  it("records response setup failures and closes the preview without releasing twice", async () => {
    const stream = new PassThrough();
    mocks.service.getPreviewObject.mockResolvedValue({ body: stream, headers: { "Content-Type": "invalid\nheader" } });

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.status).toBe(500);
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(expect.any(TypeError));
    expect(stream.destroyed).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123");
  });

  it("releases the lease when preview creation fails without exposing the key", async () => {
    mocks.service.getPreviewObject.mockRejectedValueOnce(new Error("failed 2026/report.pdf"));

    const response = await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("2026/report.pdf");
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123");
  });

  it("records premature close and releases even if outcome persistence fails", async () => {
    const stream = new PassThrough();
    mocks.service.getPreviewObject.mockResolvedValue({ body: stream, headers: { "Cache-Control": "no-store" } });
    mocks.recordOutcome.mockRejectedValueOnce(new Error("audit unavailable"));
    await GET(new Request("https://app.test/api/object-preview/reports/2026/report.pdf"), context);

    stream.destroy();

    await vi.waitFor(() => expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123"));
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "StreamClosed" }));
  });
});
