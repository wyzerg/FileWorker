import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FilePane } from "../src/components/FilePane";
import { TransferQueue } from "../src/components/TransferQueue";
import { Dialog } from "../src/components/Dialog";
import type { DirectoryListing, TransferJob } from "../src/lib/types";

const listing: DirectoryListing = {
  path: "/local", parentPath: "/", warnings: [],
  entries: [
    { name: "folder", path: "/local/folder", isDir: true, isSymlink: false, size: null, modifiedMs: null, hidden: false },
    { name: "a.txt", path: "/local/a.txt", isDir: false, isSymlink: false, size: 4, modifiedMs: null, hidden: false },
    { name: "b.txt", path: "/local/b.txt", isDir: false, isSymlink: false, size: 8, modifiedMs: null, hidden: false },
    { name: "link", path: "/local/link", isDir: false, isSymlink: true, size: 4, modifiedMs: null, hidden: false },
  ],
};

it("文件栏只提交选中的普通文件，支持多选、筛选清理及路径切换", () => {
  const onTransfer = vi.fn();
  const { rerender } = render(<FilePane side="local" listing={listing} path="/local" transferEnabled onTransfer={onTransfer} />);
  const upload = screen.getByRole("button", { name: "上传所选文件" });
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByText("folder"));
  expect(upload).toBeDisabled();
  fireEvent.click(screen.getByLabelText("选择 a.txt"));
  fireEvent.click(screen.getByLabelText("选择 b.txt"));
  expect(upload).toBeEnabled();
  fireEvent.click(upload);
  expect(onTransfer.mock.calls[0][0].map((entry: { name: string }) => entry.name)).toEqual(["a.txt", "b.txt"]);
  fireEvent.change(screen.getByLabelText("筛选本地文件"), { target: { value: "b.txt" } });
  fireEvent.click(upload);
  expect(onTransfer.mock.calls[1][0].map((entry: { name: string }) => entry.name)).toEqual(["b.txt"]);
  rerender(<FilePane side="local" listing={{ ...listing, path: "/other" }} path="/other" transferEnabled onTransfer={onTransfer} />);
  expect(upload).toBeDisabled();
});

it("未连接时选中文件也不能上传，符号链接不能勾选", () => {
  render(<FilePane side="local" listing={listing} path="/local" onTransfer={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("选择 a.txt"));
  expect(screen.getByRole("button", { name: "上传所选文件" })).toBeDisabled();
  expect(screen.getByLabelText("选择 link")).toBeDisabled();
});

const job: TransferJob = {
  id: "job-1", sessionId: "session", direction: "upload", name: "a.txt", attempt: 1,
  sourcePath: "/local/a.txt", destinationDir: "/remote", destinationPath: "/remote/a.txt",
  state: "running", transferredBytes: 4, totalBytes: 8, bytesPerSecond: 2, etaSeconds: 2,
  error: null, warning: null,
};
const actions = () => ({
  onCancel: vi.fn(), onRetry: vi.fn(), onResolve: vi.fn(), onConcurrency: vi.fn(), onClear: vi.fn(),
});

it("队列使用真实字节进度，显示错误、冲突和可用操作", async () => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: [job] }} sessionId="session" {...callbacks} />);
  expect(screen.getByRole("progressbar", { name: "a.txt 传输进度" })).toHaveAttribute("value", "4");
  fireEvent.click(screen.getByRole("button", { name: "取消 a.txt" }));
  expect(callbacks.onCancel).toHaveBeenCalledWith("job-1");
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: [{ ...job, state: "failed", error: "磁盘空间不足" }] }} sessionId="session" {...callbacks} />);
  expect(screen.getByText("磁盘空间不足")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试 a.txt" }));
  expect(callbacks.onRetry).toHaveBeenCalledWith("job-1");
  rerender(<TransferQueue snapshot={{ revision: 3, concurrency: 3, jobs: [{ ...job, state: "conflict" }] }} sessionId="session" {...callbacks} />);
  const dialog = within(screen.getByRole("dialog", { name: "同名文件" }));
  fireEvent.click(dialog.getByRole("button", { name: "保留两份" }));
  expect(callbacks.onResolve).toHaveBeenCalledWith("job-1", "keepBoth");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("断开后禁用旧任务重试，切换过滤和折叠不会改变任务", () => {
  const callbacks = actions();
  render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: [{ ...job, state: "canceled" }] }} sessionId={null} {...callbacks} />);
  expect(screen.getByRole("button", { name: "重试 a.txt" })).toBeDisabled();
  fireEvent.click(screen.getByRole("tab", { name: /已完成/ }));
  expect(screen.queryByRole("button", { name: "重试 a.txt" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起传输队列" }));
  expect(screen.getByRole("button", { name: "展开传输队列" })).toHaveAttribute("aria-expanded", "false");
  expect(callbacks.onClear).not.toHaveBeenCalled();
});

const conflicts: TransferJob[] = [
  { ...job, state: "conflict" },
  { ...job, id: "job-2", name: "b.txt", sourcePath: "/local/b.txt", destinationPath: "/remote/b.txt", state: "conflict" },
];

it("检测到同名后自动弹出文件名和目标路径，不默认提交任何选择", () => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: [job] }} sessionId="session" {...callbacks} />);
  fireEvent.click(screen.getByRole("tab", { name: /已完成/ }));
  fireEvent.click(screen.getByRole("button", { name: "收起传输队列" }));
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  const dialog = within(screen.getByRole("dialog", { name: "同名文件" }));
  expect(dialog.getByText(/目标已存在.*a\.txt/u)).toBeInTheDocument();
  expect(dialog.getByText("/remote/a.txt")).toBeInTheDocument();
  for (const name of ["跳过", "覆盖", "保留两份"]) expect(dialog.getByRole("button", { name })).toBeEnabled();
  expect(callbacks.onResolve).not.toHaveBeenCalled();
});

