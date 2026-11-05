import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Download, Ellipsis, Folder, FolderPlus, Home, LayoutGrid, Monitor, Pencil, Plus, Server, ShieldCheck, Trash2 } from "lucide-react";
import type { ConnectionGroup, ConnectionProfile, RuntimeEnvironment } from "../lib/types";
import { IconButton } from "./IconButton";
import "./connection-groups.css";

const shortcutIcons = { 主目录: Home, 桌面: Monitor, 下载: Download, 文稿: Folder };
const collapsedStorageKey = "fileworker.groups.collapsed.v1";
type ProfileMenuHandler = (profile: ConnectionProfile, anchor: { x: number; y: number }, trigger?: HTMLElement) => void;

function ProfileRow({ profile, selected, connected, onSelect, onProfileMenu }: {
  profile: ConnectionProfile;
  selected: boolean;
  connected: boolean;
  onSelect: (id: string) => void;
  onProfileMenu?: ProfileMenuHandler;
}) {
  const nameId = useId();

  function openAtButton(button: HTMLButtonElement) {
    const bounds = button.getBoundingClientRect();
    onProfileMenu?.(profile, { x: bounds.left, y: bounds.bottom }, button);
  }

  return (
    <div className="connection-profile-row"
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onProfileMenu?.(profile, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        event.stopPropagation();
        const button = (event.target as HTMLElement).closest("button");
        if (button) openAtButton(button);
      }}>
      <button type="button" className={`profile-item ${selected ? "active" : ""}`}
        aria-pressed={selected} onClick={() => onSelect(profile.id)} title={`${profile.name}\n${profile.username}@${profile.host}:${profile.port}`}>
        <span className="profile-icon"><Server size={17} /></span>
        <span className="profile-description"><strong id={nameId}>{profile.name}</strong><span>{profile.host}</span></span>
        <span className={`connection-dot ${connected ? "connected" : ""}`} title={connected ? "已连接" : "未连接"} />
      </button>
      <IconButton label="连接菜单" title={`${profile.name} 的连接菜单`} aria-describedby={nameId}
        aria-haspopup="menu" className="connection-profile-menu" disabled={!onProfileMenu}
        onClick={(event) => openAtButton(event.currentTarget)}><Ellipsis size={15} /></IconButton>
    </div>
  );
}

function GroupMenu({ group, open, onOpenChange, onNew, onEdit, onDelete }: {
  group: ConnectionGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNew: (groupId?: string | null) => void;
  onEdit?: (group: ConnectionGroup) => void;
  onDelete?: (group: ConnectionGroup) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(trigger.left, window.innerWidth - menu.width - 8)),
      top: Math.max(8, trigger.bottom + menu.height + 4 > window.innerHeight - 8
        ? trigger.top - menu.height - 4 : trigger.bottom + 4),
    });
    const items = menuRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (focusLast.current ? items[items.length - 1] : items[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: Event) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) onOpenChange(false);
    }
    function dismissOnMove() { onOpenChange(false); }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    window.addEventListener("resize", dismissOnMove);
    document.addEventListener("scroll", dismissOnMove, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      window.removeEventListener("resize", dismissOnMove);
      document.removeEventListener("scroll", dismissOnMove, true);
    };
  }, [open, onOpenChange]);

  function closeAndFocus() {
    triggerRef.current?.focus();
    onOpenChange(false);
  }

  return <>
    <IconButton label="分组菜单" title={`${group.name} 的分组菜单`} ref={triggerRef}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      className="connection-group-menu-trigger"
      onClick={() => { focusLast.current = false; onOpenChange(!open); }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        focusLast.current = event.key === "ArrowUp";
        onOpenChange(true);
      }}><Ellipsis size={15} /></IconButton>
    {open && createPortal(
      <div id={menuId} role="menu" aria-label={`${group.name} 分组菜单`} ref={menuRef}
        className="connection-group-menu" style={position}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeAndFocus();
          } else if (event.key === "Tab") {
            closeAndFocus();
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => { closeAndFocus(); onNew(group.id); }}>
          <Plus size={14} /><span>新建连接</span>
        </button>
        <button type="button" role="menuitem" tabIndex={-1} disabled={!onEdit} onClick={() => { closeAndFocus(); onEdit?.(group); }}>
          <Pencil size={14} /><span>编辑分组</span>
        </button>
        <button type="button" role="menuitem" tabIndex={-1} className="connection-group-delete" disabled={!onDelete}
          onClick={() => { closeAndFocus(); onDelete?.(group); }}>
          <Trash2 size={14} /><span>删除分组</span>
        </button>
      </div>, document.body,
    )}
  </>;
}

function readCollapsedGroups(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(collapsedStorageKey) ?? "[]");
    return Array.isArray(saved) && saved.every((id) => typeof id === "string") ? saved : [];
  } catch {
    return [];
  }
}

