import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";

import { assertSafeObjectKey, toPrefixMarkerKey } from "@/lib/objects/keys";
import { type OperatorObject, type OperatorSearchResult } from "@/lib/objects/operator-index";

type S3ClientLike = Pick<S3Client, "send">;
type ListedObjectEntry = Readonly<{ Key?: string; Size?: number; LastModified?: Date }>;
type ArchiveTarget = Readonly<{ key: string; kind: "object" | "prefix" }>;
type ArchiveEntry = Readonly<{ key: string; size: number }>;

const DEFAULT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_ARCHIVE_MAX_OBJECTS = 1000;
const DEFAULT_SEARCH_MAX_PAGES = 25;
const DEFAULT_SEARCH_MAX_RESULTS = 100;
const previewableContentTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif"
]);

export class AllowedBucketError extends Error {
  constructor() {
    super("Not found or not permitted");
    this.name = "AllowedBucketError";
  }
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super("Object exceeds the 500 MiB upload limit");
    this.name = "ObjectTooLargeError";
  }
}

export class ArchiveLimitError extends Error {
  constructor() {
    super("Prefix download exceeds the configured archive limit");
    this.name = "ArchiveLimitError";
  }
}

export class PreviewNotSupportedError extends Error {
  constructor() {
    super("Preview is not supported for this object");
    this.name = "PreviewNotSupportedError";
  }
}

export class InvalidArchiveSelectionError extends Error {
  constructor() {
    super("Select one or more unique objects");
    this.name = "InvalidArchiveSelectionError";
  }
}

export type ListedObject = OperatorObject;

