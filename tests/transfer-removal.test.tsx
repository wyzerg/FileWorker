import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useTransfers } from "../src/lib/useTransfers";
import type { TransferJob, TransferSnapshot } from "../src/lib/types";

const fixture = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (...args: unknown[]) => fixture.invoke(...args),
}));

const job: TransferJob = {
  id: "failed-job", name: "failed.txt", attempt: 1, sessionId: "session", direction: "download",
  sourcePath: "/remote/failed.txt", destinationDir: "/local", destinationPath: "/local/failed.txt",
  state: "failed", totalBytes: 3, transferredBytes: 1, bytesPerSecond: 0, etaSeconds: null,
  error: "磁盘空间不足", warning: null,
};
const other: TransferJob = { ...job, id: "other-job", name: "other.txt", state: "canceled", error: null };

beforeEach(() => { fixture.invoke.mockReset(); });

it("通过精确的 IPC ID 移除单条记录，刷新后保留其余任务", async () => {
  let snapshot: TransferSnapshot = { revision: 1, concurrency: 3, jobs: [job, other] };
  fixture.invoke.mockImplementation(async (command: string, args: { id?: string }) => {
    if (command === "transfer_snapshot") return snapshot;
    if (command === "remove_finished_transfer" && args.id === "failed-job") {
      snapshot = { revision: 2, concurrency: 3, jobs: [other] };
      return;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const onComplete = vi.fn();
  const onNotice = vi.fn();
  const { result } = renderHook(() => useTransfers(onComplete, onNotice));
  await waitFor(() => expect(result.current.snapshot.jobs).toHaveLength(2));
  await act(async () => { await result.current.remove("failed-job"); });
  expect(result.current.snapshot.jobs).toEqual([other]);
  expect(fixture.invoke.mock.calls).toEqual([
    ["transfer_snapshot", {}],
    ["remove_finished_transfer", { id: "failed-job" }],
    ["transfer_snapshot", {}],
  ]);
  expect(onComplete).not.toHaveBeenCalled();
  expect(onNotice).not.toHaveBeenCalled();
});

it("移除失败显示后端错误并保留记录，不把失败误报为成功", async () => {
  fixture.invoke.mockImplementation(async (command: string) => {
    if (command === "transfer_snapshot") return { revision: 1, concurrency: 3, jobs: [job, other] };
    throw { code: "invalid_transfer_state", message: "此任务尚未结束，不能移除传输记录" };
  });
  const onNotice = vi.fn();
  const { result } = renderHook(() => useTransfers(vi.fn(), onNotice));
  await waitFor(() => expect(result.current.snapshot.jobs).toHaveLength(2));
  await act(async () => { await result.current.remove("failed-job"); });
  expect(onNotice).toHaveBeenCalledExactlyOnceWith("此任务尚未结束，不能移除传输记录");
  expect(result.current.snapshot.jobs).toEqual([job, other]);
  expect(fixture.invoke).toHaveBeenCalledTimes(2);
});

it("移除后的高 revision 快照不被迟到快照覆盖，不复活任务或触发完成回调", async () => {
  let finish!: (snapshot: TransferSnapshot) => void;
  fixture.invoke.mockImplementationOnce(() => new Promise<TransferSnapshot>((resolve) => { finish = resolve; }));
  fixture.invoke.mockImplementation(async (command: string, args: { id?: string }) => {
    if (command === "remove_finished_transfer" && args.id === "failed-job") return;
    if (command === "transfer_snapshot") return { revision: 2, concurrency: 3, jobs: [other] };
    throw new Error(`Unexpected command: ${command}`);
  });
  const onComplete = vi.fn();
  const onNotice = vi.fn();
  const { result } = renderHook(() => useTransfers(onComplete, onNotice));
  await act(async () => { await result.current.remove("failed-job"); });
  expect(result.current.snapshot.revision).toBe(2);
  await act(async () => {
    finish({ revision: 1, concurrency: 3, jobs: [{ ...job, state: "completed" }, other] });
  });
  expect(result.current.snapshot.jobs).toEqual([other]);
  expect(result.current.snapshot.revision).toBe(2);
  expect(onComplete).not.toHaveBeenCalled();
  expect(onNotice).not.toHaveBeenCalled();
});
