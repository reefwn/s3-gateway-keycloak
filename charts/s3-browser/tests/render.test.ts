// @vitest-environment node

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function render(extraArgs: string[] = []) {
  return spawnSync("helm", ["template", "s3-browser", ".", "-f", "values-production.example.yaml", ...extraArgs], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}

function sourceManifest(output: string, templateName: string) {
  const marker = `# Source: s3-browser/templates/${templateName}`;
  const start = output.indexOf(marker);
  const end = output.indexOf("\n---", start);

  return output.slice(start, end === -1 ? undefined : end);
}

describe("s3-browser chart", () => {
  it("renders the application, migration gate, and retained PostgreSQL storage", () => {
    const result = render();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kind: Deployment");
    expect(result.stdout).toContain("kind: StatefulSet");
    expect(result.stdout).toContain("clusterIP: None");
    expect(result.stdout).toContain("replicas: 1");
    expect(result.stdout).toContain("volumeClaimTemplates:");
    expect(result.stdout).toContain("whenDeleted: Retain");
    expect(result.stdout).toContain("whenScaled: Retain");
    expect(result.stdout).toContain("key: POSTGRES_DB");
    expect(result.stdout).toContain("key: POSTGRES_USER");
    expect(result.stdout).toContain("key: POSTGRES_PASSWORD");
    expect(result.stdout).toContain("key: DATABASE_URL");
    expect(result.stdout).toMatch(/initContainers:\s+- name: migrate[\s\S]*?command:\s+- bun\s+- run\s+- db:migrate/);
    expect(result.stdout).not.toContain("kind: Secret");
    expect(result.stdout).not.toContain("AWS_ACCESS_KEY_ID");
    expect(result.stdout).toContain("name: deployment-secrets");
    expect(result.stdout).toContain('image: "reefwn/s3-gateway-keycloak:v1.0.1"');
    expect(result.stdout).toContain("readOnlyRootFilesystem: true");
    expect(result.stdout).toContain("allowPrivilegeEscalation: false");
    expect(result.stdout).toContain("- ALL");
    expect(result.stdout).toContain("path: /api/health");
    expect(result.stdout).toContain("kind: ConfigMap");
    expect(result.stdout).not.toContain("kind: Ingress");
    expect(result.stdout).not.toContain("kind: Job");
    expect(result.stdout).not.toContain("helm.sh/hook:");

    const configMap = sourceManifest(result.stdout, "configmap.yaml");
    expect(configMap).toContain("S3_ALLOWED_BUCKETS");
    expect(configMap).toContain("S3_ROLE_MAPPING");
    expect(configMap).not.toContain("DATABASE_URL");
    expect(configMap).not.toContain("AWS_ACCESS_KEY_ID");

    const deployment = sourceManifest(result.stdout, "deployment.yaml");
    expect(deployment).toContain("initContainers:");
    expect(deployment).toContain("name: migrate");
    expect(deployment).toContain("key: DATABASE_URL");
  });

  it("rejects an empty existing secret name", () => {
    const result = render(["--set", "existingSecret.name="]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/existingSecret.*name/i);
  });

  it("renders ingress only when it is configured", () => {
    const result = render([
      "--set", "ingress.enabled=true",
      "--set", "ingress.host=s3-browser.internal.example",
      "--set", "ingress.tlsSecretName=s3-browser-tls"
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("kind: Ingress");
    expect(result.stdout).toContain("host: s3-browser.internal.example");
    expect(result.stdout).toContain("secretName: s3-browser-tls");
  });

  it("renders with the documented existing secret override", () => {
    const result = render(["--set", "existingSecret.name=deployment-secrets"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("name: deployment-secrets");
  });
});
