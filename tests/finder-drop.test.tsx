import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import type { DirectoryListing } from "../src/lib/types";

interface NativeEvent {
  phase: "enter" | "over" | "drop" | "leave";
  paths?: string[];
  position: { x: number; y: number };
}
const fixture = vi.hoisted(() => ({
  desktop: true, supported: true, occluded: false, session: 0,
  listener: null as ((event: NativeEvent) => void) | null,
  subscribe: vi.fn(), unlisten: vi.fn(), upload: vi.fn(), enqueue: vi.fn(),
  local: vi.fn(), remote: vi.fn(),
}));
const profile = {
  id: "e6814610-8703-4c50-ab27-e823c8577fc3", name: "Finder 验收",
  host: "test.example.invalid", port: 22, username: "tester", authMethod: "password",
  privateKeyPath: null, remotePath: "/remote",
};
const local: DirectoryListing = {
  path: "/local", parentPath: "/", warnings: [],
  entries: [{ name: "local.txt", path: "/local/local.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false }],
};
const remote: DirectoryListing = {
  path: "/remote", parentPath: "/", warnings: [],
  entries: [{ name: "remote.txt", path: "/remote/remote.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false }],
};
const paths = ["/finder/a.txt", "/finder/b.txt"];

vi.mock("../src/lib/api", () => ({
  get isDesktop() { return fixture.desktop; },
  errorMessage: (error: Error) => error.message, errorCode: () => undefined,
  api: {
    getEnvironment: async () => ({
      homePath: "/local", runtime: fixture.desktop ? "desktop" : "browser",
      shortcuts: [], finderDrop: fixture.supported,
    }),
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
    cancelConnection: async () => {}, disconnectSession: async () => {},
    transferSnapshot: async () => ({ revision: 0, concurrency: 3, jobs: [] }),
    enqueueTransfers: (requests: unknown) => fixture.enqueue(requests),
    enqueueFinderUpload: (...args: unknown[]) => fixture.upload(...args),
    listenFinderDrop: (listener: (event: NativeEvent) => void) => fixture.subscribe(listener),
  },
}));

const position = { x: 0.75, y: 0.4 };
function emit(phase: NativeEvent["phase"], point = position, eventPaths = paths) {
  act(() => { fixture.listener?.({ phase, paths: phase === "enter" || phase === "drop" ? eventPaths : undefined, position: point }); });
}
function remotePane() { return screen.getByRole("region", { name: "远程文件" }); }
async function connect() {
  fireEvent.click(screen.getByRole("button", { name: "连接服务器" }));
  const dialog = await screen.findByRole("dialog", { name: "服务器认证" });
  fireEvent.change(within(dialog).getByLabelText("密码"), { target: { value: "isolated" } });
  fireEvent.submit(within(dialog).getByLabelText("密码").closest("form")!);
  await screen.findByText("remote.txt");
}
async function workspace() {
  const view = render(<App />);
  await screen.findByText("local.txt");
  await connect();
  return view;
}

beforeEach(() => {
  vi.restoreAllMocks();
  fixture.desktop = true; fixture.supported = true; fixture.occluded = false;
  fixture.session = 0; fixture.listener = null;
  fixture.unlisten.mockReset();
  fixture.subscribe.mockReset().mockImplementation(async (listener) => {
    fixture.listener = listener;
    return fixture.unlisten;
  });
  fixture.upload.mockReset().mockResolvedValue(["job"]);
  fixture.enqueue.mockReset().mockResolvedValue(["job"]);
  fixture.local.mockReset().mockResolvedValue(local);
  fixture.remote.mockReset().mockResolvedValue(remote);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 820 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches(".file-pane--remote .file-list-container")
      ? new DOMRect(700, 200, 500, 400) : new DOMRect(0, 0, 600, 600);
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: (x: number, y: number) => !fixture.occluded && x >= 700 && x < 1200 && y >= 200 && y < 600
      ? remotePane().querySelector(".file-list-container") : document.body,
  });
});

it("Finder 进入和移动只高亮实际命中的远程文件列表", async () => {
  await workspace();
  emit("enter");
  expect(remotePane()).toHaveClass("file-pane--drop-target");
  emit("over", { x: 0.2, y: 0.4 });
  expect(remotePane()).not.toHaveClass("file-pane--drop-target");
  emit("over");
  expect(remotePane()).toHaveClass("file-pane--drop-target");
  emit("leave");
  expect(remotePane()).not.toHaveClass("file-pane--drop-target");
  expect(fixture.upload).not.toHaveBeenCalled();
});

it("原生拖动只提交一次，绑定已打开目录而非路径输入", async () => {
  await workspace();
  fireEvent.change(screen.getByLabelText("远程路径"), { target: { value: "/not-opened" } });
  emit("enter"); emit("drop"); emit("drop");
  await waitFor(() => expect(fixture.upload).toHaveBeenCalledExactlyOnceWith(paths, "session-1", "/remote"));
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(remotePane()).not.toHaveClass("file-pane--drop-target");
});

it.each(["missing-enter", "mismatched-paths", "leave", "escape", "internal-start"] as const)(
  "%s 不能使用原生事件提交上传", async (action) => {
    await workspace();
    if (action !== "missing-enter") emit("enter");
    if (action === "leave") emit("leave");
    if (action === "escape") fireEvent.keyDown(window, { key: "Escape" });
    if (action === "internal-start") fireEvent.dragStart(window);
    emit("drop", position, action === "mismatched-paths" ? ["/other/file.txt"] : paths);
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(remotePane()).not.toHaveClass("file-pane--drop-target");
  },
);

it.each([
  { x: 0.2, y: 0.4 }, { x: 0.75, y: 0.1 }, { x: 2, y: 0.4 }, { x: NaN, y: 0.4 },
])("拒绝非目标位置 $x,$y 并使旧票据失效", async (point) => {
  await workspace();
  emit("enter"); emit("drop", point); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
});

it("远程列表被弹窗遮挡时不能上传", async () => {
  await workspace();
  fixture.occluded = true;
  emit("enter"); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
});

it.each(["local", "remote"] as const)("%s 刷新后不能重放原生手势", async (side) => {
  await workspace();
  emit("enter");
  const response = side === "local" ? fixture.local : fixture.remote;
  response.mockResolvedValue({ ...(side === "local" ? local : remote) });
  fireEvent.click(screen.getByRole("button", { name: side === "local" ? "刷新本地目录" : "刷新远程目录" }));
  await waitFor(() => expect(response).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新远程目录" })).toBeEnabled());
  emit("over"); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
});

it("断开重连不能将旧原生票据用于新会话", async () => {
  await workspace();
  emit("enter");
  fireEvent.click(screen.getByRole("button", { name: "断开服务器" }));
  await connect();
  emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
  emit("enter"); emit("drop");
  await waitFor(() => expect(fixture.upload).toHaveBeenCalledExactlyOnceWith(paths, "session-2", "/remote"));
});

it("原生批次校验失败会提示错误，不改用其他上传入口", async () => {
  fixture.upload.mockRejectedValue(new Error("只能拖入普通文件，目录和符号链接不受支持"));
  await workspace();
  emit("enter"); emit("drop");
  await screen.findByText("只能拖入普通文件，目录和符号链接不受支持");
  expect(fixture.upload).toHaveBeenCalledTimes(1);
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("Finder 提交期间禁用其他提交，完成后旧票据不能重放", async () => {
  let finish!: (ids: string[]) => void;
  fixture.upload.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await workspace();
  emit("enter"); emit("drop");
  await waitFor(() => expect(fixture.upload).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText("选择 local.txt"));
  expect(screen.getByRole("button", { name: "上传所选文件" })).toBeDisabled();
  emit("enter"); emit("drop");
  await act(async () => { finish(["job"]); });
  emit("drop");
  expect(fixture.upload).toHaveBeenCalledTimes(1);
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("按钮提交与 Finder 提交共用互斥", async () => {
  let finish!: (ids: string[]) => void;
  fixture.enqueue.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await workspace();
  fireEvent.click(screen.getByLabelText("选择 local.txt"));
  fireEvent.click(screen.getByRole("button", { name: "上传所选文件" }));
  emit("enter"); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
  await act(async () => { finish(["job"]); });
});

it("卸载早于监听注册完成时仍会取消监听并忽略迟到事件", async () => {
  let subscribed!: (unlisten: () => void) => void;
  fixture.subscribe.mockImplementation((listener) => {
    fixture.listener = listener;
    return new Promise((resolve) => { subscribed = resolve; });
  });
  const view = await workspace();
  expect(fixture.subscribe).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { subscribed(fixture.unlisten); });
  expect(fixture.unlisten).toHaveBeenCalledTimes(1);
  emit("enter"); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
});

it.each(["preview", "unsupported"] as const)("%s 不注册 Finder 入口", async (mode) => {
  fixture.desktop = mode !== "preview";
  fixture.supported = mode !== "unsupported";
  render(<App />);
  await screen.findByRole("heading", { name: "FileWorker" });
  await waitFor(() => expect(screen.getByRole("button", { name: "添加 SFTP 连接" })).toBeEnabled());
  expect(fixture.subscribe).not.toHaveBeenCalled();
  emit("enter"); emit("drop");
  expect(fixture.upload).not.toHaveBeenCalled();
});
