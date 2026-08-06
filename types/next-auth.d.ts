import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      sub: string;
      role: "admin" | "readwrite" | "readonly";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: "admin" | "readwrite" | "readonly";
    username?: string | null;
  }
}
