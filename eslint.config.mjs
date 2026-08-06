import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".impeccable/**",
    ".next/**",
    "coverage/**",
    "db/migrations/meta/**",
    "next-env.d.ts"
  ])
]);
