import type { NextAuthOptions } from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";

import { loadConfig } from "@/lib/config";
import { actorFromProfile } from "@/lib/auth/session";

export function getAuthOptions(): NextAuthOptions {
  const config = loadConfig();

  // NextAuth infers cookie `secure` from whether NEXTAUTH_URL is HTTPS. When
  // ALLOW_INSECURE_HTTP is set for a trusted internal-network deployment (see
  // lib/config.ts), NEXTAUTH_URL is intentionally HTTP, so that inference
  // would otherwise mark the session/callback cookies `secure: true` and the
  // browser would silently drop them — sign-in would appear to succeed but
  // never actually authenticate. Override explicitly to keep behavior
  // consistent with the HTTPS check we already relaxed.
  const useSecureCookies = !config.allowsInsecureHttp && !config.isLocalDevelopment;
  const cookiePrefix = useSecureCookies ? "__Secure-" : "";

  return {
    pages: {
      signIn: "/sign-in",
    },
    useSecureCookies,
    cookies: {
      sessionToken: {
        name: `${cookiePrefix}next-auth.session-token`,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: useSecureCookies
        }
      }
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