function contentDisposition(disposition: "inline" | "attachment", key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) || "download";
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const header = `${disposition}; filename="${fallback}"`;
  if (fallback === filename) return header;

  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${header}; filename*=UTF-8''${encoded}`;
}

function normalizeListedObject(object: ListedObjectEntry): ListedObject | undefined {
  if (!object.Key || object.Key.endsWith("/")) return undefined;

  return {
    key: object.Key,
    size: object.Size ?? 0,
    lastModified: object.LastModified?.toISOString()
  };
}

function isPreviewableContentType(contentType: string | undefined): contentType is string {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLocaleLowerCase();

  return mediaType !== undefined && previewableContentTypes.has(mediaType);
}

function assertArchiveNames(names: readonly string[], allowDirectories = false): void {
  const normalizedNames = new Set<string>();
  const entries: { name: string; isDirectory: boolean }[] = [];
  for (const name of names) {
    try {
      assertSafeObjectKey(name);
    } catch {
      throw new InvalidArchiveSelectionError();
    }
    const isDirectory = allowDirectories && name.endsWith("/");
    const path = isDirectory ? name.slice(0, -1) : name;
    // ZIP extractors treat backslashes, drive prefixes, and dot segments as paths.
    if (/[\\:]/.test(path) || path.split("/").some((part) => !part || /[. ]$/.test(part))) {
      throw new InvalidArchiveSelectionError();
    }
    const normalizedName = path.normalize("NFC").toLowerCase();
    if (normalizedNames.has(normalizedName)) throw new InvalidArchiveSelectionError();
    normalizedNames.add(normalizedName);
    entries.push({ name: normalizedName, isDirectory });
  }

  for (const entry of entries) {
    if (!entry.isDirectory && entries.some((other) => other.name.startsWith(`${entry.name}/`))) {
      throw new InvalidArchiveSelectionError();
    }
  }
}

function assertArchiveTargets(keys: readonly string[]): ArchiveTarget[] {
  if (keys.length === 0) throw new InvalidArchiveSelectionError();
  try {
    const targets = keys.map((key) => ({
      key: assertSafeObjectKey(key),
      kind: key.endsWith("/") ? "prefix" as const : "object" as const
    }));
    assertArchiveNames(targets.map(({ key }) => key), true);
    const ordered = [...targets].sort((left, right) => left.key.localeCompare(right.key));
    if (ordered.some((target, index) => index > 0 && target.key.startsWith(ordered[index - 1].key))) {
      throw new InvalidArchiveSelectionError();
    }
    return targets;
  } catch {
    throw new InvalidArchiveSelectionError();
  }
}

function discardBody(body: unknown): void {
  if (!body || typeof body !== "object") return;

  const cancellableBody = body as {
    destroy?: () => unknown;
    cancel?: () => Promise<unknown> | unknown;
  };

  try {
    if (typeof cancellableBody.destroy === "function") {
      cancellableBody.destroy();
      return;
    }

    if (typeof cancellableBody.cancel === "function") {
      void Promise.resolve(cancellableBody.cancel()).catch(() => undefined);
    }
  } catch {
    // Preserve the generic error response for rejected previews and cancelled archives.
  }
}

function streamArchive(
  input: Readonly<{ client: S3ClientLike }>,
  archive: ZipArchive,
  bucket: string,
  entries: readonly Readonly<{ key: string; name: string }>[],
  maxBytes: number
): void {
  const controller = new AbortController();
  let activeBody: Readable | undefined;
  let streamedBytes = 0;
  let producing = true;
  const cancel = () => {
    controller.abort();
    discardBody(activeBody);
  };
  const onClose = () => {
    if (producing) cancel();
  };

  archive.once("close", onClose);
  void (async () => {
    try {
      for (const { key, name } of entries) {
        if (archive.destroyed) return;

        const output = await input.client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { abortSignal: controller.signal }
        );
        if (archive.destroyed) {
          discardBody(output.Body);
          return;
        }
        if (!output.Body) throw new Error("S3 returned no object body");

        activeBody = output.Body as Readable;
        const limitedBody = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            streamedBytes += chunk.length;
            if (streamedBytes > maxBytes) return callback(new ArchiveLimitError());
            callback(null, chunk);
          }
        });
        const bodyFinished = pipeline(activeBody, limitedBody, { signal: controller.signal });
        archive.append(limitedBody, { name });
        await bodyFinished;
        activeBody = undefined;
      }

      if (!archive.destroyed) await archive.finalize();
    } catch (error) {
      cancel();
      if (!archive.destroyed) archive.destroy(error instanceof Error ? error : new Error("S3 archive stream failed"));
    } finally {
      producing = false;
      archive.off("close", onClose);
    }
  })();
}

export function createS3Service(input: Readonly<{
  client: S3ClientLike;
  allowedBuckets: readonly string[];
  objectMaxBytes: number;
  archiveMaxBytes?: number;
  archiveMaxObjects?: number;
  searchMaxResults?: number;
  searchMaxPages?: number;
}>) {
  const assertAllowedBucket = (bucket: string) => {
    if (!input.allowedBuckets.includes(bucket)) throw new AllowedBucketError();
  };

  const resolveArchiveTargets = async (bucket: string, targets: readonly ArchiveTarget[]) => {
    const archiveMaxObjects = input.archiveMaxObjects ?? DEFAULT_ARCHIVE_MAX_OBJECTS;
    const archiveMaxBytes = input.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
    if (targets.length > archiveMaxObjects) throw new ArchiveLimitError();

    const entries: ArchiveEntry[] = [];
    const resolvedKeys = new Set<string>();
    let totalSize = 0;
    const addEntry = (key: string, size: number) => {
      if (!Number.isFinite(size) || size < 0) throw new ArchiveLimitError();
      if (resolvedKeys.has(key)) throw new InvalidArchiveSelectionError();

      resolvedKeys.add(key);
      entries.push({ key, size });
      totalSize += size;
      if (entries.length > archiveMaxObjects || totalSize > archiveMaxBytes) throw new ArchiveLimitError();
    };

    for (const target of targets) {
      if (target.kind === "object") {
        const output = await input.client.send(new HeadObjectCommand({ Bucket: bucket, Key: target.key }));
        const size = output.ContentLength;
        if (typeof size !== "number") throw new ArchiveLimitError();
        addEntry(target.key, size);
        continue;
      }

      let continuationToken: string | undefined;
      do {
        const page = await input.client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: target.key, ContinuationToken: continuationToken })
        );
        for (const object of page.Contents ?? []) {
          if (!object.Key) continue;
          const size = object.Size;
          if (typeof size !== "number") throw new ArchiveLimitError();
          addEntry(object.Key, size);
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    }

    return { entries, totalSize };
  };

  return {
    async listObjects(bucket: string, prefix: string, continuationToken: string | undefined) {
      assertAllowedBucket(bucket);
      const output = await input.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: continuationToken })
      );

      return {
        objects: (output.Contents ?? [])
          .map(normalizeListedObject)
          .filter((object): object is ListedObject => object !== undefined),
        prefixes: (output.CommonPrefixes ?? [])
          .map((prefixEntry) => prefixEntry.Prefix)
          .filter((value): value is string => Boolean(value)),
        nextContinuationToken: output.NextContinuationToken
      };
    },

    async searchObjects(bucket: string, query: string): Promise<OperatorSearchResult> {
      assertAllowedBucket(bucket);
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (!normalizedQuery) throw new Error("Search query is required");

      const maxResults = input.searchMaxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
      const maxPages = input.searchMaxPages ?? DEFAULT_SEARCH_MAX_PAGES;
      const objects: ListedObject[] = [];
      let continuationToken: string | undefined;
      let pagesRead = 0;

      do {
        const page = await input.client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken })
        );
        pagesRead += 1;

        for (const entry of page.Contents ?? []) {
          const object = normalizeListedObject(entry);
          if (!object || !object.key.toLocaleLowerCase().includes(normalizedQuery)) continue;

          objects.push(object);
          if (objects.length === maxResults) break;
        }

        continuationToken = page.NextContinuationToken;
      } while (continuationToken && objects.length < maxResults && pagesRead < maxPages);

      return { objects, truncated: Boolean(continuationToken) || objects.length === maxResults };
    },

    async getObject(bucket: string, key: string) {
      assertAllowedBucket(bucket);
      const safeKey = assertSafeObjectKey(key);
      const output = await input.client.send(new GetObjectCommand({ Bucket: bucket, Key: safeKey }));

      if (!output.Body) throw new Error("S3 returned no object body");

      return {
        body: output.Body,
        headers: {
          "Content-Disposition": contentDisposition("attachment", safeKey),
          "Content-Type": output.ContentType || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          ...(output.ContentLength === undefined ? {} : { "Content-Length": String(output.ContentLength) })
        }
      };
    },

    async getPreviewObject(bucket: string, key: string) {
      assertAllowedBucket(bucket);
      const safeKey = assertSafeObjectKey(key);
      const output = await input.client.send(new GetObjectCommand({ Bucket: bucket, Key: safeKey }));

      if (!isPreviewableContentType(output.ContentType)) {
        discardBody(output.Body);
        throw new PreviewNotSupportedError();
      }
      if (!output.Body) throw new Error("S3 returned no object body");

      return {
        body: output.Body,
        headers: {
          "Content-Disposition": contentDisposition("inline", safeKey),
          "Content-Type": output.ContentType,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        }
      };
    },

    async putObject(
      bucket: string,
      key: string,
      body: unknown,
      contentType: string | undefined,
      contentLength: number,
      overwrite = false
    ) {
      assertAllowedBucket(bucket);
      const safeKey = assertSafeObjectKey(key);

      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > input.objectMaxBytes) {
        throw new ObjectTooLargeError();
      }

      await input.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: safeKey,
          Body: body as never,
          ContentType: contentType || "application/octet-stream",
          ContentLength: contentLength,
          IfNoneMatch: overwrite ? undefined : "*"
        })
      );
    },

    async deleteObject(bucket: string, key: string) {
      assertAllowedBucket(bucket);
      await input.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: assertSafeObjectKey(key) }));
    },

    async createPrefixMarker(bucket: string, prefix: string) {
      assertAllowedBucket(bucket);
      await input.client.send(new PutObjectCommand({ Bucket: bucket, Key: toPrefixMarkerKey(prefix), Body: "", ContentLength: 0 }));
    },

    async getPrefixArchive(bucket: string, prefix: string) {
      assertAllowedBucket(bucket);
      const keys: { key: string; size: number }[] = [];
      let totalSize = 0;
      let continuationToken: string | undefined;

      do {
        const page = await input.client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
        );
        for (const object of page.Contents ?? []) {
          if (!object.Key) continue;
          totalSize += object.Size ?? 0;
          keys.push({ key: object.Key, size: object.Size ?? 0 });
          if (keys.length > (input.archiveMaxObjects ?? DEFAULT_ARCHIVE_MAX_OBJECTS) || totalSize > (input.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES)) {
            throw new ArchiveLimitError();
          }
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);

      const entries = keys.map((object) => ({ key: object.key, name: object.key.slice(prefix.length) || object.key }));
      assertArchiveNames(entries.map((entry) => entry.name), true);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      streamArchive(input, archive, bucket, entries, input.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES);

      return { stream: archive, objectCount: keys.length, totalSize };
    },

    async getSelectedArchive(bucket: string, keys: readonly string[]) {
      assertAllowedBucket(bucket);
      const targets = assertArchiveTargets(keys);
      const archiveMaxBytes = input.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;
      const { entries, totalSize } = await resolveArchiveTargets(bucket, targets);

      assertArchiveNames(entries.map(({ key }) => key), true);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      streamArchive(input, archive, bucket, entries.map(({ key }) => ({ key, name: key })), archiveMaxBytes);

      return { stream: archive, objectCount: entries.length, totalSize };
    }
  };
}
