import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRemoteConnection } from "../src/lib/useRemoteConnection";
import type { ConnectionProfile } from "../src/lib/types";

const remote = vi.hoisted(() => ({
  saved: false, trusted: true, failAuth: false,
  probe: vi.fn(), auth: vi.fn(), list: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), status: vi.fn(),
}));
const profile: ConnectionProfile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "独立测试", host: "example.invalid",
  port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: ".",
};
const input = { secret: "generated-test-only", privateKeyContent: null, remember: false };
vi.mock("../src/lib/api", () => ({
  isDesktop: true,
  errorMessage: (cause: { message: string }) => cause.message,
  errorCode: (cause: { code?: string }) => cause.code,
  api: {
    credentialStatus: () => remote.status(),
    probeConnection: (...args: unknown[]) => remote.probe(...args),
    authenticateConnection: (...args: unknown[]) => remote.auth(...args),
    listRemoteDirectory: (...args: unknown[]) => remote.list(...args),
    trustConnection: async () => { remote.trusted = true; },
    cancelConnection: (...args: unknown[]) => remote.cancel(...args),
    disconnectSession: (...args: unknown[]) => remote.disconnect(...args),
  },
}));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  remote.saved = false; remote.trusted = true; remote.failAuth = false;
  remote.cancel.mockResolvedValue(undefined); remote.disconnect.mockResolvedValue(undefined);
  remote.status.mockReset().mockImplementation(async () => ({ available: remote.saved, supported: true }));
  remote.probe.mockImplementation(async (_id, attemptId) => ({
    attemptId, trusted: remote.trusted, host: profile.host, port: 22,
    identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:generated" },
  }));
  remote.auth.mockImplementation(async () => {
    if (remote.failAuth) throw { code: "authentication_failed", message: "测试凭据无效" };
    return { sessionId: crypto.randomUUID(), profileId: profile.id, initialPath: "/home/tester", warning: null };
  });
  remote.list.mockImplementation(async (_id, path) => ({ path, parentPath: "/", entries: [], warnings: [] }));
});

it("trusted hosts automatically authenticate with available saved credentials", async () => {
  remote.saved = true;
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(); });
  await waitFor(() => expect(hook.result.current.listing?.path).toBe("/home/tester"));
  expect(hook.result.current.attempt).toBeNull();
  expect(remote.auth).toHaveBeenCalledWith(expect.any(String), null, false, null);
});

it("saved credentials are not sent until a first-use host is explicitly trusted", async () => {
  remote.saved = true; remote.trusted = false;
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(); });
  expect(hook.result.current.attempt?.phase).toBe("trust");
  expect(remote.auth).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.trust(); });
  await waitFor(() => expect(hook.result.current.session).not.toBeNull());
});

it("a failed automatic credential attempt leaves a manual form and does not loop", async () => {
  remote.saved = true; remote.failAuth = true;
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(); });
  expect(hook.result.current.attempt?.phase).toBe("auth");
  expect(hook.result.current.dialogError).toBe("测试凭据无效");
  expect(remote.auth).toHaveBeenCalledTimes(1);
});

it("restores the last successful directory after unmount and reconnect, not an unsubmitted input", async () => {
  const first = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await first.result.current.connect(input); });
  await act(async () => { await first.result.current.navigate("/srv/application/logs"); });
  act(() => first.result.current.setPath("/not-submitted"));
  first.unmount();
  const second = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await second.result.current.connect(input); });
  await waitFor(() => expect(second.result.current.listing?.path).toBe("/srv/application/logs"));
});

it("invalid remembered directories fall back once to the configured initial path with a notice", async () => {
  const first = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await first.result.current.connect(input); });
  await act(async () => { await first.result.current.navigate("/removed"); });
  first.unmount();
  remote.list.mockImplementation(async (_id, path) => {
    if (path === "/removed") throw { code: "remote_directory", message: "目录不存在" };
    return { path, parentPath: "/", entries: [], warnings: [] };
  });
  const notices: string[] = [];
  const second = renderHook(() => useRemoteConnection(profile, (message) => notices.push(message)));
  await act(async () => { await second.result.current.connect(input); });
  await waitFor(() => expect(second.result.current.listing?.path).toBe("/home/tester"));
  expect(notices.join(" ")).toMatch(/上次.*目录/u);
});

it("changed endpoints cannot reuse a profile's remembered remote location", async () => {
  const first = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await first.result.current.connect(input); });
  await act(async () => { await first.result.current.navigate("/old-server-only"); });
  first.unmount();
  const second = renderHook(() => useRemoteConnection({ ...profile, host: "other.invalid" }, () => {}));
  await act(async () => { await second.result.current.connect(input); });
  await waitFor(() => expect(second.result.current.listing?.path).toBe("/home/tester"));
});

