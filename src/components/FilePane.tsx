import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpFromLine, ChevronDown, ChevronRight, Eye, EyeOff, File, FileArchive, FileCode2, FileImage, FileText, Folder, FolderOpen, HardDrive, Link2, LoaderCircle, Monitor, Pencil, PlugZap, Plus, RefreshCw, Search, Server, Unplug } from "lucide-react";
import type { ConnectionProfile, DirectoryListing, FileEntry, SortDirection, SortKey } from "../lib/types";
import { formatBytes, formatDate, isOrdinaryFile, visibleEntries } from "../lib/files";
import { IconButton } from "./IconButton";
import type { FilePaneDrag } from "../lib/useTransferDrag";

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.isDir) return <Folder size={19} className="folder-icon" fill="currentColor" fillOpacity={0.13} />;
  const extension = entry.name.split(".").pop()?.toLowerCase();
  const Icon = extension && ["png", "jpg", "webp", "svg", "gif", "heic"].includes(extension) ? FileImage
    : extension && ["zip", "tar", "gz", "7z"].includes(extension) ? FileArchive
      : extension && ["rs", "ts", "tsx", "js", "json", "toml", "py", "go"].includes(extension) ? FileCode2
        : extension && ["txt", "md", "log", "csv"].includes(extension) ? FileText : File;
  return <Icon size={18} className="file-icon" />;
}

