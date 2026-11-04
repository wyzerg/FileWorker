import type { FileEntry, SortDirection, SortKey } from "./types";

export function visibleEntries(
  entries: FileEntry[],
  query: string,
  showHidden: boolean,
  sortKey: SortKey,
  direction: SortDirection,
): FileEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries
    .filter((entry) => (showHidden || !entry.hidden) && entry.name.toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
      const delta = sortKey === "size"
        ? (left.size ?? -1) - (right.size ?? -1)
        : sortKey === "modified"
          ? (left.modifiedMs ?? -1) - (right.modifiedMs ?? -1)
          : left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
      return (delta || left.name.localeCompare(right.name)) * (direction === "asc" ? 1 : -1);
    });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${Number(value.toFixed(value < 10 ? 1 : 0))} ${units[index]}`;
}

export function formatDate(timestamp: number | null): string {
  return timestamp === null ? "—" : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(timestamp);
}
