import { useLayoutEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage } from "./api";
import type { DirectoryListing, FileAction, FileEntry, RemoteFileProperties, RemotePreview } from "./types";

type DialogAction = Exclude<FileAction, "download" | "copyPath">;
export interface RemoteFileDialogState {
  kind: DialogAction;
  sessionId: string;
  directory: string;
  path: string;
  name: string;
  busy: boolean;
  error: string;
  preview?: RemotePreview;
  properties?: RemoteFileProperties;
}
const isMutation = (kind: DialogAction) => ["createDirectory", "rename", "delete"].includes(kind);

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
    if (isMutation(action) && mutationsBlocked) { onNotice("请先完成或取消当前连接的传输，再修改远程文件"); return; }
    if (action !== "createDirectory" && entries.length > 1) return;
    const entry = entries[0];
    if (["preview", "rename", "delete"].includes(action) && (!entry || entry.isSymlink)) return;
    if (action === "preview" && entry?.isDir) return;
    const target: RemoteFileDialogState = {
      kind: action, sessionId, directory: listing.path, path: action === "createDirectory" ? listing.path : entry?.path ?? listing.path,
      name: action === "createDirectory" ? "" : entry?.name ?? listing.path, busy: false, error: "",
    };
    if (action === "preview" || action === "properties") void load(target);
    else setDialog(target);
  }
  async function submit() {
    const target = dialogRef.current;
    if (!target || target.busy || !isMutation(target.kind) || target.sessionId !== current.current.sessionId) return;
    if (current.current.mutationsBlocked) {
      setDialog({ ...target, error: "请先完成或取消当前连接的传输，再修改远程文件" }); return;
    }
    if (target.kind !== "delete" && (!target.name.trim() || [".", ".."].includes(target.name)
      || /[/\u0000-\u001f\u007f]/u.test(target.name) || new TextEncoder().encode(target.name).length > 255)) {
      setDialog({ ...target, error: "请输入有效名称，不能包含斜杠、控制字符，也不能是 . 或 .." }); return;
    }
    const token = ++generation.current;
    setDialog({ ...target, busy: true, error: "" });
    try {
      await api.mutateRemoteFile(target.sessionId, target.path, target.kind === "delete" ? { kind: "delete" }
        : { kind: target.kind as "rename" | "createDirectory", name: target.name });
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
