# Multiple Connections

## Approved Behavior

Switching the selected saved connection changes the visible remote workspace,
not the lifetime of its authenticated session. Each profile has at most one
authenticated session. Previously connected profiles remain connected until
explicitly disconnected, removed, changed to a different authentication
identity, lost to a network error, or the app exits.

Each connection retains its accepted directory, path input, listing, navigation
history, loading state and directory errors. Late responses update only their
original connection and cannot reopen a canceled authentication dialog.
Authentication remains a single foreground operation; switching away cancels
an unfinished attempt, without closing authenticated connections.

The sidebar marks every live connection. Double-clicking a live profile selects
its workspace without another authentication request. In-progress transfers
continue while browsing another profile. File mutations remain blocked only
for the session with unfinished transfers. Retry and conflict actions retain
the task's original session, including background sessions; disconnected tasks
cannot borrow another live connection.

Completed uploads refresh their destination when that directory is next shown,
including completions received while the connection was in the background.
Switching still closes file dialogs and invalidates old internal/Finder drag
tickets. Unsubmitted path input must not be used as a transfer destination.

Manual disconnect with unfinished transfers keeps the existing protection:
finish or cancel that connection's tasks first. Editing or deleting another
connection must inspect that target's tasks, not the visible connection's tasks.
Normal app exit cancels and drains the transfer queue, closes every browsing
and draft connection, and prevents new work.

## Boundaries

Keep profile format v2, existing IPC session identifiers, Keychain storage,
host-key verification, transfer commit/cleanup policies and platform support.
No connection, credential or queue is persisted across process restarts beyond
the already-supported profile and last-directory records. Network failures and
server idle timeouts can still end a session; there is no automatic reconnect.

Use only isolated protocol fixtures and in-memory browser IPC fixtures.
Do not connect to user servers, access real credentials or replace an installed
application. Clean up this task's temporary servers, files and test reports.

## Implementation Boundaries

- `connections.rs`: session-id-indexed active connections, precise lifecycle
  actions and idempotent shutdown. Pending authentication remains single.
- `useRemoteConnection.ts`: profile-indexed view state, foreground authentication,
  profile reconciliation, all-live-session metadata and precise disconnect.
- `App.tsx`, `Sidebar.tsx`, `TransferQueue.tsx`: selection, session-local mutation
  guards, all-session status and task actions, delayed directory refresh.
- Frontend, Playwright and real SFTP tests: switching, late responses, background
  transfers, targeted invalidation and full shutdown.

The user approved this design in the current conversation on 2026-11-06.
