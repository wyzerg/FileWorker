import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, readThemePreference, syncNativeTheme, themeStorageKey, type ThemePreference } from "../lib/theme";
import { IconButton } from "./IconButton";

const choices = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor },
] as const;

export function ThemeMenu({ onError }: { onError: (message: string) => void }) {
  const [preference, setPreference] = useState(readThemePreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const error = useRef(onError);
  error.current = onError;
  const id = useId();
  const CurrentIcon = choices.find((choice) => choice.value === preference)!.Icon;

  useLayoutEffect(() => { applyTheme(preference, systemDark); }, [preference, systemDark]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let active = true;
    void syncNativeTheme(preference).catch(() => {
      if (active) error.current("窗口外观未能同步，界面主题仍已切换");
    });
    return () => { active = false; };
  }, [preference]);
  useLayoutEffect(() => {
    if (open) container.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  function choose(next: ThemePreference) {
    setPreference(next);
    try { localStorage.setItem(themeStorageKey, next); }
    catch { error.current("未能保存外观偏好，本次选择仍然有效"); }
    setOpen(false);
    trigger.current?.focus();
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation();
      setOpen(false); trigger.current?.focus(); return;
    }
    if (event.key === "Tab" && open) {
      setOpen(false); trigger.current?.focus(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const items = Array.from(container.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div className="theme-menu-anchor" ref={container} onKeyDown={handleKey}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <IconButton label="外观设置" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        ref={trigger} onClick={() => setOpen((value) => !value)}><CurrentIcon size={17} /></IconButton>
      {open && <div className="action-menu theme-menu" role="menu" aria-label="外观" id={id}>
        <div className="theme-menu-label" aria-hidden="true">外观</div>
        {choices.map(({ value, label, Icon }) => (
          <button type="button" role="menuitemradio" aria-checked={preference === value} tabIndex={-1}
            key={value} onClick={() => choose(value)}>
            <Icon size={16} /><span>{label}</span>{preference === value && <Check size={15} className="theme-check" />}
          </button>
        ))}
      </div>}
    </div>
  );
}
