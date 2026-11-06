import { useEffect, useId, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { IconButton } from "./IconButton";

export function StatusNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (!container.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

  return <div className="status-notice" ref={container}>
    <button type="button" className="status-notice-trigger" ref={trigger} title={message}
      aria-label="查看完整提示" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined}
      onClick={() => setExpanded((value) => !value)}>
      <Info size={12} /><span role="alert">{message}</span>
    </button>
    <IconButton label="关闭提示" onClick={onDismiss}><X size={12} /></IconButton>
    {expanded && <div id={detailsId} className="status-notice-details" role="region" aria-label="完整提示" tabIndex={0}>
      {message}
    </div>}
  </div>;
}
