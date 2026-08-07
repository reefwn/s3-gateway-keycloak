# Operator Index UX/UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the application-owned sign-in page and authenticated S3 browser so daily bucket selection and object browsing are fast, context-rich, and visually minimal.

**Architecture:** Keep NextAuth, S3 APIs, audit operations, and authorization contracts unchanged. Add a custom `/sign-in` page through NextAuth’s `pages.signIn` option, establish shared warm-minimal visual primitives, and refactor the client browser into an Operator index that derives prefix context and filtered, folder-first rows from its existing listing response.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, shadcn/Radix primitives, Vitest, Testing Library.

## Global Constraints

- Redesign only application-owned pages: `/sign-in` and the authenticated workspace. Keycloak-hosted pages remain unchanged.
- Preserve the existing S3 API, audit-event flow, transfer limits, auth session contract, bucket allowlist, and role capability rules.
- Use warm bone `#F7F6F3`/white surfaces, charcoal text, exact 1px `#EAEAEA` structure, crisp 8px/12px radii, and no gradients or heavy shadows.
- Do not use Inter, Roboto, Open Sans, Lucide, Feather, Heroicons, emojis, large rounded containers, or generic colored SaaS panels in redesigned surfaces.
- Use system/Geist-style sans, an editorial serif stack for display headings, and monospace for keys and metadata.
- Use muted pastel accents only for role, status, and destructive context.
- Respect `prefers-reduced-motion`; only animate `opacity` and `transform`.
- Client-side request failures must produce a generic inline action message rather than an unhandled promise rejection.

---

### Task 1: Establish the warm-minimal visual foundation and local icon set

**Files:**
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Modify: `components/ui/button.tsx`
- Modify: `components/ui/card.tsx`
- Modify: `components/ui/badge.tsx`
- Modify: `components/ui/input.tsx`
- Create: `components/ui-icons.tsx`

**Interfaces:**
- Produces: `WorkspaceIcon` components `BucketIcon`, `FolderIcon`, `UploadIcon`, `RefreshIcon`, `ArchiveIcon`, `SearchIcon`, `ChevronLeftIcon`, and `TrashIcon` with `React.SVGProps<SVGSVGElement>`.
- Produces: application-wide CSS variables for warm canvas, surface, structural border, and semantic pastel colors.
- Consumes: existing shadcn `Button`, `Card`, `Badge`, and `Input` contracts without changing their public props.

- [ ] **Step 1: Add the failing component-contract assertions**

Create `components/ui-icons.test.tsx` to render an icon and verify it is decorative and scalable:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BucketIcon } from "@/components/ui-icons";

