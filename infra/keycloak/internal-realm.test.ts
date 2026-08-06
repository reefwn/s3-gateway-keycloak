import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local Keycloak realm", () => {
  it("creates the app client and one user for each application role", async () => {
    const realm = JSON.parse(await readFile("infra/keycloak/internal-realm.json", "utf8"));
    const client = realm.clients.find((entry: { clientId: string }) => entry.clientId === "s3-browser");

    expect(realm.realm).toBe("internal");
    expect(client).toBeDefined();
    expect(client!.redirectUris).toEqual(["http://localhost:3000/api/auth/callback/keycloak"]);
    expect(client!.clientAuthenticatorType).toBe("client-secret");
    expect(client!).not.toHaveProperty("roles");
    expect(realm.roles.client["s3-browser"]).toEqual([
      { name: "s3-browser-admin" },
      { name: "s3-browser-readwrite" },
      { name: "s3-browser-readonly" },
    ]);
    expect(realm.users.map((user: {
      username: string;
      enabled: boolean;
      credentials: Array<{ type: string; value: string; temporary: boolean }>;
      clientRoles: Record<string, string[]>;
    }) => ({
      username: user.username,
      enabled: user.enabled,
      credentials: user.credentials,
      clientRoles: user.clientRoles,
    }))).toEqual([
      {
        username: "s3-readonly",
        enabled: true,
        credentials: [{ type: "password", value: "local-readonly-password", temporary: false }],
        clientRoles: { "s3-browser": ["s3-browser-readonly"] },
      },
      {
        username: "s3-readwrite",
        enabled: true,
        credentials: [{ type: "password", value: "local-readwrite-password", temporary: false }],
        clientRoles: { "s3-browser": ["s3-browser-readwrite"] },
      },
      {
        username: "s3-admin",
        enabled: true,
        credentials: [{ type: "password", value: "local-admin-password", temporary: false }],
        clientRoles: { "s3-browser": ["s3-browser-admin"] },
      },
    ]);
    expect(client!.protocolMappers).toHaveLength(1);
    expect(client!.protocolMappers[0]).toMatchObject({
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-client-role-mapper",
      config: {
        "claim.name": "resource_access.s3-browser.roles",
        "usermodel.clientRoleMapping.clientId": "s3-browser",
        "userinfo.token.claim": "true",
        "id.token.claim": "true",
        "access.token.claim": "true",
      },
    });
  });
});
