import { describe, expect, it } from "vitest";
import { formatBytes, visibleEntries } from "../src/lib/files";
import type { FileEntry } from "../src/lib/types";

function entry(name: string, fields: Partial<FileEntry> = {}): FileEntry {
  return {
    name, path: `/work/${name}`, isDir: false, isSymlink: false,
    size: 5, modifiedMs: 0, hidden: name.startsWith("."), ...fields,
  };
}

describe("文件列表", () => {
  it("默认隐藏点文件，但可以主动显示", () => {
    const entries = [entry(".env"), entry("notes.txt")];
    expect(visibleEntries(entries, "", false, "name", "asc").map((e) => e.name)).toEqual(["notes.txt"]);
    expect(visibleEntries(entries, "", true, "name", "asc")).toHaveLength(2);
  });

  it("逆序仍将目录置于文件前面", () => {
    const entries = [entry("a.txt"), entry("Z-folder", { isDir: true, size: null })];
    expect(visibleEntries(entries, "", false, "name", "desc")[0]?.name).toBe("Z-folder");
  });

  it("按文件大小排序且不修改原始列表", () => {
    const entries = [entry("big", { size: 1024 }), entry("small", { size: 1 })];
    expect(visibleEntries(entries, "", false, "size", "asc").map((e) => e.name)).toEqual(["small", "big"]);
    expect(entries[0].name).toBe("big");
  });

  it("搜索忽略大小写且不把上一次筛选结果当作输入", () => {
    const entries = [entry("ReadMe.md"), entry("data.csv")];
    expect(visibleEntries(entries, "README", false, "name", "asc").map((e) => e.name)).toEqual(["ReadMe.md"]);
  });

  it("显示实际的字节数，而不是将零字节当作未知", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(null)).toBe("—");
  });
});
