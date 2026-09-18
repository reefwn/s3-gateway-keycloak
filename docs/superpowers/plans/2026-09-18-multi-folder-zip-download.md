# Multi-Folder ZIP Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select several visible files and folders and receive their contents in one streamed ZIP archive that preserves bucket-root paths.

**Architecture:** The browser will submit its existing native same-origin form with a mixed list of object keys and slash-terminated folder prefixes. `getSelectedArchive` will validate that selection, expand prefix entries by paginating S3, calculate limits from the expanded archive members, and feed the existing streaming ZIP writer with original object keys as ZIP names. The existing route retains authorization, CSRF/origin checks, transfer leases, and audit finalization.

**Tech Stack:** Next.js 16 route handlers and React 19, TypeScript, AWS SDK v3, `archiver`, Vitest, Testing Library.

## Global Constraints

- Keep ZIP creation and object delivery streamed; do not buffer archives or objects in browser, memory, or local disk.
- Preserve the existing authenticated same-origin form POST and its `Cache-Control: no-store` response behavior.
- A selection is non-empty, uniquely normalized, and may contain exact object keys or safe folder prefixes ending in `/`.
- Reject a selection where one target contains another target; this prevents duplicate archive entries and ambiguous folder/file ancestry.
- Preserve archive names as original bucket-root keys; apply configured count and uncompressed-byte limits to the fully expanded object list before `GetObject` calls.
- Retain existing download capability, trusted-origin, transfer-limit, generic-error, and audited stream behavior.

---

## File Structure

- Modify `lib/s3/service.ts`: validate mixed object/prefix selections, expand selected prefixes, and construct the selected archive from resolved entries.
- Modify `lib/s3/service.test.ts`: describe the S3 pagination, safety, limit, and ZIP-name behavior of mixed selections.
- Modify `app/api/selected-download/[bucket]/route.ts`: use item-neutral validation copy while preserving the same request schema and archive delegation.
- Modify `app/api/selected-download/[bucket]/route.test.ts`: verify slash-terminated prefixes reach the archive service and malformed requests retain the revised generic message.
- Modify `components/s3-browser.tsx`: make visible folder prefixes selectable and ensure select-all and preview semantics distinguish files from folders.
- Modify `components/s3-browser.test.tsx`: verify folder-inclusive selection and submitted native form data.

### Task 1: Resolve mixed object and folder selections in the S3 service

**Files:**
- Modify: `lib/s3/service.ts:80-145,390-412`
- Test: `lib/s3/service.test.ts:220-480`

**Interfaces:**
- Consumes: `getSelectedArchive(bucket: string, keys: readonly string[])` and the configured `archiveMaxObjects` / `archiveMaxBytes`.
- Produces: the unchanged archive result `{ stream: ZipArchive; objectCount: number; totalSize: number }`; `keys` now accepts exact object keys and slash-terminated prefixes.

- [ ] **Step 1: Write the failing service tests**

Add focused tests that assert all of the following observable behavior:

```ts
it("expands multiple selected folders and files into bucket-root ZIP entries", async () => {
  send
    .mockResolvedValueOnce({ Contents: [{ Key: "reports/", Size: 0 }, { Key: "reports/jan/a.txt", Size: 1 }], NextContinuationToken: undefined })
    .mockResolvedValueOnce({ Contents: [{ Key: "photos/p.png", Size: 2 }] })
    .mockResolvedValueOnce({ ContentLength: 3 })
    .mockResolvedValueOnce({ Body: Readable.from([]) })
    .mockResolvedValueOnce({ Body: Readable.from("a") })
    .mockResolvedValueOnce({ Body: Readable.from("p!") })
    .mockResolvedValueOnce({ Body: Readable.from("log") });

  const archive = await service.getSelectedArchive("reports", ["reports/", "photos/", "top-level.log"]);
  const names: string[] = [];
  archive.stream.on("entry", (entry) => names.push(entry.name));
  for await (const chunk of archive.stream) void chunk;

  expect(names).toEqual(["reports/", "reports/jan/a.txt", "photos/p.png", "top-level.log"]);
  expect(archive).toMatchObject({ objectCount: 4, totalSize: 6 });
});

it.each([
  ["reports/", "reports/jan/"],
  ["reports/", "reports/jan/a.txt"],
  ["report.txt", "report.txt"]
])("rejects overlapping or duplicate archive targets %j before S3 access", async (keys) => {
  await expect(service.getSelectedArchive("reports", keys)).rejects.toThrow(InvalidArchiveSelectionError);
  expect(send).not.toHaveBeenCalled();
});
```

