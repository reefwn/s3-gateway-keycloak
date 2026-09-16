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
    assertTrustedMutationOrigin: vi.fn(),
    beginAuditedStream: vi.fn(),
    recordOutcome: vi.fn(),
    service: { getSelectedArchive: vi.fn() }
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
vi.mock("@/lib/security/origin", () => ({ assertTrustedMutationOrigin: mocks.assertTrustedMutationOrigin }));
vi.mock("@/lib/s3/client", () => ({ getS3Service: mocks.getS3Service }));

import { POST } from "@/app/api/selected-download/[bucket]/route";

const context = { params: Promise.resolve({ bucket: "reports" }) };

function selectedRequest(body: unknown): Request {
  return new Request("https://app.test/api/selected-download/reports", {
    method: "POST",
    headers: { Origin: "https://app.test", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/selected-download/[bucket]", () => {
  beforeEach(() => {
    mocks.requireCapability.mockReset();
    mocks.loadConfig.mockReset();
    mocks.getS3Service.mockReset();
    mocks.transferAcquire.mockReset();
    mocks.transferRelease.mockReset();
    mocks.assertTrustedMutationOrigin.mockReset();
    mocks.beginAuditedStream.mockReset();
    mocks.recordOutcome.mockReset();
    mocks.service.getSelectedArchive.mockReset();

    mocks.requireCapability.mockResolvedValue(mocks.actor);
    mocks.loadConfig.mockReturnValue({ applicationOrigin: "https://app.test", transferLimit: 3 });
    mocks.getS3Service.mockReturnValue(mocks.service);
    mocks.transferAcquire.mockResolvedValue({ granted: true, id: "lease-123", expiresAt: new Date("2026-09-15T00:00:00.000Z") });
    mocks.transferRelease.mockResolvedValue(undefined);
    mocks.recordOutcome.mockResolvedValue(undefined);
    mocks.beginAuditedStream.mockImplementation(async (_input: unknown, operation: () => Promise<unknown>) => ({
      result: await operation(),
      recordOutcome: mocks.recordOutcome
    }));
  });

  it("rejects a selected ZIP body that is not a JSON key array", async () => {
    const response = await POST(selectedRequest({ keys: "report.pdf" }), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Select one or more unique objects" });
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { keys: [1] }, { keys: ["report.pdf"], prefix: "private/" }])("rejects malformed selection %j before leasing", async (body) => {
    const response = await POST(selectedRequest(body), context);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON before leasing", async () => {
    const response = await POST(new Request("https://app.test/api/selected-download/reports", { method: "POST", body: "{" }), context);

    expect(response.status).toBe(400);
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
  });

  it("blocks an untrusted origin before acquiring a lease or accessing S3", async () => {
    mocks.assertTrustedMutationOrigin.mockImplementationOnce(() => { throw new Error("untrusted origin"); });

    const response = await POST(selectedRequest({ keys: ["private/report.pdf"] }), context);

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
  });

  it("releases the lease without S3 access when the audit attempt fails", async () => {
    mocks.beginAuditedStream.mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await POST(selectedRequest({ keys: ["private/report.pdf"] }), context);

    expect(response.status).toBe(500);
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123");
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });

  it("releases the lease and hides raw keys when archive creation fails", async () => {
    mocks.service.getSelectedArchive.mockRejectedValueOnce(new Error("Cannot access private/report.pdf"));

    const response = await POST(selectedRequest({ keys: ["private/report.pdf"] }), context);

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("private/report.pdf");
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123");
  });

  it("requires download capability before leasing a selected ZIP", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new mocks.AccessDeniedError());

    const response = await POST(selectedRequest({ keys: ["2026/report.pdf"] }), context);

    expect(response.status).toBe(404);
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
  });

  it("rejects a selected ZIP when the download lease is unavailable", async () => {
    mocks.transferAcquire.mockResolvedValueOnce({ granted: false });

    const response = await POST(selectedRequest({ keys: ["2026/report.pdf"] }), context);

    expect(response.status).toBe(429);
    expect(mocks.service.getSelectedArchive).not.toHaveBeenCalled();
    expect(mocks.beginAuditedStream).not.toHaveBeenCalled();
  });

  it("streams a selected ZIP with a non-sensitive audit prefix", async () => {
    const stream = Readable.from([Buffer.from("zip")]);
    mocks.service.getSelectedArchive.mockResolvedValue({ stream, objectCount: 2, totalSize: 32 });

    const response = await POST(selectedRequest({ keys: ["2026/report.pdf", "2026/summary.pdf"] }), context);

    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="selected-objects.zip"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(mocks.assertTrustedMutationOrigin).toHaveBeenCalledWith(expect.any(Request), "https://app.test");
    expect(mocks.transferAcquire).toHaveBeenCalledWith({ actorSub: "operator-123", type: "download", limit: 3 });
    expect(mocks.service.getSelectedArchive).toHaveBeenCalledWith("reports", ["2026/report.pdf", "2026/summary.pdf"]);
    expect(mocks.beginAuditedStream).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: "selected-download", bucket: "reports", prefix: "selected:2" }) }),
      expect.any(Function)
    );

    await response.arrayBuffer();
    await vi.waitFor(() => expect(mocks.recordOutcome).toHaveBeenCalledWith(undefined, { objectCount: 2, totalSize: 32 }));
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
  });

  it("records selected archive stream failures with archive details only once", async () => {
    const stream = new PassThrough();
    mocks.service.getSelectedArchive.mockResolvedValue({ stream, objectCount: 3, totalSize: 48 });

    await POST(selectedRequest({ keys: ["2026/one.pdf", "2026/two.pdf", "2026/three.pdf"] }), context);
    const error = new Error("archive stream failed");
    stream.emit("error", error);
    stream.emit("close");

    await vi.waitFor(() => expect(mocks.recordOutcome).toHaveBeenCalledTimes(1));
    expect(mocks.recordOutcome).toHaveBeenCalledWith(error, { objectCount: 3, totalSize: 48 });
    expect(mocks.transferRelease).toHaveBeenCalledTimes(1);
  });

  it("records setup failures and closes the archive without releasing twice", async () => {
    const stream = new PassThrough();
    mocks.service.getSelectedArchive.mockResolvedValue({ stream, objectCount: 1, totalSize: 4 });
    const error = new Error("stream conversion failed");
    const conversion = vi.spyOn(Readable, "toWeb").mockImplementationOnce(() => { throw error; });
    let response: Response;
    try {
      response = await POST(selectedRequest({ keys: ["report.pdf"] }), context);
    } finally {
      conversion.mockRestore();
    }

    expect(response.status).toBe(500);
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(error, { objectCount: 1, totalSize: 4 });
    expect(stream.destroyed).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123");
  });

  it("records cancellation as failure and releases even if outcome persistence fails", async () => {
    const stream = new PassThrough();
    mocks.service.getSelectedArchive.mockResolvedValue({ stream, objectCount: 1, totalSize: 4 });
    mocks.recordOutcome.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await POST(selectedRequest({ keys: ["report.pdf"] }), context);

    await response.body!.cancel();

    await vi.waitFor(() => expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("lease-123"));
    expect(mocks.recordOutcome).toHaveBeenCalledExactlyOnceWith(expect.any(Error), { objectCount: 1, totalSize: 4 });
    expect(stream.destroyed).toBe(true);
  });
});
