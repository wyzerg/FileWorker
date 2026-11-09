# Local Credentials Implementation Plan

> **For agentic workers:** Use the approved design and relevant Superpowers
> test-driven implementation, independent review and verification workflows.
> Execute in the current workspace under the user's standing development request.

**Goal:** Replace Keychain with an opt-in, automatically readable local encrypted
credential store without changing SSH authentication or stored profile identities.

**Architecture:** A `LocalCredentialStore` in the core crate implements the
existing trait. The Tauri browsing and test managers share one store. UI continues
to send secrets only through authentication IPC and never reads them back.

**Tech Stack:** Rust, RustCrypto chacha20poly1305 0.10.1, OS randomness,
std filesystem locks, tempfile atomic replacement, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-09-local-credentials-design.md`

## Global Constraints

- Never access or migrate user Keychain items, credentials or real servers.
- Keep profiles v2, account hashes, host-key verification and session policies.
- No master password, system-security changes or Windows application claim.
- Run JavaScript through `bash scripts/run.sh`; Cargo includes
  `/Users/shitou/.cargo/bin` on PATH.
- Serialize Rust verification and Tauri builds. Clean only this task's artifacts.
- No unrelated worktree, branch, toolchain or installed-application changes.

## Task 1: Local Store

**Files:** `crates/fileworker-core/src/local_credentials.rs`,
`crates/fileworker-core/src/lib.rs`, `crates/fileworker-core/Cargo.toml`,
`crates/fileworker-core/tests/local_credentials.rs`, `Cargo.lock`.

**Interface:** `LocalCredentialStore::new(app_data: PathBuf) -> Self`, implementing
`CredentialStore::{get,set,exists,delete,supported}` with existing error contracts.

- [x] Add failing storage tests before implementation. Run
  `cargo test -p fileworker-core --test local_credentials`; confirm missing-store
  failure, then test against a minimal unavailable-store stub.
- [x] Implement versioned per-account AEAD envelopes, bounded reads, random
  key/nonce generation and account-bound associated data.
- [x] Implement lazy private directory creation, bounded cross-process locking,
  atomic key creation/record replacement and precise idempotent deletion.
- [x] Exercise restart, no plaintext on disk, empty passphrases, record tampering,
  wrong key/account, missing and malformed keys, oversized input, per-install
  separation, concurrent processes, link/permission rejection and cleanup.

## Task 2: App And Authentication

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`,
`src-tauri/src/credentials.rs`, `src-tauri/Cargo.toml`,
`crates/fileworker-core/src/connections.rs`, `src/components/CredentialFields.tsx`,
authentication tests and real-protocol fixtures.

**Interface:** IPC and `CredentialStatus` stay unchanged. Runtime support comes
from `remote.credential_storage_supported()`, not a macOS platform check.

- [x] Replace both managers' native stores with a shared local store; remove
  the direct Keychain dependency/adapter and native-Keychain test.
- [x] Test user-visible remembering/reusing/forgetting, preserving manual input,
  and save-failure warnings. Replace platform-specific error wording.
- [x] Add isolated SFTP coverage using the real local store for password and
  pasted-key save/reconnect, forgetting and identity invalidation.
- [x] Run frontend and protocol tests; ensure no test touches real Keychain.

## Task 3: Review, Documentation And Delivery

**Files:** `README.md`, `CHANGELOG.md`, `.gitignore`, this plan, release
documentation only if a verified new binary is published.

- [x] Explain auto-unlock risk, opt-in behavior, first reentry, on-disk ownership,
  backup/lost-key implications and rollback; remove stale current Keychain claims.
- [x] Review filesystem races, concurrency, persistence failures and secret
  leakage; fix concrete findings with regressions.
- [x] Run full Rust/protocol, frontend (default/shuffle), Playwright, types,
  format, Clippy, optimized build and packaging checks.
- [ ] Clean task-owned fixtures/reports, inspect final diff, then commit/push
  under the user's standing request. Do not mislabel preview.8 as containing it.
