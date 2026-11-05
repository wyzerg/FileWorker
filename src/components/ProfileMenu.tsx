import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, KeyRound, Pencil, PlugZap, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../lib/types";

export function ProfileMenu({ profile, anchor, trigger, busy, desktop, onClose, onConnect, onEdit, onDuplicate, onForget, onDelete }: {
  profile: ConnectionProfile;
  anchor: { x: number; y: number };
  trigger?: HTMLElement | null;
  busy: boolean;
  desktop: boolean;
  onClose: () => void;
  onConnect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onForget: () => void;
  onDelete: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(trigger ?? document.activeElement as HTMLElement | null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useLayoutEffect(() => {
    const bounds = panel.current?.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, window.innerWidth - (bounds?.width ?? 174) - 8)),
      top: Math.max(8, Math.min(anchor.y, window.innerHeight - (bounds?.height ?? 230) - 8)),
    });
    panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor.x, anchor.y]);
  useEffect(() => {
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) onClose();
    };
    const move = () => onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [onClose, trigger]);
  const closeAndFocus = () => {
    onClose();
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  };
  const run = (action: () => void) => { closeAndFocus(); action(); };
  return createPortal(<div ref={panel} className="action-menu profile-context-menu" role="menu"
    aria-label={`${profile.name} 连接操作`} style={position} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (["Escape", "Tab"].includes(event.key)) {
        if (event.key === "Escape") event.preventDefault();
        event.stopPropagation(); closeAndFocus(); return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
    <div className="profile-menu-name">{profile.name}</div>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy || !desktop} onClick={() => run(onConnect)}><PlugZap size={15} />连接服务器</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => run(onEdit)}><Pencil size={15} />编辑连接</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => run(onDuplicate)}><Copy size={15} />复制连接</button>
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy || !desktop} onClick={() => run(onForget)}><KeyRound size={15} />忘记已存凭据</button>
    <div className="menu-divider" />
    <button type="button" role="menuitem" tabIndex={-1} disabled={busy} className="danger-text" onClick={() => run(onDelete)}><Trash2 size={15} />删除连接</button>
  </div>, document.body);
}
