// @vitest-environment node

import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
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

  it("retains directory entries while streaming safe prefix archives", async () => {
    send.mockResolvedValueOnce({ Contents: [
      { Key: "reports/nested/", Size: 0 }, { Key: "reports/nested/ไทย.txt", Size: 3 }
    ] });
    send.mockResolvedValueOnce({ Body: Readable.from([]) });
    send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("one")]) });
    const archive = await service.getPrefixArchive("reports", "reports/");
    const names: string[] = [];
    archive.stream.on("entry", (entry) => names.push(entry.name));
    for await (const chunk of archive.stream) void chunk;

    expect(names).toEqual(["nested/", "nested/ไทย.txt"]);
    expect(archive.objectCount).toBe(2);
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

  it("does not count folder markers toward the search result limit", async () => {
    const bounded = createS3Service({ client: { send }, allowedBuckets: ["reports"], objectMaxBytes: 1, searchMaxResults: 1 });
    send.mockResolvedValueOnce({ Contents: [{ Key: "reports/", Size: 0 }], NextContinuationToken: "files" });
    send.mockResolvedValueOnce({ Contents: [
      { Key: "reports/nested/", Size: 0 }, { Key: "reports/empty.txt", Size: 0 }
    ] });

    await expect(bounded.searchObjects("reports", "reports")).resolves.toEqual({
      objects: [{ key: "reports/empty.txt", size: 0, lastModified: undefined }], truncated: true
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("omits the current folder marker from selectable listing objects", async () => {
    send.mockResolvedValueOnce({ Contents: [
      { Key: "reports/", Size: 0 }, { Key: "reports/empty.txt", Size: 0 }
    ] });

    await expect(service.listObjects("reports", "reports/", undefined)).resolves.toMatchObject({
      objects: [{ key: "reports/empty.txt", size: 0 }]
    });
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

  it.each(["getPreviewObject", "getObject"] as const)("constructs usable Unicode filename headers for %s", async (method) => {
    send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("pdf")]), ContentType: "application/pdf" });
    const result = await service[method]("reports", "reports/ไทย 📄.pdf");
    const response = new Response(Readable.toWeb(result.body as Readable) as ReadableStream, { headers: result.headers });
    const disposition = response.headers.get("Content-Disposition")!;

    expect(disposition).toMatch(/filename="[\x20-\x7e]+"/);
    expect(disposition).toContain("filename*=UTF-8''%E0%B9%84%E0%B8%97%E0%B8%A2%20%F0%9F%93%84.pdf");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("pdf");
  });

  it("encodes quoted and RFC 5987 reserved filename characters in preview headers", async () => {
    send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("pdf")]), ContentType: "application/pdf" });
    const result = await service.getPreviewObject("reports", 'reports/ไทย "draft" (a)*\'.pdf');
    const response = new Response(Readable.toWeb(result.body as Readable) as ReadableStream, { headers: result.headers });

    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E0%B9%84%E0%B8%97%E0%B8%A2%20%22draft%22%20%28a%29%2A%27.pdf");
    expect(await response.text()).toBe("pdf");
  });

  it("destroys rejected preview bodies before reporting an unsupported media type", async () => {
    const rejectedBody = Readable.from([Buffer.alloc(128 * 1024)]);
    const destroy = vi.spyOn(rejectedBody, "destroy");
    send.mockResolvedValueOnce({ Body: rejectedBody, ContentType: "image/svg+xml" });

    await expect(service.getPreviewObject("reports", "diagram.svg")).rejects.toThrow(PreviewNotSupportedError);
    expect(destroy).toHaveBeenCalledOnce();
    expect(rejectedBody.destroyed).toBe(true);
  });

  it("cancels rejected web preview bodies", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    send.mockResolvedValueOnce({ Body: body, ContentType: "text/html" });

    await expect(service.getPreviewObject("reports", "page.html")).rejects.toThrow(PreviewNotSupportedError);
    expect(cancelled).toBe(true);
  });

  it("rejects duplicate selected keys before fetching an archive body", async () => {
    await expect(service.getSelectedArchive("reports", ["one.pdf", "one.pdf"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unsafe selected keys before fetching object metadata", async () => {
    await expect(service.getSelectedArchive("reports", ["unsafe\u0000.pdf"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "../outside.txt", "nested/../../outside.txt", "/absolute.txt", "C:/absolute.txt",
    "C:relative.txt", "nested\\outside.txt", "nested/./file.txt", "nested//file.txt", "folder/",
    "nested/.. /outside.txt", "nested/file.txt.", "nested/file.txt "
  ])("rejects unsafe archive entry %j before fetching metadata", async (key) => {
    send.mockImplementation(async (command) => command instanceof HeadObjectCommand
      ? { ContentLength: 0 } : { Body: Readable.from([]) });
    await expect(service.getSelectedArchive("reports", [key])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["folder/file.txt", "folder\\file.txt"],
    ["café.txt", "cafe\u0301.txt"],
    ["REPORT.txt", "report.txt"]
  ])("rejects colliding archive entries %j and %j before fetching metadata", async (first, second) => {
    send.mockImplementation(async (command) => command instanceof HeadObjectCommand
      ? { ContentLength: 0 } : { Body: Readable.from([]) });
    await expect(service.getSelectedArchive("reports", [first, second])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects selected archive file entries that are ancestors of another entry before fetching metadata", async () => {
    await expect(service.getSelectedArchive("reports", ["folder", "folder/file.txt"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects prefix archive file entries that are ancestors of another entry before fetching bodies", async () => {
    send.mockResolvedValueOnce({ Contents: [
      { Key: "reports/folder", Size: 1 }, { Key: "reports/folder/file.txt", Size: 1 }
    ] });

    await expect(service.getPrefixArchive("reports", "reports/")).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.any(ListObjectsV2Command));
  });

  it.each(["../../outside.txt", "bad\nfile.txt"])("rejects unsafe prefix archive name %j before fetching any bodies", async (name) => {
    send.mockResolvedValueOnce({ Contents: [
      { Key: "reports/safe.txt", Size: 1 }, { Key: `reports/${name}`, Size: 1 }
    ] });
    send.mockImplementation(async () => ({ Body: Readable.from("x") }));

    await expect(service.getPrefixArchive("reports", "reports/")).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send.mock.calls.every(([command]) => command instanceof ListObjectsV2Command)).toBe(true);
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

    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);

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
  });

  it.each(["selected", "prefix"] as const)("aborts a %s archive when overwritten objects exceed the actual byte budget", async (kind) => {
    const limitedService = createS3Service({ client: { send }, allowedBuckets: ["reports"], objectMaxBytes: 1, archiveMaxBytes: 5 });
    const firstBody = Readable.from([Buffer.from("123")]);
    const overwrittenBody = Readable.from([Buffer.from("45"), Buffer.from("6")]);
    if (kind === "selected") {
      send.mockResolvedValueOnce({ ContentLength: 1 });
      send.mockResolvedValueOnce({ ContentLength: 1 });
      send.mockResolvedValueOnce({ ContentLength: 1 });
    } else {
      send.mockResolvedValueOnce({ Contents: [
        { Key: "first.txt", Size: 1 }, { Key: "overwritten.txt", Size: 1 }, { Key: "queued.txt", Size: 1 }
      ] });
    }
    send.mockResolvedValueOnce({ Body: firstBody });
    send.mockResolvedValueOnce({ Body: overwrittenBody });
    send.mockResolvedValueOnce({ Body: Readable.from("x") });
    const archive = kind === "selected"
      ? await limitedService.getSelectedArchive("reports", ["first.txt", "overwritten.txt", "queued.txt"])
      : await limitedService.getPrefixArchive("reports", "");

    await expect(async () => {
      for await (const chunk of archive.stream) void chunk;
    }).rejects.toThrow(ArchiveLimitError);
    expect(overwrittenBody.destroyed).toBe(true);
    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(2);
  });

  it("accepts an archive at the actual byte limit even when HEAD metadata is stale", async () => {
    const limitedService = createS3Service({ client: { send }, allowedBuckets: ["reports"], objectMaxBytes: 1, archiveMaxBytes: 5 });
    send.mockResolvedValueOnce({ ContentLength: 1 });
    send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from("123"), Buffer.from("45")]) });
    const archive = await limitedService.getSelectedArchive("reports", ["changed.txt"]);

    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("streams selected archives through a constrained connection pool", async () => {
    const bodySize = 2 * 1024 * 1024;
    const keys = ["reports/first.bin", "reports/second.bin"];
    let openConnections = 0;
    const poolSend = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: bodySize };
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 command");
      if (openConnections >= 1) throw new Error("constrained connection pool exhausted");

      openConnections += 1;
      const body = Readable.from([randomBytes(bodySize / 2), randomBytes(bodySize / 2)]);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        openConnections -= 1;
      };
      body.once("end", release).once("error", release).once("close", release);
      return { Body: body };
    });
    const pooledService = createS3Service({
      client: { send: poolSend },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1
    });

    const archive = await pooledService.getSelectedArchive("reports", keys);

    const chunks: Buffer[] = [];
    for await (const chunk of archive.stream) chunks.push(Buffer.from(chunk));

    expect(bodySize).toBeGreaterThan(archive.stream.readableHighWaterMark);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    expect(openConnections).toBe(0);
    expect(
      poolSend.mock.calls
        .map(([command]) => command)
        .filter((command): command is GetObjectCommand => command instanceof GetObjectCommand)
        .map((command) => command.input.Key)
    ).toEqual(keys);
  });

  it("surfaces selected archive producer failures through the returned stream", async () => {
    const producerError = new Error("S3 stream failed");
    send.mockResolvedValueOnce({ ContentLength: 3 });
    send.mockResolvedValueOnce({ ContentLength: 4 });
    send.mockResolvedValueOnce({ Body: Readable.from("one") });
    send.mockRejectedValueOnce(producerError);

    const archive = await service.getSelectedArchive("reports", ["reports/one.txt", "reports/two.txt"]);

    await expect(async () => {
      for await (const chunk of archive.stream) {
        // Consuming the archive advances the controlled producer to the failed GET.
        void chunk;
      }
    }).rejects.toThrow(producerError);
  });

  it("aborts and disposes active selected archive bodies when the consumer cancels", async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, "destroy");
    let abortSignal: AbortSignal | undefined;
    const cancellationSend = vi.fn();
    cancellationSend.mockImplementation(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 1 };
      if (!(command instanceof GetObjectCommand)) throw new Error("Unexpected S3 command");

      abortSignal = options?.abortSignal;
      return { Body: body };
    });
    const cancellationService = createS3Service({
      client: { send: cancellationSend },
      allowedBuckets: ["reports"],
      objectMaxBytes: 1
    });

    const archive = await cancellationService.getSelectedArchive("reports", ["reports/pending.txt", "reports/queued.txt"]);
    await vi.waitFor(() => expect(abortSignal).toBeDefined());
    archive.stream.destroy();
    await vi.waitFor(() => expect(abortSignal?.aborted).toBe(true));

    expect(destroy).toHaveBeenCalled();
    expect(cancellationSend.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(1);
  });

  it("disposes a selected archive body that reports a streaming error without closing", async () => {
    const producerError = new Error("S3 response interrupted");
    const body = new Readable({ read() {} });
    send.mockResolvedValueOnce({ ContentLength: 1 });
    send.mockResolvedValueOnce({ Body: body });
    const archive = await service.getSelectedArchive("reports", ["reports/interrupted.txt"]);
    const consumed = (async () => {
      for await (const chunk of archive.stream) void chunk;
    })();
    const rejected = expect(consumed).rejects.toThrow(producerError);

    body.emit("error", producerError);
    await rejected;

    expect(body.destroyed).toBe(true);
  });

  it("returns before a pending GET resolves and disposes its late body after cancellation", async () => {
    const body = new Readable({ read() {} });
    let resolveGet!: (output: { Body: Readable }) => void;
    const pendingGet = new Promise<{ Body: Readable }>((resolve) => { resolveGet = resolve; });
    send.mockResolvedValueOnce({ ContentLength: 1 });
    send.mockResolvedValueOnce({ ContentLength: 1 });
    send.mockReturnValueOnce(pendingGet);

    const archive = await service.getSelectedArchive("reports", ["reports/pending.txt", "reports/queued.txt"]);
    archive.stream.destroy();
    resolveGet({ Body: body });
    await vi.waitFor(() => expect(body.destroyed).toBe(true));

    expect(send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(1);
  });
});