Also add a paginated-prefix test, an empty-prefix test returning an empty archive, and an expanded-limit test using `archiveMaxObjects: 1`; each must assert no `GetObjectCommand` was sent on limit failure.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- lib/s3/service.test.ts`

Expected: FAIL because `getSelectedArchive` treats every slash-terminated prefix as a direct object and issues `HeadObjectCommand` instead of listing it.

- [ ] **Step 3: Implement minimal mixed-selection validation and resolution**

In `lib/s3/service.ts`, replace the object-only selection helper with a typed selection helper and a resolver. Keep path safety delegated to the existing `assertSafeObjectKey` and `assertArchiveNames` rules.

```ts
type ArchiveTarget = Readonly<{ key: string; kind: "object" | "prefix" }>;
type ArchiveEntry = Readonly<{ key: string; size: number }>;

function assertArchiveTargets(keys: readonly string[]): ArchiveTarget[] {
  if (keys.length === 0) throw new InvalidArchiveSelectionError();
  const targets = keys.map((key) => ({ key: assertSafeObjectKey(key), kind: key.endsWith("/") ? "prefix" as const : "object" as const }));
  assertArchiveNames(targets.map(({ key }) => key), true);
  const ordered = [...targets].sort((left, right) => left.key.localeCompare(right.key));
  if (ordered.some((target, index) => index > 0 && target.key.startsWith(ordered[index - 1].key))) {
    throw new InvalidArchiveSelectionError();
  }
  return targets;
}
```

Implement a resolver inside `createS3Service` that heads direct objects and uses `ListObjectsV2Command({ Bucket: bucket, Prefix: target.key, ContinuationToken })` for each selected prefix. Add every returned non-empty S3 key with a finite non-negative size, reject duplicate resolved keys, and increment count/total size as each entry is resolved. Throw `ArchiveLimitError` immediately when either configured limit is exceeded. Return the resolved entries in deterministic target/listing order.

Update `getSelectedArchive` to call the resolver, validate archive names with `allowDirectories: true`, and call:

```ts
streamArchive(input, archive, bucket, entries.map(({ key }) => ({ key, name: key })), archiveMaxBytes);
return { stream: archive, objectCount: entries.length, totalSize };
```

Do not alter `getPrefixArchive`; it keeps its current relative-path ZIP behavior.

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `npm test -- lib/s3/service.test.ts`

Expected: PASS, including all existing object-only, prefix-archive, archive-limit, and stream-cancellation tests.

- [ ] **Step 5: Commit the service deliverable**

```bash
git add lib/s3/service.ts lib/s3/service.test.ts
git commit -m "feat: expand selected folders into zip archives"
```

### Task 2: Preserve route safeguards for mixed archive selections

**Files:**
- Modify: `app/api/selected-download/[bucket]/route.ts:35-42`
- Test: `app/api/selected-download/[bucket]/route.test.ts:65-175`

**Interfaces:**
- Consumes: `getSelectedArchive(bucket, keys)` from Task 1, receiving slash-terminated prefixes in the same `keys` array.
- Produces: identical ZIP response headers and lifecycle behavior; invalid request bodies use the generic message `Select one or more unique items`.

- [ ] **Step 1: Write failing route tests**

Change the malformed-body expectations to the item-neutral copy and add this request-format coverage:

```ts
it.each(requestFormats)("passes a selected folder in a $name body to the archive service", async ({ request }) => {
  const stream = Readable.from([Buffer.from("zip")]);
  mocks.service.getSelectedArchive.mockResolvedValue({ stream, objectCount: 2, totalSize: 8 });

  const response = await POST(request(["reports/", "top-level.log"]), context);

  expect(response.status).toBe(200);
  expect(mocks.service.getSelectedArchive).toHaveBeenCalledWith("reports", ["reports/", "top-level.log"]);
  expect(mocks.beginAuditedStream).toHaveBeenCalledWith(
    expect.objectContaining({ context: expect.objectContaining({ action: "selected-download", prefix: "selected:2" }) }),
    expect.any(Function)
  );
});
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `npm test -- app/api/selected-download/[bucket]/route.test.ts`

Expected: FAIL only on the revised error copy; folder-shaped strings already pass the route’s structural JSON/form parsing and must still reach the mocked service.

- [ ] **Step 3: Implement the minimal route copy change**

Update `invalidSelectionResponse` only:

