"use client";

import { signIn } from "next-auth/react";

import { Button } from "@/components/ui/button";

export function SignInPanel() {
  return (
    <section className="w-full max-w-md border border-[#eaeaea] bg-white p-7 sm:p-9">
      <p className="font-metadata text-xs uppercase tracking-[0.18em] text-muted-foreground">
        Internal storage
      </p>
      <h1 className="font-editorial mt-5 text-4xl leading-none tracking-tight text-foreground sm:text-5xl">
        S3 Browser
      </h1>
      <p className="mt-5 max-w-sm text-sm leading-6 text-muted-foreground">
        Browse object storage with the permissions assigned to your role.
      </p>
      <Button
        className="mt-8 w-full"
        onClick={() => signIn("keycloak", { callbackUrl: "/" })}
        type="button"
      >
        Continue with Keycloak
      </Button>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Access is recorded and governed by your assigned role.
      </p>
    </section>
  );
}
