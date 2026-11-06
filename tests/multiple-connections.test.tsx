import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { ConnectionProfile, TransferJob, TransferSnapshot } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  profiles: [] as ConnectionProfile[], attempts: new Map<string, string>(),
  active: new Map<string, string>(), snapshot: { revision: 0, concurrency: 3, jobs: [] } as TransferSnapshot,
  disconnect: vi.fn(), list: vi.fn(), auth: vi.fn(), enqueue: vi.fn(), save: vi.fn(), remove: vi.fn(),
}));
const profiles: ConnectionProfile[] = [
  { id: "0a4a976f-ddc8-4e60-8b8f-de2532f0212d", name: "生产服务器", host: "production.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
  { id: "a761b759-3b79-4f00-ae1f-f4cdc1e3d947", name: "测试服务器", host: "staging.invalid", port: 22, username: "tester", authMethod: "password", privateKeyPath: null, remotePath: "." },
];
const sessionA = `session-${profiles[0].id}`;
const sessionB = `session-${profiles[1].id}`;
const job: TransferJob = {
  id: "upload-job", sessionId: sessionA, name: "upload.txt", attempt: 1, direction: "upload",
  sourcePath: "/local/upload.txt", destinationDir: "/", destinationPath: "/upload.txt", state: "running",
  transferredBytes: 1, totalBytes: 10, bytesPerSecond: 1, etaSeconds: 9, error: null, warning: null,
};
const entry = (path: string, isDir = false) => ({
  path, name: path.slice(path.lastIndexOf("/") + 1), isDir, isSymlink: false,
  size: isDir ? null : 10, modifiedMs: null, hidden: false,
});

vi.mock("../src/lib/api", () => ({
  isDesktop: true,
  errorCode: (cause: { code?: string }) => cause.code,
  errorMessage: (cause: { message: string }) => cause.message,
  api: {
    getEnvironment: async () => ({ homePath: "/local", runtime: "desktop", shortcuts: [], credentialStorage: true }),
    listProfiles: async () => fixture.profiles,
    listGroups: async () => [],
    listDirectory: async () => ({ path: "/local", parentPath: "/", warnings: [], entries: [entry("/local/upload.txt")] }),
    credentialStatus: async () => ({ available: true, supported: true }),
    probeConnection: async (id: string, attemptId: string) => {
      fixture.attempts.set(attemptId, id);
      return { attemptId, host: "fixture.invalid", port: 22, trusted: true, identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture" } };
    },
    authenticateConnection: (...args: unknown[]) => fixture.auth(...args),
    listRemoteDirectory: (...args: unknown[]) => fixture.list(...args),
    cancelConnection: async () => {},
    disconnectSession: (...args: unknown[]) => fixture.disconnect(...args),
    transferSnapshot: async () => fixture.snapshot,
    enqueueTransfers: (...args: unknown[]) => fixture.enqueue(...args),
    saveProfile: (...args: unknown[]) => fixture.save(...args),
    deleteProfile: (...args: unknown[]) => fixture.remove(...args),
  },
}));

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  fixture.profiles = profiles.map((profile) => ({ ...profile }));
  fixture.attempts.clear(); fixture.active.clear();
  fixture.snapshot = { revision: 0, concurrency: 3, jobs: [] };
  fixture.auth.mockImplementation(async (attemptId) => {
    const id = fixture.attempts.get(attemptId)!;
    fixture.active.set(`session-${id}`, id);
    return { sessionId: `session-${id}`, profileId: id, initialPath: "/", warning: null };
  });
  fixture.disconnect.mockImplementation(async (id) => { fixture.active.delete(id); });
  fixture.list.mockImplementation(async (id, path) => {
    if (!fixture.active.has(id)) throw { code: "session_closed", message: "原连接已关闭" };
    return { path, parentPath: path === "/" ? null : "/", warnings: [], entries: [entry(`${path === "/" ? "" : path}/folder`, true)] };
  });
  fixture.enqueue.mockResolvedValue(["upload-job"]);
  fixture.save.mockImplementation(async (profile) => profile);
  fixture.remove.mockResolvedValue(undefined);
});

function profileButton(name: string) {
  return within(screen.getByRole("navigation", { name: "已保存连接" })).getByRole("button", { name: new RegExp(name) });
}
async function connect(name: string) {
  fireEvent.doubleClick(profileButton(name));
  await waitFor(() => expect(profileButton(name)).toHaveAttribute("aria-pressed", "true"));
  const target = profiles.find((profile) => profile.name === name)!;
  await waitFor(() => expect(fixture.active.has(`session-${target.id}`)).toBe(true));
  await waitFor(() => expect(screen.getByRole("button", { name: "断开服务器" })).toBeEnabled());
  await waitFor(() => expect(screen.getByLabelText("远程路径")).toHaveValue("/"));
}
async function startTransfer() {
  fireEvent.click(screen.getByLabelText("选择 upload.txt"));
  fixture.snapshot = { revision: 1, concurrency: 3, jobs: [job] };
  fireEvent.click(screen.getByRole("button", { name: "上传所选文件" }));
  await screen.findByRole("button", { name: "取消 upload.txt" });
}

