import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { useRemoteConnection } from "../src/lib/useRemoteConnection";
import type { ConnectionProfile } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  trusted: false, authenticated: false,
  probe: vi.fn(), trust: vi.fn(), authenticate: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(), listRemote: vi.fn(),
  listLocal: vi.fn(), enqueue: vi.fn(), snapshot: vi.fn(),
}));
const profile: ConnectionProfile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "测试 SFTP", host: "sftp.example.com",
  port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: ".",
};
vi.mock("../src/lib/api", () => ({
  isDesktop: true,
  errorMessage: (cause: unknown) => (cause as { message: string }).message,
  errorCode: (cause: unknown) => (cause as { code?: string }).code,
  api: {
    transferSnapshot: () => fixture.snapshot(),
    enqueueTransfers: (...args: unknown[]) => fixture.enqueue(...args),
    getEnvironment: async () => ({ homePath: "/local", runtime: "desktop", shortcuts: [] }),
    listProfiles: async () => [profile],
    listGroups: async () => [],
    saveProfile: async (value: ConnectionProfile) => value,
    credentialStatus: async () => ({ available: false, supported: true }),
    listDirectory: (...args: unknown[]) => fixture.listLocal(...args),
    probeConnection: (...args: unknown[]) => fixture.probe(...args),
    trustConnection: (...args: unknown[]) => fixture.trust(...args),
    authenticateConnection: (...args: unknown[]) => fixture.authenticate(...args),
    cancelConnection: (...args: unknown[]) => fixture.cancel(...args),
    disconnectSession: (...args: unknown[]) => fixture.disconnect(...args),
    listRemoteDirectory: (...args: unknown[]) => fixture.listRemote(...args),
    forgetCredential: async () => {},
  },
}));

beforeEach(() => {
  localStorage.clear();
  fixture.trusted = false; fixture.authenticated = false;
  fixture.snapshot.mockReset().mockResolvedValue({ revision: 0, concurrency: 3, jobs: [] });
  fixture.listLocal.mockReset().mockResolvedValue({
    path: "/local", parentPath: "/", warnings: [],
    entries: [{ name: "upload.txt", path: "/local/upload.txt", isDir: false, isSymlink: false, size: 3, modifiedMs: null, hidden: false }],
  });
  fixture.enqueue.mockReset().mockResolvedValue(["job"]);
  fixture.cancel.mockReset().mockResolvedValue(undefined);
  fixture.disconnect.mockReset().mockResolvedValue(undefined);
  fixture.trust.mockReset().mockImplementation(async () => { fixture.trusted = true; });
  fixture.probe.mockReset().mockImplementation(async (_id, attemptId) => ({
    attemptId, host: profile.host, port: 22, trusted: fixture.trusted,
    identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:abcd1234" },
  }));
  fixture.authenticate.mockReset().mockImplementation(async (_attemptId, secret) => {
    if (!fixture.trusted) throw { code: "host_not_trusted", message: "主机尚未信任" };
    if (secret !== "test-password" && secret !== null) throw { code: "authentication_failed", message: "密码不正确" };
    fixture.authenticated = true;
    return { sessionId: "session-1", profileId: profile.id, initialPath: "/", warning: null };
  });
  fixture.listRemote.mockReset().mockImplementation(async (_sessionId, path) => {
    if (!fixture.authenticated) throw new Error("尚未认证");
    if (path === "/denied") throw { code: "remote_directory", message: "没有读取权限" };
    return {
      path, parentPath: path === "/" ? null : "/", warnings: [],
      entries: path === "/" ? [{ name: "remote-folder", path: "/remote-folder", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false }] : [],
    };
  });
});

