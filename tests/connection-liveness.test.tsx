import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRemoteLocation } from "../src/lib/remoteLocations";
import { useRemoteConnection } from "../src/lib/useRemoteConnection";
import type { ConnectedSession, ConnectionProfile, DirectoryListing } from "../src/lib/types";

const remote = vi.hoisted(() => ({
  desktop: true, sequence: 0, attempts: new Map<string, string>(),
  probe: vi.fn(), authenticate: vi.fn(), list: vi.fn(), check: vi.fn(), disconnect: vi.fn(), cancel: vi.fn(),
}));
vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...actual,
    get isDesktop() { return remote.desktop; },
    api: {
      ...actual.api,
      credentialStatus: async () => ({ available: false, supported: true }),
      probeConnection: (...args: unknown[]) => remote.probe(...args),
      authenticateConnection: (...args: unknown[]) => remote.authenticate(...args),
      listRemoteDirectory: (...args: unknown[]) => remote.list(...args),
      checkSession: (...args: unknown[]) => remote.check(...args),
      disconnectSession: (...args: unknown[]) => remote.disconnect(...args),
      cancelConnection: (...args: unknown[]) => remote.cancel(...args),
    },
  };
});

const profile: ConnectionProfile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "生产服务器", host: "production.invalid",
  port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: ".",
};
const otherProfile: ConnectionProfile = {
  ...profile, id: "a761b759-3b79-4f00-ae1f-f4cdc1e3d947", name: "测试服务器", host: "staging.invalid",
};
const input = { secret: null, remember: false, privateKeyContent: null };
const lost = { code: "connection_lost", message: "服务器连接已中断，请重新连接" };
const closed = { code: "session_closed", message: "连接已关闭，请重新连接" };
const listing = (path: string): DirectoryListing => ({
  path, parentPath: path === "/" ? null : "/", warnings: [],
  entries: [{ name: "server.txt", path: `${path}/server.txt`, isDir: false, isSymlink: false, size: 10, modifiedMs: null, hidden: false }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup() {
  const notice = vi.fn();
  const hook = renderHook(
    ({ selected, all }: { selected: ConnectionProfile | null; all: ConnectionProfile[] }) =>
      useRemoteConnection(selected, notice, all),
    { initialProps: { selected: profile, all: [profile, otherProfile] } },
  );
  return { ...hook, notice };
}
async function connect(hook: ReturnType<typeof setup>): Promise<ConnectedSession> {
  await act(async () => { await hook.result.current.connect(input); });
  expect(hook.result.current.session).not.toBeNull();
  return hook.result.current.session!;
}
async function advance(milliseconds = 30_000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
async function focus() {
  await act(async () => { fireEvent.focus(window); });
}
async function visible() {
  await act(async () => { fireEvent(document, new Event("visibilitychange")); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
  vi.resetAllMocks();
  localStorage.clear();
  remote.desktop = true; remote.sequence = 0; remote.attempts.clear();
  remote.probe.mockImplementation(async (profileId: string, attemptId: string) => {
    remote.attempts.set(attemptId, profileId);
    return {
      attemptId, trusted: true, host: "fixture.invalid", port: 22,
      identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" },
    };
  });
  remote.authenticate.mockImplementation(async (attemptId: string) => ({
    sessionId: `session-${++remote.sequence}`, profileId: remote.attempts.get(attemptId),
    initialPath: "/home/tester", warning: null,
  }));
  remote.list.mockImplementation(async (_id: string, path: string) => listing(path));
  remote.check.mockResolvedValue(undefined);
  remote.disconnect.mockResolvedValue(undefined);
  remote.cancel.mockResolvedValue(undefined);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("checks all authenticated sessions every 30 seconds without refreshing directories or changing navigation", async () => {
  const hook = setup();
  const first = await connect(hook);
  await act(async () => { await hook.result.current.navigate("/one"); });
  await act(async () => { await hook.result.current.navigate("/two"); });
  await act(async () => { await hook.result.current.goBack(); });
  act(() => hook.result.current.setPath("/not-submitted"));
  const firstListing = hook.result.current.listing;
  hook.rerender({ selected: otherProfile, all: [profile, otherProfile] });
  const second = await connect(hook);
  const secondListing = hook.result.current.listing;
  const directoryCalls = remote.list.mock.calls.length;

  await advance(29_999);
  expect(remote.check).not.toHaveBeenCalled();
  await advance(1);
  expect(remote.check.mock.calls).toEqual([[first.sessionId], [second.sessionId]]);
  expect(hook.result.current.session).toBe(second);
  expect(hook.result.current.listing).toBe(secondListing);
  expect(remote.list).toHaveBeenCalledTimes(directoryCalls);
  expect(remote.authenticate).toHaveBeenCalledTimes(2);
  hook.rerender({ selected: profile, all: [profile, otherProfile] });
  expect(hook.result.current.path).toBe("/not-submitted");
  expect(hook.result.current.listing).toBe(firstListing);
  expect(hook.result.current.canGoBack).toBe(true);
  expect(hook.result.current.canGoForward).toBe(true);
  await advance();
  expect(remote.check.mock.calls).toEqual([
    [first.sessionId], [second.sessionId], [first.sessionId], [second.sessionId],
  ]);
  expect(hook.notice).not.toHaveBeenCalled();
});

it.each(["focus", "visibility"] as const)("immediately checks sessions on %s recovery and reports the disconnected connection", async (event) => {
  const hook = setup();
  const session = await connect(hook);
  remote.check.mockRejectedValueOnce(lost);
  if (event === "visibility") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await visible();
    expect(remote.check).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await visible();
  } else await focus();

  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.sessions).toEqual([]);
  expect(hook.result.current.listing).toBeNull();
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.error).toBe(lost.message);
  expect(hook.notice).toHaveBeenCalledWith(expect.stringContaining(profile.name));
  expect(hook.notice).toHaveBeenCalledWith(expect.stringContaining(lost.message));
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  expect(remote.authenticate).toHaveBeenCalledOnce();
});

it("timer-only recovery checks sessions after a suspended wall clock resumes", async () => {
  const hook = setup();
  await connect(hook);
  await advance();
  expect(remote.check).toHaveBeenCalledOnce();
  vi.setSystemTime(new Date("2026-11-11T03:00:00Z"));
  remote.check.mockRejectedValueOnce(closed);
  await advance();
  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.error).toBe(closed.message);
});

it("includes newly authenticated sessions after earlier empty or unauthenticated timer ticks", async () => {
  const hook = setup();
  await advance();
  await focus();
  expect(remote.check).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.connect(); });
  expect(hook.result.current.attempt?.phase).toBe("auth");
  await advance();
  expect(remote.check).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.authenticate(null, false); });
  const session = hook.result.current.session!;
  remote.check.mockRejectedValueOnce(closed);
  await advance();
  expect(remote.check).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  expect(hook.result.current.session).toBeNull();
});

