import { z } from "zod";

const MAX_OBJECT_BYTES = 500 * 1024 * 1024;
const DEFAULT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

const roleSchema = z.enum(["admin", "readwrite", "readonly"]);

const rawConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(32),
  NEXTAUTH_URL: z.string().url(),
  KEYCLOAK_ISSUER: z.string().url(),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ALLOWED_BUCKETS: z.string().min(1),
  S3_ROLE_CLAIM: z.string().min(1),
  S3_ROLE_MAPPING: z.string().min(1),
  APP_ENVIRONMENT: z.enum(["local", "deployment"]).default("deployment"),
  ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false"),
  S3_OBJECT_MAX_BYTES: z.coerce.number().int().positive().default(MAX_OBJECT_BYTES),
  S3_TRANSFER_LIMIT: z.coerce.number().int().min(1).default(5),
  S3_ARCHIVE_MAX_OBJECTS: z.coerce.number().int().min(1).default(1000),
  S3_ARCHIVE_MAX_BYTES: z.coerce.number().int().min(1).default(DEFAULT_ARCHIVE_BYTES),
  S3_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).default(100),
  S3_SEARCH_MAX_PAGES: z.coerce.number().int().min(1).default(25),
  S3_ENDPOINT_URL: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional()
});

export type AppRole = z.infer<typeof roleSchema>;

export type AppConfig = Readonly<{
  databaseUrl: string;
  nextAuthSecret: string;
  applicationOrigin: string;
  keycloakIssuer: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
  s3Region: string;
  allowedBuckets: readonly string[];
  roleClaim: string;
  roleMapping: Readonly<Record<string, AppRole>>;
  isLocalDevelopment: boolean;
  allowsInsecureHttp: boolean;
  localS3: {
    endpointUrl: string;
    accessKeyId: string;
    secretAccessKey: string;
  } | null;
  objectMaxBytes: number;
  transferLimit: number;
  archiveMaxObjects: number;
  archiveMaxBytes: number;
  searchMaxResults: number;
  searchMaxPages: number;
}>;

function parseRoleMapping(value: string): Record<string, AppRole> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("S3_ROLE_MAPPING must be valid JSON");
  }

  const result = z.record(z.string().min(1), roleSchema).safeParse(parsed);

  if (!result.success || Object.keys(result.data).length === 0) {
    throw new Error("S3_ROLE_MAPPING must map one or more claim values to valid roles");
  }

  return result.data;
}

function parseBuckets(value: string): string[] {
  const buckets = value
    .split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);

  if (buckets.length === 0) {
    throw new Error("S3_ALLOWED_BUCKETS must contain at least one bucket");
  }

  if (new Set(buckets).size !== buckets.length) {
    throw new Error("S3_ALLOWED_BUCKETS contains duplicate bucket names");
  }

  return buckets;
}

export function loadConfig(environment: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = rawConfigSchema.safeParse(environment);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.join(".") || "configuration"}: ${issue.message}`);
  }

  const raw = parsed.data;

  if (raw.AWS_ACCESS_KEY_ID || raw.AWS_SECRET_ACCESS_KEY || raw.AWS_SESSION_TOKEN) {
    throw new Error("Static AWS credentials are forbidden; configure IRSA instead");
  }

  const localS3Values = [raw.S3_ENDPOINT_URL, raw.S3_ACCESS_KEY_ID, raw.S3_SECRET_ACCESS_KEY];
  const hasAnyLocalS3Value = localS3Values.some((value) => value !== undefined);
  const hasCompleteLocalS3Config = localS3Values.every(Boolean);

  if (raw.APP_ENVIRONMENT !== "local" && hasAnyLocalS3Value) {
    throw new Error("S3_ENDPOINT_URL and local S3 credentials are allowed only in local development");
  }

  if (raw.APP_ENVIRONMENT === "local" && hasAnyLocalS3Value && !hasCompleteLocalS3Config) {
    throw new Error("S3_ENDPOINT_URL, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY must be supplied together");
  }

  let localS3: AppConfig["localS3"] = null;

  if (hasCompleteLocalS3Config) {
    try {
      new URL(raw.S3_ENDPOINT_URL!);
    } catch {
      throw new Error("S3_ENDPOINT_URL must be a valid URL");
    }

    localS3 = Object.freeze({
      endpointUrl: raw.S3_ENDPOINT_URL!,
      accessKeyId: raw.S3_ACCESS_KEY_ID!,
      secretAccessKey: raw.S3_SECRET_ACCESS_KEY!
    });
  }

  const applicationUrl = new URL(raw.NEXTAUTH_URL);
  const keycloakIssuerUrl = new URL(raw.KEYCLOAK_ISSUER);
  const allowsInsecureHttp = raw.ALLOW_INSECURE_HTTP === "true";

  // HTTPS is required by default outside local development. ALLOW_INSECURE_HTTP
  // is a narrow, explicit opt-out for deployments that terminate TLS elsewhere
  // (e.g. an internal service mesh / gateway that only exposes HTTP inside a
  // private network) — it must be set deliberately by the operator, never
  // inferred, and it affects only the application's own origin. The Keycloak
  // issuer is a separate trust boundary (the identity provider) and always
  // requires HTTPS outside local development, regardless of this flag.
  if (raw.APP_ENVIRONMENT !== "local" && !allowsInsecureHttp && applicationUrl.protocol !== "https:") {
    throw new Error(
      "NEXTAUTH_URL must use HTTPS outside local development (set ALLOW_INSECURE_HTTP=true to override for a trusted internal network)"
    );
  }

  if (raw.APP_ENVIRONMENT !== "local" && keycloakIssuerUrl.protocol !== "https:") {
    throw new Error("KEYCLOAK_ISSUER must use HTTPS outside local development");
  }

  return Object.freeze({
    databaseUrl: raw.DATABASE_URL,
    nextAuthSecret: raw.NEXTAUTH_SECRET,
    applicationOrigin: applicationUrl.origin,
    keycloakIssuer: raw.KEYCLOAK_ISSUER,
    keycloakClientId: raw.KEYCLOAK_CLIENT_ID,
    keycloakClientSecret: raw.KEYCLOAK_CLIENT_SECRET,
    s3Region: raw.S3_REGION,
    allowedBuckets: Object.freeze(parseBuckets(raw.S3_ALLOWED_BUCKETS)),
    roleClaim: raw.S3_ROLE_CLAIM,
    roleMapping: Object.freeze(parseRoleMapping(raw.S3_ROLE_MAPPING)),
    isLocalDevelopment: raw.APP_ENVIRONMENT === "local",
    allowsInsecureHttp,
    localS3,
    objectMaxBytes: raw.S3_OBJECT_MAX_BYTES,
    transferLimit: raw.S3_TRANSFER_LIMIT,
    archiveMaxObjects: raw.S3_ARCHIVE_MAX_OBJECTS,
    archiveMaxBytes: raw.S3_ARCHIVE_MAX_BYTES,
    searchMaxResults: raw.S3_SEARCH_MAX_RESULTS,
    searchMaxPages: raw.S3_SEARCH_MAX_PAGES
  });
}
