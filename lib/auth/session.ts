import type { AppRole } from "@/lib/auth/roles";
import { resolveRole } from "@/lib/auth/roles";

export type Actor = Readonly<{
  sub: string;
  username: string | null;
  email: string | null;
  role: AppRole;
}>;

export function readClaim(profile: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;

    return (value as Record<string, unknown>)[segment];
  }, profile);
}

export function actorFromProfile(
  profile: unknown,
  roleClaim: string,
  roleMapping: Readonly<Record<string, AppRole>>
): Actor | null {
  if (profile === null || typeof profile !== "object") return null;

  const claims = profile as Record<string, unknown>;
  const sub = claims.sub;
  const role = resolveRole(readClaim(profile, roleClaim), roleMapping);

  if (typeof sub !== "string" || sub.length === 0 || !role) return null;

  return {
    sub,
    username: typeof claims.preferred_username === "string" ? claims.preferred_username : null,
    email: typeof claims.email === "string" ? claims.email : null,
    role
  };
}