it("a slow session cannot delay detecting another background session's failure", async () => {
  const hook = setup();
  const first = await connect(hook);
  const firstListing = hook.result.current.listing;
  hook.rerender({ selected: otherProfile, all: [profile, otherProfile] });
  const second = await connect(hook);
  hook.rerender({ selected: profile, all: [profile, otherProfile] });
  const slow = deferred<void>();
  remote.check.mockImplementation((id: string) => id === first.sessionId ? slow.promise : Promise.reject(lost));
  await advance();

  expect(hook.result.current.sessions).toEqual([first]);
  expect(hook.result.current.session).toBe(first);
  expect(hook.result.current.listing).toBe(firstListing);
  expect(hook.result.current.error).toBe("");
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(second.sessionId);
  expect(hook.notice).toHaveBeenCalledWith(expect.stringContaining(otherProfile.name));
  hook.rerender({ selected: otherProfile, all: [profile, otherProfile] });
  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.listing).toBeNull();
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.error).toBe(lost.message);
  await act(async () => { slow.resolve(undefined); });
});

it("a failed health check cancels in-flight directory UI and preserves the last successful location", async () => {
  const hook = setup();
  const session = await connect(hook);
  await act(async () => { await hook.result.current.navigate("/remembered"); });
  const pending = deferred<DirectoryListing>();
  remote.list.mockReturnValueOnce(pending.promise);
  let navigation!: Promise<void>;
  act(() => { navigation = hook.result.current.navigate("/pending"); });
  expect(hook.result.current.loading).toBe(true);
  remote.check.mockRejectedValueOnce(lost);
  await advance();

  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.listing).toBeNull();
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.error).toBe(lost.message);
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  await act(async () => { pending.resolve(listing("/pending")); await navigation; });
  expect(hook.result.current.listing).toBeNull();
  expect(hook.result.current.error).toBe(lost.message);
  expect(readRemoteLocation(profile)).toBe("/remembered");
  expect(remote.authenticate).toHaveBeenCalledOnce();
  await connect(hook);
  expect(hook.result.current.listing?.path).toBe("/remembered");
});

