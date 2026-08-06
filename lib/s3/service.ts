import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import type { Archiver, ArchiverOptions } from "archiver";

import { assertSafeObjectKey, toPrefixMarkerKey } from "@/lib/objects/keys";

type S3ClientLike = Pick<S3Client, "send">;
const createArchiver = createRequire(import.meta.url)("archiver") as (format: string, options?: ArchiverOptions) => Archiver;

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

export type ListedObject = Readonly<{ key: string; size: number; lastModified?: Date }>;

function attachmentFilename(key: string): string {
  const filename = key.split("/").filter(Boolean).at(-1) || "download";

  return filename.replaceAll('"', "_").replaceAll("\\", "_");
}

export function createS3Service(input: Readonly<{
  client: S3ClientLike;
  allowedBuckets: readonly string[];
  objectMaxBytes: number;
  archiveMaxBytes?: number;
  archiveMaxObjects?: number;
}>) {
  const assertAllowedBucket = (bucket: string) => {
    if (!input.allowedBuckets.includes(bucket)) throw new AllowedBucketError();
  };

  return {
    async listObjects(bucket: string, prefix: string, continuationToken: string | undefined) {
      assertAllowedBucket(bucket);
      const output = await input.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
      );

      return {
        objects: (output.Contents ?? [])
          .filter((object): object is Required<Pick<typeof object, "Key">> & typeof object => Boolean(object.Key))
          .map((object) => ({
            key: object.Key,
            size: object.Size ?? 0,
            lastModified: object.LastModified
          })),
        prefixes: (output.CommonPrefixes ?? [])
          .map((prefixEntry) => prefixEntry.Prefix)
          .filter((value): value is string => Boolean(value)),
        nextContinuationToken: output.NextContinuationToken
      };
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
          if (keys.length > (input.archiveMaxObjects ?? 1000) || totalSize > (input.archiveMaxBytes ?? 2 * 1024 * 1024 * 1024)) {
            throw new ArchiveLimitError();
          }
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);

      const archive = createArchiver("zip", { zlib: { level: 6 } });
      for (const object of keys) {
        const output = await input.client.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }));
        if (!output.Body) throw new Error("S3 returned no object body");
        archive.append(output.Body as Readable, { name: object.key.slice(prefix.length) || object.key });
      }
      void archive.finalize();

      return { stream: archive, objectCount: keys.length, totalSize };
    }
  };
}
