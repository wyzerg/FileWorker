import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, CircleCheck, Copy, KeyRound, LoaderCircle, MoreHorizontal, PanelLeft, Pencil, PlugZap, Plus, Trash2, Unplug, X } from "lucide-react";
import { api, errorMessage, isDesktop } from "./lib/api";
import type { ConnectionProfile, DirectoryListing, RuntimeEnvironment } from "./lib/types";
import { Dialog } from "./components/Dialog";
import { FilePane } from "./components/FilePane";
import { IconButton } from "./components/IconButton";
import { ProfileDialog } from "./components/ProfileDialog";
import { Sidebar } from "./components/Sidebar";
import { ThemeMenu } from "./components/ThemeMenu";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { useRemoteConnection } from "./lib/useRemoteConnection";
import { useTransfers } from "./lib/useTransfers";
import { TransferQueue } from "./components/TransferQueue";
import { formatBytes } from "./lib/files";

export default function App() {
  const [environment, setEnvironment] = useState<RuntimeEnvironment | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ profile: ConnectionProfile | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activePane, setActivePane] = useState("local");
  const requestId = useRef(0);
  const completedTargets = useRef({ local: new Set<string>(), remote: new Set<string>() });
  const menu = useRef<HTMLDivElement>(null);
  const selectedProfile = profiles.find((profile) => profile.id === selectedId) ?? null;
  const remote = useRemoteConnection(selectedProfile, setNotice);

  const navigate = useCallback(async (nextPath: string | null) => {
    const current = ++requestId.current;
    setLoading(true); setDirectoryError(""); setListing(null);
    if (nextPath !== null) setPath(nextPath);
    try {
      const result = await api.listDirectory(nextPath);
      if (current !== requestId.current) return;
      setListing(result); setPath(result.path);
    } catch (cause) {
      if (current === requestId.current) setDirectoryError(errorMessage(cause));
    } finally {
      if (current === requestId.current) setLoading(false);
    }
  }, []);

  const transfers = useTransfers((job) => {
    const destination = job.destinationPath;
    const parent = destination ? destination.slice(0, destination.lastIndexOf("/")) || "/" : job.destinationDir;
    if (job.direction === "download") completedTargets.current.local.add(parent);
    else completedTargets.current.remote.add(JSON.stringify([job.sessionId, parent]));
  }, setNotice);
  useEffect(() => {
    if (!loading) {
      const refresh = listing && path === listing.path && completedTargets.current.local.has(listing.path);
      completedTargets.current.local.clear();
      if (refresh) void navigate(listing.path);
    }
    if (!remote.loading) {
      const refresh = remote.listing && remote.path === remote.listing.path && remote.session
        && completedTargets.current.remote.has(JSON.stringify([remote.session.sessionId, remote.listing.path]));
      completedTargets.current.remote.clear();
      if (refresh) void remote.navigate(remote.listing!.path);
    }
  }, [transfers.snapshot.revision, loading, listing, path, navigate, remote.loading, remote.listing, remote.path, remote.session, remote.navigate]);
  const transferReady = isDesktop && Boolean(remote.session && remote.listing && listing)
    && !remote.loading && !loading && !transfers.submitting;
  const rates = transfers.snapshot.jobs.reduce((value, job) => {
    if (job.state === "running") value[job.direction] += job.bytesPerSecond;
    return value;
  }, { upload: 0, download: 0 });

  useEffect(() => {
    let active = true;
    const initialRequest = requestId.current;
    api.getEnvironment().then((result) => {
      if (!active) return;
      setEnvironment(result);
      if (result.runtime === "desktop" && requestId.current === initialRequest) void navigate(null);
    }).catch((cause) => { if (active) setNotice(errorMessage(cause)); });
    api.listProfiles().then((result) => {
      if (!active) return;
      setProfiles(result);
      setSelectedId((id) => id ?? result[0]?.id ?? null);
    }).catch((cause) => { if (active) setNotice(errorMessage(cause)); })
      .finally(() => { if (active) setProfilesLoading(false); });
    return () => { active = false; requestId.current += 1; };
  }, [navigate]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const newProfile = () => {
    if (!profilesLoading) { setNotice(""); setEditor({ profile: null }); }
  };
  async function saveProfile(profile: ConnectionProfile) {
    const saved = await api.saveProfile(profile);
    setProfiles((previous) => {
      const index = previous.findIndex((item) => item.id === saved.id);
      return index === -1 ? [...previous, saved] : previous.map((item) => item.id === saved.id ? saved : item);
    });
    setSelectedId(saved.id); setNotice("");
  }
  async function duplicateProfile() {
    if (!selectedProfile || mutationBusy) return;
    setMenuOpen(false); setMutationBusy(true);
    try {
      await saveProfile({ ...selectedProfile, id: crypto.randomUUID(), name: `${selectedProfile.name} 副本` });
    } catch (cause) { setNotice(errorMessage(cause)); }
    finally { setMutationBusy(false); }
  }
  async function deleteProfile() {
    if (!deleteTarget || mutationBusy) return;
    setMutationBusy(true);
    try {
      await api.deleteProfile(deleteTarget.id);
      const remaining = profiles.filter((profile) => profile.id !== deleteTarget.id);
      setProfiles(remaining);
      if (selectedId === deleteTarget.id) setSelectedId(remaining[0]?.id ?? null);
      setDeleteTarget(null); setNotice("");
    } catch (cause) { setNotice(errorMessage(cause)); }
    finally { setMutationBusy(false); }
  }

  return (
    <div className={`app-shell ${isDesktop ? "desktop-runtime" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`} data-active-pane={activePane}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><img src="/fileworker.svg" alt="" width={26} height={26} /><h1>FileWorker</h1></div>
        <span className="titlebar-divider" />
        <span className="workspace-title" data-tauri-drag-region>文件工作区</span>
        <div className="titlebar-actions">
          <span className={`runtime-label ${isDesktop ? "desktop" : ""}`}><span />{isDesktop ? "本地工作区" : "浏览器预览"}</span>
          <ThemeMenu onError={setNotice} />
          <IconButton label="切换侧栏" onClick={() => {
            if (window.innerWidth <= 760) setMobileSidebarOpen((value) => !value);
            else setSidebarCollapsed((value) => !value);
          }}><PanelLeft size={18} /></IconButton>
        </div>
      </header>
      <div className="workspace-body">
        {mobileSidebarOpen && <button type="button" className="sidebar-scrim" aria-label="关闭侧栏" onClick={() => setMobileSidebarOpen(false)} />}
        <Sidebar profiles={profiles} selectedId={selectedId} environment={environment} loading={profilesLoading} connectedId={remote.session?.profileId}
          localPath={listing?.path ?? ""} onNew={newProfile}
          onSelect={(id) => { setSelectedId(id); setMobileSidebarOpen(false); setActivePane("remote"); }}
          onNavigate={(nextPath) => { setMobileSidebarOpen(false); setActivePane("local"); void navigate(nextPath); }} />
        <main className="workspace-main">
          <div className="workspace-toolbar">
            <div className="workspace-heading"><ArrowRightLeft size={17} /><span>文件管理</span></div>
            <div className="mobile-pane-switch" role="tablist" aria-label="文件位置">
              <button type="button" role="tab" aria-selected={activePane === "local"} onClick={() => setActivePane("local")}>本地</button>
              <button type="button" role="tab" aria-selected={activePane === "remote"} onClick={() => setActivePane("remote")}>远程</button>
            </div>
            <div className="workspace-tools">
              <button type="button" className="button primary compact" onClick={newProfile} disabled={profilesLoading} aria-label="添加 SFTP 连接"><Plus size={15} /><span>新建连接</span></button>
              <div className="connection-menu-anchor" ref={menu}>
                <IconButton label="管理当前连接" disabled={!selectedProfile || mutationBusy} aria-haspopup="menu" aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={18} /></IconButton>
                {menuOpen && selectedProfile && <div className="action-menu" role="menu" aria-label="连接操作">
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setEditor({ profile: selectedProfile }); }}><Pencil size={15} />编辑连接</button>
                  <button type="button" role="menuitem" onClick={() => { void duplicateProfile(); }}><Copy size={15} />复制连接</button>
                  <button type="button" role="menuitem" disabled={!isDesktop} onClick={() => {
                    setMenuOpen(false);
                    void api.forgetCredential(selectedProfile.id)
                      .then(() => setNotice("已移除此连接的已存凭据"))
                      .catch((cause) => setNotice(errorMessage(cause)));
                  }}><KeyRound size={15} />忘记已存凭据</button>
                  <div className="menu-divider" />
                  <button type="button" role="menuitem" className="danger-text" onClick={() => { setMenuOpen(false); setDeleteTarget(selectedProfile); }}><Trash2 size={15} />删除连接</button>
                </div>}
              </div>
            </div>
          </div>
          {notice && <div className="notice" role="alert"><span>{notice}</span><IconButton label="关闭提示" onClick={() => setNotice("")}><X size={15} /></IconButton></div>}
          <div className="panes">
            <FilePane side="local" listing={listing} path={path} onPathChange={setPath} onNavigate={(nextPath) => { void navigate(nextPath); }}
              transferEnabled={transferReady} onTransfer={(entries) => {
                if (!remote.session || !remote.listing) return;
                void transfers.enqueue(entries.map((entry) => ({
                  sessionId: remote.session!.sessionId, direction: "upload", sourcePath: entry.path, destinationDir: remote.listing!.path,
                })));
              }}
              loading={loading} error={directoryError} preview={!isDesktop} onChooseDirectory={async () => {
                try { const nextPath = await api.chooseDirectory(); if (nextPath) void navigate(nextPath); }
                catch (cause) { setNotice(errorMessage(cause)); }
              }} />
            <FilePane side="remote" path={remote.path} parentPath={remote.parentPath} listing={remote.listing} profile={selectedProfile} onNewProfile={newProfile}
              loading={remote.loading} error={remote.error} preview={!isDesktop}
              connected={Boolean(remote.session)} connecting={Boolean(remote.attempt)}
              onConnect={() => { void remote.connect(); }} onDisconnect={remote.cancel}
              onPathChange={remote.setPath} onNavigate={(nextPath) => { if (nextPath !== null) void remote.navigate(nextPath); }}
              onEditProfile={() => { if (selectedProfile) setEditor({ profile: selectedProfile }); }}
              transferEnabled={transferReady} onTransfer={(entries) => {
                if (!remote.session || !listing) return;
                void transfers.enqueue(entries.map((entry) => ({
                  sessionId: remote.session!.sessionId, direction: "download", sourcePath: entry.path, destinationDir: listing.path,
                })));
              }}
              onMenu={() => setMenuOpen((value) => !value)} />
          </div>
          <TransferQueue snapshot={transfers.snapshot} sessionId={remote.session?.sessionId ?? null}
            onCancel={(id) => { void transfers.cancel(id); }} onRetry={(id) => { void transfers.retry(id); }}
            onResolve={(id, policy) => { void transfers.resolve(id, policy); }}
            onConcurrency={(value) => { void transfers.concurrency(value); }} onClear={() => { void transfers.clear(); }} />
        </main>
      </div>
      <footer className="app-statusbar">
        <span className="status-left">{loading ? <LoaderCircle size={12} className="spinning" /> : <CircleCheck size={12} />}<span>{loading ? "正在读取目录" : isDesktop ? "本地文件可用" : "浏览器预览"}</span></span>
        <span className="status-connection">{remote.session ? <PlugZap size={12} /> : <Unplug size={12} />}{selectedProfile ? `${selectedProfile.host} · ${remote.session ? "已连接" : remote.attempt ? "连接中" : "未连接"}` : "未连接服务器"}</span>
        <div className="status-rates"><span><ArrowUpFromLine size={11} />{formatBytes(rates.upload)}/s</span><span><ArrowDownToLine size={11} />{formatBytes(rates.download)}/s</span></div>
      </footer>
      {editor && <ProfileDialog profile={editor.profile} onSave={saveProfile} onClose={() => setEditor(null)} />}
      {remote.attempt && <ConnectionDialog key={remote.attempt.id} attempt={remote.attempt} working={remote.working}
        error={remote.dialogError} onCancel={remote.cancel} onTrust={remote.trust} onAuthenticate={remote.authenticate} />}
      {deleteTarget && <Dialog title="删除连接" onClose={() => setDeleteTarget(null)} busy={mutationBusy} className="confirm-dialog">
        <div className="dialog-body"><p className="confirm-message">删除「{deleteTarget.name}」？</p><p className="muted">服务器上的文件不会受到影响。</p></div>
        <footer className="dialog-footer"><button type="button" className="button secondary" disabled={mutationBusy} onClick={() => setDeleteTarget(null)}>取消</button>
          <button type="button" className="button danger" disabled={mutationBusy} onClick={() => { void deleteProfile(); }}><Trash2 size={15} />{mutationBusy ? "正在删除" : "删除连接"}</button>
        </footer>
      </Dialog>}
    </div>
  );
}
