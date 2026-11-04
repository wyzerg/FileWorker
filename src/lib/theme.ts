import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePreference = "light" | "dark" | "system";
export const themeStorageKey = "fileworker.appearance.v1";

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  return "system";
}

export function applyTheme(preference: ThemePreference, systemDark: boolean) {
  const theme = preference === "system" ? systemDark ? "dark" : "light" : preference;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const background = theme === "dark" ? "#191b20" : "#e9edf1";
  root.style.backgroundColor = background;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", background);
}

export async function syncNativeTheme(preference: ThemePreference) {
  if (isTauri()) await getCurrentWindow().setTheme(preference === "system" ? null : preference);
}
