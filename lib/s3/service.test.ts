// @vitest-environment node

import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AllowedBucketError,
  ArchiveLimitError,
  InvalidArchiveSelectionError,
  ObjectTooLargeError,
  PreviewNotSupportedError,
  createS3Service
} from "@/lib/s3/service";

const send = vi.fn();
const service = createS3Service({
  client: { send },
  allowedBuckets: ["reports"],
  objectMaxBytes: 500 * 1024 * 1024
});

beforeEach(() => {
  send.mockReset();
});

describe("S3 service", () => {
  it("rejects calls to buckets outside the configured allowlist", async () => {
    await expect(service.listObjects("not-approved", "", undefined)).rejects.toThrow(AllowedBucketError);
    expect(send).not.toHaveBeenCalled();
  });

  it("normalizes paginated S3 listing data", async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: "reports/january.pdf", Size: 12, LastModified: new Date("2026-01-01") }],
      CommonPrefixes: [{ Prefix: "reports/" }],
      NextContinuationToken: "next"
    });

    await expect(service.listObjects("reports", "reports/", "current")).resolves.toEqual({
      objects: [{ key: "reports/january.pdf", size: 12, lastModified: "2026-01-01T00:00:00.000Z" }],
      prefixes: ["reports/"],
      nextContinuationToken: "next"
    });
    expect(send).toHaveBeenLastCalledWith(expect.any(ListObjectsV2Command));
  });

  it("asks S3 for immediate prefixes so folder markers are not listed as objects", async () => {
    send.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: "hello/" }] });

    await expect(service.listObjects("reports", "", undefined)).resolves.toMatchObject({
      objects: [],
      prefixes: ["hello/"],
    });

    expect((send.mock.calls.at(-1)?.[0] as ListObjectsV2Command).input).toMatchObject({
      Bucket: "reports",
      Delimiter: "/",
      Prefix: "",
    });
  });

  it("streams downloads as attachments with no-sniff headers", async () => {
    const body = Readable.from("report");
    send.mockResolvedValueOnce({ Body: body, ContentType: "application/pdf", ContentLength: 6 });

    const download = await service.getObject("reports", "reports/january.pdf");

    expect(download.headers).toMatchObject({
      "Content-Disposition": 'attachment; filename="january.pdf"',
      "X-Content-Type-Options": "nosniff"
    });
    expect(download.body).toBe(body);
    expect(send).toHaveBeenLastCalledWith(expect.any(GetObjectCommand));
  });

  it("rejects oversized uploads before creating an S3 command", async () => {
    await expect(
      service.putObject("reports", "reports/large.bin", Readable.from("data"), "application/octet-stream", 500 * 1024 * 1024 + 1)
    ).rejects.toThrow(ObjectTooLargeError);
    expect(send).not.toHaveBeenCalledWith(expect.any(PutObjectCommand));
  });

  it("uses a conditional S3 write unless overwrite was explicitly requested", async () => {
    send.mockResolvedValue({});
    await service.putObject("reports", "reports/new.txt", Readable.from("data"), "text/plain", 4);
    expect((send.mock.calls.at(-1)?.[0] as PutObjectCommand).input).toMatchObject({ IfNoneMatch: "*" });

    await service.putObject("reports", "reports/new.txt", Readable.from("data"), "text/plain", 4, true);
    expect((send.mock.calls.at(-1)?.[0] as PutObjectCommand).input).toMatchObject({ IfNoneMatch: undefined });
  });

  it("rejects prefix archives that exceed limits before fetching object bodies", async () => {
    const limitedService = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 500 * 1024 * 1024,
      archiveMaxObjects: 1
    });
    send.mockResolvedValueOnce({ Contents: [{ Key: "one.txt", Size: 1 }, { Key: "two.txt", Size: 1 }] });

    await expect(limitedService.getPrefixArchive("reports", "")).rejects.toThrow(ArchiveLimitError);
    expect(send).toHaveBeenLastCalledWith(expect.any(ListObjectsV2Command));
  });

  it("creates a ZIP archive for objects under a prefix", async () => {
    send.mockResolvedValueOnce({ Contents: [{ Key: "reports/january.txt", Size: 6 }] });
    send.mockResolvedValueOnce({ Body: Readable.from("report") });

    const archive = await service.getPrefixArchive("reports", "reports/");

    expect(archive.objectCount).toBe(1);
    expect(archive.totalSize).toBe(6);

    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it("searches full keys across pages case-insensitively and flags a page bound", async () => {
    const bounded = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1,
      searchMaxResults: 5,
      searchMaxPages: 1
    });
    send.mockResolvedValueOnce({ Contents: [{ Key: "2026/Annual-REPORT.pdf", Size: 8 }], NextContinuationToken: "next" });

    await expect(bounded.searchObjects("reports", "report")).resolves.toEqual({
      objects: [{ key: "2026/Annual-REPORT.pdf", size: 8, lastModified: undefined }],
      truncated: true
    });
    expect((send.mock.calls[0][0] as ListObjectsV2Command).input).not.toHaveProperty("Delimiter");
  });

  it("searches full keys across configured pages", async () => {
    const bounded = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1,
      searchMaxResults: 5,
      searchMaxPages: 2
    });
    send.mockResolvedValueOnce({ Contents: [{ Key: "2026/Annual-REPORT.pdf", Size: 8 }], NextContinuationToken: "next" });
    send.mockResolvedValueOnce({ Contents: [{ Key: "2026/summary.txt", Size: 3 }, { Key: "2025/Report.csv", Size: 2 }] });

    await expect(bounded.searchObjects("reports", " report ")).resolves.toEqual({
      objects: [
        { key: "2026/Annual-REPORT.pdf", size: 8, lastModified: undefined },
        { key: "2025/Report.csv", size: 2, lastModified: undefined }
      ],
      truncated: false
    });
    expect((send.mock.calls[1][0] as ListObjectsV2Command).input).toMatchObject({ ContinuationToken: "next" });
  });

  it("flags results as truncated and stops fetching when it reaches the result bound", async () => {
    const bounded = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1,
      searchMaxResults: 1,
      searchMaxPages: 5
    });
    send.mockResolvedValueOnce({
      Contents: [{ Key: "reports/one.pdf", Size: 1 }, { Key: "reports/two.pdf", Size: 2 }],
      NextContinuationToken: "next"
    });

    await expect(bounded.searchObjects("reports", "reports")).resolves.toEqual({
      objects: [{ key: "reports/one.pdf", size: 1, lastModified: undefined }],
      truncated: true
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty search query before querying S3", async () => {
    await expect(service.searchObjects("reports", "   ")).rejects.toThrow("Search query is required");
    expect(send).not.toHaveBeenCalled();
  });

  it("serves a server-verified PDF preview inline but rejects SVG", async () => {
    send.mockResolvedValueOnce({ Body: Readable.from("pdf"), ContentType: "application/pdf" });

    await expect(service.getPreviewObject("reports", "report.pdf")).resolves.toMatchObject({
      headers: {
        "Content-Disposition": 'inline; filename="report.pdf"',
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      }
    });

    send.mockResolvedValueOnce({ Body: Readable.from("svg"), ContentType: "image/svg+xml" });
    await expect(service.getPreviewObject("reports", "diagram.svg")).rejects.toThrow(PreviewNotSupportedError);

    send.mockResolvedValueOnce({ ContentType: "image/svg+xml" });
    await expect(service.getPreviewObject("reports", "missing-body.svg")).rejects.toThrow(PreviewNotSupportedError);
  });

  it("rejects duplicate selected keys before fetching an archive body", async () => {
    await expect(service.getSelectedArchive("reports", ["one.pdf", "one.pdf"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unsafe selected keys before fetching object metadata", async () => {
    await expect(service.getSelectedArchive("reports", ["unsafe\u0000.pdf"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an empty selected archive before fetching object metadata", async () => {
    await expect(service.getSelectedArchive("reports", [])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects selected archive count limits before fetching object metadata", async () => {
    const limitedService = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1,
      archiveMaxObjects: 1
    });

    await expect(limitedService.getSelectedArchive("reports", ["one.pdf", "two.pdf"])).rejects.toThrow(ArchiveLimitError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects selected archive byte limits before fetching object bodies", async () => {
    const limitedService = createS3Service({
      client: { send },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1,
      archiveMaxBytes: 10
    });
    send.mockResolvedValueOnce({ ContentLength: 5 });
    send.mockResolvedValueOnce({ ContentLength: 6 });

    await expect(limitedService.getSelectedArchive("reports", ["one.pdf", "two.pdf"])).rejects.toThrow(ArchiveLimitError);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([command]) => command)).toEqual([expect.any(HeadObjectCommand), expect.any(HeadObjectCommand)]);
  });

  it("streams a ZIP of exactly the selected object keys", async () => {
    const keys = ["reports/one.txt", "reports/nested/two.txt"];
    send.mockResolvedValueOnce({ ContentLength: 3 });
    send.mockResolvedValueOnce({ ContentLength: 4 });
    send.mockResolvedValueOnce({ Body: Readable.from("one") });
    send.mockResolvedValueOnce({ Body: Readable.from("four") });

    const archive = await service.getSelectedArchive("reports", keys);

    expect(archive.objectCount).toBe(2);
    expect(archive.totalSize).toBe(7);
    expect(
      send.mock.calls
        .map(([command]) => command)
        .filter((command): command is GetObjectCommand => command instanceof GetObjectCommand)
        .map((command) => command.input.Key)
    ).toEqual(keys);
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      expect.any(HeadObjectCommand),
      expect.any(HeadObjectCommand),
      expect.any(GetObjectCommand),
      expect.any(GetObjectCommand)
    ]);

    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });
});