it("上传下载只使用另一栏已打开的目录，不使用尚未提交的路径输入", async () => {
  fixture.trusted = true;
  fixture.listRemote.mockResolvedValue({
    path: "/", parentPath: null, warnings: [],
    entries: [{ name: "download.txt", path: "/download.txt", isDir: false, isSymlink: false, size: 3, modifiedMs: null, hidden: false }],
  });
  await start();
  await screen.findByText("upload.txt");
  fireEvent.click(screen.getByLabelText("选择 upload.txt"));
  expect(screen.getByRole("button", { name: "上传所选文件" })).toBeDisabled();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await screen.findByText("download.txt");
  fireEvent.change(screen.getByLabelText("远程路径"), { target: { value: "/not-submitted" } });
  fireEvent.click(screen.getByRole("button", { name: "上传所选文件" }));
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledWith([
    { sessionId: "session-1", direction: "upload", sourcePath: "/local/upload.txt", destinationDir: "/" },
  ]));
  fireEvent.change(screen.getByLabelText("本地路径"), { target: { value: "/not-submitted-local" } });
  fireEvent.click(screen.getByLabelText("选择 download.txt"));
  fireEvent.click(screen.getByRole("button", { name: "下载所选文件" }));
  await waitFor(() => expect(fixture.enqueue).toHaveBeenLastCalledWith([
    { sessionId: "session-1", direction: "download", sourcePath: "/download.txt", destinationDir: "/local" },
  ]));
});

it("双击已连接对象不会重新探测或断开服务器", async () => {
  fixture.trusted = true;
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await screen.findByText("remote-folder");
  fireEvent.doubleClick(screen.getByRole("navigation", { name: "已保存连接" }).querySelector("button")!);
  expect(fixture.probe).toHaveBeenCalledTimes(1);
  expect(fixture.disconnect).not.toHaveBeenCalled();
});

it("显式保存并连接可以更换当前活动连接的身份并使用新输入认证", async () => {
  fixture.trusted = true;
  const user = userEvent.setup();
  await start();
  await user.type(await readyPassword(), "test-password");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "连接" }));
  await screen.findByText("remote-folder");
  await user.click(screen.getByRole("button", { name: "管理当前连接" }));
  await user.click(screen.getByRole("menuitem", { name: "编辑连接" }));
  await user.clear(screen.getByLabelText("主机地址"));
  await user.type(screen.getByLabelText("主机地址"), "changed.example.invalid");
  await user.type(screen.getByLabelText("密码"), "test-password");
  await user.click(screen.getByRole("button", { name: "保存并连接" }));
  await waitFor(() => expect(fixture.authenticate).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("remote-folder")).toBeInTheDocument();
});

it("传输完成与目标目录读取重叠时，目录读取后仍会刷新新文件", async () => {
  fixture.trusted = true;
  const entry = { name: "download.txt", path: "/download.txt", isDir: false, isSymlink: false, size: 3, modifiedMs: null, hidden: false };
  fixture.listRemote.mockResolvedValue({ path: "/", parentPath: null, warnings: [], entries: [entry] });
  let finishEnqueue!: (value: string[]) => void;
  fixture.enqueue.mockImplementation(() => new Promise((resolve) => { finishEnqueue = resolve; }));
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await screen.findByText("download.txt");
  fireEvent.click(screen.getByLabelText("选择 download.txt"));
  fireEvent.click(screen.getByRole("button", { name: "下载所选文件" }));
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalled());
  let finishListing!: (value: unknown) => void;
  fixture.listLocal.mockImplementationOnce(() => new Promise((resolve) => { finishListing = resolve; }));
  fixture.listLocal.mockResolvedValue({ path: "/local", parentPath: "/", warnings: [], entries: [{ ...entry, path: "/local/download.txt" }] });
  const localPath = screen.getByLabelText("本地路径");
  fireEvent.submit(localPath.closest("form")!);
  fixture.snapshot.mockResolvedValue({
    revision: 1, concurrency: 3, jobs: [{
      id: "job", name: "download.txt", attempt: 1, sessionId: "session-1", direction: "download",
      sourcePath: "/download.txt", destinationDir: "/local", destinationPath: "/local/download.txt",
      state: "completed", transferredBytes: 3, totalBytes: 3, bytesPerSecond: 0, etaSeconds: null, error: null, warning: null,
    }],
  });
  await act(async () => { finishEnqueue(["job"]); });
  await act(async () => { finishListing({ path: "/local", parentPath: "/", warnings: [], entries: [] }); });
  expect(await within(screen.getByRole("region", { name: "本地文件" })).findByText("download.txt")).toBeInTheDocument();
});

