import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(
    "button, input, select, textarea, a[href], [tabindex]",
  ) ?? []).filter((element) => !element.matches(":disabled") && element.tabIndex >= 0 && !element.hidden);
}

export function Dialog({ title, children, onClose, busy = false, className = "" }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string;
}) {
  const id = useId();
  const container = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const root = document.getElementById("root");
    const previousInert = root?.inert ?? false;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    const panel = container.current;
    const controls = focusableElements(panel);
    (controls.find((element) => element.tagName === "INPUT") ?? controls[0] ?? panel)?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (panel && !panel.contains(event.target as Node)) panel.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.body.style.overflow = overflow;
      if (root) root.inert = previousInert;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useLayoutEffect(() => {
    if (busy) container.current?.focus();
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
