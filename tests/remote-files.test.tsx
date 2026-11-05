import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FilePane } from "../src/components/FilePane";
import { RemoteFileDialogs } from "../src/components/RemoteFileDialogs";
import { useRemoteFiles } from "../src/lib/useRemoteFiles";
import type { DirectoryListing, FileEntry } from "../src/lib/types";

const fixture = vi.hoisted(() => ({ preview: vi.fn(), properties: vi.fn(), mutate: vi.fn() }));
vi.mock("../src/lib/api", () => ({
  errorMessage: (error: { message: string }) => error.message,
  errorCode: (error: { code?: string }) => error.code,
  api: {
    previewRemoteFile: (...args: unknown[]) => fixture.preview(...args),
    remoteFileProperties: (...args: unknown[]) => fixture.properties(...args),
    mutateRemoteFile: (...args: unknown[]) => fixture.mutate(...args),
  },
}));
const entry = (name: string, fields: Partial<FileEntry> = {}): FileEntry => ({
  name, path: `/remote/${name}`, isDir: false, isSymlink: false, size: 5, modifiedMs: null, hidden: false, ...fields,
});
const listing: DirectoryListing = {
  path: "/remote", parentPath: "/", warnings: [],
  entries: [entry("alpha.log"), entry("beta.txt"), entry("folder", { isDir: true }), entry("link", { isSymlink: true })],
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.preview.mockResolvedValue({ kind: "text", path: "/remote/alpha.log", text: "<script>not executed</script>\n日志" });
  fixture.properties.mockResolvedValue({ path: "/remote/alpha.log", kind: "file", size: 5, modifiedMs: null, permissions: "0600", uid: 501, gid: 20 });
  fixture.mutate.mockResolvedValue(undefined);
});
function pane(extra = {}) {
  return <FilePane side="remote" listing={listing} path="/unsubmitted" connected
    transferEnabled onFileAction={() => {}} {...extra} />;
}
it("remote right-click is a file menu and refreshing lists the accepted directory without reconnecting", () => {
  const navigate = vi.fn(), connect = vi.fn();
  render(pane({ onNavigate: navigate, onConnect: connect }));
  expect(fireEvent.contextMenu(screen.getByText("alpha.log"), { clientX: 200, clientY: 100 })).toBe(false);
  fireEvent.click(screen.getByRole("menuitem", { name: "刷新目录" }));
  expect(navigate).toHaveBeenCalledWith("/remote");
  expect(connect).not.toHaveBeenCalled();
});
it("double-click and toolbar preview open an ordinary remote file, never a symlink", () => {
  const open = vi.fn();
  render(pane({ onFileAction: open }));
  expect(screen.getByRole("button", { name: "预览文件" })).toBeDisabled();
  fireEvent.doubleClick(screen.getByText("alpha.log"));
  expect(open).toHaveBeenCalledWith("preview", [listing.entries[0]]);
  fireEvent.click(screen.getByText("link"));
  expect(screen.getByRole("button", { name: "预览文件" })).toBeDisabled();
});
it("right-click preserves a selected batch but targets an unselected row exactly", () => {
  const open = vi.fn();
  render(pane({ onFileAction: open }));
  fireEvent.click(screen.getByText("alpha.log"));
  fireEvent.click(screen.getByText("beta.txt"), { ctrlKey: true });
  fireEvent.contextMenu(screen.getByText("alpha.log"));
  expect(screen.getByRole("menuitem", { name: "重命名" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "下载所选文件" }));
  expect(open).toHaveBeenLastCalledWith("download", listing.entries.slice(0, 2));
  fireEvent.contextMenu(screen.getByText("folder"));
  fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
  expect(open).toHaveBeenLastCalledWith("rename", [listing.entries[2]]);
});
it("unfinished transfers disable all remote mutation controls but keep previews available", () => {
  render(pane({ mutationsBlocked: true }));
  fireEvent.click(screen.getByText("alpha.log"));
  for (const name of ["新建文件夹", "重命名", "删除"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.getByRole("button", { name: "预览文件" })).toBeEnabled();
});
it("keyboard context menu targets the focused row", () => {
  const open = vi.fn();
  render(pane({ onFileAction: open }));
  const row = screen.getByText("beta.txt").closest("tr")!;
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "属性" }));
  expect(open).toHaveBeenCalledWith("properties", [listing.entries[1]]);
});
function Harness({ sessionId = "session-1", blocked = false, refresh = () => {} }: {
  sessionId?: string | null; blocked?: boolean; refresh?: () => void;
}) {
  const controller = useRemoteFiles({ sessionId, listing, mutationsBlocked: blocked, onRefresh: refresh, onNotice: () => {} });
  return <>
    {pane({ onFileAction: controller.open, mutationsBlocked: blocked })}
    <RemoteFileDialogs controller={controller} />
  </>;
}
it("text previews are read-only and do not execute HTML", async () => {
  render(<Harness />);
  fireEvent.doubleClick(screen.getByText("alpha.log"));
  const text = await screen.findByLabelText("远程文本预览");
  expect(text).toHaveValue("<script>not executed</script>\n日志");
  expect(text).toHaveAttribute("readonly");
  expect(screen.getByRole("dialog").querySelector("script")).toBeNull();
  expect(fixture.preview).toHaveBeenCalledWith("session-1", "/remote/alpha.log");
});
it("preview errors remain visible and can be retried", async () => {
  fixture.preview.mockRejectedValueOnce({ message: "临时读取失败" });
  render(<Harness />);
  fireEvent.doubleClick(screen.getByText("alpha.log"));
  expect(await screen.findByRole("alert")).toHaveTextContent("临时读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByLabelText("远程文本预览")).toBeInTheDocument();
});
it("deletion requires confirmation, stays open on failure and refreshes only after success", async () => {
  fixture.mutate.mockRejectedValueOnce({ message: "目录非空" });
  const refresh = vi.fn();
  render(<Harness refresh={refresh} />);
  fireEvent.contextMenu(screen.getByText("folder"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  const dialog = screen.getByRole("dialog", { name: "删除远程项目" });
  expect(dialog).toHaveTextContent("不会递归删除");
  expect(fixture.mutate).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("目录非空");
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(fixture.mutate).toHaveBeenLastCalledWith("session-1", "/remote/folder", { kind: "delete" });
  expect(refresh).toHaveBeenCalledOnce();
});
it("mkdir uses the accepted listing, not the unsubmitted path input", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "新建文件夹" }));
  fireEvent.change(screen.getByLabelText("文件夹名称"), { target: { value: "private" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "创建" }));
  await waitFor(() => expect(fixture.mutate).toHaveBeenCalledWith("session-1", "/remote", { kind: "createDirectory", name: "private" }));
});
it("late preview results never reopen a dialog after session replacement", async () => {
  let finish!: (value: unknown) => void;
  fixture.preview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<Harness />);
  fireEvent.doubleClick(screen.getByText("alpha.log"));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  view.rerender(<Harness sessionId="session-2" />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => { finish({ kind: "text", path: "/remote/alpha.log", text: "old session" }); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("duplicate mutation submission is blocked synchronously and late success cannot refresh a new session", async () => {
  let finish!: () => void;
  fixture.mutate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const refresh = vi.fn();
  const view = render(<Harness refresh={refresh} />);
  fireEvent.contextMenu(screen.getByText("alpha.log"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  const form = screen.getByRole("dialog").querySelector("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(fixture.mutate).toHaveBeenCalledTimes(1);
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭对话框" })).toBeDisabled();
  view.rerender(<Harness sessionId="session-2" refresh={refresh} />);
  await act(async () => { finish(); });
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("a transfer starting while a mutation dialog is open blocks submission", async () => {
  const view = render(<Harness />);
  fireEvent.contextMenu(screen.getByText("alpha.log"));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  view.rerender(<Harness blocked />);
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
  expect(fixture.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("请先完成或取消");
});