it("selecting another connection during a transfer keeps the original server and queue alive", async () => {
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  await startTransfer();
  fireEvent.click(profileButton("测试服务器"));
  expect(profileButton("测试服务器")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "连接服务器" })).toBeVisible();
  await connect("测试服务器");
  expect(fixture.active.has(sessionA)).toBe(true);
  expect(fixture.active.has(sessionB)).toBe(true);
  expect(screen.getByRole("button", { name: "取消 upload.txt" })).toBeEnabled();
  expect(fixture.disconnect).not.toHaveBeenCalled();
  expect(within(screen.getByRole("navigation", { name: "已保存连接" })).getAllByText("已连接")).toHaveLength(2);
  fireEvent.click(profileButton("生产服务器"));
  await waitFor(() => expect(screen.getByLabelText("远程路径")).toHaveValue("/"));
  expect(fixture.auth).toHaveBeenCalledTimes(2);
});

it("a background upload completion refreshes its directory when selected again", async () => {
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  await startTransfer();
  await connect("测试服务器");
  fixture.list.mockImplementation(async (id, path) => ({
    path, parentPath: null, warnings: [],
    entries: id === sessionA ? [entry("/uploaded-new.txt")] : [],
  }));
  fixture.snapshot = { revision: 2, concurrency: 3, jobs: [{ ...job, state: "completed", transferredBytes: 10, bytesPerSecond: 0, etaSeconds: null }] };
  await screen.findByRole("button", { name: "清理已结束任务" });
  await waitFor(() => expect(screen.getByRole("button", { name: "清理已结束任务" })).toBeEnabled(), { timeout: 3000 });
  fireEvent.click(profileButton("生产服务器"));
  expect(await within(screen.getByRole("region", { name: "远程文件" })).findByText("uploaded-new.txt")).toBeVisible();
  expect(fixture.auth).toHaveBeenCalledTimes(2);
});

it("a background connection with unfinished transfers cannot be deleted", async () => {
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  await startTransfer();
  await connect("测试服务器");
  fireEvent.contextMenu(profileButton("生产服务器"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除连接" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "删除连接" })).getByRole("button", { name: "删除连接" }));
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(/传输/);
  expect(fixture.remove).not.toHaveBeenCalled();
  expect(fixture.active.has(sessionA)).toBe(true);
});

it("deleting a background profile disconnects it without closing the selected session", async () => {
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  await connect("测试服务器");
  fireEvent.contextMenu(profileButton("生产服务器"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除连接" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "删除连接" })).getByRole("button", { name: "删除连接" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fixture.active.has(sessionA)).toBe(false);
  expect(fixture.active.has(sessionB)).toBe(true);
  expect(screen.getByRole("button", { name: "断开服务器" })).toBeEnabled();
});

it.each([false, true])("editing a background identity respects its own transfers (busy=%s)", async (busy) => {
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  if (busy) await startTransfer();
  await connect("测试服务器");
  fireEvent.contextMenu(profileButton("生产服务器"));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑连接" }));
  const host = await screen.findByLabelText("主机地址");
  fireEvent.change(host, { target: { value: "replacement.invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "仅保存配置" }));
  if (busy) {
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/传输/);
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.active.has(sessionA)).toBe(true);
  } else {
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fixture.active.has(sessionA)).toBe(false);
    expect(profileButton("测试服务器")).toHaveAttribute("aria-pressed", "true");
  }
  expect(fixture.active.has(sessionB)).toBe(true);
});

it("same-path remote files never inherit another connected server's selection", async () => {
  fixture.list.mockImplementation(async (_id, path) => ({
    path, parentPath: null, warnings: [], entries: [entry("/shared.txt")],
  }));
  render(<App />);
  await screen.findByText("upload.txt");
  await connect("生产服务器");
  await connect("测试服务器");
  fireEvent.click(profileButton("生产服务器"));
  const remote = () => within(screen.getByRole("region", { name: "远程文件" }));
  fireEvent.click(remote().getByLabelText("选择 shared.txt"));
  expect(remote().getByRole("button", { name: "下载所选文件" })).toBeEnabled();
  fireEvent.click(profileButton("测试服务器"));
  expect(remote().getByLabelText("选择 shared.txt")).not.toBeChecked();
  expect(remote().getByRole("button", { name: "下载所选文件" })).toBeDisabled();
  expect(remote().getByRole("button", { name: "删除" })).toBeDisabled();
  fireEvent.click(profileButton("生产服务器"));
  expect(remote().getByLabelText("选择 shared.txt")).not.toBeChecked();
});
