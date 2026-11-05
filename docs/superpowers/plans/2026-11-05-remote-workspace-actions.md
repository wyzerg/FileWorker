# Remote Workspace Actions Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved plan task-by-task. Respect the existing delegation limit; do not create additional tasks.

**Goal:** Restore each connection's last directory, connect directly with saved credentials, and provide safe remote file actions and read-only previews.

**Architecture:** Keep connection lifecycle and navigation in `useRemoteConnection`; keep recent locations separate from connection configuration and secrets. Add a focused Rust remote-file module, with session-bound commands and bounded in-memory previews, and a focused frontend action/dialog controller shared by the toolbar and context menu.

**Tech Stack:** Existing Rust/ssh2, Tauri 2, React/TypeScript, lucide-react, Vitest and Playwright. No new runtime dependencies.

**Spec:** The user approved the six-point design in this task on 2026-11-05; the exact scope and constraints are recorded below.

## Global Constraints

- Each saved connection restores its last successfully read directory across restarts. Failed or stale requests never replace the remembered path. Changed host/port/user cannot reuse another endpoint's location.
- Directory memory contains only endpoint metadata and paths, never secrets. Deletion clears that connection's memory; explicit default-directory changes reset it.
- A missing/unreadable remembered directory falls back once to the configured start directory with a visible notice. Network loss never triggers a fallback loop.
- Single click selects; double click connects. Already connected double clicks do nothing. Saved credentials auto-authenticate only after host trust; missing/failed credentials open manual input.
- Keep first-use fingerprint confirmation and changed-fingerprint blocking. Do not read saved secrets before host verification.
- Remove per-connection ellipsis buttons, retain right-click, keyboard context menus and the global current-connection menu. Keep group menus.
- Show an unmistakable connected badge, not color alone.
- Replace WebView Reload on noneditable app surfaces with contextual file actions. Keep native text-input copy/paste.
- Toolbar/context menu share preview, download, copy path, new directory, rename, delete and properties actions. Navigation adds back/forward, parent and refresh.
- Preview only ordinary files, in memory, with text/image size limits and safe MIME handling. No HTML execution, external editor, automatic upload or on-disk preview cache.
- New directories use private permissions; rename never overwrites; delete is explicit and nonrecursive. No operations on root, dot entries or unsupported special files.
- Block mutations while this session has unfinished transfers. Session changes dismiss stale actions/previews; stale responses cannot mutate a different connection.
- Test only generated loopback fixtures and credentials. Clean all owned fixtures/reports without deleting actual user data or earlier pending download acceptance.

## Task 1: Connection And Navigation

**Files:** `src/lib/useRemoteConnection.ts`, new `src/lib/remoteLocations.ts`, `src/components/Sidebar.tsx`, `src/App.tsx`, sidebar styles; `tests/remote-navigation.test.tsx`, existing connection/sidebar tests.

**Interfaces:** `connect(input?: AuthenticationInput)`, `navigate(path: string)`, `goBack()`, `goForward()`, `canGoBack`, `canGoForward`; `readRemoteLocation(profile)`, `rememberRemoteLocation(profile,path)`, `forgetRemoteLocation(id)`.

- [x] Add hook regressions for remembered directories, fallback, stale responses, saved-credential direct authentication and trust boundaries; add sidebar double-click/no-ellipsis tests.
- [x] Run `bash scripts/run.sh test tests/remote-navigation.test.tsx tests/sidebar.test.tsx`; inspect intended failures before implementation.
- [x] Implement location storage, successful navigation history and direct authentication; retain existing cancellation/request guards.
- [x] Wire double-click, endpoint cleanup and the connected badge; update old tests only where the approved interaction intentionally changed.
- [x] Run targeted and complete frontend tests.

## Task 2: Session-Bound Remote Files

**Files:** new `crates/fileworker-core/src/remote_files.rs`; `connections.rs`, `lib.rs`, Tauri `remote.rs`/`lib.rs`; `tests/sftp_integration.rs`.

**Interfaces:** `RemoteFileAction::{CreateDirectory,Rename,Delete}`, `RemoteFileProperties`, `RemotePreview`; ConnectionManager methods `file_properties`, `preview_file`, `mutate_file`, each taking the exact active session ID and absolute POSIX path.

- [x] Add real protocol regressions for bounded text/image previews, nonordinary files, file properties, private directory creation, no-overwrite rename, nonrecursive deletion, invalid names/root and stale sessions.
- [x] Run `cargo test -p fileworker-core --test sftp_integration --no-run` and the new filtered protocol tests; record the missing implementation failures.
- [x] Add path/name validation and bounded in-memory preview classification; reuse the active authenticated SSH handle and cancellation checks.
- [x] Add session-bound Tauri commands; block mutations with unfinished session transfers in the native command boundary as well as in the UI.
- [x] Run isolated protocol tests, default workspace tests, format and Clippy.

## Task 3: File Menus, Toolbar And Preview

**Files:** `FilePane.tsx`, new remote action controller/dialog/menu components, `App.tsx`, API/types and focused styles; `tests/remote-files.test.tsx`, desktop API tests.

**Interfaces:** pane `onFileAction(action,entry?)`; shared actions use accepted session/listing snapshots, not unsubmitted path input. Modal controller exposes `dialogOpen` for existing transfer-conflict/Finder modal coordination.

- [x] Add component regressions for native-menu suppression, selected/right-clicked targets, refresh without reconnect, toolbar availability, read-only preview, confirmation/retry and stale session results.
- [x] Run those tests to observe missing behavior.
- [x] Implement keyboard-accessible menus and icon toolbar; retain text input native menus and narrow layouts.
- [x] Implement cancelable UI preview/properties requests, private mkdir and explicit rename/delete dialogs; disable unsafe/multiple-selection mutations.
- [x] Add Playwright scenarios and screenshots for desktop/mobile, light/dark, long text and image preview.

## Task 4: Verification, Cleanup And Release

**Files:** `README.md`, `CHANGELOG.md`, `docs/RELEASING.md`, acceptance/release notes.

- [x] Run frontend, whole Playwright, workspace including ignored loopback/Keychain, C ASan protocol tests, type/build/fmt/Clippy and preview packaging regressions.
- [x] Build optimized `.app` sequentially after Rust tests; package under a new preview tag, never replace prior tags/assets.
- [x] Verify the exact packaged app natively against an isolated generated loopback service; honestly record untested platform/download boundaries.
- [x] Remove only owned test credentials, processes, temporary directories and reports; verify actual user configuration is unchanged.
- [x] Update current documentation and append the changelog; review the final diff and verify a clean commit.
- [x] Commit/push, publish a new prerelease with ZIP/checksum, verify public assets and exact remote main/tag.

## Completion And Review

The change was reviewed in connection/navigation, native file/queue safety, and frontend action/dialog stages.
The smallest independently reviewable implementation stage is the native module plus active-session checks,
queue reservation and real-protocol tests; keeping its mutation guard and tests together avoids exposing an
unguarded write API. Frontend integration depends on those commands and was verified as a complete workflow.
The full change is larger than the usual review-size guidance because it includes all three stages and their
regressions; no unrelated refactors, dependencies, credential schemas or platform promises were added.

Shipped code: `6e8f163ae44feebefd0aaa48480d07dfc9521e0e`.
Published prerelease: `v0.1.0-preview.5`, GitHub release `435087805`.
Full evidence and remaining native/download boundaries are recorded in
`docs/acceptance/2026-11-05-remote-workspace.md`.
