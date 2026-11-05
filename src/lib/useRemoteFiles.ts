import { useLayoutEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage } from "./api";
import type { DirectoryListing, FileAction, FileEntry, RemoteFileProperties, RemotePreview } from "./types";

type DialogAction = Exclude<FileAction, "download" | "copyPath">;
interface DeleteTarget {
  path: string;
  status: "pending" | "deleting" | "deleted" | "failed";
  error: string;
}
export interface RemoteFileDialogState {
  kind: DialogAction;
  sessionId: string;
  directory: string;
  path: string;
  name: string;
  busy: boolean;
  error: string;
  deleteTargets?: DeleteTarget[];
  reconnectRequired?: boolean;
  preview?: RemotePreview;
  properties?: RemoteFileProperties;
}
const isMutation = (kind: DialogAction) => ["createDirectory", "rename", "delete"].includes(kind);
const mutationBlockedMessage = "请先完成或取消当前连接的传输，再修改远程文件";

export function useRemoteFiles(options: {
  sessionId: string | null;
  listing: DirectoryListing | null;
  mutationsBlocked: boolean;
  onRefresh: (path: string) => void;
  onNotice: (message: string) => void;
  onSessionError?: (cause: unknown) => void;
}) {
  const [dialog, setState] = useState<RemoteFileDialogState | null>(null);
  const current = useRef(options); current.current = options;
  const dialogRef = useRef(dialog);
  const generation = useRef(0);
  function setDialog(value: RemoteFileDialogState | null) { dialogRef.current = value; setState(value); }
  useLayoutEffect(() => {
    generation.current += 1; setDialog(null);
    return () => { generation.current += 1; };
  }, [options.sessionId]);
  const valid = (target: RemoteFileDialogState, token: number) =>
    token === generation.current && current.current.sessionId === target.sessionId && dialogRef.current?.path === target.path;
  function handleError(cause: unknown) {
    if (["connection_lost", "session_closed"].includes(errorCode(cause) ?? "")) current.current.onSessionError?.(cause);
  }
  async function load(target: RemoteFileDialogState) {
    const token = ++generation.current;
    setDialog({ ...target, busy: true, error: "" });
    try {
      const result = target.kind === "preview"
        ? { preview: await api.previewRemoteFile(target.sessionId, target.path) }
        : { properties: await api.remoteFileProperties(target.sessionId, target.path) };
      if (valid(target, token)) setDialog({ ...target, ...result, busy: false, error: "" });
    } catch (cause) {
      if (!valid(target, token)) return;
      setDialog({ ...target, busy: false, error: errorMessage(cause) }); handleError(cause);
    }
  }
  function open(action: FileAction, entries: FileEntry[] = []) {
    const { sessionId, listing, mutationsBlocked, onNotice } = current.current;
    if (!sessionId || !listing || dialogRef.current) return;
    if (entries.some((entry) => !listing.entries.some((item) => item.path === entry.path))) return;
    entries = entries.map((entry) => listing.entries.find((item) => item.path === entry.path)!);
    if (action === "download") return;
    if (action === "copyPath") {
      const text = entries.length ? entries.map((entry) => entry.path).join("\n") : listing.path;
      void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          if (current.current.sessionId === sessionId) onNotice("路径已复制");
        } catch {
          if (current.current.sessionId === sessionId) onNotice("未能复制路径，请从属性中选择并复制");
        }
      })();
      return;
    }
    if (isMutation(action) && mutationsBlocked) { onNotice(mutationBlockedMessage); return; }
    if (action !== "createDirectory" && action !== "delete" && entries.length > 1) return;
    if (action === "delete" && (!entries.length || entries.some((entry) => entry.isSymlink || entry.path === "/")
      || new Set(entries.map((entry) => entry.path)).size !== entries.length)) return;
    const entry = entries[0];
    if (["preview", "rename", "delete"].includes(action) && (!entry || entry.isSymlink)) return;
    if (action === "preview" && entry?.isDir) return;
    const target: RemoteFileDialogState = {
      kind: action, sessionId, directory: listing.path, path: action === "createDirectory" ? listing.path : entry?.path ?? listing.path,
      name: action === "createDirectory" ? "" : entry?.name ?? listing.path, busy: false, error: "",
      ...(action === "delete" ? { deleteTargets: entries.map(({ path }) => ({ path, status: "pending" as const, error: "" })) } : {}),
    };
    if (action === "preview" || action === "properties") void load(target);
    else setDialog(target);
  }
  async function deleteBatch(target: RemoteFileDialogState, token: number) {
    let targets = target.deleteTargets!.map((item) => item.status === "failed" ? { ...item, status: "pending" as const, error: "" } : item);
    let changed = false;
    let stopMessage = "";
    let sessionFailure: unknown;
    const publish = () => setDialog({ ...target, deleteTargets: targets, busy: true, error: "" });
    const stopRemaining = (start: number, message: string) => {
      targets = targets.map((item, index) => index >= start && item.status !== "deleted"
        ? { ...item, status: "failed", error: `未执行删除：${message}` } : item);
    };
    for (let index = 0; index < targets.length; index += 1) {
      if (!valid(target, token)) return;
      if (targets[index].status === "deleted") continue;
      if (current.current.mutationsBlocked) {
        stopMessage = mutationBlockedMessage;
        stopRemaining(index, stopMessage); break;
      }
      targets = targets.map((item, at) => at === index ? { ...item, status: "deleting", error: "" } : item);
      publish();
      try {
        await api.mutateRemoteFile(target.sessionId, targets[index].path, { kind: "delete" });
        if (!valid(target, token)) return;
        targets = targets.map((item, at) => at === index ? { ...item, status: "deleted" } : item);
        changed = true;
      } catch (cause) {
        if (!valid(target, token)) return;
        const message = errorMessage(cause), code = errorCode(cause);
        targets = targets.map((item, at) => at === index ? { ...item, status: "failed", error: message } : item);
        if (["connection_lost", "session_closed", "transfers_active", "remote_file_busy"].includes(code ?? "")) {
          stopMessage = message;
          if (code === "connection_lost" || code === "session_closed") sessionFailure = cause;
          stopRemaining(index + 1, message); break;
        }
      }
      publish();
    }
    if (!valid(target, token)) return;
    const failures = targets.filter((item) => item.status === "failed");
    setDialog(!failures.length && targets.length === 1 ? null : {
      ...target, deleteTargets: targets, busy: false, reconnectRequired: sessionFailure !== undefined,
      error: stopMessage || (failures.length === 1 ? failures[0].error : failures.length ? `${failures.length} 项删除失败，请查看各项原因后重试` : ""),
    });
    if (sessionFailure !== undefined) handleError(sessionFailure);
    else if (changed) current.current.onRefresh(target.directory);
  }
  async function submit() {
    const target = dialogRef.current;
    if (!target || target.busy || target.reconnectRequired || !isMutation(target.kind) || target.sessionId !== current.current.sessionId) return;
    if (target.kind === "delete" && !target.deleteTargets?.some((item) => item.status !== "deleted")) return;
    if (current.current.mutationsBlocked) {
      setDialog({ ...target, error: mutationBlockedMessage }); return;
    }
    if (target.kind !== "delete" && (!target.name.trim() || [".", ".."].includes(target.name)
      || /[/\u0000-\u001f\u007f]/u.test(target.name) || new TextEncoder().encode(target.name).length > 255)) {
      setDialog({ ...target, error: "请输入有效名称，不能包含斜杠、控制字符，也不能是 . 或 .." }); return;
    }
    const token = ++generation.current;
    setDialog({ ...target, busy: true, error: "" });
    if (target.kind === "delete") { await deleteBatch(target, token); return; }
    try {
      await api.mutateRemoteFile(target.sessionId, target.path, { kind: target.kind as "rename" | "createDirectory", name: target.name });
      if (!valid(target, token)) return;
      setDialog(null);
      current.current.onRefresh(target.directory);
    } catch (cause) {
      if (!valid(target, token)) return;
      setDialog({ ...target, busy: false, error: errorMessage(cause) }); handleError(cause);
    }
  }
  return {
    dialog: dialog?.sessionId === options.sessionId ? dialog : null,
    open, submit,
    close: () => {
      const active = dialogRef.current;
      if (active?.busy && isMutation(active.kind)) return;
      generation.current += 1; setDialog(null);
    },
    setName: (name: string) => {
      if (dialogRef.current && !dialogRef.current.busy) setDialog({ ...dialogRef.current, name, error: "" });
    },
    retry: () => { if (dialogRef.current && !dialogRef.current.busy) void load(dialogRef.current); },
  };
}

export type RemoteFileController = ReturnType<typeof useRemoteFiles>;