it("successful back/forward navigation preserves history and a new path discards the forward branch", async () => {
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(input); });
  await act(async () => { await hook.result.current.navigate("/one"); });
  await act(async () => { await hook.result.current.navigate("/two"); });
  await act(async () => { await hook.result.current.goBack(); });
  expect(hook.result.current.listing?.path).toBe("/one");
  expect(hook.result.current.canGoForward).toBe(true);
  await act(async () => { await hook.result.current.navigate("/three"); });
  expect(hook.result.current.canGoForward).toBe(false);
});

it("failed and stale listings never replace the last accepted location or add history", async () => {
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(input); });
  let finish!: (value: unknown) => void;
  remote.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void hook.result.current.navigate("/slow"); });
  await act(async () => { await hook.result.current.navigate("/fast"); });
  await act(async () => { finish({ path: "/slow", parentPath: "/", entries: [], warnings: [] }); });
  remote.list.mockRejectedValueOnce({ code: "remote_directory", message: "不存在" });
  await act(async () => { await hook.result.current.navigate("/failed"); });
  await act(async () => { await hook.result.current.goBack(); });
  expect(hook.result.current.listing?.path).toBe("/home/tester");
  await act(async () => { await hook.result.current.goForward(); });
  expect(hook.result.current.listing?.path).toBe("/fast");
  hook.unmount();
  const next = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await next.result.current.connect(input); });
  expect(next.result.current.listing?.path).toBe("/fast");
});
it("network failure while restoring a location does not retry the initial directory", async () => {
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await hook.result.current.connect(input); });
  await act(async () => { await hook.result.current.navigate("/lost"); });
  hook.unmount();
  remote.list.mockClear().mockRejectedValue({ code: "connection_lost", message: "网络中断" });
  const next = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => { await next.result.current.connect(input); });
  expect(next.result.current.session).toBeNull();
  expect(next.result.current.error).toBe("网络中断");
  expect(remote.list).toHaveBeenCalledTimes(1);
  expect(remote.list).toHaveBeenCalledWith(expect.any(String), "/lost");
});
it("canceling during a saved-credential status check cannot start authentication later", async () => {
  let finish!: (value: unknown) => void;
  remote.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const hook = renderHook(() => useRemoteConnection(profile, () => {}));
  act(() => { void hook.result.current.connect(); });
  await waitFor(() => expect(remote.status).toHaveBeenCalled());
  act(() => hook.result.current.cancel());
  await act(async () => { finish({ available: true, supported: true }); });
  expect(remote.auth).not.toHaveBeenCalled();
  expect(hook.result.current.attempt).toBeNull();
});

const otherProfile = { ...profile, id: "f148fd16-f1a2-442b-a3a6-01a8ee91462f", name: "另一个连接" };
function multipleSessions() {
  const attempts = new Map<string, string>();
  remote.probe.mockImplementation(async (profileId, attemptId) => {
    attempts.set(attemptId, profileId);
    return {
      attemptId, trusted: true, host: profile.host, port: 22,
      identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:generated" },
    };
  });
  remote.auth.mockImplementation(async (attemptId) => ({
    sessionId: `session-${attempts.get(attemptId)}`, profileId: attempts.get(attemptId),
    initialPath: "/home/tester", warning: null,
  }));
}

it("switching back restores a live session, path input and history without reconnecting", async () => {
  multipleSessions();
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  await act(async () => { await hook.result.current.connect(input); });
  const firstSession = hook.result.current.session!.sessionId;
  await act(async () => { await hook.result.current.navigate("/srv/one"); });
  await act(async () => { await hook.result.current.navigate("/srv/two"); });
  act(() => hook.result.current.setPath("/not-submitted"));
  hook.rerender({ selected: otherProfile });
  await act(async () => { await hook.result.current.connect(input); });
  expect(hook.result.current.session?.profileId).toBe(otherProfile.id);
  hook.rerender({ selected: profile });
  expect(hook.result.current.session?.sessionId).toBe(firstSession);
  expect(hook.result.current.path).toBe("/not-submitted");
  expect(hook.result.current.listing?.path).toBe("/srv/two");
  await act(async () => { await hook.result.current.goBack(); });
  expect(hook.result.current.listing?.path).toBe("/srv/one");
  expect(hook.result.current.canGoForward).toBe(true);
  expect(remote.disconnect).not.toHaveBeenCalled();
  expect(remote.auth).toHaveBeenCalledTimes(2);
});

