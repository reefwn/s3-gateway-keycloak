// @vitest-environment node

import { describe, expect, it } from "vitest";

import { s3ClientOptions } from "@/lib/s3/client";

describe("S3 client configuration", () => {
  it("uses the default AWS credential chain outside local S3 development", () => {
    expect(
      s3ClientOptions({
        s3Region: "ap-southeast-7",
        localS3: null
      })
    ).toEqual({ region: "ap-southeast-7" });
  });

  it("uses path-style addressing and configured credentials for local S3", () => {
    expect(
      s3ClientOptions({
        s3Region: "ap-southeast-7",
        localS3: {
          endpointUrl: "http://localhost:4566",
          accessKeyId: "local-floci",
          secretAccessKey: "local-floci-secret"
        }
      })
    ).toEqual({
      region: "ap-southeast-7",
      endpoint: "http://localhost:4566",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "local-floci",
        secretAccessKey: "local-floci-secret"
      }
    });
  });
});
