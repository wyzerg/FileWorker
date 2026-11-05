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
- [x] Run real Finder multi-file upload and same-name keep-both on an unlocked
  Apple Silicon desktop using the published `v0.1.0-preview.1` package;
  verify source/destination SHA-256 and no temporary-file remnants.
- [x] Complete mixed invalid-batch native evidence using the unchanged published
  `v0.1.0-preview.2` package and fresh files: file + directory and file + symlink
  gestures are rejected with an empty queue, unchanged remote inventory, and no
  server-side file operations. A separate real Finder positive control uploads
  successfully with matching SHA-256 and confirms that server auditing works.
  Remove generated files, keys, temporary HOME, environment, logs, and extracted
  app; verify test processes/port are closed and real user configuration is unchanged.
- [ ] Complete native Finder wrong-target acceptance; browser coverage alone is
  not native evidence.
- [ ] Verify Windows/Linux desktop build and native drag behavior before listing them
  as supported.

## Task 4: Documentation And GitHub Synchronization

- [x] Update README, CHANGELOG, release plan and this implementation plan with the
  exact current feature boundary.
- [x] Review listener lifetime, coordinate units, replay invalidation, whole-batch
  validation and the final diff.
- [x] Commit the feature (`ebd6d93`), fast-forward `main`, push, and compare local
  and remote commit IDs.
- [x] Do not publish a GitHub Release.

The no-Release constraint applied to the implementation phase. The user later
approved the separate experimental preview release. Native observations and
remaining verification boundaries are recorded in
`docs/acceptance/2026-11-05-native-transfers.md`.
