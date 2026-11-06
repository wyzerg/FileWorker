import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, Copy, FolderPlus, Info, MoreHorizontal, Pencil, RefreshCw, ScanEye, Trash2 } from "lucide-react";
import type { FileAction, FileEntry } from "../lib/types";
import { isOrdinaryFile } from "../lib/files";
import { IconButton } from "./IconButton";
import "./remote-files.css";

const actions = [
  { id: "preview", label: "预览文件", Icon: ScanEye },
  { id: "download", label: "下载所选文件", Icon: ArrowDownToLine },
  { id: "copyPath", label: "复制路径", Icon: Copy },
  { id: "createDirectory", label: "新建文件夹", Icon: FolderPlus },
  { id: "rename", label: "重命名", Icon: Pencil },
  { id: "delete", label: "删除", Icon: Trash2 },
  { id: "properties", label: "属性", Icon: Info },
] as const;
type ActionOptions = {
  entries: FileEntry[];
  ready: boolean;
  mutationsBlocked: boolean;
  downloadEnabled: boolean;
  onAction: (action: FileAction, entries: FileEntry[]) => void;
};
function disabled(action: FileAction, { entries, ready, mutationsBlocked, downloadEnabled }: ActionOptions) {
  if (!ready) return true;
  if (action === "copyPath") return false;
  if (action === "properties") return entries.length > 1;
  if (action === "download") return !downloadEnabled || !entries.length || !entries.every(isOrdinaryFile);
  if (action === "preview") return entries.length !== 1 || !isOrdinaryFile(entries[0]);
  if (mutationsBlocked) return true;
  if (action === "delete") return !entries.length || entries.some((entry) => entry.isSymlink || entry.path === "/");
  return action !== "createDirectory" && (entries.length !== 1 || entries[0].isSymlink);
}
export function RemoteFileToolbar(options: ActionOptions & { menuOpen: boolean; onMenu: (trigger: HTMLButtonElement) => void }) {
  return <div className="file-actions remote-file-toolbar">
    {actions.map(({ id, label, Icon }) => <IconButton key={id} label={label} disabled={disabled(id, options)}
      className={["copyPath", "rename", "properties"].includes(id) ? "toolbar-secondary" : ""}
      onClick={() => options.onAction(id, options.entries)}><Icon size={16} /></IconButton>)}
    <IconButton label="更多文件操作" className="file-toolbar-overflow" disabled={!options.ready}
      aria-haspopup="menu" aria-expanded={options.menuOpen} onClick={(event) => options.onMenu(event.currentTarget)}>
      <MoreHorizontal size={16} />
    </IconButton>
  </div>;
}
export function RemoteFileMenu({ anchor, trigger, toggleTrigger = false, onClose, onRefresh, ...options }: ActionOptions & {
  anchor: { x: number; y: number }; trigger: HTMLElement | null; toggleTrigger?: boolean; onClose: () => void; onRefresh: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const bounds = panel.current?.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - (bounds?.width ?? 180) - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - (bounds?.height ?? 300) - 8)),
    });
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor.x, anchor.y]);
  useEffect(() => {
    const outside = (event: Event) => {
      const togglesMenu = toggleTrigger && trigger?.contains(event.target as Node);
      if (!panel.current?.contains(event.target as Node) && !togglesMenu) onClose();
    };
    const move = () => onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", move, true); window.removeEventListener("resize", move);
    };
  }, [onClose, trigger, toggleTrigger]);
  function close() { onClose(); if (trigger?.isConnected) trigger.focus(); }
  return createPortal(<div ref={panel} role="menu" aria-label="远程文件操作" className="remote-file-menu" style={position}
    onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (["Escape", "Tab"].includes(event.key)) {
        if (event.key === "Escape") event.preventDefault();
        event.stopPropagation(); close(); return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    {actions.map(({ id, label, Icon }) => <button type="button" role="menuitem" key={id} tabIndex={-1}
      className={id === "delete" ? "danger-text" : ""} disabled={disabled(id, options)}
      onClick={() => { close(); options.onAction(id, options.entries); }}><Icon size={15} />{label}</button>)}
    <div className="menu-divider" />
    <button type="button" role="menuitem" tabIndex={-1} disabled={!options.ready}
      onClick={() => { close(); onRefresh(); }}><RefreshCw size={15} />刷新目录</button>
  </div>, document.body);
}
