import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

const storageKey = "fileworker.sidebar-width.v1";
const defaultWidth = 215;
const minWidth = 180;
const maxWidth = 400;
const minWorkspaceWidth = 520;
const mobileBreakpoint = 760;

function readWidth() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (typeof value === "number" && Number.isInteger(value) && value >= minWidth && value <= maxWidth) return value;
  } catch {}
  return defaultWidth;
}

interface ResizeGesture {
  pointerId: number;
  startX: number;
  startWidth: number;
  preference: number;
  moved: boolean;
  target: HTMLElement;
}

export function useSidebarResize(collapsed: boolean, onNotice: (message: string) => void) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const preferred = useRef(preferredWidth);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, desktop: window.innerWidth > mobileBreakpoint }));
  const maximum = Math.max(minWidth, Math.min(maxWidth, Math.floor(viewport.width - minWorkspaceWidth)));
  const limit = useRef(maximum);
  limit.current = maximum;
  const notice = useRef(onNotice);
  notice.current = onNotice;
  const gesture = useRef<ResizeGesture | null>(null);
  const enabled = !collapsed && viewport.desktop;
  const width = Math.min(maximum, preferredWidth);
  const update = useCallback((value: number) => {
    preferred.current = value;
    setPreferredWidth(value);
  }, []);
  const save = useCallback((value: number) => {
    try { localStorage.setItem(storageKey, String(value)); }
    catch { notice.current("未能保存侧栏宽度，本次调整仍然有效"); }
  }, []);
  const release = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    document.body.classList.remove("resizing-sidebar");
    if (active?.target.hasPointerCapture?.(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback(() => {
    const active = release();
    if (active) update(active.preference);
  }, [release, update]);

  useLayoutEffect(() => {
    const measure = () => {
      const next = { width: workspaceRef.current?.getBoundingClientRect().width || window.innerWidth, desktop: window.innerWidth > mobileBreakpoint };
      setViewport((previous) => previous.width === next.width && previous.desktop === next.desktop ? previous : next);
      cancel();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (workspaceRef.current) observer?.observe(workspaceRef.current);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [cancel]);
  useLayoutEffect(() => { if (!enabled) cancel(); }, [enabled, cancel]);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId || !Number.isFinite(event.clientX)) return;
      const next = Math.max(minWidth, Math.min(limit.current, Math.round(active.startWidth + event.clientX - active.startX)));
      active.moved = next !== active.startWidth;
      update(active.moved ? next : active.preference);
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      move(event);
      const active = release();
      if (active?.moved) save(preferred.current);
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) cancel();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) { event.preventDefault(); cancel(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => {
      release();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
    };
  }, [cancel, release, save, update]);

  const reset = () => {
    cancel();
    update(defaultWidth);
    save(defaultWidth);
  };
  return {
    workspaceRef,
    style: { "--sidebar-width": `${width}px` } as CSSProperties,
    enabled,
    separatorProps: {
      role: "separator",
      "aria-label": "调整侧栏宽度",
      "aria-orientation": "vertical" as const,
      "aria-controls": "file-workspace",
      "aria-valuemin": minWidth,
      "aria-valuemax": maximum,
      "aria-valuenow": width,
      tabIndex: 0,
      title: "调整侧栏宽度",
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (!enabled || event.button !== 0 || event.isPrimary === false || gesture.current || !Number.isFinite(event.clientX)) return;
        event.preventDefault();
        event.currentTarget.focus();
        gesture.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, preference: preferred.current, moved: false, target: event.currentTarget };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.body.classList.add("resizing-sidebar");
      },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (gesture.current?.pointerId === event.pointerId) cancel();
      },
      onDoubleClick: reset,
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter") { event.preventDefault(); reset(); return; }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || gesture.current) return;
        event.preventDefault();
        const next = event.key === "Home" ? minWidth : event.key === "End" ? maximum
          : Math.max(minWidth, Math.min(maximum, width + (event.key === "ArrowRight" ? 10 : -10)));
        if (next === width) return;
        update(next);
        save(next);
      },
    },
  };
}