it.each(["success", "failure"] as const)("ignores a late old-session health %s without blocking the replacement session's checks", async (outcome) => {
  const hook = setup();
  const old = await connect(hook);
  const oldProbe = deferred<void>();
  remote.check.mockReturnValueOnce(oldProbe.promise);
  await advance();
  expect(remote.check).toHaveBeenCalledExactlyOnceWith(old.sessionId);
  act(() => hook.result.current.cancel());
  const replacement = await connect(hook);
  const replacementListing = hook.result.current.listing;
  const replacementProbe = deferred<void>();
  remote.check.mockReturnValueOnce(replacementProbe.promise);
  await focus();
  expect(remote.check.mock.calls).toEqual([[old.sessionId], [replacement.sessionId]]);
  await act(async () => {
    if (outcome === "success") oldProbe.resolve(undefined);
    else oldProbe.reject(lost);
  });
  expect(hook.result.current.session).toBe(replacement);
  expect(hook.result.current.listing).toBe(replacementListing);
  expect(hook.result.current.error).toBe("");
  expect(hook.notice).not.toHaveBeenCalled();
  await focus();
  expect(remote.check).toHaveBeenCalledTimes(2);
  await act(async () => { replacementProbe.resolve(undefined); });
  remote.check.mockRejectedValueOnce(closed);
  await focus();
  expect(hook.result.current.session).toBeNull();
  expect(remote.disconnect.mock.calls).toEqual([[old.sessionId], [replacement.sessionId]]);
});

it("never overlaps checks for an exact session across interval, focus and visibility events", async () => {
  const hook = setup();
  const first = await connect(hook);
  hook.rerender({ selected: otherProfile, all: [profile, otherProfile] });
  const second = await connect(hook);
  const pending = deferred<void>();
  remote.check.mockImplementation((id: string) => id === first.sessionId ? pending.promise : Promise.resolve());
  await advance();
  await focus();
  await visible();
  await advance(60_000);
  expect(remote.check.mock.calls.filter(([id]) => id === first.sessionId)).toHaveLength(1);
  expect(remote.check.mock.calls.filter(([id]) => id === second.sessionId)).toHaveLength(5);
  await act(async () => { pending.resolve(undefined); });
  await focus();
  expect(remote.check.mock.calls.filter(([id]) => id === first.sessionId)).toHaveLength(2);
  expect(hook.result.current.sessions).toEqual([first, second]);
});

it.each(["identity change", "deletion"] as const)("ignores health errors from a workspace released by %s", async (change) => {
  const hook = setup();
  const old = await connect(hook);
  const pending = deferred<void>();
  remote.check.mockReturnValueOnce(pending.promise);
  await advance();
  expect(remote.check).toHaveBeenCalledExactlyOnceWith(old.sessionId);
  const updated = { ...profile, host: "replacement.invalid" };
  const all = change === "deletion" ? [otherProfile] : [updated, otherProfile];
  hook.rerender({ selected: otherProfile, all });
  const other = await connect(hook);
  if (change === "identity change") {
    hook.rerender({ selected: updated, all });
    await connect(hook);
  }
  const current = hook.result.current.session;
  await act(async () => { pending.reject(lost); });
  expect(hook.result.current.session).toBe(current);
  expect(hook.result.current.sessions).toContain(other);
  expect(hook.result.current.error).toBe("");
  expect(hook.notice).not.toHaveBeenCalled();
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(old.sessionId);
});

