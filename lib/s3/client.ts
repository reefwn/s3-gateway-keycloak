import "server-only";

import { S3Client } from "@aws-sdk/client-s3";

import { loadConfig } from "@/lib/config";
import { createS3Service } from "@/lib/s3/service";

let service: ReturnType<typeof createS3Service> | undefined;

export function getS3Service(): ReturnType<typeof createS3Service> {
  if (!service) {
    const config = loadConfig();
    service = createS3Service({
      client: new S3Client({ region: config.s3Region }),
      allowedBuckets: config.allowedBuckets,
      objectMaxBytes: config.objectMaxBytes,
      archiveMaxBytes: config.archiveMaxBytes,
      archiveMaxObjects: config.archiveMaxObjects
    });
  }

  return service;
}
