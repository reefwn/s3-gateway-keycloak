// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  class AuditOutcomePersistenceError extends Error {}

  return {
    AccessDeniedError,
    AuditOutcomePersistenceError,
    actor: { sub: "operator-123", username: "operator", email: "operator@example.test", role: "readonly" },
    auditRepository: { writeAttempt: vi.fn(), writeOutcome: vi.fn() },
    getCurrentActor: vi.fn(),
    requireCapability: vi.fn(),
    loadConfig: vi.fn(),
    getS3Service: vi.fn(),
    transferAcquire: vi.fn(),
    transferRelease: vi.fn(),
    assertTrustedMutationOrigin: vi.fn(),
    runAuditedOperation: vi.fn(),
    service: { listObjects: vi.fn(), searchObjects: vi.fn(), createPrefixMarker: vi.fn(), putObject: vi.fn() }
  };
});

vi.mock("@/db/audit", () => ({ auditRepository: mocks.auditRepository }));
vi.mock("@/db/transfers", () => ({ transferRepository: { acquire: mocks.transferAcquire, release: mocks.transferRelease } }));
vi.mock("@/lib/auth/require", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  getCurrentActor: mocks.getCurrentActor,
  requireCapability: mocks.requireCapability
}));
vi.mock("@/lib/config", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("@/lib/operations/with-audit", () => ({
  AuditOutcomePersistenceError: mocks.AuditOutcomePersistenceError,
  runAuditedOperation: mocks.runAuditedOperation
}));
vi.mock("@/lib/security/origin", () => ({ assertTrustedMutationOrigin: mocks.assertTrustedMutationOrigin }));
vi.mock("@/lib/s3/client", () => ({ getS3Service: mocks.getS3Service }));

import { GET, POST } from "@/app/api/objects/[bucket]/route";

const context = { params: Promise.resolve({ bucket: "reports" }) };

describe("GET /api/objects/[bucket]", () => {
  beforeEach(() => {
    mocks.getCurrentActor.mockReset();
    mocks.requireCapability.mockReset();
    mocks.loadConfig.mockReset();
    mocks.getS3Service.mockReset();
    mocks.transferAcquire.mockReset();
    mocks.transferRelease.mockReset();
    mocks.assertTrustedMutationOrigin.mockReset();
    mocks.runAuditedOperation.mockReset();
    mocks.service.listObjects.mockReset();
    mocks.service.searchObjects.mockReset();
    mocks.service.createPrefixMarker.mockReset();
    mocks.service.putObject.mockReset();

    mocks.requireCapability.mockResolvedValue(mocks.actor);
    mocks.getS3Service.mockReturnValue(mocks.service);
    mocks.loadConfig.mockReturnValue({ applicationOrigin: "https://app.test", transferLimit: 3 });
    mocks.transferAcquire.mockResolvedValue({ granted: true, id: "upload-lease" });
    mocks.runAuditedOperation.mockImplementation(async (_input: unknown, operation: () => Promise<unknown>) => operation());
  });

  it("audits a bucket search and returns its bounded result without caching", async () => {
    mocks.service.searchObjects.mockResolvedValue({ objects: [{ key: "2026/report.pdf", size: 4 }], truncated: false });

    const response = await GET(new Request("https://app.test/api/objects/reports?search=report"), context);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ objects: [{ key: "2026/report.pdf" }], truncated: false });
    expect(mocks.requireCapability).toHaveBeenCalledWith("list");
    expect(mocks.service.searchObjects).toHaveBeenCalledWith("reports", "report");
    expect(mocks.runAuditedOperation).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: "search-objects", bucket: "reports", prefix: "report" }) }),
      expect.any(Function)
    );
  });

  it("keeps a prefix listing when search is absent", async () => {
    mocks.service.listObjects.mockResolvedValue({ objects: [], prefixes: ["2026/"], nextContinuationToken: "next" });

    const response = await GET(new Request("https://app.test/api/objects/reports?prefix=2026%2F&continuationToken=next"), context);

    expect(response.status).toBe(200);
    expect(mocks.service.listObjects).toHaveBeenCalledWith("reports", "2026/", "next");
    expect(mocks.service.searchObjects).not.toHaveBeenCalled();
    expect(mocks.runAuditedOperation).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: "list-objects", objectKey: "2026/" }) }),
      expect.any(Function)
    );
  });

  it("keeps a prefix listing when search is blank", async () => {
    mocks.service.listObjects.mockResolvedValue({ objects: [], prefixes: [], nextContinuationToken: undefined });

    const response = await GET(new Request("https://app.test/api/objects/reports?search=%20%20%20&prefix=2026%2F"), context);

    expect(response.status).toBe(200);
    expect(mocks.service.listObjects).toHaveBeenCalledWith("reports", "2026/", undefined);
    expect(mocks.service.searchObjects).not.toHaveBeenCalled();
  });

  it("does not query S3 when recording the search attempt fails", async () => {
    mocks.runAuditedOperation.mockRejectedValueOnce(new Error("audit unavailable"));

    const response = await GET(new Request("https://app.test/api/objects/reports?search=report"), context);

    expect(response.status).toBe(500);
    expect(mocks.service.searchObjects).not.toHaveBeenCalled();
  });

  it("hides a search from an actor without list capability", async () => {
    mocks.requireCapability.mockRejectedValueOnce(new mocks.AccessDeniedError());

    const response = await GET(new Request("https://app.test/api/objects/reports?search=report"), context);

    expect(response.status).toBe(404);
    expect(mocks.service.searchObjects).not.toHaveBeenCalled();
  });

  it("does not expose the query in search error responses", async () => {
    mocks.service.searchObjects.mockRejectedValueOnce(new Error("private-report query failed"));

    const response = await GET(new Request("https://app.test/api/objects/reports?search=private-report"), context);

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-report");
  });

  it("preserves create-prefix authorization and audit context", async () => {
    const form = new FormData();
    form.set("action", "create-prefix");
    form.set("prefix", "2026/");

    const response = await POST(new Request("https://app.test/api/objects/reports", { method: "POST", body: form }), context);

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.requireCapability).toHaveBeenCalledWith("createPrefix");
    expect(mocks.service.createPrefixMarker).toHaveBeenCalledWith("reports", "2026/");
    expect(mocks.runAuditedOperation).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ action: "create-prefix", objectKey: "2026/" }) }),
      expect.any(Function)
    );
    expect(mocks.transferAcquire).not.toHaveBeenCalled();
  });

  it("preserves upload authorization, stream contents, and lease release", async () => {
    const form = new FormData();
    form.set("key", "2026/report.txt");
    form.set("file", new File(["report"], "report.txt", { type: "text/plain" }));
    let uploaded = "";
    mocks.service.putObject.mockImplementation(async (_bucket, _key, stream) => {
      for await (const chunk of stream) uploaded += chunk.toString();
    });

    const response = await POST(new Request("https://app.test/api/objects/reports", { method: "POST", body: form }), context);

    expect(response.status).toBe(201);
    expect(uploaded).toBe("report");
    expect(mocks.requireCapability).toHaveBeenCalledWith("upload");
    expect(mocks.transferAcquire).toHaveBeenCalledWith({ actorSub: "operator-123", type: "upload", limit: 3 });
    expect(mocks.transferRelease).toHaveBeenCalledExactlyOnceWith("upload-lease");
  });
});
