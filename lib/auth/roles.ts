export type AppRole = "admin" | "readwrite" | "readonly";

export type Capability = "list" | "download" | "upload" | "createPrefix" | "delete";

const capabilities: Readonly<Record<AppRole, readonly Capability[]>> = {
  readonly: ["list", "download"],
  readwrite: ["list", "download", "upload", "createPrefix"],
  admin: ["list", "download", "upload", "createPrefix", "delete"]
};

// Ascending privilege order — used to pick the highest role when a user's
// claim resolves to more than one. Kept separate from `capabilities`'
// object-key order (which happens to match today, but key order isn't a
// contract) so this ranking is explicit and doesn't silently break if
// `capabilities` is ever reordered or restructured.
const roleRank: readonly AppRole[] = ["readonly", "readwrite", "admin"];

export function resolveRole(claimValue: unknown, mapping: Readonly<Record<string, AppRole>>): AppRole | null {
  const values = Array.isArray(claimValue) ? claimValue : [claimValue];
  const matchedRoles = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => mapping[value])
    .filter((role): role is AppRole => role !== undefined);

  if (matchedRoles.length === 0) return null;

  // A user's Keycloak group memberships are shared across every client in
  // this realm, not just this app — a user with legitimate reasons to hold
  // multiple roles on other clients (e.g. one group grants readwrite,
  // another grants admin) will end up with more than one of this app's
  // roles too. Rather than reject that as ambiguous, grant the highest
  // privilege among the matched roles: it's never less permissive than
  // what any single matched role alone would allow, so it can't grant
  // access a user wasn't already entitled to via at least one assignment.
  return matchedRoles.reduce((highest, role) =>
    roleRank.indexOf(role) > roleRank.indexOf(highest) ? role : highest
  );
}

export function can(role: AppRole, capability: Capability): boolean {
  return capabilities[role].includes(capability);
}