async function start() {
  render(<App />);
  await screen.findByRole("button", { name: /测试 SFTP/ });
  fireEvent.click(screen.getByRole("button", { name: "连接服务器" }));
}

async function readyPassword() {
  const dialog = await screen.findByRole("dialog", { name: "服务器认证" });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "连接" })).toBeEnabled());
  return within(dialog).getByLabelText("密码");
}

function immediateConnection(initialProfile: ConnectionProfile | null) {
  return renderHook(({ selectedProfile }) => {
    const connection = useRemoteConnection(selectedProfile, () => {});
    useLayoutEffect(() => {
      if (selectedProfile) void connection.connect();
    }, [selectedProfile]);
    return connection;
  }, { initialProps: { selectedProfile: initialProfile } });
}

it("配置就绪后的首帧连接不会被延后的初始化清理取消", async () => {
  fixture.trusted = true;
  const { result, rerender } = immediateConnection(null);
  rerender({ selectedProfile: profile });
  await waitFor(() => expect(result.current.attempt?.phase).toBe("auth"));
  expect(fixture.cancel).not.toHaveBeenCalled();
});

it("切换配置后可立即连接，旧握手的迟到响应不会取消新尝试", async () => {
  fixture.trusted = true;
  let finishOld!: (value: unknown) => void;
  fixture.probe.mockImplementationOnce((_id, attemptId) => new Promise((resolve) => {
    finishOld = (value) => resolve({
      attemptId, host: profile.host, port: profile.port, trusted: true,
      identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:old" },
      ...value as object,
    });
  }));
  const { result, rerender } = immediateConnection(profile);
  const oldAttemptId = fixture.probe.mock.calls[0][1];
  const nextProfile = { ...profile, id: "ee3b9e96-029c-44b6-9451-9828b3eb0052", name: "另一个连接" };
  rerender({ selectedProfile: nextProfile });
  await waitFor(() => expect(result.current.attempt?.phase).toBe("auth"));
  const nextAttemptId = result.current.attempt!.id;
  expect(nextAttemptId).not.toBe(oldAttemptId);
  expect(result.current.attempt?.profile.id).toBe(nextProfile.id);
  expect(fixture.cancel).toHaveBeenCalledWith(oldAttemptId);
  await act(async () => { finishOld({}); });
  expect(result.current.attempt?.id).toBe(nextAttemptId);
  expect(fixture.cancel).not.toHaveBeenCalledWith(nextAttemptId);
});

it("首次连接先确认指纹，确认后才输入密码，成功后可进入远程目录", async () => {
  const user = userEvent.setup();
  await start();
  expect(await screen.findByRole("dialog", { name: "确认服务器指纹" })).toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(fixture.authenticate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "信任并继续" }));
  const password = await readyPassword();
  expect(password).toHaveFocus();
  await user.type(password, "test-password");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "连接" }));
  expect(await screen.findByText("remote-folder")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.doubleClick(screen.getByText("remote-folder"));
  await waitFor(() => expect(screen.getByLabelText("远程路径")).toHaveValue("/remote-folder"));
  expect(within(screen.getByRole("region", { name: "远程文件" })).getByText("此目录为空")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "断开服务器" }));
  expect(screen.getByRole("button", { name: "连接服务器" })).toBeInTheDocument();
  expect(fixture.disconnect).toHaveBeenCalledWith("session-1");
});

it("拒绝指纹不会进入认证或保存密码", async () => {
  await start();
  await screen.findByRole("dialog", { name: "确认服务器指纹" });
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fixture.cancel).toHaveBeenCalled();
  expect(fixture.authenticate).not.toHaveBeenCalled();
  expect(localStorage.getItem("password")).toBeNull();
});