describe("workspace icons", () => {
  it("renders a decorative SVG that accepts a class name", () => {
    render(<BucketIcon className="size-4" />);
    expect(screen.getByTestId("bucket-icon")).toHaveClass("size-4");
    expect(screen.getByTestId("bucket-icon")).toHaveAttribute("aria-hidden", "true");
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bunx vitest run components/ui-icons.test.tsx`

Expected: FAIL because `@/components/ui-icons` does not exist.

- [ ] **Step 3: Add the local SVG icon components**

Create `components/ui-icons.tsx` with a shared renderer and thick, simple SVG paths. Each icon must set `aria-hidden="true"`, `focusable="false"`, `fill="none"`, `stroke="currentColor"`, and `strokeWidth="1.8"`; `BucketIcon` must expose `data-testid="bucket-icon"` for the focused test. Do not import an icon library.

```tsx
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function BucketIcon(props: IconProps) {
  return <svg data-testid="bucket-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}><path d="M4 8.5 12 4l8 4.5v8L12 21l-8-4.5v-8Z" /><path d="m4 8.5 8 4.5 8-4.5" /></svg>;
}
```

Implement the remaining icons with the same SVG contract and concise names.

- [ ] **Step 4: Apply the visual tokens and primitive styling**

In `app/globals.css`, replace neutral-only root values with warm equivalents and add explicit custom variables:

```css
:root {
  --background: #f7f6f3;
  --foreground: #2f3437;
  --card: #ffffff;
  --border: #eaeaea;
  --muted: #f1f0ed;
  --muted-foreground: #787774;
  --role-readonly: #e1f3fe;
  --role-readwrite: #edf3ec;
  --role-admin: #fbf3db;
  --status-error: #fdebec;
  --radius: 0.5rem;
}

body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; line-height: 1.6; }
.font-editorial { font-family: Iowan Old Style, Baskerville, Georgia, serif; letter-spacing: -0.03em; line-height: 1.1; }
.font-metadata { font-family: "SFMono-Regular", Menlo, Consolas, monospace; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; scroll-behavior: auto !important; } }
```

Update primitives so cards use an explicit `border border-[#eaeaea]`, 8px/12px radii, and no `ring` shadow substitute; default buttons use `rounded-md bg-[#111] text-white hover:bg-[#333] active:scale-[0.98]`; badges retain their small pill form and use uppercase tracked text; inputs use 1px border, 6px radius, and warm focus treatment. Remove all Lucide-specific descendant selectors from `Button`.

Set `metadata.title` to `S3 Browser — Internal Storage` and wrap the layout body with `className="min-h-screen bg-background antialiased"`.

- [ ] **Step 5: Run focused tests and static checks**

Run:

```bash
bunx vitest run components/ui-icons.test.tsx
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 6: Commit the foundation task**

```bash
git add app/globals.css app/layout.tsx components/ui components/ui-icons.tsx components/ui-icons.test.tsx
git commit -m "feat: establish operator index visual foundation"
```

### Task 2: Replace the default NextAuth sign-in surface

**Files:**
- Modify: `auth.ts`
- Create: `app/sign-in/page.tsx`
- Create: `components/sign-in-panel.tsx`
- Create: `components/sign-in-panel.test.tsx`

**Interfaces:**
- Produces: NextAuth configuration with `pages: { signIn: "/sign-in" }`.
- Produces: `SignInPanel`, a client component that calls `signIn("keycloak", { callbackUrl: "/" })`.
- Consumes: existing `getAuthOptions()` and Keycloak provider unchanged.

- [ ] **Step 1: Write failing sign-in component tests**

Mock `next-auth/react` and assert the exact accessible copy and provider call:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInPanel } from "@/components/sign-in-panel";

const signIn = vi.fn();
vi.mock("next-auth/react", () => ({ signIn }));

describe("SignInPanel", () => {
  it("starts the Keycloak sign-in flow back to the workspace", () => {
    render(<SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Keycloak" }));
    expect(signIn).toHaveBeenCalledWith("keycloak", { callbackUrl: "/" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run components/sign-in-panel.test.tsx`

Expected: FAIL because `SignInPanel` is not defined.

- [ ] **Step 3: Implement the application-owned sign-in page**

Create `SignInPanel` as a client component with a small `Internal storage` label, an editorial `S3 Browser` heading, a concise sentence describing approved-bucket access, and a single default button labelled `Continue with Keycloak`. Use `signIn` only in its click handler. Include a small security note: `Access is recorded and governed by your assigned role.`

Create `app/sign-in/page.tsx` to render the panel in a centered, max-width layout over the warm canvas. Do not include credential fields, Keycloak replicas, gradients, or external imagery.

Update `getAuthOptions()`:

```ts
return {
  pages: { signIn: "/sign-in" },
  providers: [/* existing Keycloak provider */],
  // existing session, jwt, and callbacks unchanged
};
```

- [ ] **Step 4: Run the focused test and build route validation**

Run:

```bash
bunx vitest run components/sign-in-panel.test.tsx
bun run build
```

Expected: the test passes and build output includes `/sign-in`.

- [ ] **Step 5: Commit the sign-in task**

```bash
git add auth.ts app/sign-in/page.tsx components/sign-in-panel.tsx components/sign-in-panel.test.tsx
git commit -m "feat: add application sign-in surface"
```

### Task 3: Add testable object-browser view-model helpers

**Files:**
- Create: `lib/objects/operator-index.ts`
- Create: `lib/objects/operator-index.test.ts`

**Interfaces:**
- Produces: `parentPrefix(prefix: string): string`, `prefixSegments(prefix: string): readonly string[]`, and `filterAndSortListing(listing, query)`.
- Consumes: listing entries shaped as `{ key: string; size: number; lastModified?: string }` and folder prefixes as strings.
- Produces: folder-first filtered rows without mutating the API response.

- [ ] **Step 1: Write failing helper tests**

```ts
import { describe, expect, it } from "vitest";
import { filterAndSortListing, parentPrefix, prefixSegments } from "@/lib/objects/operator-index";

describe("operator index helpers", () => {
  it("returns a parent prefix and display segments", () => {
    expect(parentPrefix("reports/2026/january/")).toBe("reports/2026/");
    expect(prefixSegments("reports/2026/january/")).toEqual(["reports", "2026", "january"]);
  });

  it("filters case-insensitively and keeps folders before objects", () => {
    const result = filterAndSortListing({
      prefixes: ["reports/Archive/"],
      objects: [{ key: "reports/annual.pdf", size: 8 }, { key: "reports/brief.txt", size: 2 }]
    }, "AN");
    expect(result).toEqual({ prefixes: ["reports/Archive/"], objects: [{ key: "reports/annual.pdf", size: 8 }] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run lib/objects/operator-index.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement pure browse helpers**

Use slash-delimited prefix normalization. `parentPrefix("")` must return `""`; otherwise strip the trailing slash, remove the final segment, and return `""` or the remaining segments plus one trailing slash. `filterAndSortListing` must lowercase the query, match folder labels and object keys, sort each collection with `localeCompare`, and return new arrays without modifying its input.

- [ ] **Step 4: Run focused helper tests**

Run: `bunx vitest run lib/objects/operator-index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the view-model task**

```bash
git add lib/objects/operator-index.ts lib/objects/operator-index.test.ts
git commit -m "feat: add operator index browse helpers"
```

### Task 4: Refactor the S3 browser into the Operator index

**Files:**
- Modify: `components/s3-browser.tsx`
- Modify: `components/s3-browser.test.tsx`
- Modify: `components/ui/table.tsx` only if needed for compact table spacing

**Interfaces:**
- Consumes: `Actor`, allowed bucket strings, existing `/api/objects/[bucket]` response, and the Task 3 helpers.
- Produces: persistent bucket navigation, selected bucket/prefix context, a client-side finder, folder-first rows, inline states, and role-gated controls.
- Preserves: `S3Browser({ actor, buckets })`, API endpoint shapes, exact-key delete confirmation, and existing action form field names.

- [ ] **Step 1: Extend component tests before refactoring**

Mock `global.fetch` and add these tests to `components/s3-browser.test.tsx`:

```tsx
it("selects a bucket and renders prefix context after loading", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ objects: [], prefixes: [] }), { status: 200 })));
  render(<S3Browser actor={{ sub: "u1", username: "sam", email: null, role: "readonly" }} buckets={["reports"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));
  expect(await screen.findByText("Prefix: /" )).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Find objects" })).toBeInTheDocument();
});

it("shows a generic inline message when a browse request rejects", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
  render(<S3Browser actor={{ sub: "u1", username: "sam", email: null, role: "readonly" }} buckets={["reports"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Browse reports" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Could not load this bucket. Try again.");
});
```

Keep existing readonly/readwrite coverage. Add an admin render assertion that the table action column is only present for admin after listing data loads.

- [ ] **Step 2: Run component tests to verify the new expectations fail**

Run: `bunx vitest run components/s3-browser.test.tsx`

Expected: FAIL because the finder and client failure message do not exist.

- [ ] **Step 3: Implement stable browse state and generic request handling**

Replace each direct action `fetch` path with a narrow `try/catch`. Preserve API error parsing for normal non-2xx responses, but map rejected requests to exact generic messages:

```ts
try {
  const response = await fetch(url, options);
  // preserve the current success and JSON-error behavior
} catch {
  setStatus("Upload could not be completed. Try again.");
}
```

Use `Could not load this bucket. Try again.`, `Folder could not be created. Try again.`, and `Delete could not be completed. Try again.` for their respective actions. Never expose browser, S3, or network error details.

For successful browse calls, set selected bucket and requested prefix before rendering the listing result, clear the previous listing while loading, and render a compact `Loading objects…` state. Maintain `isLoading` state so inactive actions do not imply completion.

- [ ] **Step 4: Replace the layout with the Operator index**

Implement this semantic structure in `S3Browser`:

```tsx
<main className="mx-auto min-h-screen max-w-7xl px-4 py-6 md:px-8 md:py-10">
  <header>{/* product title, role badge, operator context */}</header>
  <section className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
    <nav aria-label="Approved buckets">{/* persistent bucket buttons */}</nav>
    <section aria-label="Object browser">
      {/* bucket title, prefix breadcrumb, finder, contextual actions, listing region */}
    </section>
  </section>
</main>
```

Use `BucketIcon`, `FolderIcon`, `UploadIcon`, `RefreshIcon`, `ArchiveIcon`, `SearchIcon`, `ChevronLeftIcon`, and `TrashIcon` from Task 1. Replace the Lucide import completely.

The selected area must display:

- `reports`-style bucket title and `Prefix: /` at root;
- a parent button when `parentPrefix(prefix) !== prefix`;
- segment breadcrumbs from `prefixSegments(prefix)` where each preceding segment is a browse target;
- an input with `aria-label="Find objects"` that filters only the current loaded listing;
- `N items` based on visible folders plus objects;
- folders before objects using `filterAndSortListing`;
- a stable empty message `No objects or folders at this location.` when the selected listing has no visible entries;
- last-modified data where supplied, formatted with `Intl.DateTimeFormat` and a `—` fallback.

Move writable controls into a contextual operations panel directly beneath the selected header. Keep their existing `name` values (`file`, `objectName`, `overwrite`, `folderName`) and upload size check. Do not show the panel to readonly users. Keep the delete dialog, but use `TrashIcon` and preserve exact-key confirmation.

On screens below the `lg` breakpoint, render the bucket buttons above the listing as a horizontal scrolling nav; on `lg` and larger screens use the persistent rail.

- [ ] **Step 5: Run focused tests, then the complete non-DB suite**

Run:

```bash
bunx vitest run components/s3-browser.test.tsx lib/objects/operator-index.test.ts
bun run lint
bun run typecheck
bun run build
```

Expected: all commands pass. If `bun run test` cannot reach the sandbox-blocked PostgreSQL socket, record its unit-test count and the exact environmental failure separately; do not treat it as a UI regression.

- [ ] **Step 6: Commit the Operator index task**

```bash
git add components/s3-browser.tsx components/s3-browser.test.tsx components/ui/table.tsx lib/objects/operator-index.ts lib/objects/operator-index.test.ts
git commit -m "feat: redesign S3 browser as operator index"
```

### Task 5: Validate application-owned routes and document the new operator flow

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-06-operator-index-ux-design.md` only if implementation decisions require an explicit clarification

**Interfaces:**
- Consumes: completed sign-in route and Operator index.
- Produces: operator-facing local verification guidance without changing deployment configuration.

- [ ] **Step 1: Write the local UX verification checklist in README**

Under `## Local development`, add a concise `### Operator UI verification` subsection with these exact checks:

```markdown
1. Open `http://localhost:3000`; the application-owned sign-in page shows one `Continue with Keycloak` action.
2. Sign in as `s3-readonly`; select a bucket, browse a prefix, filter the current listing, and confirm no upload/create/delete controls appear.
3. Sign in as `s3-readwrite`; select a bucket and confirm upload and folder controls become available.
4. Sign in as `s3-admin`; confirm deleting an object requires the exact object key.
```

- [ ] **Step 2: Run static documentation and route verification**

Run:

```bash
git diff --check
bun run build
```

Expected: no whitespace errors and build output includes `/sign-in`.

- [ ] **Step 3: Perform manual browser verification when Chrome Debug is available**

Verify the four README checks using manually selected files for any upload scenario. Do not use automated CDP file chooser upload because the current Chrome Debug bridge can terminate its renderer before the request reaches the app.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/superpowers/specs/2026-08-06-operator-index-ux-design.md
git commit -m "docs: describe operator index verification"
```

## Plan Self-Review

- Spec coverage: Task 1 implements visual constraints and icon policy; Task 2 implements the application-owned sign-in page; Task 3 defines isolated browse transformations; Task 4 implements fast bucket/object workflows, roles, responsive layout, and generic client failure handling; Task 5 documents and manually validates all application-owned pages.
- Scope: Keycloak, APIs, audit, transfer limits, S3 behavior, and deployment configuration are explicitly preserved.
- Placeholders: scanned for unresolved markers and vague implementation instructions; all code-changing tasks include exact interfaces, focused test commands, and expected results.
- Type consistency: `filterAndSortListing`, `parentPrefix`, and `prefixSegments` are defined in Task 3 and consumed with the same names in Task 4. `SignInPanel` is defined in Task 2 and tested under the same name.
