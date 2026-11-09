# Local Automatic Credentials

## Approved Behavior

The user approved replacing Keychain on 2026-11-09 with an application-owned
encrypted credential store that unlocks automatically. Passwords, key-file
passphrases and pasted private-key envelopes use the same `CredentialStore`
interface. Saving remains opt-in and occurs only after successful authentication.
Secrets are never returned to JavaScript, written to profiles, logs or browser
storage. Temporary authentication remains available if saving fails.

No code reads, migrates, removes or falls back to old Keychain items. Existing
profiles keep their identities and require one manual reentry to save into the
new store. Forgetting, deletion and authentication-identity changes affect only
the new store. Existing SSH host trust and session/transfer protections remain.

## Storage

`<app-data>/credentials-v1/` contains `master.key`, `store.lock` and independently
encrypted `<sha256(account)>.enc` records. The per-installation key is 32 random
bytes; records use RustCrypto XChaCha20-Poly1305 with a fresh 24-byte random nonce
and the account plus version domain as authenticated associated data.
The binary envelope has an explicit version. The record size limit is 8 MiB,
including passwords and serialized pasted-key envelopes.

The store initializes only on the first explicit save. Missing reads and status
checks create no directories. Record writes stage ciphertext only; atomic key
creation stages only the random key envelope, never credential plaintext.
All staging files remain in the private store directory. A cross-process lock protects key initialization,
reads, replacement and deletion, with a bounded wait. Different store instances
share the same disk key rather than caching independently generated keys.

Unix directories use 0700 and files use 0600, checked on use. Symlinks,
nonordinary files and overly permissive existing store objects are rejected,
not followed or silently repaired. Windows uses the current user's application
data directory and its inherited ACL; actual Windows ACL and application
acceptance remain explicitly unverified in this macOS task.

Missing/corrupt keys with existing records never cause silent key regeneration.
Malformed envelopes, oversized reads, tampering, wrong-account records and
unsupported versions fail closed without overwriting the original. A user may
explicitly forget an individual corrupt record. The key remains stable after
deleting the last record. Exceptions contain no secrets or sensitive file data.

## Security And Compatibility

Automatic unlocking stores the decryption key on the same machine. Anyone who
can read both key and records can decrypt them; this is not Keychain-equivalent
isolation and does not defend against the current user, administrator or malware.
No master password, hardware binding, cloud synchronization or portable export
is added. OS entropy is not an OS credential-vault dependency.

The filesystem store is platform-neutral, not a claim of Windows application
support. Profile v2, credential identity hashes, host trust, session behavior and
IPC shapes remain unchanged. Rollback to preview.8 uses its old Keychain items;
new local secrets do not synchronize back.

## Verification And Boundaries

Use only temporary directories, generated fixture keys, loopback SFTP and
in-memory browser IPC. Test persistence, optional saving, metadata queries,
wrong-key/tampering, record substitution, missing-key preservation, corruption,
concurrency, deletion, permissions, links, bounds and save failures.
Run existing connection, profile, multi-session, frontend, browser and packaging
regressions. Do not read real credentials, contact user servers, replace installed
apps, alter system security settings or claim native Windows/macOS acceptance
from headless results. Clean this task's fixtures and reports.
