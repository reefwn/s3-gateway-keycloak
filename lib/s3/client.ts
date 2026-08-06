import "server-only";

import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

import { type AppConfig, loadConfig } from "@/lib/config";
import { createS3Service } from "@/lib/s3/service";

let service: ReturnType<typeof createS3Service> | undefined;

export function s3ClientOptions(config: Pick<AppConfig, "s3Region" | "localS3">): S3ClientConfig {
  if (!config.localS3) {
    return { region: config.s3Region };
  }

  return {
    region: config.s3Region,
    endpoint: config.localS3.endpointUrl,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.localS3.accessKeyId,
      secretAccessKey: config.localS3.secretAccessKey
    }
  };
}

export function createS3Client(config: Pick<AppConfig, "s3Region" | "localS3">): S3Client {
  return new S3Client(s3ClientOptions(config));
}

export function getS3Service(): ReturnType<typeof createS3Service> {
  if (!service) {
    const config = loadConfig();
    service = createS3Service({
      client: createS3Client(config),
      allowedBuckets: config.allowedBuckets,
      objectMaxBytes: config.objectMaxBytes,
      archiveMaxBytes: config.archiveMaxBytes,
      archiveMaxObjects: config.archiveMaxObjects
    });
  }

  return service;
}