export function FilePane({ side, listing, path, parentPath, onPathChange, onNavigate, loading, error, onChooseDirectory, profile, onNewProfile, onEditProfile, onMenu, preview = false, connected = false, connecting = false, onConnect, onDisconnect, transferEnabled = false, onTransfer, drag, externalDropTarget = false, dropRef }: {
  side: "local" | "remote";
  listing?: DirectoryListing | null;
  path: string;
  parentPath?: string | null;
  onPathChange?: (path: string) => void;
  onNavigate?: (path: string | null) => void;
  loading?: boolean;
  error?: string;
  onChooseDirectory?: () => void;
  profile?: ConnectionProfile | null;
  onNewProfile?: () => void;
  onEditProfile?: () => void;
  onMenu?: () => void;
  preview?: boolean;
  connected?: boolean;
  connecting?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  transferEnabled?: boolean;
  onTransfer?: (entries: FileEntry[]) => void;
  drag?: FilePaneDrag;
  externalDropTarget?: boolean;
  dropRef?: Ref<HTMLDivElement>;
}) {
  const local = side === "local";
  const navigable = (local || connected) && !preview;
  const parent = parentPath === undefined ? listing?.parentPath : parentPath;
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => { setSelected(new Set()); setQuery(""); anchor.current = null; }, [listing?.path]);
  const entries = useMemo(() => visibleEntries(listing?.entries ?? [], query, showHidden, sortKey, direction),
    [listing, query, showHidden, sortKey, direction]);
  const selectedEntries = entries.filter((entry) => selected.has(entry.path));
  const selectable = entries.filter(isOrdinaryFile);
  const canDrag = (entry: FileEntry) => Boolean(drag?.enabled && transferEnabled && !preview && !loading && isOrdinaryFile(entry))
    && (!selected.has(entry.path) || selectedEntries.every(isOrdinaryFile));
  useEffect(() => {
    setSelected((previous) => {
      const next = new Set([...previous].filter((path) => entries.some((entry) => entry.path === path)));
      return next.size === previous.size ? previous : next;
    });
  }, [entries]);
  const select = (entry: FileEntry, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => {
    if (modifiers.shiftKey && anchor.current) {
      const start = entries.findIndex((item) => item.path === anchor.current);
      const end = entries.indexOf(entry);
      if (start >= 0) {
        setSelected(new Set(entries.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.path)));
        return;
      }
    }
    anchor.current = entry.path;
    setSelected((previous) => {
      if (!modifiers.metaKey && !modifiers.ctrlKey) return new Set([entry.path]);
      const next = new Set(previous);
      if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
      return next;
    });
  };
  const toggleFile = (entry: FileEntry) => {
    anchor.current = entry.path;
    setSelected((previous) => {
      const next = new Set([...previous].filter((path) => selectable.some((file) => file.path === path)));
      if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
      return next;
    });
  };
  const sort = (key: SortKey) => {
    setDirection(key === sortKey && direction === "asc" ? "desc" : "asc");
    setSortKey(key);
  };
  const label = local ? "本地" : "远程";
  return (
    <section className={`file-pane file-pane--${side} ${drag?.target || externalDropTarget ? "file-pane--drop-target" : ""}`} aria-label={`${label}文件`}>
      <header className="pane-heading">
        <span className={`pane-icon ${local ? "local" : "remote"}`}>{local ? <Monitor size={18} /> : <Server size={18} />}</span>
        <div className="pane-title"><h2>{local ? "本地文件" : "远程文件"}</h2><span>{local ? (preview ? "浏览器预览" : "本地工作区") : (profile?.name ?? "SFTP")}</span></div>
        <span className={`connection-state ${(local && !preview) || connected ? "available" : ""}`}><i />{local ? (preview ? "未接入" : "就绪") : connected ? "已连接" : connecting ? "连接中" : "未连接"}</span>
        {!local && connected && <IconButton label="断开服务器" onClick={onDisconnect}><Unplug size={16} /></IconButton>}
        {!local && profile && <IconButton label="连接操作" onClick={onMenu}><ChevronDown size={16} /></IconButton>}
      </header>
      <div className="pane-toolbar">
        <IconButton label={`${label}返回上级`} disabled={!navigable || !parent || loading}
          onClick={() => onNavigate?.(parent ?? null)}><ArrowUp size={17} /></IconButton>
        <form className="path-form" onSubmit={(event) => { event.preventDefault(); if (navigable) onNavigate?.(path); }}>
          <Folder size={15} />
          <input aria-label={`${label}路径`} value={local || connected ? path : (profile?.remotePath ?? "")}
            onChange={(event) => onPathChange?.(event.target.value)}
            placeholder={local ? (preview ? "桌面文件系统未连接" : "正在打开目录") : "尚未连接服务器"}
            disabled={!navigable} spellCheck={false} autoComplete="off" />
        </form>
        <IconButton label={`刷新${label}目录`} disabled={!navigable || loading} onClick={() => onNavigate?.(listing?.path ?? path)}>
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
        </IconButton>
        {local && <IconButton label="选择本地目录" onClick={onChooseDirectory} disabled={preview}><FolderOpen size={17} /></IconButton>}
      </div>
      <div className="pane-filter-row">
        <label className="search-field"><Search size={14} /><input aria-label={`筛选${label}文件`} value={query}
          onChange={(event) => setQuery(event.target.value)} placeholder="筛选文件" disabled={!listing} /></label>
        <IconButton label={showHidden ? "隐藏点文件" : "显示隐藏文件"} aria-pressed={showHidden} disabled={!listing}
          onClick={() => setShowHidden((value) => !value)}>{showHidden ? <Eye size={16} /> : <EyeOff size={16} />}</IconButton>
        <IconButton label={local ? "上传所选文件" : "下载所选文件"}
          disabled={!transferEnabled || preview || loading || !selectedEntries.length || selectedEntries.some((entry) => entry.isDir || entry.isSymlink)}
          onClick={() => onTransfer?.(selectedEntries)}>
          {local ? <ArrowUpFromLine size={16} /> : <ArrowDownToLine size={16} />}
        </IconButton>
      </div>
      <div className="file-list-container" ref={dropRef} aria-busy={loading || undefined}
        onDragEnter={(event) => { event.preventDefault(); }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = drag?.accepts(event.dataTransfer) ? "copy" : "none";
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          drag?.drop(event.dataTransfer);
        }}>
        <table className="file-table" aria-label={`${label}文件列表`}>
          <colgroup><col className="selection-column" /><col className="name-column" /><col className="size-column" /><col className="date-column" /></colgroup>
          <thead><tr><th className="selection-cell"><input type="checkbox" aria-label={`选择全部${label}文件`}
            disabled={!selectable.length} checked={selectable.length > 0 && selectable.every((entry) => selected.has(entry.path))}
            onChange={(event) => setSelected(new Set(event.target.checked ? selectable.map((entry) => entry.path) : []))} /></th>
            {([["name", "名称"], ["size", "大小"], ["modified", "修改时间"]] as const).map(([key, title]) =>
            <th key={key} className={`column-${key}`} aria-sort={sortKey === key ? (direction === "asc" ? "ascending" : "descending") : "none"}>
              <button type="button" onClick={() => sort(key)} disabled={!listing}>{title}{sortKey === key && (direction === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>
            </th>,
          )}</tr></thead>
          <tbody>{entries.map((entry, index) => (
            <tr key={entry.path} className={selected.has(entry.path) ? "selected" : ""} aria-selected={selected.has(entry.path)}
              draggable={canDrag(entry)}
              onDragStart={(event) => {
                if (!canDrag(entry)) {
                  event.preventDefault();
                  return;
                }
                const dragEntries = selected.has(entry.path) ? selectedEntries : [entry];
                if (!dragEntries.length || !dragEntries.every(isOrdinaryFile)) {
                  event.preventDefault();
                  return;
                }
                if (!drag?.begin(dragEntries, event.dataTransfer)) { event.preventDefault(); return; }
                if (!selected.has(entry.path)) {
                  anchor.current = entry.path;
                  setSelected(new Set([entry.path]));
                }
              }}
              onDragEnd={drag?.end}
              tabIndex={selected.has(entry.path) || (!selectedEntries.length && index === 0) ? 0 : -1}
              onClick={(event) => select(entry, event)} onDoubleClick={() => { if (entry.isDir) onNavigate?.(entry.path); }}
              onKeyDown={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                if (event.key === "Enter" && entry.isDir) onNavigate?.(entry.path);
                if (event.key === " " && !entry.isDir && !entry.isSymlink) { event.preventDefault(); toggleFile(entry); }
                if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault(); setSelected(new Set(selectable.map((item) => item.path)));
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
                  select(entries[next], { shiftKey: event.shiftKey });
                  const rows = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("tr");
                  rows?.[next]?.focus();
                }
              }}>
              <td className="selection-cell"><input type="checkbox" aria-label={`选择 ${entry.name}`}
                disabled={entry.isDir || entry.isSymlink} checked={selected.has(entry.path)}
                onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                onChange={() => toggleFile(entry)} /></td>
              <td><span className="entry-name" title={entry.name}><EntryIcon entry={entry} /><span>{entry.name}</span>{entry.isSymlink && <Link2 size={11} className="symlink-icon" />}{entry.isDir && <ChevronRight size={12} className="entry-chevron" />}</span></td>
              <td className="column-size">{entry.isDir ? "—" : formatBytes(entry.size)}</td>
              <td className="column-modified">{formatDate(entry.modifiedMs)}</td>
            </tr>
          ))}</tbody>
        </table>
        {loading ? <div className="pane-empty"><LoaderCircle size={25} className="spinning" /><p>正在读取目录</p></div>
          : error ? <div className="pane-empty error-empty"><Folder size={30} strokeWidth={1.3} /><p role="alert">{error}</p>
            <button type="button" className="button secondary small" aria-label={!local && !connected ? "连接服务器" : undefined}
              disabled={preview || connecting} onClick={() => !local && !connected ? onConnect?.() : onNavigate?.(path)}>
              <RefreshCw size={14} />{!local && !connected ? "重新连接" : "重试"}</button></div>
            : listing && entries.length === 0 ? <div className="pane-empty"><FolderOpen size={32} strokeWidth={1.2} /><p>{query ? "没有匹配的文件" : "此目录为空"}</p></div>
              : local && !listing ? <div className="pane-empty"><HardDrive size={33} strokeWidth={1.2} /><h3>{preview ? "桌面文件系统未连接" : "尚未打开目录"}</h3></div>
                : !local && !connected ? <div className="pane-empty remote-empty">
                  <div className="remote-empty-symbol"><Server size={33} strokeWidth={1.3} /><span><Unplug size={14} /></span></div>
                  <h3>{profile ? profile.name : "未连接远程服务器"}</h3>
                  <p className="remote-address">{profile ? `${profile.username}@${profile.host}:${profile.port}` : "暂无活动连接"}</p>
                  <div className="remote-empty-actions">
                    <button type="button" className={`button ${profile ? "primary" : "secondary"} small`}
                      disabled={Boolean(profile) && (preview || connecting)} onClick={profile ? onConnect : onNewProfile}>
                      {profile ? <PlugZap size={14} /> : <Plus size={15} />}{profile ? "连接服务器" : "添加连接"}
                    </button>
                    {profile && <IconButton label="编辑连接" onClick={onEditProfile} disabled={connecting}><Pencil size={15} /></IconButton>}
                  </div>
                </div> : null}
      </div>
      <footer className="pane-footer">
        <span>{listing ? `${entries.length} 个项目${selectedEntries.length ? ` · 已选择 ${selectedEntries.length} 项` : ""}` : "0 个项目"}</span>
        {listing?.warnings.length ? <span className="warning-count" title={listing.warnings.join("\n")}>{listing.warnings.length} 项读取警告</span>
          : <span>{local ? <><HardDrive size={12} />{preview ? "未接入" : "本地磁盘"}</> : <><Unplug size={12} />SFTP</>}</span>}
      </footer>
    </section>
  );
}
