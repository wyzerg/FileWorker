# Multiple Connections Implementation Plan

> **For agentic workers:** Use the relevant Superpowers testing and review
> workflows. Continue the approved implementation in this workspace.

**Goal:** Keep authenticated servers and their transfers alive when switching
the selected connection.

**Architecture:** Index backend sessions by session ID and frontend view state
by profile identity. Foreground authentication remains serial. All operations
and async completions retain the original session identity.

**Tech Stack:** Rust, Tauri 2, React, TypeScript, Vitest, Playwright, AsyncSSH.

**Spec:** `docs/superpowers/specs/2026-11-06-multiple-connections-design.md`

## Global Constraints

- Keep profile format v2, Keychain storage and host-key verification unchanged.
- Keep task actions bound to their original session.
- No real user server, credential, configuration or installed-app changes.
- Manual code edits use `apply_patch`; temporary fixture resources are cleaned.
- Run JavaScript commands through `bash scripts/run.sh`.
- Cargo uses `/Users/shitou/.cargo/bin` on PATH.
- Do not create another worktree or install a global dependency.

## Task 1: Backend Session Ownership

**Files:** `crates/fileworker-core/src/connections.rs`,
`crates/fileworker-core/tests/sftp_integration.rs`, `src-tauri/src/lib.rs`.

**Interfaces:** Existing session-ID operations remain unchanged. Add
`ConnectionManager::shutdown(&self)` for explicit app-exit cleanup.

- [x] Add failing real-protocol tests for A surviving B's probe/authentication,
  failed or canceled B attempts not closing A, and targeted disconnect/cancel.
- [x] Run those tests against the original manager and observe `session_closed`.
- [x] Replace `Option<Active>` with a session-ID map. Replace only sessions
  belonging to the same profile after successful authentication. Preserve
  unrelated sessions on new probes and all targeted lifecycle operations.
- [x] Add idempotent shutdown that rejects new probes and closes all pending
  and authenticated connections; call it after transfer shutdown on app exit,
  for both the browsing manager and draft-testing manager.
- [x] Verify transfers for A remain functional with B connected and after B
  disconnects; verify full shutdown and run the core Rust suite.

## Task 2: Frontend Workspaces And Task Actions

**Files:** `src/lib/useRemoteConnection.ts`, `src/App.tsx`,
`src/components/Sidebar.tsx`, `src/components/TransferQueue.tsx`,
`tests/connection.test.tsx`, `tests/remote-navigation.test.tsx`,
`tests/transfers.test.tsx`, `tests/sidebar.test.tsx`,
`tests/e2e/multiple-connections.spec.ts`.

**Interfaces:** Keep the selected-workspace hook interface, add
`sessions: ConnectedSession[]`, optional known-profile reconciliation and
`disconnectProfile(profileId: string)`. The sidebar accepts all connected
profile IDs. The queue accepts all live session IDs, while retaining the
selected session for foreground conflict prompts.

- [x] Add tests that fail when selecting B disconnects A, loses A's history,
  prevents switching during transfers or hides background task actions.
- [x] Observe the failures with the old implementation.
- [x] Retain per-profile context and update it only when its session and request
  generation still match. Cancel foreground attempts on selection changes;
  release all contexts only on unmount, identity change or explicit removal.
- [x] Remove transfer-based selection blocking. Inspect the target session for
  delete/identity-change guards and disconnect only that target.
- [x] Mark every live profile in the sidebar and enable retry/manual conflict
  actions for live background sessions without changing the selected workspace.
- [x] Retain unconsumed upload-completion refresh targets until that connection
  is selected. Drop only targets for sessions that are actually closed.
- [x] Run frontend and end-to-end tests, including late list/authentication
  responses, identity changes, deletion, drag-ticket invalidation and unmount.

## Task 3: Documentation, Review And Delivery

**Files:** `README.md`, `CHANGELOG.md`, this plan and release documentation when
a new binary is produced.

- [x] Update current multi-connection behavior and append compatibility,
  verification, migration and rollback notes.
- [x] Review changed lifecycle and async paths for races and cross-session
  mutation/transfer risks; resolve concrete findings with focused tests.
- [x] Run frontend, browser, Rust, type, format, Clippy, package and optimized
  build checks. Record actual results and native/platform verification limits.
- [ ] Clean only this task's temporary artifacts; inspect the final diff.
- [ ] Commit and push the verified source using the user's standing request.
  Do not claim an existing published binary contains this change.

## Verification Notes

- Original hook: four new workspace regressions failed because switching
  discarded sessions/history and ignored background directory results.
- Original manager: six multi-session regressions failed with `session_closed`.
  Three shutdown regressions also failed against a no-op shutdown.
- Core: 107 tests pass, including all 45 SFTP tests and 10 new lifecycle tests.
  Workspace default: 69 pass; 41 fixture tests and one real Keychain test are
  ignored by default. The fixture tests were separately run, not skipped.
- Frontend: 239 tests pass in default and shuffled order (seed 72611).
- Playwright: all 36 tests pass. Multi-session coverage includes dark/light,
  1280/800/390 widths, separate path inputs, background upload refresh, no
  reauthentication and targeted disconnect. Screenshots inspected.
- Full regression caught a duplicate-profile selection regression; restored
  selecting a newly created profile when no live session/attempt is selected,
  without selecting an edited background profile.
- Review stages: backend and protocol tests; hook and navigation tests; App,
  sidebar, queue and their browser/behavior tests. These boundaries keep each
  implementation stage reviewable despite the aggregate test-heavy diff.
- Review fixes: release the authentication lock before the first directory
  request completes; key the remote pane by session/profile so identical paths
  cannot inherit another server's selection. Deferred directory and conflict
  submissions have focused regressions. An older navigation test now queries
  the live input after authentication instead of a detached pre-auth node.
- Final optimized app and 11 packaging checks pass. Local preview.8 ZIP is
  5,389,768 bytes, SHA-256
  `2c2055a4bc12aa61e8053be7d3839fea350e5f8d847a8f8b2046673479eac15b`.
  Public upload and download verification are still pending.
