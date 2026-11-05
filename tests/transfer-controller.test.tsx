import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useTransfers } from "../src/lib/useTransfers";
import type { TransferJob, TransferSnapshot } from "../src/lib/types";

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), retry: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/lib/api", () => ({
  isDesktop: true, errorMessage: (error: Error) => error.message,
  api: {
    transferSnapshot: () => fixture.snapshot(),
    retryTransfer: (id: string) => fixture.retry(id),
    resolveTransferConflict: (id: string, policy: string) => fixture.resolve(id, policy),
  },
}));
const job: TransferJob = {
  id: "job", name: "a.txt", attempt: 1, sessionId: "session", direction: "download",
  sourcePath: "/a.txt", destinationDir: "/local", destinationPath: "/local/a.txt",
  state: "completed", totalBytes: 3, transferredBytes: 3, bytesPerSecond: 0, etaSeconds: null,
  error: null, warning: null,
};
beforeEach(() => {
  fixture.snapshot.mockReset();
  fixture.retry.mockReset().mockResolvedValue(undefined);
  fixture.resolve.mockReset().mockResolvedValue(undefined);
});

it("同一任务重试完成后再次刷新目标，但重复快照不重复触发", async () => {
  const onComplete = vi.fn();
  fixture.snapshot.mockResolvedValue({ revision: 1, concurrency: 3, jobs: [job] });
  const { result } = renderHook(() => useTransfers(onComplete, vi.fn()));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  await act(async () => { await result.current.retry("job"); });
  expect(onComplete).toHaveBeenCalledTimes(1);
  fixture.snapshot.mockResolvedValue({ revision: 3, concurrency: 3, jobs: [{ ...job, attempt: 2 }] });
  await act(async () => { await result.current.retry("job"); });
  expect(onComplete).toHaveBeenCalledTimes(2);
});

it("旧的初始化快照不能覆盖操作后的新状态，卸载后不触发刷新", async () => {
  let finish!: (value: TransferSnapshot) => void;
  fixture.snapshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  fixture.snapshot.mockResolvedValue({ revision: 2, concurrency: 1, jobs: [job] });
  const onComplete = vi.fn();
  const { result, unmount } = renderHook(() => useTransfers(onComplete, vi.fn()));
  await act(async () => { await result.current.retry("job"); });
  expect(result.current.snapshot.revision).toBe(2);
  await act(async () => { finish({ revision: 1, concurrency: 3, jobs: [] }); });
  expect(result.current.snapshot.jobs).toHaveLength(1);
  unmount();
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it("冲突处理失败向弹框返回错误，不吞掉错误导致误以为已处理", async () => {
  fixture.snapshot.mockResolvedValue({ revision: 1, concurrency: 3, jobs: [{ ...job, state: "conflict" }] });
  fixture.resolve.mockRejectedValueOnce(new Error("同名处理失败"));
  const onNotice = vi.fn();
  const { result } = renderHook(() => useTransfers(vi.fn(), onNotice));
  await waitFor(() => expect(result.current.snapshot.revision).toBe(1));
  await act(async () => {
    await expect(result.current.resolve("job", "keepBoth")).rejects.toThrow("同名处理失败");
  });
  expect(result.current.snapshot.jobs[0].state).toBe("conflict");
  expect(onNotice).not.toHaveBeenCalled();
  fixture.snapshot.mockResolvedValue({ revision: 2, concurrency: 3, jobs: [job] });
  await act(async () => { await result.current.resolve("job", "skip"); });
  expect(result.current.snapshot.jobs[0].state).toBe("completed");
  expect(fixture.resolve).toHaveBeenLastCalledWith("job", "skip");
});
