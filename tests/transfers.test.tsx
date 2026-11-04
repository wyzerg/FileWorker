import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FilePane } from "../src/components/FilePane";
import { TransferQueue } from "../src/components/TransferQueue";
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

it("队列使用真实字节进度，显示错误、冲突和可用操作", () => {
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
  fireEvent.click(screen.getByRole("button", { name: "处理 a.txt 的同名文件" }));
  const dialog = within(screen.getByRole("dialog", { name: "同名文件" }));
  fireEvent.click(dialog.getByRole("button", { name: "保留两份" }));
  expect(callbacks.onResolve).toHaveBeenCalledWith("job-1", "keepBoth");
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
