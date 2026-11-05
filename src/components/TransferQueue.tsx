import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, Copy, Inbox, LoaderCircle, RefreshCw, Settings2, SkipForward, Trash2, X } from "lucide-react";
import type { ConflictPolicy, TransferJob, TransferSnapshot, TransferState } from "../lib/types";
import { formatBytes } from "../lib/files";
import { errorMessage } from "../lib/api";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";

const labels: Record<TransferState, string> = {
  queued: "等待中", running: "传输中", canceling: "正在取消", conflict: "同名待处理",
  completed: "已完成", failed: "失败", canceled: "已取消", skipped: "已跳过",
};
export const unfinished = (job: TransferJob) => ["queued", "running", "canceling", "conflict"].includes(job.state);
const remaining = (seconds: number | null) => seconds === null ? "" : seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`;
const conflictKey = (job: TransferJob) => JSON.stringify([job.sessionId, job.id, job.attempt]);
type ResolveConflict = (id: string, policy: ConflictPolicy) => void | Promise<void>;

function TransferConflictDialog({ job, onResolve, onResolved, onClose }: {
  job: TransferJob; onResolve: ResolveConflict; onResolved: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  async function resolve(policy: ConflictPolicy) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError("");
    try {
      await onResolve(job.id, policy);
      onResolved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return <Dialog title="同名文件" onClose={onClose} busy={busy}>
    <div className="dialog-body"><p className="confirm-message">目标已存在「{job.name}」</p>
      <p className="conflict-path">{job.destinationPath ?? `${job.destinationDir.replace(/\/$/u, "")}/${job.name}`}</p>
      {error && <p className="form-error" role="alert">{error}</p>}</div>
    <footer className="dialog-footer conflict-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={() => { void resolve("skip"); }}><SkipForward size={14} />跳过</button>
      <button type="button" className="button danger" disabled={busy} onClick={() => { void resolve("overwrite"); }}><ArrowDownToLine size={14} />覆盖</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => { void resolve("keepBoth"); }}><Copy size={14} />保留两份</button>
    </footer>
  </Dialog>;
}

export function TransferQueue({ snapshot, sessionId, dialogBlocked = false, onCancel, onRetry, onResolve, onConcurrency, onClear }: {
  snapshot: TransferSnapshot;
  sessionId: string | null;
  dialogBlocked?: boolean;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onResolve: ResolveConflict;
  onConcurrency: (value: number) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState("全部");
  const [conflictId, setConflictId] = useState<string | null>(null);
  const prompted = useRef(new Set<string>());
  const conflicts = snapshot.jobs.filter((job) => job.state === "conflict" && job.sessionId === sessionId);
  const conflict = conflicts.find((job) => conflictKey(job) === conflictId);
  useEffect(() => {
    const pending = snapshot.jobs.filter((job) => job.state === "conflict" && job.sessionId === sessionId);
    const keys = new Set(pending.map(conflictKey));
    for (const key of prompted.current) if (!keys.has(key)) prompted.current.delete(key);
    if (dialogBlocked || pending.some((job) => conflictKey(job) === conflictId)) return;
    const next = pending.find((job) => !prompted.current.has(conflictKey(job)));
    if (next) {
      const key = conflictKey(next);
      prompted.current.add(key);
      setConflictId(key);
    } else if (conflictId !== null) setConflictId(null);
  }, [snapshot.jobs, sessionId, dialogBlocked, conflictId]);
  const deferConflicts = () => {
    // Closing defers all currently pending prompts, not one popup at a time.
    for (const job of conflicts) prompted.current.add(conflictKey(job));
    setConflictId(null);
  };
  const filters = {
    全部: snapshot.jobs,
    传输中: snapshot.jobs.filter(unfinished),
    已完成: snapshot.jobs.filter((job) => job.state === "completed"),
  };
  const jobs = filters[tab as keyof typeof filters];
  return <section className={`transfer-queue ${expanded ? "" : "collapsed"}`} aria-label="传输队列">
    <header className="queue-heading">
      <span className="queue-title"><ArrowDownToLine size={16} /><h2>传输队列</h2></span>
      <div className="queue-tabs" role="tablist" aria-label="传输状态">
        {Object.entries(filters).map(([label, items]) => <button type="button" role="tab" aria-selected={label === tab} key={label}
          onClick={() => setTab(label)}>{label}<span>{items.length}</span></button>)}
      </div>
      <div className="queue-actions">
        <label className="concurrency-control" title="同时传输数量"><Settings2 size={14} /><select aria-label="同时传输数量"
          value={snapshot.concurrency} onChange={(event) => onConcurrency(Number(event.target.value))}>
          {[1, 2, 3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <IconButton label="清理已结束任务" disabled={!snapshot.jobs.some((job) => !unfinished(job))} onClick={onClear}><Trash2 size={15} /></IconButton>
        <IconButton label={expanded ? "收起传输队列" : "展开传输队列"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </IconButton>
      </div>
    </header>
    {expanded && (jobs.length ? <div className="queue-list">
      {jobs.map((job) => <div className={`transfer-row transfer-row--${job.state}`} key={job.id} aria-label={`${job.name} · ${labels[job.state]}`}>
        <span className={`transfer-direction ${job.direction}`} title={job.direction === "upload" ? "上传" : "下载"}>
          {job.direction === "upload" ? <ArrowUpFromLine size={16} /> : <ArrowDownToLine size={16} />}
        </span>
        <div className="transfer-file"><strong title={job.name}>{job.name}</strong>
          <span title={`${job.sourcePath} → ${job.destinationPath ?? job.destinationDir}`}>{job.destinationPath ?? job.destinationDir}</span>
          {(job.error || job.warning) && <span className={job.error && job.state === "failed" ? "transfer-error" : "transfer-note"}
            title={job.error ?? job.warning ?? ""}>{job.error ?? job.warning}</span>}
        </div>
        <div className="transfer-progress">
          <div><span>{formatBytes(job.transferredBytes)}{job.totalBytes !== null && ` / ${formatBytes(job.totalBytes)}`}</span>
            {job.state === "running" && <span>{formatBytes(job.bytesPerSecond)}/s</span>}</div>
          <progress aria-label={`${job.name} 传输进度`} max={job.totalBytes || 1}
            value={job.totalBytes === 0 && job.state === "completed" ? 1 : job.transferredBytes} />
        </div>
        <div className="transfer-state"><span>{job.state === "canceling" && <LoaderCircle size={11} className="spinning" />}{labels[job.state]}</span>
          {job.state === "running" && job.etaSeconds !== null && <small>{remaining(job.etaSeconds)}</small>}</div>
        <div className="transfer-actions">
          {job.state === "conflict" && <IconButton label={`处理 ${job.name} 的同名文件`} disabled={job.sessionId !== sessionId}
            onClick={() => {
              const key = conflictKey(job);
              prompted.current.add(key);
              setConflictId(key);
            }}><Copy size={15} /></IconButton>}
          {["failed", "canceled"].includes(job.state) && <IconButton label={`重试 ${job.name}`} disabled={job.sessionId !== sessionId}
            onClick={() => onRetry(job.id)}><RefreshCw size={15} /></IconButton>}
          {unfinished(job) && <IconButton label={`取消 ${job.name}`} disabled={job.state === "canceling"} onClick={() => onCancel(job.id)}><X size={15} /></IconButton>}
        </div>
      </div>)}
    </div> : <div className="queue-empty"><Inbox size={25} strokeWidth={1.3} /><span>{tab === "全部" ? "暂无传输任务" : "暂无此类任务"}</span></div>)}
    {conflict && !dialogBlocked && <TransferConflictDialog key={conflictKey(conflict)} job={conflict} onResolve={onResolve}
      onClose={deferConflicts} onResolved={() => {
        setConflictId((current) => current === conflictKey(conflict) ? null : current);
      }} />}
  </section>;
}
