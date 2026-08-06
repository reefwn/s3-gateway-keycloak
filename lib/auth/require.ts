import "server-only";

import { getServerSession } from "next-auth";

import { getAuthOptions } from "@/auth";
import type { Capability } from "@/lib/auth/roles";
import { can } from "@/lib/auth/roles";
import type { Actor } from "@/lib/auth/session";

export class AccessDeniedError extends Error {
  constructor() {
    super("Not found or not permitted");
    this.name = "AccessDeniedError";
  }
}

export async function getCurrentActor(): Promise<Actor> {
  const session = await getServerSession(getAuthOptions());

  if (!session?.user?.sub || !session.user.role) throw new AccessDeniedError();

  return {
    sub: session.user.sub,
    username: session.user.name ?? null,
    email: session.user.email ?? null,
    role: session.user.role
  };
}

export async function requireCapability(capability: Capability): Promise<Actor> {
  const actor = await getCurrentActor();

  if (!can(actor.role, capability)) throw new AccessDeniedError();

  return actor;
}
