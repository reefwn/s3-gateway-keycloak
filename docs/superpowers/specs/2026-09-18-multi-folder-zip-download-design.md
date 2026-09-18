# Multi-Folder ZIP Download Design

**Status:** Approved design; written-spec review requested  
**Date:** 2026-09-18

## Goal

Allow a user to select any visible mix of files and folders and download all
selected content as one authenticated, streamed ZIP archive. ZIP entries retain
their paths from the bucket root.

## Scope

- Make listed folders selectable without changing their existing navigation
  behavior.
- Include selected folder contents recursively in the existing selected-download
  ZIP flow.
- Preserve the current native form POST, streaming, authorization, origin
  checks, transfer leases, audit records, and configured archive limits.

## Interaction

- Each visible folder has an accessible selection checkbox; clicking its name
  continues to browse into that prefix.
- The select-all checkbox includes visible files and folders.
- The contextual panel is labelled for selected items rather than only objects.
  Its ZIP action accepts the mixed selection.
- Preview is offered only for exactly one selected file, never a folder.
- Selection still clears when the bucket, prefix, search query, or listing
  refresh changes.

## Archive Request and Expansion

The existing `POST /api/selected-download/[bucket]` body stays
`{ "keys": string[] }`. A key ending in `/` is a selected folder prefix; every
other entry is an exact object key.

The route delegates the full selection to the S3 service. The service validates
all entries as safe archive paths, allows prefix entries, rejects empty,
duplicate, normalized-colliding, and ancestor/descendant selections, then
expands every selected prefix by paginating `ListObjectsV2` without a
delimiter. It combines direct objects and expanded objects into one de-duplicated
archive entry list.

ZIP entry names are the original S3 keys, preserving bucket-root paths. Folder
marker objects (`key/`) are included only when S3 returns them, preserving the
current prefix-archive behavior; a prefix with no returned objects produces a
valid empty ZIP.

## Limits, Security, and Errors

The configured archive object-count and uncompressed-byte limits apply to the
fully expanded unique object list. The service rejects an over-limit archive
before requesting object bodies. Existing streaming enforcement remains as a
second guard during transfer.

The request continues to require download capability and a trusted mutation
origin, acquires the existing download transfer lease, and writes the existing
audited attempt/outcome. Audit uses the resolved object count and total size,
not the number of client-submitted items. Failures retain current generic API
responses and no-store headers.

## Tests

- Service tests: mixed object/prefix expansion, multiple folders, root-path ZIP
  entries, empty folders, pagination, overlapping-selection rejection, and
  archive limits after expansion.
- Route tests: folder-prefixed request acceptance and archive/audit delegation
  without weakening malformed-body, authorization, origin, or lease handling.
- Component tests: folder checkbox semantics, select-all over files and
  folders, folder-inclusive native form submission, and preview remaining
  unavailable for a folder selection.

## Out of Scope

- Client-side recursive listing or ZIP creation.
- Separate ZIPs per folder, bulk deletion, or a change to archive-limit
  configuration.
