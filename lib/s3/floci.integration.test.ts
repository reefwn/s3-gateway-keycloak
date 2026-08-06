// @vitest-environment node

import { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createS3Service } from "@/lib/s3/service";

const bucket = process.env.S3_ALLOWED_BUCKETS?.split(",").map((value) => value.trim()).find(Boolean) ?? "reports";
const client = new S3Client({
  region: "ap-southeast-7",
  endpoint: "http://localhost:4566",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "local-floci",
    secretAccessKey: "local-floci-secret"
  }
});
const service = createS3Service({
  client,
  allowedBuckets: [bucket],
  objectMaxBytes: 500 * 1024 * 1024
});
const generatedKeys = new Set<string>();
const runIntegration = process.env.RUN_S3_INTEGRATION === "true";

async function readStream(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all([...generatedKeys].map((key) => service.deleteObject(bucket, key)));
  generatedKeys.clear();
});

describe.runIf(runIntegration)("Floci S3 integration", () => {
  it("writes, conditionally overwrites, lists, downloads, and deletes a Floci object", async () => {
    const key = `integration/${randomUUID()}.txt`;
    generatedKeys.add(key);

    await service.putObject(bucket, key, Readable.from("first"), "text/plain", 5);
    await expect(service.putObject(bucket, key, Readable.from("second"), "text/plain", 6)).rejects.toThrow();
    await service.putObject(bucket, key, Readable.from("second"), "text/plain", 6, true);

    const list = await service.listObjects(bucket, "integration/", undefined);
    expect(list.objects.map((entry) => entry.key)).toContain(key);

    const download = await service.getObject(bucket, key);
    expect((await readStream(download.body as AsyncIterable<Uint8Array | string>)).toString()).toBe("second");

    await service.deleteObject(bucket, key);
    generatedKeys.delete(key);
    await expect(service.listObjects(bucket, key, undefined)).resolves.toMatchObject({ objects: [] });
  });

  it("streams an archive of exactly its UUID-scoped objects", async () => {
    const prefix = `integration-archive/${randomUUID()}/`;
    const firstKey = `${prefix}first.txt`;
    const secondKey = `${prefix}second.txt`;
    generatedKeys.add(firstKey);
    generatedKeys.add(secondKey);

    await service.putObject(bucket, firstKey, Readable.from("one"), "text/plain", 3);
    await service.putObject(bucket, secondKey, Readable.from("four"), "text/plain", 4);

    const archive = await service.getPrefixArchive(bucket, prefix);
    const zip = await readStream(archive.stream);

    expect(archive.objectCount).toBe(2);
    expect(archive.totalSize).toBe(7);
    expect(zip.length).toBeGreaterThan(0);
  });
});