it("多个同名逐个提示，等待提交结果且旧快照不会重复弹出已处理任务", async () => {
  let finish!: () => void;
  const callbacks = { ...actions(), onResolve: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  const dialog = screen.getByRole("dialog", { name: "同名文件" });
  fireEvent.click(within(dialog).getByRole("button", { name: "保留两份" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "保留两份" }));
  expect(callbacks.onResolve).toHaveBeenCalledTimes(1);
  expect(callbacks.onResolve).toHaveBeenCalledWith("job-1", "keepBoth");
  for (const button of within(dialog).getAllByRole("button")) expect(button).toBeDisabled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(dialog).getByText("/remote/a.txt")).toBeInTheDocument();
  await act(async () => { finish(); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(screen.getByRole("dialog")).getByText("/remote/b.txt")).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "跳过" }));
  expect(callbacks.onResolve).toHaveBeenLastCalledWith("job-2", "skip");
  await act(async () => { finish(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: conflicts.map((item) => ({ ...item })) }} sessionId="session" {...callbacks} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each(["关闭按钮", "Escape", "遮罩"])("%s 关闭表示稍后处理，本批不连续弹出且仍可手动打开", async (method) => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  const dialog = screen.getByRole("dialog");
  if (method === "关闭按钮") fireEvent.click(within(dialog).getByRole("button", { name: "关闭对话框" }));
  else if (method === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
  else fireEvent.click(dialog.parentElement!);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: conflicts.map((item) => ({ ...item })) }} sessionId="session" {...callbacks} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(callbacks.onResolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "处理 b.txt 的同名文件" }));
  expect(within(screen.getByRole("dialog")).getByText("/remote/b.txt")).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "覆盖" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(callbacks.onResolve).toHaveBeenCalledWith("job-2", "overwrite");
});

it("稍后处理不屏蔽后续新增冲突", () => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: [conflicts[0]] }} sessionId="session" {...callbacks} />);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭对话框" }));
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  expect(within(screen.getByRole("dialog")).getByText("/remote/b.txt")).toBeInTheDocument();
});

it("其他弹窗打开时推迟提示，关闭后再弹出且不叠窗", () => {
  const callbacks = actions();
  const { rerender } = render(<>
    <TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" dialogBlocked {...callbacks} />
    <Dialog title="编辑连接" onClose={vi.fn()}>连接设置</Dialog>
  </>);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "编辑连接" })).toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" dialogBlocked={false} {...callbacks} />);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(screen.getByRole("dialog", { name: "同名文件" })).getByText("/remote/a.txt")).toBeInTheDocument();
});

it("只提示当前会话，断开后关闭提示，重试的新尝试可以再次提示", () => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="other-session" {...callbacks} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId={null} {...callbacks} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: [{ ...conflicts[0], attempt: 2 }] }} sessionId="session" {...callbacks} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("同一次尝试离开冲突后又出现新的目标竞争时重新提示", () => {
  const callbacks = actions();
  const { rerender } = render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: [conflicts[0]] }} sessionId="session" {...callbacks} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  rerender(<TransferQueue snapshot={{ revision: 2, concurrency: 3, jobs: [{ ...job, state: "queued" }] }} sessionId="session" {...callbacks} />);
  rerender(<TransferQueue snapshot={{ revision: 3, concurrency: 3, jobs: [conflicts[0]] }} sessionId="session" {...callbacks} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("冲突处理失败时保留当前弹框和错误，可以重新提交后再处理下一个", async () => {
  const callbacks = {
    ...actions(),
    onResolve: vi.fn().mockRejectedValueOnce(new Error("连接已断开，请重连后重试")).mockResolvedValue(undefined),
  };
  render(<TransferQueue snapshot={{ revision: 1, concurrency: 3, jobs: conflicts }} sessionId="session" {...callbacks} />);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保留两份" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("连接已断开"));
  expect(within(screen.getByRole("dialog")).getByText("/remote/a.txt")).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保留两份" }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("/remote/b.txt")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