export function Sidebar({ profiles, selectedId, onSelect, onNew, environment, localPath, onNavigate, loading, connectedId, groups = [], onNewGroup, onEditGroup, onDeleteGroup, onProfileMenu }: {
  profiles: ConnectionProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: (groupId?: string | null) => void;
  environment: RuntimeEnvironment | null;
  localPath: string;
  onNavigate: (path: string) => void;
  loading: boolean;
  connectedId?: string;
  groups?: ConnectionGroup[];
  onNewGroup?: () => void;
  onEditGroup?: (group: ConnectionGroup) => void;
  onDeleteGroup?: (group: ConnectionGroup) => void;
  onProfileMenu?: ProfileMenuHandler;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsedGroups);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const groupListId = useId();
  const selectedProfile = profiles.find((profile) => profile.id === selectedId);
  const selectedGroupId = groups.find((group) => group.id === selectedProfile?.groupId)?.id;
  const previousSelection = useRef({ id: selectedId, groupId: selectedGroupId });
  const selectionRestored = useRef(!loading);

  useEffect(() => {
    if (loading) return;
    if (!selectionRestored.current) {
      selectionRestored.current = true;
      previousSelection.current = { id: selectedId, groupId: selectedGroupId };
      return;
    }
    if (previousSelection.current.id === selectedId && previousSelection.current.groupId === selectedGroupId) return;
    previousSelection.current = { id: selectedId, groupId: selectedGroupId };
    if (selectedGroupId) {
      setCollapsed((previous) => previous.includes(selectedGroupId)
        ? previous.filter((id) => id !== selectedGroupId) : previous);
    }
  }, [loading, selectedId, selectedGroupId]);

  useEffect(() => {
    try {
      localStorage.setItem(collapsedStorageKey, JSON.stringify(collapsed));
    } catch {
      // Folding remains available when the WebView denies storage.
    }
  }, [collapsed]);

  function toggleGroup(id: string) {
    setCollapsed((previous) => previous.includes(id)
      ? previous.filter((value) => value !== id) : [...previous, id]);
  }

  function renderProfile(profile: ConnectionProfile) {
    return (
      <ProfileRow key={profile.id} profile={profile} selected={selectedId === profile.id} connected={connectedId === profile.id}
        onSelect={onSelect} onProfileMenu={onProfileMenu} />
    );
  }

  const ungroupedProfiles = profiles.filter((profile) => !groups.some((group) => group.id === profile.groupId));

  return (
    <aside className="sidebar" aria-label="位置和连接">
      <div className="sidebar-section local-section">
        <h2>本地位置</h2>
        <nav aria-label="本地位置">
          {(environment?.shortcuts.length ? environment.shortcuts : [
            { name: "主目录", path: "" }, { name: "桌面", path: "" },
            { name: "下载", path: "" }, { name: "文稿", path: "" },
          ]).map((shortcut) => {
            const Icon = shortcutIcons[shortcut.name as keyof typeof shortcutIcons] ?? Folder;
            return (
              <button type="button" key={shortcut.name} className={`sidebar-item ${localPath === shortcut.path && shortcut.path ? "active" : ""}`}
                onClick={() => onNavigate(shortcut.path)} disabled={!shortcut.path}
                title={shortcut.path || shortcut.name}>
                <Icon size={17} /><span>{shortcut.name}</span>
              </button>
            );
          })}
        </nav>
      </div>
      <div className="sidebar-section connections-section">
        <div className="sidebar-section-title"><h2>我的连接</h2><span>{profiles.length}</span>
          <div className="connection-section-actions">
            <IconButton label="新建分组" onClick={onNewGroup} disabled={loading || !onNewGroup}><FolderPlus size={16} /></IconButton>
            <IconButton label="新建连接" onClick={() => onNew()} disabled={loading}><Plus size={16} /></IconButton>
          </div>
        </div>
        {loading ? <p className="sidebar-empty">正在读取连接</p> : profiles.length === 0 && groups.length === 0 ? (
          <div className="sidebar-no-connections">
            <div className="server-outline"><Server size={22} strokeWidth={1.5} /></div>
            <span>暂无已保存的连接</span>
          </div>
        ) : <nav aria-label="已保存连接" className="profile-list">
          {groups.length === 0 ? profiles.map(renderProfile) : <>
            {groups.map((group, index) => {
              const members = profiles.filter((profile) => profile.groupId === group.id);
              const expanded = !collapsed.includes(group.id);
              const contentsId = `${groupListId}-${index}`;
              const Chevron = expanded ? ChevronDown : ChevronRight;
              return (
                <div role="group" aria-label={group.name} className="connection-group" key={group.id}>
                  <div className="connection-group-header">
                    <button type="button" className="connection-group-toggle" aria-label={`${group.name} ${members.length}`} aria-expanded={expanded}
                      aria-controls={contentsId} onClick={() => toggleGroup(group.id)} title={group.name}>
                      <Chevron size={14} /><Folder size={14} /><span className="connection-group-name">{group.name}</span>
                      <span className="connection-group-count">{members.length}</span>
                    </button>
                    <GroupMenu group={group} open={groupMenuId === group.id} onOpenChange={(open) => setGroupMenuId(open ? group.id : null)}
                      onNew={onNew} onEdit={onEditGroup} onDelete={onDeleteGroup} />
                  </div>
                  <div id={contentsId} className="connection-group-members">{expanded && members.map(renderProfile)}</div>
                </div>
              );
            })}
            <div role="group" aria-label="未分组" className="connection-group">
              <div className="connection-ungrouped-title">未分组 <span className="connection-group-count">{ungroupedProfiles.length}</span></div>
              {ungroupedProfiles.map(renderProfile)}
            </div>
          </>}
        </nav>}
      </div>
      <div className="sidebar-bottom">
        <span><ShieldCheck size={15} />仅保存在此设备</span>
        <div><span><LayoutGrid size={13} />FileWorker</span><span>0.1.0</span></div>
      </div>
    </aside>
  );
}
