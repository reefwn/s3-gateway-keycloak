# Object Selection, Preview, and Bucket Search Design

**Status:** Approved design, ready for implementation planning  
**Date:** 2026-09-15

## Goal

Bring the object browser closer to the focused interaction model in the MinIO
reference: users can select several files, download them in one ZIP archive,
inspect supported files without first saving them locally, delete from the
relevant row, and find files anywhere in the currently selected bucket.

## Scope

- Add a checkbox to each file row and a select-all checkbox for the currently
  visible result set. Prefixes remain navigable and are not selectable.
- Show a contextual, MinIO-inspired action panel when at least one file is
  selected. It provides selected count, Download ZIP, Preview when eligible,
  and Clear selection.
- Download selected files as one streamed ZIP archive, subject to the existing
  configured archive count and uncompressed-size limits.
- Add an in-app dialog preview for exactly one selected PDF or image. Other
  types remain download-only.
- Move the admin delete affordance from global actions to each object row;
  retain exact-key typed confirmation before deletion.
- Search the complete selected bucket, matching a case-insensitive substring
  of an object key. Search results expose the full key/path and navigation to
  the containing prefix.

## Architecture

The existing Next.js same-origin browser and API boundary remain the sole
interaction surface. Extend the object service and its routes rather than
introducing an independent search/download service.

1. The S3 service gains functions for bucket-wide key search, selected-key ZIP
   streaming, and safe inline retrieval of previews.
2. Route handlers continue to authorize, audit, and rate-limit operations.
   Search uses list permission; selected ZIP uses download permission and the
   existing download transfer category; preview uses download permission and
   the same transfer category.
3. The browser owns ephemeral selection, preview-dialog, query, and loading
   state. It clears selections when a bucket, prefix, query, or fresh listing
   changes, preventing actions on stale keys.

## Interaction Design

### Object table and selection

Each object row receives an accessible checkbox. The table header checkbox
selects or clears only visible object rows; it never includes folders. A
selection action panel appears next to the listing when one or more files are
selected. The panel displays a selected count and actions appropriate to that
selection:

- **Download ZIP:** available for one or more selected files.
- **Preview:** available only when precisely one selected object has a
  previewable PDF/image content type or filename extension.
- **Clear selection:** removes all selected keys.

Folders retain their current click-to-browse behavior. File rows retain a
direct single-file download link.

### Preview

Preview opens a labelled modal dialog. Images render as an image and PDFs in
an embedded document viewer. The browser requests a new authenticated preview
route; it never receives cloud credentials or a presigned URL.

The server permits only PDF and explicit image media types. It sends
`Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and
`Cache-Control: no-store`. Unsupported, missing, or mismatched content types
return a generic error. The preview response is audited and receives the same
concurrent-download guard as ordinary download streaming.

### Row deletion

Only admins see a Delete control on an object row. Selecting it opens the
current exact-key confirmation dialog pre-bound to that row. There is no bulk
delete and no delete control in the contextual selection panel.

### Bucket-wide search

The search input searches object keys throughout the selected bucket, not
merely the current prefix. The request is debounced in the UI and only starts
after a short non-empty query. Matching is case-insensitive and applied to
full keys. Search results show filename, containing path, last modified time,
and size. Choosing a result clears the search and opens its containing prefix.

Search is implemented by paginating `ListObjectsV2` from the selected bucket
and filtering keys in the service. It has a configured/result-page bound so a
large bucket cannot produce an unbounded response; when the bound is reached,
the UI explains that results are partial and encourages a more specific query.

## Error Handling and Security

- Preserve generic not-found-or-not-permitted behavior for inaccessible
  buckets/objects and normalized service failures.
- Reject duplicate, empty, or unallowlisted selected keys server-side. Never
  trust selection values, object MIME type, role, or bucket supplied by the
  browser.
- Stream ZIPs and previews end-to-end. Do not buffer object data or archives
  in application memory or local disk.
- Record audited attempt/outcome events for search, selected ZIP, and preview;
  failed audit attempts deny the associated S3 action.
- A ZIP/preview failure shows an in-page error without retaining a misleading
  loading state. A successful deletion refreshes the current listing and
  clears selection.

## Testing

- Unit-test preview allowlisting, case-insensitive key matching, selected-key
  validation/deduplication, streaming archive limits, and safe response
  headers.
- Route-test roles, audit fail-closed behavior, transfer limits, invalid
  selection/search input, generic errors, and no-store responses.
- Component-test checkbox/select-all semantics, contextual action visibility,
  ZIP request behavior, preview eligibility/dialog rendering, per-row delete,
  search result navigation, and selection reset on navigation/query change.

## Out of Scope

- Preview for video, audio, office documents, HTML, text, or arbitrary files.
- Bulk delete, recursive prefix actions, public/presigned URLs, thumbnails,
  object metadata management, or any change to role definitions.
