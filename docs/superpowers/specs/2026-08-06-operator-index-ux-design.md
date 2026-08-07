# Operator Index UX/UI Redesign

## Goal

Redesign every application-owned page—the NextAuth sign-in screen and the authenticated S3 workspace—to make selecting an approved bucket and finding or browsing an object the fastest daily workflow. Keycloak-hosted pages are out of scope.

## Product principles

- Optimize for repeat internal operators on desktop while preserving a focused responsive layout.
- Make bucket, prefix, and current object context visible at all times.
- Keep role permissions intact: readonly can browse/download, readwrite can upload/create folders, and admin can delete after exact-key confirmation.
- Preserve existing API, audit, transfer-limit, S3, and authentication behavior. This is a presentation and interaction redesign, not a backend feature change.

## Information architecture

### Sign-in page

- Present one quiet application-owned entry page at `/api/auth/signin`.
- Show product identity, a concise internal-storage statement, security context, and one Keycloak sign-in action.
- Do not recreate or restyle Keycloak-hosted pages.

### Authenticated workspace: Operator index

- Use a persistent bucket rail on wide screens. Each allowed bucket is a directly selectable destination with a clear current selection.
- The primary workspace header contains the selected bucket, a breadcrumb-like prefix trail, object count, and a client-side object finder scoped to the current listing.
- Render folders before objects in a compact, scan-first table with name, type, size, and last-modified data where available.
- Keep browse state stable: selecting a folder updates the prefix context without moving the bucket rail; a parent affordance returns one level.
- Show upload, create-folder, refresh, and prefix-ZIP controls only in the selected-bucket context and only when the actor role permits them.
- Present empty, loading, and recoverable error states inside the listing region so the page does not shift.

## Visual direction: Premium utilitarian minimalism

- Use a warm bone application canvas, white surfaces, charcoal text, and exact 1px light dividers.
- Use crisp 8px or 12px corner radii, generous whitespace, and nearly shadowless surfaces. Do not use gradients, large colored panels, glass effects, or heavy shadows.
- Use a characterful system/Geist-style sans for UI, a restrained editorial serif for the sign-in and workspace display heading, and monospace for keys and metadata.
- Use pale blue, green, yellow, and red only as small semantic accents for role/status/destructive context.
- Replace Lucide usage within redesigned surfaces with consistent inline SVG or Radix-style primitives; do not add a generic thin-line icon library.
- Use quiet opacity/transform-only micro-interactions for row hover, selection, and state transitions. Respect reduced-motion preferences.

## Responsive behavior

- On narrow screens, collapse the bucket rail into a compact bucket selector before reducing the browsing table.
- Preserve object name, bucket/prefix context, and search. Hide lower-priority metadata before hiding primary information.
- Keep destructive confirmation and transfer status accessible without modal layering conflicts.

## Error and transfer feedback

- Represent uploads and folder creation in the relevant workspace area with clear inline progress/outcome text.
- Catch client-side request failures and display a generic action-specific failure message rather than allowing an unhandled browser rejection.
- Keep the exact-key deletion confirmation workflow and its generic error treatment intact.

## Verification

- Component tests cover bucket selection, current-prefix context, filtered listing, permission-gated actions, and the friendly client request-failure state.
- Existing S3, authentication, authorization, audit, transfer, and integration tests remain green.
- Browser checks validate sign-in, readonly browsing/downloading controls, readwrite selection/upload controls, and admin deletion confirmation.
- Verify wide and narrow layouts, keyboard focus order, reduced-motion behavior, and no regressions in loading/empty/error states.