it("late directory results update the original background workspace, never the selected server", async () => {
  multipleSessions();
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  await act(async () => { await hook.result.current.connect(input); });
  let finish!: (value: unknown) => void;
  remote.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void hook.result.current.navigate("/background-result"); });
  hook.rerender({ selected: otherProfile });
  await act(async () => { await hook.result.current.connect(input); });
  await act(async () => { finish({ path: "/background-result", parentPath: "/", entries: [], warnings: [] }); });
  expect(hook.result.current.listing?.path).toBe("/home/tester");
  hook.rerender({ selected: profile });
  expect(hook.result.current.listing?.path).toBe("/background-result");
  expect(hook.result.current.loading).toBe(false);
});

it("disconnecting one profile preserves the other and unmount closes the remaining sessions", async () => {
  multipleSessions();
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  await act(async () => { await hook.result.current.connect(input); });
  const firstSession = hook.result.current.session!.sessionId;
  hook.rerender({ selected: otherProfile });
  await act(async () => { await hook.result.current.connect(input); });
  const otherSession = hook.result.current.session!.sessionId;
  act(() => hook.result.current.cancel());
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(otherSession);
  hook.rerender({ selected: profile });
  expect(hook.result.current.session?.sessionId).toBe(firstSession);
  hook.unmount();
  expect(remote.disconnect).toHaveBeenCalledWith(firstSession);
  expect(remote.disconnect).toHaveBeenCalledTimes(2);
});

it("a background network failure closes only its own session", async () => {
  multipleSessions();
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  await act(async () => { await hook.result.current.connect(input); });
  let fail!: (cause: unknown) => void;
  remote.list.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  act(() => { void hook.result.current.navigate("/lost"); });
  hook.rerender({ selected: otherProfile });
  await act(async () => { await hook.result.current.connect(input); });
  const liveSession = hook.result.current.session!.sessionId;
  await act(async () => { fail({ code: "connection_lost", message: "原连接网络中断" }); });
  expect(hook.result.current.session?.sessionId).toBe(liveSession);
  expect(hook.result.current.error).toBe("");
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(`session-${profile.id}`);
  hook.rerender({ selected: profile });
  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.error).toBe("原连接网络中断");
});

it.each(["identity change", "deletion"])("reconciling a background %s closes that profile only", async (change) => {
  multipleSessions();
  const hook = renderHook(({ selected, all }) => useRemoteConnection(selected, () => {}, all), {
    initialProps: { selected: profile, all: [profile, otherProfile] },
  });
  await act(async () => { await hook.result.current.connect(input); });
  hook.rerender({ selected: otherProfile, all: [profile, otherProfile] });
  await act(async () => { await hook.result.current.connect(input); });
  const liveSession = hook.result.current.session!.sessionId;
  const updated = { ...profile, host: "new-endpoint.invalid" };
  hook.rerender({ selected: otherProfile, all: change === "deletion" ? [otherProfile] : [updated, otherProfile] });
  expect(hook.result.current.session?.sessionId).toBe(liveSession);
  expect(hook.result.current.sessions.map((session) => session.sessionId)).toEqual([liveSession]);
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith(`session-${profile.id}`);
});

it("a canceled late authentication cannot overwrite another live connection", async () => {
  multipleSessions();
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  await act(async () => { await hook.result.current.connect(input); });
  hook.rerender({ selected: otherProfile });
  let finish!: (value: unknown) => void;
  remote.auth.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => { void hook.result.current.connect(input); });
  await waitFor(() => expect(remote.auth).toHaveBeenCalledTimes(2));
  hook.rerender({ selected: profile });
  await act(async () => {
    finish({ sessionId: "late-background", profileId: otherProfile.id, initialPath: "/", warning: null });
  });
  expect(hook.result.current.session?.sessionId).toBe(`session-${profile.id}`);
  expect(remote.disconnect).toHaveBeenCalledExactlyOnceWith("late-background");
  hook.rerender({ selected: otherProfile });
  expect(hook.result.current.session).toBeNull();
  expect(hook.result.current.attempt).toBeNull();
});

it("a slow initial directory for an authenticated background session cannot block the next authentication", async () => {
  multipleSessions();
  let finish!: (value: unknown) => void;
  remote.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const hook = renderHook(({ selected }) => useRemoteConnection(selected, () => {}), {
    initialProps: { selected: profile },
  });
  act(() => { void hook.result.current.connect(input); });
  await waitFor(() => expect(hook.result.current.session?.profileId).toBe(profile.id));
  expect(hook.result.current.loading).toBe(true);
  hook.rerender({ selected: otherProfile });
  await act(async () => { await hook.result.current.connect(input); });
  expect(hook.result.current.session?.profileId).toBe(otherProfile.id);
  expect(hook.result.current.working).toBe(false);
  await act(async () => { finish({ path: "/slow-home", parentPath: "/", entries: [], warnings: [] }); });
  expect(hook.result.current.listing?.path).toBe("/home/tester");
  hook.rerender({ selected: profile });
  expect(hook.result.current.listing?.path).toBe("/slow-home");
});
