import type { NextAuthOptions } from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";

import { loadConfig } from "@/lib/config";
import { actorFromProfile } from "@/lib/auth/session";

export function getAuthOptions(): NextAuthOptions {
  const config = loadConfig();

  return {
    pages: {
      signIn: "/sign-in",
    },
    providers: [
      KeycloakProvider({
        clientId: config.keycloakClientId,
        clientSecret: config.keycloakClientSecret,
        issuer: config.keycloakIssuer
      })
    ],
    secret: config.nextAuthSecret,
    session: {
      strategy: "jwt",
      maxAge: 8 * 60 * 60,
      updateAge: 5 * 60
    },
    jwt: {
      maxAge: 5 * 60
    },
    callbacks: {
      async signIn({ profile }) {
        return actorFromProfile(profile, config.roleClaim, config.roleMapping) !== null;
      },
      async jwt({ token, profile }) {
        if (profile) {
          const actor = actorFromProfile(profile, config.roleClaim, config.roleMapping);

          if (!actor) return token;

          token.sub = actor.sub;
          token.email = actor.email;
          token.name = actor.username;
          token.username = actor.username;
          token.role = actor.role;
        }

        return token;
      },
      async session({ session, token }) {
        if (!token.sub || !token.role) return session;

        session.user = {
          ...session.user,
          sub: token.sub,
          role: token.role,
          name: typeof token.name === "string" ? token.name : null,
          email: typeof token.email === "string" ? token.email : null
        };

        return session;
      }
    }
  };
}
