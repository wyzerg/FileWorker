import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useTransfers } from "../src/lib/useTransfers";
import type { TransferJob, TransferSnapshot } from "../src/lib/types";

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), retry: vi.fn() }));
vi.mock("../src/lib/api", () => ({
  isDesktop: true, errorMessage: (error: Error) => error.message,
  api: {
    transferSnapshot: () => fixture.snapshot(),
    retryTransfer: (id: string) => fixture.retry(id),
  },
}));
const job: TransferJob = {
  id: "job", name: "a.txt", attempt: 1, sessionId: "session", direction: "download",
  sourcePath: "/a.txt", destinationDir: "/local", destinationPath: "/local/a.txt",
  state: "completed", totalBytes: 3, transferredBytes: 3, bytesPerSecond: 0, etaSeconds: null,
  error: null, warning: null,
};
beforeEach(() => { fixture.snapshot.mockReset(); fixture.retry.mockReset().mockResolvedValue(undefined); });

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
