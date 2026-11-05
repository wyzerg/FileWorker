import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(
    "button, input, select, textarea, a[href], [tabindex]",
  ) ?? []).filter((element) => !element.matches(":disabled") && element.tabIndex >= 0 && !element.hidden);
}

const modalStack: HTMLElement[] = [];
let pageState: {
  root: HTMLElement | null; inert: boolean; overflow: string; focus: HTMLElement | null;
} | null = null;

function focusPanel(panel: HTMLElement) {
  const controls = focusableElements(panel);
  (controls.find((element) => element.tagName === "INPUT") ?? controls[0] ?? panel).focus();
}

function registerModal(panel: HTMLElement) {
  const previous = document.activeElement as HTMLElement | null;
  if (!modalStack.length) {
    const root = document.getElementById("root");
    pageState = { root, inert: root?.inert ?? false, overflow: document.body.style.overflow, focus: previous };
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
  }
  modalStack.at(-1)?.setAttribute("inert", "");
  modalStack.push(panel);
  focusPanel(panel);
  return () => {
    const wasTop = modalStack.at(-1) === panel;
    const index = modalStack.indexOf(panel);
    if (index !== -1) modalStack.splice(index, 1);
    panel.removeAttribute("inert");
    const top = modalStack.at(-1);
    if (top) {
      top.removeAttribute("inert");
      if (wasTop) {
        if (previous?.isConnected && top.contains(previous)) previous.focus();
        else focusPanel(top);
      }
    } else if (pageState) {
      const saved = pageState;
      pageState = null;
      if (saved.root) saved.root.inert = saved.inert;
      document.body.style.overflow = saved.overflow;
      if (saved.focus?.isConnected) saved.focus.focus();
    }
  };
}

export function Dialog({ title, children, onClose, busy = false, className = "" }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string;
}) {
  const id = useId();
  const container = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const panel = container.current;
    if (!panel) return;
    const unregister = registerModal(panel);
    const keepFocus = (event: FocusEvent) => {
      if (modalStack.at(-1) === panel && !panel.contains(event.target as Node)) panel.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      unregister();
    };
  }, []);
  useLayoutEffect(() => {
    if (busy && modalStack.at(-1) === container.current) container.current?.focus();
  }, [busy]);
  return createPortal(
    <div className="modal-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget && !busy) close.current();
    }}>
      <section ref={container} tabIndex={-1} className={`dialog ${className}`} role="dialog" aria-modal="true"
        aria-labelledby={id} onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) { event.stopPropagation(); close.current(); }
          if (event.key !== "Tab") return;
          const controls = focusableElements(container.current);
          if (!controls.length) {
            event.preventDefault(); container.current?.focus(); return;
          }
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <header className="dialog-header">
          <h2 id={id}>{title}</h2>
          <IconButton label="关闭对话框" onClick={onClose} disabled={busy}><X size={18} /></IconButton>
        </header>
        {children}
      </section>
    </div>, document.body,
  );
}