```ts
return Response.json({ error: "Select one or more unique items" }, { status: 400, headers: { "Cache-Control": "no-store" } });
```

Do not add client-side folder expansion or route-side S3 listing. Keep origin validation before lease acquisition and keep audit outcome values sourced from the resolved archive result.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `npm test -- app/api/selected-download/[bucket]/route.test.ts`

Expected: PASS, including authorization, audit fail-closed, lease-release, generic-error, and stream-finalization coverage.

- [ ] **Step 5: Commit the route deliverable**

```bash
git add app/api/selected-download/[bucket]/route.ts app/api/selected-download/[bucket]/route.test.ts
git commit -m "feat: accept folder selections for zip downloads"
```

### Task 3: Select folders in the browser and submit the mixed selection

**Files:**
- Modify: `components/s3-browser.tsx:65-74,382-447`
- Test: `components/s3-browser.test.tsx:119-233`

**Interfaces:**
- Consumes: `OperatorListing.prefixes: string[]` and the unchanged form field `keys` accepted by Task 2.
- Produces: a mixed `selectedKeys: readonly string[]` collection; `selectedObject` is defined only for a single selected listed object.

- [ ] **Step 1: Write failing component tests**

Replace file-only selection expectations with item-inclusive behavior and add a mixed-form assertion:

```tsx
it("selects visible folders and files, while keeping preview file-only", async () => {
  await renderBrowserWithListing();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select archive/" }));

  expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("1 selected");
  expect(screen.queryByRole("button", { name: "Preview selected file" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible items" }));
  expect(screen.getByRole("complementary", { name: "Selected items" })).toHaveTextContent("3 selected");
});
```

Update the native POST test to select all visible items and expect the exact form payload:

```ts
fields: [["keys", '["archive/","notes.txt","photo.png"]']]
```

Retain an assertion that the folder-name button still calls `browse(selectedBucket, "archive/")` when clicked.

- [ ] **Step 2: Run the component tests to verify they fail**

Run: `npm test -- components/s3-browser.test.tsx`

Expected: FAIL because prefix rows have an empty selection cell, select-all derives only from `objects`, and the panel is labelled `Selected objects`.

- [ ] **Step 3: Implement the minimal browser selection changes**

Derive a single visible-item list and use it consistently for select-all and indeterminate state:

```ts
const visibleKeys = visibleListing
  ? [...visibleListing.prefixes, ...visibleListing.objects.map((object) => object.key)]
  : [];
const selectedObject = selectedKeys.length === 1
  ? visibleListing?.objects.find((object) => object.key === selectedKeys[0])
  : undefined;
```

For each folder row, render an input checkbox before the existing browse button:

```tsx
<input
  aria-label={`Select ${item}`}
  checked={selectedKeys.includes(item)}
  className="size-4 cursor-pointer accent-foreground"
  onChange={(event) => setSelectedKeys((keys) => event.target.checked ? [...keys, item] : keys.filter((key) => key !== item))}
  type="checkbox"
/>
```

Change accessible copy from `Select all visible files` to `Select all visible items` and from `Selected objects` to `Selected items`. Leave `downloadSelected` unchanged: it serializes the mixed `selectedKeys` array into the native form and never buffers a response. Keep folder buttons independent from their checkbox so navigation behavior remains intact.

- [ ] **Step 4: Run the component tests to verify they pass**

Run: `npm test -- components/s3-browser.test.tsx`

Expected: PASS, including current search reset, navigation reset, native download, dialog focus, and admin deletion behavior.

- [ ] **Step 5: Run the full verification suite and commit**

Run:

```bash
npm test
npm run lint
npm run typecheck
```

Expected: all commands exit 0 with no new warnings.

```bash
git add components/s3-browser.tsx components/s3-browser.test.tsx
git commit -m "feat: select folders for zip download"
```

## Plan Self-Review

- Spec coverage: Task 1 implements safe mixed selection, prefix expansion, bucket-root archive names, empty folders, pagination, deduplication/overlap rejection, expanded limits, and streamed bodies. Task 2 preserves endpoint and security/audit behavior. Task 3 implements folder selection, item-inclusive select-all, native submission, and file-only preview.
- Placeholder scan: no deferred implementation markers or unspecified validation/error-handling steps remain.
- Type consistency: every task uses the existing `keys: string[]` request body and unchanged `getSelectedArchive(bucket, keys)` return shape; Task 3’s trailing-slash folder strings are consumed by Task 1.
