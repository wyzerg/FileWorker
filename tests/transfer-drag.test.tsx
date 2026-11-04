import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { DirectoryListing } from "../src/lib/types";

const fixture = vi.hoisted(() => ({
  desktop: true,
  enqueue: vi.fn(),
  local: vi.fn(),
  remote: vi.fn(),
  session: 0,
}));

const profile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "拖放验收",
  host: "test.example.invalid", port: 22, username: "tester", authMethod: "password",
  privateKeyPath: null, remotePath: "/remote",
};

vi.mock("../src/lib/api", () => ({
  get isDesktop() { return fixture.desktop; },
  errorMessage: (error: Error) => error.message,
  errorCode: () => undefined,
  api: {
    getEnvironment: async () => ({ homePath: "/local", runtime: fixture.desktop ? "desktop" : "browser", shortcuts: [] }),
    listProfiles: async () => [profile],
    listDirectory: (path: string | null) => fixture.local(path),
    listRemoteDirectory: (_session: string, path: string) => fixture.remote(path),
    probeConnection: async (_profile: string, attemptId: string) => ({
      attemptId, host: profile.host, port: 22, trusted: true,
      identity: { algorithm: "ssh-ed25519", fingerprint: "SHA256:test" },
    }),
    authenticateConnection: async () => ({
      sessionId: `session-${++fixture.session}`, profileId: profile.id, initialPath: "/remote", warning: null,
    }),
    cancelConnection: async () => {},
    disconnectSession: async () => {},
    transferSnapshot: async () => ({ revision: 0, concurrency: 3, jobs: [] }),
    enqueueTransfers: (requests: unknown) => fixture.enqueue(requests),
  },
}));

const local: DirectoryListing = {
  path: "/local", parentPath: "/", warnings: [],
  entries: [
    { name: "folder", path: "/local/folder", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false },
    { name: "a.txt", path: "/local/a.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false },
    { name: "b.txt", path: "/local/b.txt", isDir: false, isSymlink: false, size: 8, modifiedMs: null, hidden: false },
    { name: "link", path: "/local/link", isDir: false, isSymlink: true, size: 4, modifiedMs: null, hidden: false },
  ],
};
const remote: DirectoryListing = {
  path: "/remote", parentPath: "/", warnings: [],
  entries: [{ name: "remote.txt", path: "/remote/remote.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false }],
};

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "uninitialized", dropEffect: "none", files: [],
    get types() { return [...data.keys()]; },
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? "",
    clearData: () => { data.clear(); },
  } as unknown as DataTransfer;
}

function pane(side: "local" | "remote") {
  return screen.getByRole("region", { name: side === "local" ? "本地文件" : "远程文件" });
}
function row(name: string) { return screen.getByText(name, { exact: true }).closest("tr")!; }
function dropZone(side: "local" | "remote") { return pane(side).querySelector(".file-list-container")!; }
async function connect() {
  fireEvent.click(screen.getByRole("button", { name: "连接服务器" }));
  const dialog = await screen.findByRole("dialog", { name: "服务器认证" });
  fireEvent.change(within(dialog).getByLabelText("密码"), { target: { value: "isolated-test" } });
  fireEvent.submit(within(dialog).getByLabelText("密码").closest("form")!);
  await screen.findByText("remote.txt");
}
async function workspace() {
  render(<App />);
  await screen.findByText("a.txt");
  await connect();
}
function start(name: string, data = dataTransfer()) {
  fireEvent.dragStart(row(name), { dataTransfer: data });
  return data;
}

beforeEach(() => {
  fixture.desktop = true;
  fixture.session = 0;
  fixture.enqueue.mockReset().mockResolvedValue(["job"]);
  fixture.local.mockReset().mockResolvedValue(local);
  fixture.remote.mockReset().mockResolvedValue(remote);
});

it("多选拖到远程只上传一次，使用已打开目录而非未提交的路径", async () => {
  await workspace();
  fireEvent.click(screen.getByLabelText("选择 a.txt"));
  fireEvent.click(screen.getByLabelText("选择 b.txt"));
  fireEvent.change(screen.getByLabelText("远程路径"), { target: { value: "/not-opened" } });
  const data = start("a.txt");
  expect(row("a.txt")).toHaveAttribute("draggable", "true");
  expect(pane("remote")).toHaveClass("file-pane--drop-target");
  expect(data.effectAllowed).toBe("copy");
  fireEvent.dragOver(dropZone("remote"), { dataTransfer: data });
  expect(data.dropEffect).toBe("copy");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
  expect(fixture.enqueue).toHaveBeenCalledWith([
    { sessionId: "session-1", direction: "upload", sourcePath: "/local/a.txt", destinationDir: "/remote" },
    { sessionId: "session-1", direction: "upload", sourcePath: "/local/b.txt", destinationDir: "/remote" },
  ]);
  expect(pane("remote")).not.toHaveClass("file-pane--drop-target");
});

it("远程拖到本地下载，拖动未选中的文件不会夹带原选择", async () => {
  await workspace();
  fireEvent.click(screen.getByLabelText("选择 a.txt"));
  const data = start("remote.txt");
  fireEvent.drop(dropZone("local"), { dataTransfer: data });
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledWith([
    { sessionId: "session-1", direction: "download", sourcePath: "/remote/remote.txt", destinationDir: "/local" },
  ]));
});

it("拖动未选中的本地行只上传该文件", async () => {
  await workspace();
  fireEvent.click(screen.getByLabelText("选择 a.txt"));
  const data = start("b.txt");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledWith([
    { sessionId: "session-1", direction: "upload", sourcePath: "/local/b.txt", destinationDir: "/remote" },
  ]));
});

