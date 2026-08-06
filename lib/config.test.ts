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

  it("rejects malformed role mapping JSON", () => {
    const environment = { ...validEnvironment, S3_ROLE_MAPPING: "not-json" };

    expect(() => loadConfig(environment)).toThrow(/S3_ROLE_MAPPING/);
  });

  it("rejects static AWS credentials", () => {
    const environment = { ...validEnvironment, AWS_ACCESS_KEY_ID: "forbidden" };

    expect(() => loadConfig(environment)).toThrow(/static AWS credentials/i);
  });
});