it.each([
  new Error("IPC 暂时不可用"),
  { code: "ipc_error", message: "IPC 暂时不可用" },
  { code: "remote_directory", message: "没有读取目录的权限" },
])("non-session health error $message never disconnects a live workspace", async (cause) => {
  const hook = setup();
  const session = await connect(hook);
  const accepted = hook.result.current.listing;
  act(() => hook.result.current.setPath("/not-submitted"));
  remote.check.mockRejectedValueOnce(cause);
  await advance();
  expect(remote.check).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  expect(hook.result.current.session).toBe(session);
  expect(hook.result.current.listing).toBe(accepted);
  expect(hook.result.current.path).toBe("/not-submitted");
  expect(hook.result.current.error).toBe("");
  expect(remote.disconnect).not.toHaveBeenCalled();
  await advance();
  expect(remote.check).toHaveBeenCalledTimes(2);
  expect(hook.result.current.session).toBe(session);
});

it.each(["connection_lost", "session_closed"])("a superseded directory %s error still invalidates its exact session", async (code) => {
  const hook = setup();
  const session = await connect(hook);
  const pending = deferred<DirectoryListing>();
  remote.list.mockReturnValueOnce(pending.promise);
  let navigation!: Promise<void>;
  act(() => { navigation = hook.result.current.navigate("/older"); });
  await act(async () => { await hook.result.current.navigate("/newer"); });
  expect(hook.result.current.listing?.path).toBe("/newer");
  await act(async () => { pending.reject({ code, message: lost.message }); await navigation; });
  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.listing).toBeNull();
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.error).toBe(lost.message);
  expect(readRemoteLocation(profile)).toBe("/newer");
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(session.sessionId);
});

it("a superseded directory permission error does not invalidate or overwrite the current directory", async () => {
  const hook = setup();
  const session = await connect(hook);
  const pending = deferred<DirectoryListing>();
  remote.list.mockReturnValueOnce(pending.promise);
  let navigation!: Promise<void>;
  act(() => { navigation = hook.result.current.navigate("/older"); });
  await act(async () => { await hook.result.current.navigate("/newer"); });
  await act(async () => {
    pending.reject({ code: "remote_directory", message: "没有读取权限" });
    await navigation;
  });
  expect(hook.result.current.session).toBe(session);
  expect(hook.result.current.listing?.path).toBe("/newer");
  expect(hook.result.current.error).toBe("");
  expect(remote.disconnect).not.toHaveBeenCalled();
});

it("an old directory fatal error cannot disconnect a manually reconnected session", async () => {
  const hook = setup();
  const old = await connect(hook);
  const pending = deferred<DirectoryListing>();
  remote.list.mockReturnValueOnce(pending.promise);
  let navigation!: Promise<void>;
  act(() => { navigation = hook.result.current.navigate("/older"); });
  act(() => hook.result.current.cancel());
  const replacement = await connect(hook);
  const accepted = hook.result.current.listing;
  await act(async () => { pending.reject(lost); await navigation; });
  expect(hook.result.current.session).toBe(replacement);
  expect(hook.result.current.listing).toBe(accepted);
  expect(hook.result.current.error).toBe("");
  expect(hook.notice).not.toHaveBeenCalled();
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(old.sessionId);
});

it("unmount removes health timers and listeners and ignores in-flight failures", async () => {
  const hook = setup();
  const session = await connect(hook);
  const pending = deferred<void>();
  remote.check.mockReturnValueOnce(pending.promise);
  await advance();
  expect(remote.check).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  const removeWindow = vi.spyOn(window, "removeEventListener");
  const removeDocument = vi.spyOn(document, "removeEventListener");
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
  expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  await focus();
  await visible();
  await advance(90_000);
  await act(async () => { pending.reject(lost); });
  expect(remote.check).toHaveBeenCalledOnce();
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(session.sessionId);
  expect(hook.notice).not.toHaveBeenCalled();
});

it("browser preview never starts session health checks or health timers", async () => {
  remote.desktop = false;
  const hook = setup();
  await connect(hook);
  await focus();
  await visible();
  await advance(90_000);
  expect(remote.check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
