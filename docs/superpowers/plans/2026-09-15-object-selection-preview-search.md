# Object Selection, Preview, and Bucket Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select visible files for one streamed ZIP download, preview a selected PDF or raster image in the browser, delete from the relevant object row, and search across the current approved bucket.

**Architecture:** Extend the existing same-origin object service and routes. S3 remains the only object store: the service lists pages to perform bounded bucket search, validates selected keys before building a streamed ZIP, and streams only allowlisted preview media. Route handlers retain the existing capability checks, transfer leases, audit attempt/outcome records, generic error responses, and no-store headers; the client owns only transient selection, query, and dialog state.

**Tech Stack:** Next.js App Router (Node runtime), React 19, TypeScript, AWS SDK v3, `archiver`, Vitest, Testing Library, Tailwind/shadcn primitives, Helm.

## Global Constraints

- Never expose S3/OIDC credentials or a presigned URL to browser JavaScript.
- Stream all object, preview, and ZIP bodies; do not buffer an object or archive on application disk or server memory.
- Use `requireCapability`, PostgreSQL-backed `download` leases, and durable audited attempt/outcome records for search, preview, and selected ZIP operations.
- Treat bucket and object keys sent by the browser as untrusted: enforce the deployment allowlist, reject empty/duplicate keys, and retain generic inaccessible-resource responses.
- `preview` permits only `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, and `image/avif`; do not preview SVG, HTML, text, office, audio, or video content.
- The select-all control applies only to visible object rows. Folders, bulk delete, recursive actions, and public URLs remain out of scope.
- Bound whole-bucket search by configuration: default to 100 returned matches and 25 scanned S3 pages; indicate partial results when either bound is reached.
- Keep the existing archive limits (`S3_ARCHIVE_MAX_OBJECTS`, `S3_ARCHIVE_MAX_BYTES`) for selected ZIPs as well as prefix ZIPs.

---

### Task 1: Add bounded search configuration and object-browser pure helpers

**Files:**

- Modify: `lib/config.ts`, `lib/config.test.ts`
- Modify: `lib/objects/operator-index.ts`, `lib/objects/operator-index.test.ts`
- Modify: `.env.example`, `charts/s3-browser/values.yaml`, `charts/s3-browser/values.schema.json`, `charts/s3-browser/templates/configmap.yaml`, `charts/s3-browser/tests/render.test.ts`

**Interfaces:**

- `AppConfig` gains `searchMaxResults: number` and `searchMaxPages: number`, populated by `S3_SEARCH_MAX_RESULTS` (default `100`) and `S3_SEARCH_MAX_PAGES` (default `25`), both positive integers.
- `OperatorSearchResult` is `Readonly<{ objects: readonly OperatorObject[]; truncated: boolean }>`.
- `isPreviewableKey(key: string): boolean` recognises only `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.avif`, case-insensitively.
- `containingPrefix(key: string): string` returns the slash-terminated parent prefix or `""`.

- [ ] **Step 1: Write failing configuration and helper tests**

  Add the following cases before modifying production code:

  ```ts
  it("uses bounded whole-bucket search defaults and rejects non-positive overrides", () => {
    expect(loadConfig(validEnvironment)).toMatchObject({ searchMaxResults: 100, searchMaxPages: 25 });
    expect(() => loadConfig({ ...validEnvironment, S3_SEARCH_MAX_RESULTS: "0" })).toThrow(/S3_SEARCH_MAX_RESULTS/i);
    expect(() => loadConfig({ ...validEnvironment, S3_SEARCH_MAX_PAGES: "-1" })).toThrow(/S3_SEARCH_MAX_PAGES/i);
  });

  it("recognises only PDF and raster-image preview filenames", () => {
    expect(isPreviewableKey("photos/Scan.JPEG")).toBe(true);
    expect(isPreviewableKey("reports/summary.pdf")).toBe(true);
    expect(isPreviewableKey("uploads/vector.svg")).toBe(false);
    expect(containingPrefix("reports/2026/summary.pdf")).toBe("reports/2026/");
    expect(containingPrefix("summary.pdf")).toBe("");
  });
  ```

- [ ] **Step 2: Verify the new tests fail for missing fields/functions**

  Run: `npm test -- lib/config.test.ts lib/objects/operator-index.test.ts`

  Expected: FAIL because `searchMaxResults`, `searchMaxPages`, `isPreviewableKey`, and `containingPrefix` do not yet exist.

- [ ] **Step 3: Implement the smallest configuration and helper surface**

  Add schema entries and frozen config output:

  ```ts
  S3_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).default(100),
  S3_SEARCH_MAX_PAGES: z.coerce.number().int().min(1).default(25),
  // ... AppConfig output
  searchMaxResults: raw.S3_SEARCH_MAX_RESULTS,
  searchMaxPages: raw.S3_SEARCH_MAX_PAGES,
  ```

  Implement helpers without inspecting object contents:

  ```ts
  const previewableSuffixes = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"];
  export const isPreviewableKey = (key: string) => previewableSuffixes.some((suffix) => key.toLocaleLowerCase().endsWith(suffix));
  export const containingPrefix = (key: string) => key.includes("/") ? `${key.split("/").slice(0, -1).join("/")}/` : "";
  ```

  Add the two environment variables to `.env.example`, Helm values/schema, and ConfigMap. Extend the existing Helm render assertion to check both emitted environment names.

- [ ] **Step 4: Verify this boundary is green**

  Run: `npm test -- lib/config.test.ts lib/objects/operator-index.test.ts charts/s3-browser/tests/render.test.ts && npm run typecheck`

  Expected: PASS with valid defaults/overrides, no invalid configuration accepted, and the render includes both search limits.

- [ ] **Step 5: Commit the bounded-search contract**

  ```bash
  git add lib/config.ts lib/config.test.ts lib/objects/operator-index.ts lib/objects/operator-index.test.ts .env.example charts/s3-browser
  git commit -m "feat: configure bounded bucket search"
  ```

### Task 2: Extend the S3 service for safe preview, selected archives, and bucket search

**Files:**

- Modify: `lib/s3/service.ts`, `lib/s3/service.test.ts`, `lib/s3/client.ts`
- Modify: `lib/http/route.ts`
- Create: `lib/http/route.test.ts`

**Interfaces:**

- `createS3Service` accepts `searchMaxResults?: number` and `searchMaxPages?: number`.
- `searchObjects(bucket: string, query: string): Promise<OperatorSearchResult>` lists without a delimiter, matches full object keys with a case-insensitive substring, and returns `{ objects, truncated }` after the result/page bound.
- `getPreviewObject(bucket: string, key: string): Promise<{ body: unknown; headers: Record<string, string> }>` calls `GetObjectCommand`, rejects non-previewable server-reported content types with `PreviewNotSupportedError`, and returns inline/no-store/no-sniff headers.
- `getSelectedArchive(bucket: string, keys: readonly string[]): Promise<{ stream: ZipArchive; objectCount: number; totalSize: number }>` validates a non-empty deduplicated key collection, gathers each selected object metadata/body, and applies archive size/count limits before streaming.
- Export `PreviewNotSupportedError` and `InvalidArchiveSelectionError`; map both to a generic 400 in `genericErrorResponse` without exposing keys or MIME values.

- [ ] **Step 1: Write failing S3 service tests**

  Add tests that exercise real returned values and AWS command inputs:

  ```ts
  it("searches full keys across pages case-insensitively and flags a page bound", async () => {
    const bounded = createS3Service({ client: { send }, allowedBuckets: ["reports"], objectMaxBytes: 1, searchMaxResults: 5, searchMaxPages: 1 });
    send.mockResolvedValueOnce({ Contents: [{ Key: "2026/Annual-REPORT.pdf", Size: 8 }], NextContinuationToken: "next" });
    await expect(bounded.searchObjects("reports", "report")).resolves.toEqual({
      objects: [{ key: "2026/Annual-REPORT.pdf", size: 8, lastModified: undefined }], truncated: true,
    });
    expect((send.mock.calls[0][0] as ListObjectsV2Command).input).not.toHaveProperty("Delimiter");
  });

  it("serves a server-verified PDF preview inline but rejects SVG", async () => {
    send.mockResolvedValueOnce({ Body: Readable.from("pdf"), ContentType: "application/pdf" });
    await expect(service.getPreviewObject("reports", "report.pdf")).resolves.toMatchObject({ headers: { "Content-Disposition": 'inline; filename="report.pdf"', "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
    send.mockResolvedValueOnce({ Body: Readable.from("svg"), ContentType: "image/svg+xml" });
    await expect(service.getPreviewObject("reports", "diagram.svg")).rejects.toThrow(PreviewNotSupportedError);
  });

  it("rejects duplicate selected keys before fetching an archive body", async () => {
    await expect(service.getSelectedArchive("reports", ["one.pdf", "one.pdf"])).rejects.toThrow(InvalidArchiveSelectionError);
    expect(send).not.toHaveBeenCalled();
  });
  ```

  Add a happy-path selected-archive test that confirms every `GetObjectCommand` receives exactly the submitted key, `objectCount`/`totalSize` are reported, and consuming `stream` yields ZIP bytes. Add failure tests for empty selection and archive count/byte limit before body reads.

- [ ] **Step 2: Verify the S3 tests are red**

  Run: `npm test -- lib/s3/service.test.ts`

  Expected: FAIL because the new service methods and error classes are absent.

- [ ] **Step 3: Implement strict service methods**

  Use one shared normalizer for a `ListObjectsV2Command` content entry so listing/search shape is identical. Search must trim the query, reject an empty value, use `query.toLocaleLowerCase()`, stop before requesting page `searchMaxPages + 1`, and set `truncated` when a continuation token remains or the result cap is reached.

  For preview, validate the safe key and allowed bucket first, then validate the actual S3 `ContentType` after `GetObjectCommand`; do not trust the filename alone. Return only these headers:

  ```ts
  {
    "Content-Disposition": `inline; filename="${attachmentFilename(safeKey)}"`,
    "Content-Type": output.ContentType,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  }
  ```

  For a selected archive, reject empty, duplicate, or unsafe keys before any network command. Call `HeadObjectCommand` for each key to validate total size/count before fetching every body with `GetObjectCommand`; append each returned `Readable` to `ZipArchive` under its full key, finalize once all bodies have been appended, and return counters. Add `HeadObjectCommand` to imports and use the deployment archive limits. Pass both search limits from `getS3Service` in `lib/s3/client.ts`.

- [ ] **Step 4: Map new expected failures without weakening generic errors**

  First add `lib/http/route.test.ts` cases for each new error class. Then implement `genericErrorResponse` so it returns `{ error: "Preview is not supported for this object" }` with status 415 for `PreviewNotSupportedError`, and `{ error: "Select one or more unique objects" }` with status 400 for `InvalidArchiveSelectionError`; each must include `Cache-Control: no-store`. Continue returning generic 404/500 responses for allowlist and S3 failures.

- [ ] **Step 5: Verify the service and HTTP error boundaries**

  Run: `npm test -- lib/s3/service.test.ts lib/http/route.test.ts && npm run typecheck`

  Expected: PASS; search is bounded, preview headers are inline/no-store/no-sniff, selected ZIP validation occurs before body retrieval, and no raw key is placed in an error response.

- [ ] **Step 6: Commit the service capabilities**

  ```bash
  git add lib/s3/service.ts lib/s3/service.test.ts lib/s3/client.ts lib/http/route.ts lib/http/route.test.ts
  git commit -m "feat: add selected ZIPs and safe object previews"
  ```

### Task 3: Add audited routes for search, selected ZIP downloads, and inline preview

**Files:**

- Modify: `app/api/objects/[bucket]/route.ts`
- Create: `app/api/objects/[bucket]/route.test.ts`
- Create: `app/api/selected-download/[bucket]/route.ts`, `app/api/selected-download/[bucket]/route.test.ts`
- Create: `app/api/object-preview/[bucket]/[...key]/route.ts`, `app/api/object-preview/[bucket]/[...key]/route.test.ts`

**Interfaces:**

- `GET /api/objects/:bucket?search=<query>` requires `list`, calls `searchObjects`, records action `search-objects` with the query as the audit `prefix`, and returns `OperatorSearchResult` with `Cache-Control: no-store`.
- `POST /api/selected-download/:bucket` accepts JSON `{ keys: string[] }`, origin-checks it, requires `download`, and streams a `selected-objects.zip` attachment.
- `GET /api/object-preview/:bucket/:key` requires `download` and streams `getPreviewObject` with its inline headers.

- [ ] **Step 1: Write failing route tests using module mocks**

  Follow the repository route-test pattern: mock `requireCapability`, `loadConfig`, `getS3Service`, `transferRepository`, and audited operation helpers, then call exported route handlers with a concrete `Request` and resolved `params`.

  ```ts
  it("audits a bucket search and returns its bounded result without caching", async () => {
    service.searchObjects.mockResolvedValue({ objects: [{ key: "2026/report.pdf", size: 4 }], truncated: false });
    const response = await GET(new Request("https://app.test/api/objects/reports?search=report"), { params: Promise.resolve({ bucket: "reports" }) });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ objects: [{ key: "2026/report.pdf" }] });
    expect(runAuditedOperation).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ action: "search-objects", prefix: "report" }) }), expect.any(Function));
  });

  it("rejects a selected ZIP body that is not a JSON key array", async () => {
    const response = await selectedDownloadPOST(new Request("https://app.test/api/selected-download/reports", { method: "POST", headers: { Origin: "https://app.test", "Content-Type": "application/json" }, body: JSON.stringify({ keys: "report.pdf" }) }), context);
    expect(response.status).toBe(400);
    expect(service.getSelectedArchive).not.toHaveBeenCalled();
  });

  it("leases, audits, and returns an inline preview stream", async () => {
    service.getPreviewObject.mockResolvedValue({ body: Readable.from("pdf"), headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="report.pdf"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    const response = await previewGET(new Request("https://app.test/api/object-preview/reports/report.pdf"), previewContext);
    expect(response.headers.get("Content-Disposition")).toContain("inline");
    expect(transferRepository.acquire).toHaveBeenCalledWith(expect.objectContaining({ type: "download" }));
  });
  ```

  Also cover missing/blank search as a normal prefix listing, unauthorised capability, denied lease (429), audit-attempt failure before S3, preview stream error releasing the lease and recording an outcome, and selected-ZIP stream error recording `objectCount` and `totalSize`.

- [ ] **Step 2: Verify route tests fail**

  Run: `npm test -- app/api/objects/[bucket]/route.test.ts app/api/selected-download/[bucket]/route.test.ts app/api/object-preview/[bucket]/[...key]/route.test.ts`

  Expected: FAIL because the search branch and selected/preview route modules do not exist.

- [ ] **Step 3: Implement the search branch in the existing list route**

  Extend the local `auditContext` helper to accept optional `prefix` as well as `objectKey`. Parse `search` once. When its trimmed form is non-empty, call `requireCapability("list")`, wrap `getS3Service().searchObjects(bucket, search)` in `runAuditedOperation`, and return it with the query stored only as audit `prefix`. Do not pass search through the normal prefix list path and do not emit the query in a browser error response. Preserve the existing listing, upload, and create-prefix behavior when `search` is absent.

- [ ] **Step 4: Implement selected ZIP streaming and audit lifecycle**

  Parse the POST JSON defensively into `{ keys: string[] }`; return the generic 400 selection error before acquiring a lease if it is malformed. Call `assertTrustedMutationOrigin`, acquire a `download` lease, then use `beginAuditedStream` with action `selected-download`, bucket, and a non-sensitive audit prefix such as `"selected:3"` rather than every submitted object key. Mirror the prefix-download `end`/`error`/`close` finalizer and return:

  ```ts
  {
    "Content-Type": "application/zip",
    "Content-Disposition": 'attachment; filename="selected-objects.zip"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }
  ```

- [ ] **Step 5: Implement preview streaming and audit lifecycle**

  Reuse the single-object download route's lease/finalizer structure, but call `getPreviewObject` and record action `preview`. Preserve exactly the service-provided headers. Ensure every pre-stream exception releases the lease and every terminal stream event attempts both outcome recording and release exactly once.

- [ ] **Step 6: Verify all API route behavior**

  Run: `npm test -- app/api/objects/[bucket]/route.test.ts app/api/selected-download/[bucket]/route.test.ts app/api/object-preview/[bucket]/[...key]/route.test.ts && npm run typecheck`

  Expected: PASS; routes have no-store responses, enforce roles/origin/leases, audit stream completion, and avoid exposing raw selected keys.

- [ ] **Step 7: Commit the API boundary**

  ```bash
  git add app/api/objects/[bucket]/route.ts app/api/objects/[bucket]/route.test.ts app/api/selected-download app/api/object-preview
  git commit -m "feat: expose audited search preview and selected downloads"
  ```

### Task 4: Implement MinIO-style selection, preview, search, and row deletion in the browser

**Files:**

- Modify: `components/s3-browser.tsx`, `components/s3-browser.test.tsx`, `components/ui-icons.tsx`

**Interfaces:**

- `S3Browser` maintains `selectedKeys: readonly string[]`, `searchResult: OperatorSearchResult | null`, `searchQuery`, and `previewKey: string | null`.
- `browse(bucket, prefix)` clears selection/search result before loading the prefix listing.
- A form POST to `/api/selected-download/:bucket` sends one hidden `keys` JSON field and targets the browser download, avoiding client-side blob buffering.

- [ ] **Step 1: Write failing user-facing component tests**

  Use a listing with two files and one folder. Assert actual accessible controls and state transitions:

  ```tsx
  it("selects only visible files and offers a ZIP download", async () => {
    renderBrowserWithListing();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select all visible files" }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download selected as ZIP" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /folder/i })).not.toBeInTheDocument();
  });

  it("offers preview only for one selected supported file", async () => {
    renderBrowserWithListing();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select photo.png" }));
    expect(screen.getByRole("button", { name: "Preview selected file" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview selected file" }));
    expect(screen.getByRole("dialog", { name: "Preview photo.png" })).toBeInTheDocument();
  });

  it("searches the selected bucket and opens a result's containing path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ objects: [{ key: "archive/2026/report.pdf", size: 4 }], truncated: false }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search this bucket" }), { target: { value: "report" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("search=report"), expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: "Open archive/2026/" }));
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("prefix=archive%2F2026%2F"), expect.anything());
  });
  ```

  Add tests that navigation, refresh, and a query change clear selection; that admins alone see `Delete <filename>` in the row; that no global delete control exists; and that unsupported/multiple selection has no Preview button.

- [ ] **Step 2: Verify the UI tests are red**

  Run: `npm test -- components/s3-browser.test.tsx`

  Expected: FAIL because selection controls, selected action panel, preview dialog, and bucket-search behavior do not exist.

- [ ] **Step 3: Refactor only the browser-local display helpers**

  Add `EyeIcon` and `DownloadIcon` to `components/ui-icons.tsx`. Keep `formatBytes`, `formatDate`, and request error parsing in `s3-browser.tsx`; do not split unrelated existing dialogs. Add a small `selectedObject` derivation from the current visible rows so a stale key cannot enable preview.

- [ ] **Step 4: Implement bucket-wide search with explicit result state**

  Change the finder label/placeholder to `Search this bucket`. Debounce a non-empty trimmed query by 300 ms with `useEffect`; fetch `/api/objects/${bucket}?search=${encodeURIComponent(query)}` and store `OperatorSearchResult`. While a query is active, render only search results, their containing path, and a `Open <path>` button. Render `Results are partial. Refine your search.` when `truncated` is true. On a result navigation, clear query/results/selection and call `browse(bucket, containingPrefix(key))`. Keep normal prefix listing untouched when the query is empty.

- [ ] **Step 5: Implement selection and selected-ZIP download without a response blob**

  Put a named checkbox in every object row and a tri-state select-all checkbox in the table header. Use the current visible object keys as the only select-all set. Render an `aside` labelled `Selected objects` beside/below the table with count, `Download selected as ZIP`, `Preview selected file` when `selectedKeys.length === 1 && isPreviewableKey(selectedKeys[0])`, and `Clear selection`.

  For ZIP download, construct and submit a temporary same-origin form rather than `fetch`:

  ```ts
  const form = document.createElement("form");
  form.method = "post";
  form.action = `/api/selected-download/${encodeURIComponent(selectedBucket)}`;
  const input = document.createElement("input");
  input.name = "keys";
  input.value = JSON.stringify(selectedKeys);
  form.append(input);
  document.body.append(form);
  form.submit();
  form.remove();
  ```

  Update Task 3's selected-download route to accept either this form value or JSON, validate it identically, and retain origin checks.

- [ ] **Step 6: Implement an isolated preview dialog and per-row delete labels**

  Reuse the existing `Dialog` primitives. For a selected `.pdf`, render `<iframe sandbox="" title={`Preview ${filename}`} src={previewUrl} className="h-[70vh] w-full" />`; for a raster image render `<img alt={`Preview ${filename}`} src={previewUrl} />`. The `previewUrl` must be the authenticated same-origin preview route with every key segment `encodeURIComponent` encoded. Close clears `previewKey` without changing selection.

  Move the admin deletion button into its object row and make its accessible name `Delete ${filename}`. Continue setting `deleteKey` and reuse the exact-key alert dialog unchanged; omit all delete actions from the selection panel and non-admin rows.

- [ ] **Step 7: Verify browser behavior and regression suite**

  Run: `npm test -- components/s3-browser.test.tsx lib/objects/operator-index.test.ts && npm run lint && npm run typecheck`

  Expected: PASS; the UI is keyboard-accessible, selection never includes folders/stale keys, ZIP uses the POST download endpoint, PDF/image preview is constrained to a dialog, search navigates correctly, and delete remains admin-only and exact-key-confirmed.

- [ ] **Step 8: Commit the browser interaction update**

  ```bash
  git add components/s3-browser.tsx components/s3-browser.test.tsx components/ui-icons.tsx app/api/selected-download/[bucket]/route.ts app/api/selected-download/[bucket]/route.test.ts
  git commit -m "feat: add object selection preview and bucket search UI"
  ```

### Task 5: Align requirements and perform production-grade verification

**Files:**

- Modify: `docs/s3-browser-tool-requirements.md`, `README.md`
- Modify if verification exposes configuration drift: `charts/s3-browser/tests/render.test.ts`, `scripts/verify-production-image.sh`

**Interfaces:**

- Documentation states that previews are limited to authenticated PDF/raster-image streams and that search is bounded by `S3_SEARCH_MAX_RESULTS` and `S3_SEARCH_MAX_PAGES`.
- Existing deployment contract remains explicit: no static production AWS credentials, no public download/preview URL, and archive/transfer limits apply to selected ZIPs.

- [ ] **Step 1: Write failing documentation/contract assertions where automated coverage exists**

  Extend the Helm render test with explicit assertions for `S3_SEARCH_MAX_RESULTS` and `S3_SEARCH_MAX_PAGES`; add a test input overriding them and assert its rendered values. If `verify-production-image.sh` asserts environment names, add both names there too.

- [ ] **Step 2: Run the focused verification and confirm red state**

  Run: `npm test -- charts/s3-browser/tests/render.test.ts`

  Expected: FAIL until the chart/configmap forwards both new deployment values.

- [ ] **Step 3: Document the revised product boundary**

  Replace the earlier blanket "no inline previews" non-goal in `docs/s3-browser-tool-requirements.md` with the exact constrained behavior: authenticated same-origin PDF/raster preview, server media-type allowlist, inline/no-store/nosniff headers, no SVG/HTML/video/office preview, and no public URL. Document selected-file ZIP download, per-row admin delete, and bounded current-bucket key search. In `README.md`, describe the two search configuration variables and their defaults.

- [ ] **Step 4: Run the complete quality gate**

  Run:

  ```bash
  npm test
  npm run lint
  npm run typecheck
  npm run build
  ```

  Expected: all commands exit 0. If a test fails, fix the implementation/test mismatch before proceeding; do not suppress or skip a test.

- [ ] **Step 5: Manually verify the critical browser flow against local S3**

  Start the local stack using the documented development command. In an approved local bucket, upload one PDF, one PNG, one non-previewable file, and a nested object. Verify: search finds the nested object and opens its path; select-all skips folders; selected ZIP downloads; PDF/PNG preview opens without an attachment download; unsupported selection lacks Preview; an admin must type the exact key to delete; a readonly user cannot see upload/delete controls. Stop the stack after verification.

- [ ] **Step 6: Commit documentation and verification updates**

  ```bash
  git add docs/s3-browser-tool-requirements.md README.md charts/s3-browser scripts/verify-production-image.sh
  git commit -m "docs: document safe previews and bounded search"
  ```

## Plan Self-Review

- **Spec coverage:** Task 1 supplies the required bounded whole-bucket search contract; Task 2 implements case-insensitive full-key matching, server-side preview type enforcement, selected ZIP validation/limits, and no-store headers; Task 3 applies authorization, audit, origin, transfer, and generic-error boundaries; Task 4 implements all MinIO-inspired UI behavior; Task 5 aligns requirements and validates the end-to-end flow.
- **Security coverage:** no public URLs, client-trusted types/keys, unbounded result lists, stale selections, unsupported inline content, bulk deletion, or unleased/auditless streaming path is introduced.
- **Type consistency:** route methods consume the service names and shapes created in Task 2; the UI consumes `OperatorSearchResult` and `isPreviewableKey` from Task 1; configuration fields are passed through `getS3Service` in Task 2.
- **Placeholder scan:** no deferred implementation markers or unspecified test behavior remain.
