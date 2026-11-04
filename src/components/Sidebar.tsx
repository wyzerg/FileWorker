import { Download, Folder, Home, LayoutGrid, Monitor, Plus, Server, ShieldCheck } from "lucide-react";
import type { ConnectionProfile, RuntimeEnvironment } from "../lib/types";
import { IconButton } from "./IconButton";

const shortcutIcons = { 主目录: Home, 桌面: Monitor, 下载: Download, 文稿: Folder };

export function Sidebar({ profiles, selectedId, onSelect, onNew, environment, localPath, onNavigate, loading, connectedId }: {
  profiles: ConnectionProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  environment: RuntimeEnvironment | null;
  localPath: string;
  onNavigate: (path: string) => void;
  loading: boolean;
  connectedId?: string;
}) {
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
          <IconButton label="新建连接" onClick={onNew} disabled={loading}><Plus size={16} /></IconButton>
        </div>
        {loading ? <p className="sidebar-empty">正在读取连接</p> : profiles.length === 0 ? (
          <div className="sidebar-no-connections">
            <div className="server-outline"><Server size={22} strokeWidth={1.5} /></div>
            <span>暂无已保存的连接</span>
          </div>
        ) : <nav aria-label="已保存连接" className="profile-list">
          {profiles.map((profile) => (
            <button type="button" key={profile.id} className={`profile-item ${selectedId === profile.id ? "active" : ""}`}
              aria-pressed={selectedId === profile.id} onClick={() => onSelect(profile.id)} title={`${profile.name}\n${profile.username}@${profile.host}:${profile.port}`}>
              <span className="profile-icon"><Server size={17} /></span>
              <span className="profile-description"><strong>{profile.name}</strong><span>{profile.host}</span></span>
              <span className={`connection-dot ${connectedId === profile.id ? "connected" : ""}`} title={connectedId === profile.id ? "已连接" : "未连接"} />
            </button>
          ))}
        </nav>}
      </div>
      <div className="sidebar-bottom">
        <span><ShieldCheck size={15} />仅保存在此设备</span>
        <div><span><LayoutGrid size={13} />FileWorker</span><span>0.1.0</span></div>
      </div>
    </aside>
  );
}
