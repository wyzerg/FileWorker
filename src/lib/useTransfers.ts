import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, isDesktop } from "./api";
import type { ConflictPolicy, TransferJob, TransferRequest, TransferSnapshot } from "./types";

const empty: TransferSnapshot = { revision: -1, concurrency: 3, jobs: [] };

export function useTransfers(onComplete: (job: TransferJob) => void, onNotice: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<TransferSnapshot>(empty);
  const [submitting, setSubmitting] = useState(false);
  const accepted = useRef(empty);
  const callbacks = useRef({ onComplete, onNotice });
  callbacks.current = { onComplete, onNotice };
  const generation = useRef(0);
  const enqueueBusy = useRef(false);
  const lastError = useRef("");

  const refresh = useCallback(async () => {
    if (!isDesktop) return;
    const current = generation.current;
    try {
      const next = await api.transferSnapshot();
      if (generation.current !== current || next.revision < accepted.current.revision) return;
      lastError.current = "";
      const previous = accepted.current;
      accepted.current = next;
      setSnapshot(next);
      for (const job of next.jobs) {
        if (job.state === "completed" && !previous.jobs.some((item) => item.id === job.id && item.attempt === job.attempt && item.state === "completed")) {
          callbacks.current.onComplete(job);
        }
      }
    } catch (cause) {
      if (generation.current !== current) return;
      const message = errorMessage(cause);
      if (lastError.current !== message) callbacks.current.onNotice(message);
      lastError.current = message;
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => { void poll(); }, accepted.current.jobs.some((job) => ["running", "queued", "canceling", "conflict"].includes(job.state)) ? 300 : 1500);
    };
    void poll();
    return () => { active = false; generation.current += 1; clearTimeout(timer); };
  }, [refresh]);

  const operate = async (action: () => Promise<unknown>) => {
    try { await action(); await refresh(); }
    catch (cause) { callbacks.current.onNotice(errorMessage(cause)); }
  };
  const submit = async (action: () => Promise<unknown>) => {
    if (enqueueBusy.current || !isDesktop) return;
    enqueueBusy.current = true; setSubmitting(true);
    try { await operate(action); }
    finally { enqueueBusy.current = false; setSubmitting(false); }
  };
  return {
    snapshot, submitting,
    enqueue: (requests: TransferRequest[]) => requests.length ? submit(() => api.enqueueTransfers(requests)) : Promise.resolve(),
    enqueueFinder: (paths: string[], sessionId: string, destinationDir: string) =>
      submit(() => api.enqueueFinderUpload(paths, sessionId, destinationDir)),
    cancel: (id: string) => operate(() => api.cancelTransfer(id)),
    retry: (id: string) => operate(() => api.retryTransfer(id)),
    resolve: async (id: string, policy: ConflictPolicy) => {
      await api.resolveTransferConflict(id, policy);
      await refresh();
    },
    concurrency: (value: number) => operate(() => api.setTransferConcurrency(value)),
    clear: () => operate(() => api.clearFinishedTransfers()),
  };
}