it("错误密码保持认证表单，目录错误不伪装成空目录", async () => {
  const user = userEvent.setup();
  fixture.trusted = true;
  await start();
  await user.type(await readyPassword(), "wrong");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "连接" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("密码不正确");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await user.clear(screen.getByLabelText("密码"));
  await user.type(screen.getByLabelText("密码"), "test-password");
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "连接" }));
  await screen.findByText("remote-folder");
  const path = screen.getByLabelText("远程路径");
  fireEvent.change(path, { target: { value: "/denied" } });
  fireEvent.submit(path.closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("没有读取权限");
  expect(screen.getByRole("button", { name: "断开服务器" })).toBeInTheDocument();
});

it("重命名或移动分组不会断开已建立的会话", async () => {
  fixture.trusted = true;
  const { result, rerender } = renderHook(({ selectedProfile }) => useRemoteConnection(selectedProfile, () => {}), {
    initialProps: { selectedProfile: profile },
  });
  await act(async () => { await result.current.connect(); });
  await act(async () => { await result.current.authenticate("test-password", false); });
  expect(result.current.session?.sessionId).toBe("session-1");
  rerender({ selectedProfile: { ...profile, name: "改名", groupId: "f9fd9ec9-642f-454c-9cb1-fbc8c9b4e6b1" } });
  expect(result.current.session?.sessionId).toBe("session-1");
  expect(fixture.disconnect).not.toHaveBeenCalled();
});

it("表单中的临时凭据在信任指纹后直接认证，不再要求重复输入", async () => {
  const { result } = renderHook(() => useRemoteConnection(profile, () => {}));
  await act(async () => {
    await result.current.connect({ secret: "test-password", privateKeyContent: null, remember: true });
  });
  expect(result.current.attempt?.phase).toBe("trust");
  expect(fixture.authenticate).not.toHaveBeenCalled();
  await act(async () => { await result.current.trust(); });
  expect(result.current.session?.sessionId).toBe("session-1");
  expect(fixture.authenticate).toHaveBeenCalledWith(expect.any(String), "test-password", true, null);
});

it("握手取消后晚到的响应不会重新打开认证表单", async () => {
  let finish!: (value: unknown) => void;
  fixture.probe.mockImplementation((_profile, attemptId) => new Promise((resolve) => {
    finish = (value) => resolve({ attemptId, host: profile.host, port: 22, trusted: true, ...value as object });
  }));
  await start();
  await screen.findByRole("dialog", { name: "正在连接服务器" });
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  await act(async () => { finish({}); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(fixture.authenticate).not.toHaveBeenCalled();
});

it("认证取消后晚到的成功会被断开，界面不会显示旧会话", async () => {
  fixture.trusted = true;
  let finish!: (value: unknown) => void;
  fixture.authenticate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await waitFor(() => expect(fixture.authenticate).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "取消连接" }));
  await act(async () => {
    finish({ sessionId: "late-session", profileId: profile.id, initialPath: "/", warning: null });
  });
  expect(fixture.disconnect).toHaveBeenCalledWith("late-session");
  expect(screen.queryByText("remote-folder")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "连接服务器" })).toBeInTheDocument();
});

it("主机指纹变化时显示阻止原因，不提供认证入口", async () => {
  fixture.probe.mockRejectedValue({ code: "host_key_changed", message: "主机指纹已变化，连接已阻止" });
  await start();
  expect(await screen.findByRole("alert")).toHaveTextContent("主机指纹已变化");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  expect(fixture.authenticate).not.toHaveBeenCalled();
});

