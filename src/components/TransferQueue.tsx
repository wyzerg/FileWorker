import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, Copy, Inbox, LoaderCircle, RefreshCw, Settings2, SkipForward, Trash2, X } from "lucide-react";
import type { ConflictPolicy, TransferJob, TransferSnapshot, TransferState } from "../lib/types";
import { formatBytes } from "../lib/files";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";

const labels: Record<TransferState, string> = {
  queued: "等待中", running: "传输中", canceling: "正在取消", conflict: "同名待处理",
  completed: "已完成", failed: "失败", canceled: "已取消", skipped: "已跳过",
};
export const unfinished = (job: TransferJob) => ["queued", "running", "canceling", "conflict"].includes(job.state);
const remaining = (seconds: number | null) => seconds === null ? "" : seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`;

export function TransferQueue({ snapshot, sessionId, onCancel, onRetry, onResolve, onConcurrency, onClear }: {
  snapshot: TransferSnapshot;
  sessionId: string | null;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onResolve: (id: string, policy: ConflictPolicy) => void;
  onConcurrency: (value: number) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [tab, setTab] = useState("全部");
  const [conflictId, setConflictId] = useState<string | null>(null);
  const conflict = snapshot.jobs.find((job) => job.id === conflictId && job.state === "conflict" && job.sessionId === sessionId);
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
            onClick={() => setConflictId(job.id)}><Copy size={15} /></IconButton>}
          {["failed", "canceled"].includes(job.state) && <IconButton label={`重试 ${job.name}`} disabled={job.sessionId !== sessionId}
            onClick={() => onRetry(job.id)}><RefreshCw size={15} /></IconButton>}
          {unfinished(job) && <IconButton label={`取消 ${job.name}`} disabled={job.state === "canceling"} onClick={() => onCancel(job.id)}><X size={15} /></IconButton>}
        </div>
      </div>)}
    </div> : <div className="queue-empty"><Inbox size={25} strokeWidth={1.3} /><span>{tab === "全部" ? "暂无传输任务" : "暂无此类任务"}</span></div>)}
    {conflict && <Dialog title="同名文件" onClose={() => setConflictId(null)}>
      <div className="dialog-body"><p className="confirm-message">目标已存在「{conflict.name}」</p>
        <p className="conflict-path">{conflict.destinationPath ?? `${conflict.destinationDir.replace(/\/$/u, "")}/${conflict.name}`}</p></div>
      <footer className="dialog-footer conflict-actions">
        <button type="button" className="button secondary" onClick={() => { onResolve(conflict.id, "skip"); setConflictId(null); }}><SkipForward size={14} />跳过</button>
        <button type="button" className="button danger" onClick={() => { onResolve(conflict.id, "overwrite"); setConflictId(null); }}><ArrowDownToLine size={14} />覆盖</button>
        <button type="button" className="button primary" onClick={() => { onResolve(conflict.id, "keepBoth"); setConflictId(null); }}><Copy size={14} />保留两份</button>
      </footer>
    </Dialog>}
  </section>;
}
