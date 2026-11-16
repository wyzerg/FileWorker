import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { isOrdinaryFile } from "./files";
import type { DirectoryListing, FileEntry, TransferRequest } from "./types";

const dragType = "application/x-fileworker-transfer";
type PaneSide = "local" | "remote";

interface ActiveDrag {
  token: string;
  side: PaneSide;
  sessionId: string;
  local: DirectoryListing;
  remote: DirectoryListing;
  entries: FileEntry[];
}

export interface FilePaneDrag {
  enabled: boolean;
  target: boolean;
  pointerMode: boolean;
  dropRef: RefObject<HTMLDivElement | null>;
  pointerStart: (entries: FileEntry[], event: PointerEvent<HTMLTableRowElement>) => boolean;
  consumeClick: () => boolean;
  begin: (entries: FileEntry[], data: DataTransfer) => boolean;
  accepts: (data: DataTransfer) => boolean;
  drop: (data: DataTransfer) => void;
  end: () => void;
}

export function useTransferDrag({ enabled, pointerMode = false, sessionId, local, remote, onTransfer }: {
  enabled: boolean;
  pointerMode?: boolean;
  sessionId: string | null;
  local: DirectoryListing | null;
  remote: DirectoryListing | null;
  onTransfer: (requests: TransferRequest[]) => void;
}) {
  const pending = useRef<ActiveDrag | null>(null);
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const localDrop = useRef<HTMLDivElement>(null);
  const remoteDrop = useRef<HTMLDivElement>(null);
  const pointer = useRef<{
    id: number; x: number; y: number; target: HTMLTableRowElement; started: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ x: number; y: number; label: string } | null>(null);
  const current = useRef({ enabled, sessionId, local, remote, onTransfer });
  useLayoutEffect(() => { current.current = { enabled, sessionId, local, remote, onTransfer }; });
  const clear = useCallback(() => {
    const gesture = pointer.current;
    pointer.current = null;
    if (gesture?.target.hasPointerCapture?.(gesture.id)) gesture.target.releasePointerCapture(gesture.id);
    pending.current = null;
    setActive(null);
    setPreview(null);
  }, []);
  const valid = useCallback((drag: ActiveDrag | null): drag is ActiveDrag => {
    const live = current.current;
    return Boolean(drag && live.enabled && live.sessionId === drag.sessionId && live.local === drag.local && live.remote === drag.remote);
  }, []);
  const submit = useCallback((drag: ActiveDrag) => {
    current.current.onTransfer(drag.entries.map((entry) => ({
      sessionId: drag.sessionId, direction: drag.side === "local" ? "upload" : "download",
      sourcePath: entry.path, destinationDir: drag.side === "local" ? drag.remote.path : drag.local.path,
    })));
  }, []);

  // A reload invalidates the gesture even when it returns to the same path.
  useLayoutEffect(clear, [enabled, pointerMode, sessionId, local, remote, clear]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    const move = (event: globalThis.PointerEvent) => {
      const gesture = pointer.current;
      const drag = pending.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      if (!valid(drag)) { clear(); return; }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      if (!gesture.started && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
      gesture.started = true;
      suppressClick.current = true;
      setActive(drag);
      setPreview({ x: event.clientX, y: event.clientY, label: drag.entries.length === 1 ? drag.entries[0].name : `${drag.entries.length} 个文件` });
    };
    const finish = (event: globalThis.PointerEvent) => {
      const gesture = pointer.current;
      const drag = pending.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      clear();
      if (!gesture.started || !valid(drag) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      const element = drag.side === "local" ? remoteDrop.current : localDrop.current;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const bounds = element?.getBoundingClientRect();
      if (element && hit && element.contains(hit) && bounds
        && event.clientX >= bounds.left && event.clientX < bounds.right
        && event.clientY >= bounds.top && event.clientY < bounds.bottom) submit(drag);
    };
    const cancel = (event: globalThis.PointerEvent) => { if (pointer.current?.id === event.pointerId) clear(); };
    const resetClick = () => { if (!pointer.current) suppressClick.current = false; };
    window.addEventListener("keydown", escape);
    window.addEventListener("dragend", clear);
    window.addEventListener("pointerdown", resetClick, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", cancel);
    window.addEventListener("blur", clear);
    window.addEventListener("resize", clear);
    return () => {
      clear();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("pointerdown", resetClick, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", clear);
    };
  }, [clear, submit, valid]);
  const create = (side: PaneSide, entries: FileEntry[]): ActiveDrag | null => {
    const listing = side === "local" ? local : remote;
    if (!enabled || !sessionId || !local || !remote || !listing || !entries.length
      || !entries.every((entry) => isOrdinaryFile(entry) && listing.entries.includes(entry))
      || new Set(entries.map((entry) => entry.path)).size !== entries.length) return null;
    return { token: crypto.randomUUID(), side, sessionId, local, remote, entries: [...entries] };
  };

  return {
    clear, preview,
    pane: (side: PaneSide): FilePaneDrag => ({
      enabled: enabled && Boolean(sessionId && local && remote),
      target: valid(active) && active.side !== side,
      pointerMode,
      dropRef: side === "local" ? localDrop : remoteDrop,
      consumeClick: () => {
        const suppressed = suppressClick.current;
        suppressClick.current = false;
        return suppressed;
      },
      pointerStart: (entries, event) => {
        if (!pointerMode || event.button !== 0 || event.isPrimary === false || pointer.current
          || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
        clear();
        suppressClick.current = false;
        const drag = create(side, entries);
        if (!drag) return false;
        pending.current = drag;
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.currentTarget, started: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return true;
      },
      begin: (entries, data) => {
        clear();
        const drag = pointerMode ? null : create(side, entries);
        if (!drag) return false;
        data.clearData();
        data.setData(dragType, drag.token);
        data.effectAllowed = "copy";
        pending.current = drag;
        setActive(drag);
        return true;
      },
      accepts: (data) => valid(pending.current) && pending.current.side !== side && Array.from(data.types).includes(dragType),
      drop: (data) => {
        const drag = pending.current;
        clear();
        if (pointerMode || !valid(drag) || drag.side === side || data.getData(dragType) !== drag.token) return;
        submit(drag);
      },
      end: clear,
    }),
  };
}
