import { describe, expect, it } from "vitest";

import { loadConfig } from "@/lib/config";

const validEnvironment = {
  DATABASE_URL: "postgres://s3_browser:s3_browser@localhost:5432/s3_browser",
  NEXTAUTH_SECRET: "a-secret-at-least-thirty-two-characters-long",
  NEXTAUTH_URL: "http://localhost:3000",
  KEYCLOAK_ISSUER: "https://keycloak.example.test/realms/internal",
  KEYCLOAK_CLIENT_ID: "s3-browser",
  KEYCLOAK_CLIENT_SECRET: "keycloak-client-secret",
  S3_REGION: "ap-southeast-7",
  S3_ALLOWED_BUCKETS: "reports,uploads",
  S3_ROLE_CLAIM: "resource_access.s3-browser.roles",
  S3_ROLE_MAPPING: '{"s3-browser-admin":"admin","s3-browser-readwrite":"readwrite","s3-browser-readonly":"readonly"}',
  APP_ENVIRONMENT: "local"
};

describe("loadConfig", () => {
  it("parses a complete deployment configuration", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      databaseUrl: validEnvironment.DATABASE_URL,
      allowedBuckets: ["reports", "uploads"],
      objectMaxBytes: 500 * 1024 * 1024,
      transferLimit: 5,
      archiveMaxObjects: 1000,
      archiveMaxBytes: 2 * 1024 * 1024 * 1024
    });
  });

  it("accepts the local Keycloak issuer used by Compose", () => {
    expect(loadConfig({
      ...validEnvironment,
      APP_ENVIRONMENT: "local",
      KEYCLOAK_ISSUER: "http://keycloak.localhost:8080/realms/internal"
    }).keycloakIssuer).toBe("http://keycloak.localhost:8080/realms/internal");
  });

  it("accepts complete local Floci configuration only in local mode", () => {
    expect(loadConfig({
      ...validEnvironment,
      S3_ENDPOINT_URL: "http://floci:4566",
      S3_ACCESS_KEY_ID: "local-floci",
      S3_SECRET_ACCESS_KEY: "local-floci-secret"
    }).localS3).toEqual({
      endpointUrl: "http://floci:4566",
      accessKeyId: "local-floci",
      secretAccessKey: "local-floci-secret"
    });
  });

  it("returns no local S3 configuration when local settings are absent", () => {
    expect(loadConfig(validEnvironment).localS3).toBeNull();
  });

  it("rejects a local S3 endpoint without local credentials", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      S3_ENDPOINT_URL: "http://floci:4566"
    })).toThrow(/S3_ENDPOINT_URL.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/i);
  });

  it("rejects a local S3 endpoint with only an access key", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      S3_ENDPOINT_URL: "http://floci:4566",
      S3_ACCESS_KEY_ID: "local-floci"
    })).toThrow(/S3_ENDPOINT_URL.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/i);
  });

  it("rejects a local S3 endpoint with only a secret key", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      S3_ENDPOINT_URL: "http://floci:4566",
      S3_SECRET_ACCESS_KEY: "local-floci-secret"
    })).toThrow(/S3_ENDPOINT_URL.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/i);
  });

  it.each([
    ["endpoint", { S3_ENDPOINT_URL: "", S3_ACCESS_KEY_ID: "local-floci", S3_SECRET_ACCESS_KEY: "local-floci-secret" }],
    ["access key", { S3_ENDPOINT_URL: "http://floci:4566", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "local-floci-secret" }],
    ["secret key", { S3_ENDPOINT_URL: "http://floci:4566", S3_ACCESS_KEY_ID: "local-floci", S3_SECRET_ACCESS_KEY: "" }]
  ])("rejects an empty local S3 %s value", (_valueName, localS3) => {
    expect(() => loadConfig({ ...validEnvironment, ...localS3 }))
      .toThrow(/S3_ENDPOINT_URL.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/i);
  });

  it("rejects local S3 credentials without an endpoint", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      S3_ACCESS_KEY_ID: "local-floci",
      S3_SECRET_ACCESS_KEY: "local-floci-secret"
    })).toThrow(/S3_ENDPOINT_URL.*S3_ACCESS_KEY_ID.*S3_SECRET_ACCESS_KEY/i);
  });

  it("rejects a malformed local S3 endpoint", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      S3_ENDPOINT_URL: "not-a-url",
      S3_ACCESS_KEY_ID: "local-floci",
      S3_SECRET_ACCESS_KEY: "local-floci-secret"
    })).toThrow(/S3_ENDPOINT_URL/);
  });

  it("rejects local S3 endpoint settings outside local development", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "https://s3.internal.example",
      S3_ENDPOINT_URL: "http://floci:4566",
      S3_ACCESS_KEY_ID: "local-floci",
      S3_SECRET_ACCESS_KEY: "local-floci-secret"
    })).toThrow(/S3_ENDPOINT_URL.*local/i);
  });

  it("rejects explicitly empty local S3 settings outside local development", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "https://s3.internal.example",
      S3_ENDPOINT_URL: ""
    })).toThrow(/S3_ENDPOINT_URL.*local/i);
  });

  it("rejects a non-local HTTP Keycloak issuer", () => {
    const environment = {
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "https://s3-browser.internal.example",
      KEYCLOAK_ISSUER: "http://keycloak.internal.example/realms/internal"
    };

    expect(() => loadConfig(environment)).toThrow(/KEYCLOAK_ISSUER.*HTTPS/);
  });

  it("rejects an incomplete database configuration", () => {
    const environment = { ...validEnvironment, DATABASE_URL: undefined };

    expect(() => loadConfig(environment)).toThrow(/DATABASE_URL/);
  });

  it("rejects duplicate configured bucket names", () => {
    const environment = { ...validEnvironment, S3_ALLOWED_BUCKETS: "reports,reports" };

    expect(() => loadConfig(environment)).toThrow(/duplicate/i);
  });

  it("rejects a non-local HTTP application origin", () => {
    const environment = {
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "http://s3-browser.internal.example"
    };

    expect(() => loadConfig(environment)).toThrow(/HTTPS/);
  });

  it("allows a non-local HTTP application origin when ALLOW_INSECURE_HTTP is true", () => {
    const environment = {
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "http://s3-browser.internal.example",
      KEYCLOAK_ISSUER: "https://keycloak.internal.example/realms/internal",
      ALLOW_INSECURE_HTTP: "true"
    };

    expect(loadConfig(environment)).toMatchObject({
      applicationOrigin: "http://s3-browser.internal.example",
      allowsInsecureHttp: true
    });
  });

  it("defaults ALLOW_INSECURE_HTTP to false when unset", () => {
    expect(loadConfig(validEnvironment).allowsInsecureHttp).toBe(false);
  });

  it("still requires HTTPS for the Keycloak issuer even when ALLOW_INSECURE_HTTP is true", () => {
    const environment = {
      ...validEnvironment,
      APP_ENVIRONMENT: "deployment",
      NEXTAUTH_URL: "http://s3-browser.internal.example",
      KEYCLOAK_ISSUER: "http://keycloak.internal.example/realms/internal",
      ALLOW_INSECURE_HTTP: "true"
    };

    expect(() => loadConfig(environment)).toThrow(/KEYCLOAK_ISSUER.*HTTPS/);
  });

  it("rejects an invalid ALLOW_INSECURE_HTTP value", () => {
    const environment = { ...validEnvironment, ALLOW_INSECURE_HTTP: "yes" };

    expect(() => loadConfig(environment)).toThrow(/ALLOW_INSECURE_HTTP/);
  });

  it("rejects malformed role mapping JSON", () => {
    const environment = { ...validEnvironment, S3_ROLE_MAPPING: "not-json" };

    expect(() => loadConfig(environment)).toThrow(/S3_ROLE_MAPPING/);
  });

  it("rejects static AWS credentials", () => {
    const environment = { ...validEnvironment, AWS_ACCESS_KEY_ID: "forbidden" };

    expect(() => loadConfig(environment)).toThrow(/static AWS credentials/i);
  });
});
