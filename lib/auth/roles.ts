export type AppRole = "admin" | "readwrite" | "readonly";

export type Capability = "list" | "download" | "upload" | "createPrefix" | "delete";

const capabilities: Readonly<Record<AppRole, readonly Capability[]>> = {
  readonly: ["list", "download"],
  readwrite: ["list", "download", "upload", "createPrefix"],
  admin: ["list", "download", "upload", "createPrefix", "delete"]
};

export function resolveRole(claimValue: unknown, mapping: Readonly<Record<string, AppRole>>): AppRole | null {
  const values = Array.isArray(claimValue) ? claimValue : [claimValue];
  const matchedRoles = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => mapping[value])
    .filter((role): role is AppRole => role !== undefined);

  return matchedRoles.length === 1 ? matchedRoles[0] : null;
}

export function can(role: AppRole, capability: Capability): boolean {
  return capabilities[role].includes(capability);
}
