import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";

import { assertSafeObjectKey, toPrefixMarkerKey } from "@/lib/objects/keys";
import { type OperatorObject, type OperatorSearchResult } from "@/lib/objects/operator-index";

type S3ClientLike = Pick<S3Client, "send">;
type ListedObjectEntry = Readonly<{ Key?: string; Size?: number; LastModified?: Date }>;

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

function attachmentFilename(key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) || "download";

  return filename.replaceAll('"', "_").replaceAll("\\", "_");
}

function normalizeListedObject(object: ListedObjectEntry): ListedObject | undefined {
  if (!object.Key) return undefined;

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

function assertSelectedKeys(keys: readonly string[]): string[] {
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new InvalidArchiveSelectionError();
  }

  try {
    return keys.map(assertSafeObjectKey);
  } catch {
    throw new InvalidArchiveSelectionError();
  }
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
          "Content-Disposition": `attachment; filename="${attachmentFilename(safeKey)}"`,
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

      if (!isPreviewableContentType(output.ContentType)) throw new PreviewNotSupportedError();
      if (!output.Body) throw new Error("S3 returned no object body");

      return {
        body: output.Body,
        headers: {
          "Content-Disposition": `inline; filename="${attachmentFilename(safeKey)}"`,
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

      const archive = new ZipArchive({ zlib: { level: 6 } });
      for (const object of keys) {
        const output = await input.client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
        if (!output.Body) throw new Error("S3 returned no object body");
        archive.append(output.Body as Readable, { name: object.key.slice(prefix.length) || object.key });
      }
      void archive.finalize();

      return { stream: archive, objectCount: keys.length, totalSize };
    },

    async getSelectedArchive(bucket: string, keys: readonly string[]) {
      assertAllowedBucket(bucket);
      const selectedKeys = assertSelectedKeys(keys);
      const archiveMaxObjects = input.archiveMaxObjects ?? DEFAULT_ARCHIVE_MAX_OBJECTS;
      const archiveMaxBytes = input.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX_BYTES;

      if (selectedKeys.length > archiveMaxObjects) throw new ArchiveLimitError();

      let totalSize = 0;
      for (const key of selectedKeys) {
        const output = await input.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const size = output.ContentLength;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new ArchiveLimitError();

        totalSize += size;
        if (totalSize > archiveMaxBytes) throw new ArchiveLimitError();
      }

      const archive = new ZipArchive({ zlib: { level: 6 } });
      for (const key of selectedKeys) {
        const output = await input.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!output.Body) throw new Error("S3 returned no object body");
        archive.append(output.Body as Readable, { name: key });
      }
      void archive.finalize();

      return { stream: archive, objectCount: selectedKeys.length, totalSize };
    }
  };
}
