# Final review fix report

Branch: `feat/object-selection-preview-search`

All five final-review findings are addressed in one cohesive fix.

## Changes

1. ZIP entry validation now rejects traversal/dot segments, absolute paths,
   backslashes, drive/alternate-stream separators, empty segments, trailing dots
   or spaces, control characters, and normalized Unicode/case collisions before
   fetching any object body. Selected-file validation also precedes HEAD calls.
   Prefix ZIPs use the same name checks and retain safe directory entries.
2. Both archive producers share a bounded streaming implementation. A Transform
   counts actual uncompressed bytes across entries, fails before forwarding an
   over-budget chunk, aborts the active request/body, and never opens queued
   objects after failure. This closes the metadata-to-GET overwrite gap without
   requiring object-version access. Cancellation and constrained-connection
   behavior remain covered.
3. Preview and individual-download Content-Disposition values use printable
   ASCII fallback filenames and RFC 5987 UTF-8 `filename*` values when needed.
   Tests construct and consume actual Response objects for Thai, emoji, quotes,
   and reserved punctuation.
4. Native selected-download forms target a persistent hidden named iframe.
   HTTP error documents trigger generic in-page retry guidance, leaving the
   workspace and selection intact. Successful downloads still go directly to
   the browser without fetch/blob buffering; the initial empty frame is ignored.
5. Shared listing/search normalization excludes slash-terminated folder marker
   keys. Markers do not consume the search result cap, while zero-byte files
   remain visible/selectable.

## TDD evidence

Each behavior had a failing regression before its production change: unsafe and
colliding archives were accepted; overwritten bodies exceeded the configured
budget; Unicode Response headers threw ByteString errors; folder markers were
returned/count-limited as files; and the native form had no isolated target or
HTTP-document error handling. Added prefix compatibility coverage for directory
entries and Unicode file paths. One preview test fixture was corrected to emit
byte buffers, matching the S3 response body contract.

## Final verification

- Focused service, browser, selected-download route, preview route, and HTTP
  error suites: **5 files / 120 tests passed**.
- Full `npm test`: **22 files passed, 1 skipped; 197 tests passed, 2 skipped**.
  The skipped tests are the existing opt-in S3 integration suite. The first
  sandboxed run could not reach PostgreSQL (`EPERM 127.0.0.1:5433`); the approved
  rerun with database access passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

## Limits

- No live-browser download smoke test or build was run in this fix pass.
  Component tests exercise real form/iframe DOM boundaries; the browser owns
  attachment saving and presentation of failures after download headers begin.
- Archive outcome size counters retain the validated metadata total; the new
  independent runtime counter enforces the limit on actual streamed bytes.
- ZIPs now reject ambiguous extraction names, including names that differ only
  in case or Unicode normalization, with the existing generic selection error.

Commit message: `fix: harden archive and native download boundaries`
