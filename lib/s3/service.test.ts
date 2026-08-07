// @vitest-environment node

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { AllowedBucketError, ArchiveLimitError, ObjectTooLargeError, createS3Service } from "@/lib/s3/service";

const send = vi.fn();
const service = createS3Service({
  client: { send },
  allowedBuckets: ["reports"],
  objectMaxBytes: 500 * 1024 * 1024
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
      objects: [{ key: "reports/january.pdf", size: 12, lastModified: new Date("2026-01-01") }],
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
});