it.each(["trust", "auth"] as const)("%s 阶段过期后关闭旧表单，重新连接使用新的尝试", async (phase) => {
  fixture.trusted = phase === "auth";
  const expired = { code: "attempt_expired", message: "连接尝试已过期，请重新连接" };
  if (phase === "trust") fixture.trust.mockRejectedValueOnce(expired);
  else fixture.authenticate.mockRejectedValueOnce(expired);
  await start();
  if (phase === "trust") {
    fireEvent.click(await screen.findByRole("button", { name: "信任并继续" }));
  } else {
    const password = await readyPassword();
    fireEvent.change(password, { target: { value: "test-password" } });
    fireEvent.submit(password.closest("form")!);
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const remote = within(screen.getByRole("region", { name: "远程文件" }));
  expect(remote.getByRole("alert")).toHaveTextContent("已过期");
  const firstAttempt = fixture.probe.mock.calls[0][1];
  fireEvent.click(remote.getByRole("button", { name: "连接服务器" }));
  await screen.findByRole("dialog", { name: phase === "trust" ? "确认服务器指纹" : "服务器认证" });
  expect(fixture.probe.mock.calls[1][1]).not.toBe(firstAttempt);
  if (phase === "trust") fireEvent.click(screen.getByRole("button", { name: "信任并继续" }));
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  expect(await screen.findByText("remote-folder")).toBeInTheDocument();
});

it.each(["/denied", "denied", "/denied/"] as const)("目录 %s 无权限后仍可返回上级", async (target) => {
  fixture.trusted = true;
  fixture.listRemote.mockImplementation(async (_sessionId, path) => {
    if (path === "/denied" || path === "/denied/") {
      throw { code: "remote_directory", message: "没有读取权限" };
    }
    return {
      path, parentPath: path === "/" ? null : "/", warnings: [],
      entries: [{ name: "remote-folder", path: "/remote-folder", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false }],
    };
  });
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await screen.findByText("remote-folder");
  const input = screen.getByLabelText("远程路径");
  fireEvent.change(input, { target: { value: target } });
  fireEvent.submit(input.closest("form")!);
  const remote = within(screen.getByRole("region", { name: "远程文件" }));
  expect(await remote.findByRole("alert")).toHaveTextContent("没有读取权限");
  expect(remote.queryByText("此目录为空")).not.toBeInTheDocument();
  const parent = remote.getByRole("button", { name: "远程返回上级" });
  expect(parent).toBeEnabled();
  fireEvent.click(parent);
  expect(await remote.findByText("remote-folder")).toBeInTheDocument();
  expect(input).toHaveValue("/");
  expect(parent).toBeDisabled();
});

it("清空远程路径提交时刷新最后成功打开的目录，仍可返回上级", async () => {
  fixture.trusted = true;
  fixture.authenticate.mockImplementation(async () => ({
    sessionId: "session-1", profileId: profile.id, initialPath: "/home", warning: null,
  }));
  fixture.listRemote.mockImplementation(async (_sessionId, path) => {
    if (!path) throw { code: "invalid_remote_path", message: "请输入有效的远程路径" };
    return {
      path, parentPath: path === "/" ? null : "/", warnings: [],
      entries: [{ name: path === "/" ? "root-folder" : "home-folder", path: `${path}/folder`, isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false }],
    };
  });
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await screen.findByText("home-folder");
  const input = screen.getByLabelText("远程路径");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(input).toHaveValue("/home"));
  const remote = within(screen.getByRole("region", { name: "远程文件" }));
  expect(await remote.findByText("home-folder")).toBeInTheDocument();
  expect(remote.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(remote.getByRole("button", { name: "远程返回上级" }));
  expect(await remote.findByText("root-folder")).toBeInTheDocument();
});

it("相对导航以最后接收的规范目录为基准，不受旧响应影响", async () => {
  fixture.trusted = true;
  let finishOld!: (value: unknown) => void;
  fixture.listRemote.mockImplementation(async (_sessionId, path) => {
    if (path === "/old") return new Promise((resolve) => { finishOld = resolve; });
    return { path: path === "/new/." ? "/new" : path, parentPath: "/", entries: [], warnings: [] };
  });
  await start();
  const password = await readyPassword();
  fireEvent.change(password, { target: { value: "test-password" } });
  fireEvent.submit(password.closest("form")!);
  await waitFor(() => expect(screen.getByLabelText("远程路径")).toBeEnabled());
  const input = screen.getByLabelText("远程路径");
  const go = (value: string) => {
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest("form")!);
  };
  go("/old"); go("/new");
  await waitFor(() => expect(input).toHaveValue("/new"));
  await act(async () => { finishOld({ path: "/old", parentPath: "/", entries: [], warnings: [] }); });
  go(".");
  await waitFor(() => expect(fixture.listRemote).toHaveBeenLastCalledWith("session-1", "/new/."));
  expect(input).toHaveValue("/new");
});
