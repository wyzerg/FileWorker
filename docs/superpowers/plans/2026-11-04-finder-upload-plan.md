# Finder Upload Implementation Plan

> **Goal:** Upload ordinary files dropped from Finder into the current remote pane.
> The user approved implementation and GitHub synchronization. Do not create a
> GitHub Release in this phase.

**Architecture:** Tauri 2 native file-drop events feed a session-scoped React
gesture controller. Rust validates the whole batch and reuses the existing
transfer queue. No custom WKWebView subclass and no native ticket store are
needed.

**Spec:** `docs/superpowers/specs/2026-11-04-finder-upload-design.md`

## Global Constraints

- Keep the existing libssh2 security revision.
- Set `dragDropEnabled: true` for Tauri native file-drop events.
- Only macOS Apple Silicon is the current verification target.
- At most 256 files per batch; directories and symlinks are rejected as a whole batch.
- No Finder drag-out, recursive copying, pause/resume, resume metadata or Release.

## Task 1: Frontend Drag Lifecycle

Files: `tests/finder-drop.test.tsx`, `src/lib/useFinderDrop.ts`,
`src/lib/api.ts`, `src/lib/types.ts`, `src/lib/useTransfers.ts`,
`src/App.tsx`, `src/components/FilePane.tsx`,
`tests/e2e/finder-drop.spec.ts`.

- [x] Add the `FinderDropEvent` contract and Tauri event adapter.
- [x] Listen to the four official `tauri://drag-*` events on the current WebView.
- [x] Convert physical coordinates to normalized coordinates with Retina scaling.
- [x] Add hit testing, session/listing binding, invalidation and single-submit behavior.
- [x] Reuse the transfer queue submission lock and error handling.
- [x] Cover target boundaries, wrong targets, duplicate drops, refresh/navigation,
  reconnect, Escape, modal occlusion and async unmount.

## Task 2: Whole-Batch Validation

Files: `src-tauri/src/finder_drop.rs`, `src-tauri/src/lib.rs`,
`src-tauri/src/commands.rs`, `src-tauri/Cargo.toml`, `Cargo.lock`.

- [x] Add `enqueue_finder_upload(paths, session_id, destination_dir)`.
- [x] Validate all paths before queueing: absolute, bounded, ordinary regular files,
  no duplicates, no directories, symlinks or missing sources.
- [x] Reuse `TransferManager::enqueue`; do not add a second transfer implementation.
- [x] Expose the macOS-only capability through `get_environment`.
- [x] Add Rust regression tests for accepted and rejected batches.

## Task 3: Verification

- [x] Run frontend tests (`96/96`) and Finder behavior tests (`21/21`).
- [x] Run the three Finder Playwright tests (`3/3`) with physical-pixel event fixtures.
- [x] Run TypeScript, Rust workspace tests, Rust format check and Clippy.
- [x] Build the production frontend and debug macOS `.app`.
- [ ] Run real Finder multi-file upload, mixed invalid batch, same-name keep-both,
  SHA-256 and temporary-file checks on an unlocked Apple Silicon desktop.
- [ ] Verify Windows/Linux desktop build and native drag behavior before listing them
  as supported.

## Task 4: Documentation And GitHub Synchronization

- [x] Update README, CHANGELOG, release plan and this implementation plan with the
  exact current feature boundary.
- [x] Review listener lifetime, coordinate units, replay invalidation, whole-batch
  validation and the final diff.
- [ ] Commit the feature, fast-forward `main`, push over HTTP/1.1 if needed, and
  compare local and remote commit IDs.
- [x] Do not publish a GitHub Release.