it.each(["folder", "link"])("拒绝拖动 %s，不创建目录或符号链接任务", async (name) => {
  await workspace();
  expect(row(name)).toHaveAttribute("draggable", "false");
  const data = dataTransfer();
  expect(fireEvent.dragStart(row(name), { dataTransfer: data })).toBe(false);
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("混入目录的范围选择不能拖动，筛选后不夹带不可见选择", async () => {
  await workspace();
  fireEvent.click(screen.getByText("folder", { exact: true }));
  fireEvent.click(screen.getByText("b.txt", { exact: true }), { shiftKey: true });
  expect(row("a.txt")).toHaveAttribute("draggable", "false");
  expect(fireEvent.dragStart(row("a.txt"), { dataTransfer: dataTransfer() })).toBe(false);
  fireEvent.click(screen.getByLabelText("选择全部本地文件"));
  fireEvent.change(screen.getByLabelText("筛选本地文件"), { target: { value: "b.txt" } });
  const data = start("b.txt");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledWith([
    { sessionId: "session-1", direction: "upload", sourcePath: "/local/b.txt", destinationDir: "/remote" },
  ]));
});

it.each(["local", "outside"] as const)("放回 %s 不传输，也不能重放旧拖动", async (target) => {
  await workspace();
  const data = start("a.txt");
  fireEvent.drop(target === "local" ? dropZone("local") : screen.getByRole("heading", { name: "FileWorker" }), { dataTransfer: data });
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(pane("remote")).not.toHaveClass("file-pane--drop-target");
});

it.each(["text/plain", "text/uri-list", "Files", "application/x-fileworker-transfer"])("拒绝外部或伪造的 %s，阻止浏览器默认打开", async (type) => {
  await workspace();
  const data = dataTransfer();
  data.setData(type, "/arbitrary/source");
  expect(fireEvent.drop(dropZone("remote"), { dataTransfer: data })).toBe(false);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(fireEvent.drop(screen.getByLabelText("本地路径"), { dataTransfer: data })).toBe(false);
});

it.each(["local", "remote"] as const)("拖动期间 %s 目录变化后拒绝旧拖动", async (side) => {
  await workspace();
  const data = start("a.txt");
  const response = side === "local" ? fixture.local : fixture.remote;
  response.mockResolvedValue({ path: "/other", parentPath: "/", warnings: [], entries: [] });
  const input = screen.getByLabelText(side === "local" ? "本地路径" : "远程路径");
  fireEvent.change(input, { target: { value: "/other" } });
  fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(within(pane(side)).getByText("此目录为空")).toBeInTheDocument());
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(pane("remote")).not.toHaveClass("file-pane--drop-target");
});

it.each(["local", "remote"] as const)("拖动期间刷新同一个 %s 目录也会让旧拖动失效", async (side) => {
  await workspace();
  const data = start("a.txt");
  const response = side === "local" ? fixture.local : fixture.remote;
  response.mockResolvedValue({ ...(side === "local" ? local : remote) });
  fireEvent.click(screen.getByRole("button", { name: side === "local" ? "刷新本地目录" : "刷新远程目录" }));
  await waitFor(() => expect(response).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新远程目录" })).toBeEnabled());
  expect(pane("remote")).not.toHaveClass("file-pane--drop-target");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("拖动期间切换目录再返回原处不能恢复旧令牌", async () => {
  await workspace();
  const data = start("a.txt");
  fixture.remote.mockImplementation(async (path: string) => path === "/other"
    ? { path: "/other", parentPath: "/", warnings: [], entries: [] } : remote);
  const input = screen.getByLabelText("远程路径");
  fireEvent.change(input, { target: { value: "/other" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByText("此目录为空");
  fireEvent.change(input, { target: { value: "/remote" } });
  fireEvent.submit(input.closest("form")!);
  await screen.findByText("remote.txt");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("即使存在内部拖动，外部类型仍显示拒绝放下且不读取任意路径", async () => {
  await workspace();
  start("a.txt");
  const external = dataTransfer();
  external.setData("text/plain", "/arbitrary/source");
  fireEvent.dragOver(dropZone("remote"), { dataTransfer: external });
  expect(external.dropEffect).toBe("none");
  fireEvent.drop(dropZone("remote"), { dataTransfer: external });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("拖动期间断开重连后不能借用新会话", async () => {
  await workspace();
  const data = start("a.txt");
  fireEvent.click(screen.getByRole("button", { name: "断开服务器" }));
  await connect();
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it.each(["escape", "dragend"] as const)("%s 取消拖动并清除目标状态", async (action) => {
  await workspace();
  const data = start("a.txt");
  expect(pane("remote")).toHaveClass("file-pane--drop-target");
  if (action === "escape") fireEvent.keyDown(window, { key: "Escape" });
  else fireEvent.dragEnd(row("a.txt"), { dataTransfer: data });
  expect(pane("remote")).not.toHaveClass("file-pane--drop-target");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("提交未结束时不能重复拖放，也不保留可重放的旧令牌", async () => {
  let finish!: (value: string[]) => void;
  fixture.enqueue.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await workspace();
  const data = start("a.txt");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
  expect(row("b.txt")).toHaveAttribute("draggable", "false");
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  await act(async () => { finish(["job"]); });
  fireEvent.drop(dropZone("remote"), { dataTransfer: data });
  expect(fixture.enqueue).toHaveBeenCalledTimes(1);
});

it("浏览器预览不接收真实文件拖放", async () => {
  fixture.desktop = false;
  render(<App />);
  await screen.findByText("桌面文件系统未连接");
  const data = dataTransfer();
  data.setData("Files", "/local/a.txt");
  expect(fireEvent.drop(dropZone("remote"), { dataTransfer: data })).toBe(false);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "连接服务器" })).toBeDisabled();
});
