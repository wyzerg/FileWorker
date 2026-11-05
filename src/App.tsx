import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine, CircleCheck, LoaderCircle, MoreHorizontal, PanelLeft, PlugZap, Plus, Trash2, Unplug, X } from "lucide-react";
import { api, errorMessage, isDesktop } from "./lib/api";
import type { AuthenticationInput, ConnectionGroup, ConnectionProfile, DirectoryListing, RuntimeEnvironment } from "./lib/types";
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
import { useTransferDrag } from "./lib/useTransferDrag";
import { useFinderDrop } from "./lib/useFinderDrop";
import { GroupDialog } from "./components/GroupDialog";
import { ProfileMenu } from "./components/ProfileMenu";
import { credentialIdentity } from "./lib/useAuthentication";

export default function App() {
  const [environment, setEnvironment] = useState<RuntimeEnvironment | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ profile: ConnectionProfile | null; groupId?: string | null } | null>(null);
  const [groupEditor, setGroupEditor] = useState<{ group: ConnectionGroup | null } | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<ConnectionGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionProfile | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [profileMenu, setProfileMenu] = useState<{ profile: ConnectionProfile; anchor: { x: number; y: number }; trigger?: HTMLElement | null } | null>(null);
  const [connectionRequest, setConnectionRequest] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activePane, setActivePane] = useState("local");
  const requestId = useRef(0);
  const completedTargets = useRef({ local: new Set<string>(), remote: new Set<string>() });
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pendingConnection = useRef<{ id: string; input?: AuthenticationInput } | null>(null);
  const selectedProfile = profiles.find((profile) => profile.id === selectedId) ?? null;
  const remote = useRemoteConnection(selectedProfile, setNotice);
  useEffect(() => {
    const pending = pendingConnection.current;
    if (!pending || editor || selectedProfile?.id !== pending.id) return;
    pendingConnection.current = null;
    void remote.connect(pending.input);
  }, [connectionRequest, selectedProfile, editor]);

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
  const drag = useTransferDrag({
    enabled: transferReady, sessionId: remote.session?.sessionId ?? null,
    local: listing, remote: remote.listing, onTransfer: (requests) => { void transfers.enqueue(requests); },
  });
  const finderDrop = useFinderDrop({
    available: isDesktop && environment?.finderDrop === true,
    enabled: transferReady && !editor && !groupEditor && !deleteTarget && !deleteGroupTarget && !remote.attempt,
    sessionId: remote.session?.sessionId ?? null, local: listing, remote: remote.listing,
    onUpload: (paths, sessionId, destinationDir) => { void transfers.enqueueFinder(paths, sessionId, destinationDir); },
    onInternalDragClear: drag.clear, onNotice: setNotice,
  });
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
    Promise.all([api.listProfiles(), api.listGroups()]).then(([result, connectionGroups]) => {
      if (!active) return;
      setProfiles(result); setGroups(connectionGroups);
      setSelectedId((id) => id ?? result[0]?.id ?? null);
    }).catch((cause) => { if (active) setNotice(errorMessage(cause)); })
      .finally(() => { if (active) setProfilesLoading(false); });
    return () => { active = false; requestId.current += 1; };
  }, [navigate]);

  const newProfile = (groupId?: string | null) => {
    if (!profilesLoading) { setNotice(""); setProfileMenu(null); setEditor({ profile: null, groupId }); }
  };
  const hasActiveTransfers = Boolean(remote.session && transfers.snapshot.jobs.some((job) =>
    job.sessionId === remote.session!.sessionId && ["queued", "running", "canceling", "conflict"].includes(job.state)));
  const transferWarning = "当前连接仍有未结束的传输，请先完成或取消任务，再断开或切换连接";
  function selectProfile(id: string) {
    if (id !== selectedId && hasActiveTransfers) { setNotice(transferWarning); return; }
    setSelectedId(id); setMobileSidebarOpen(false); setActivePane("remote");
  }
  function requestConnect(id: string, input?: AuthenticationInput) {
    if (hasActiveTransfers) { setNotice(transferWarning); return; }
    remote.cancel();
    pendingConnection.current = { id, input };
    setSelectedId(id); setConnectionRequest((value) => value + 1);
    setActivePane("remote"); setMobileSidebarOpen(false);
  }
  async function saveProfile(profile: ConnectionProfile, input?: AuthenticationInput, connect = false) {
    const changesActiveIdentity = selectedProfile?.id === profile.id && credentialIdentity(selectedProfile) !== credentialIdentity(profile);
    if (hasActiveTransfers && (connect || changesActiveIdentity)) throw new Error(transferWarning);
    const saved = await api.saveProfile(profile);
    setProfiles((previous) => {
      const index = previous.findIndex((item) => item.id === saved.id);
      return index === -1 ? [...previous, saved] : previous.map((item) => item.id === saved.id ? saved : item);
    });
    if (connect && isDesktop) requestConnect(saved.id, input);
    else if (!remote.session && !remote.attempt) setSelectedId(saved.id);
    setNotice(connect && !isDesktop ? "配置已保存；连接服务器请使用桌面应用" : "连接配置已保存");
  }
  async function duplicateProfile(profile: ConnectionProfile) {
    if (mutationBusy) return;
    setMutationBusy(true);
    try {
      await saveProfile({ ...profile, id: crypto.randomUUID(), name: `${profile.name} 副本` });
    } catch (cause) { setNotice(errorMessage(cause)); }
    finally { setMutationBusy(false); }
  }
  async function deleteProfile() {
    if (!deleteTarget || mutationBusy) return;
    if (deleteTarget.id === remote.session?.profileId && hasActiveTransfers) { setMutationError(transferWarning); return; }
    setMutationBusy(true); setMutationError("");
    try {
      await api.deleteProfile(deleteTarget.id);
      const remaining = profiles.filter((profile) => profile.id !== deleteTarget.id);
      setProfiles(remaining);
      if (selectedId === deleteTarget.id) setSelectedId(remaining[0]?.id ?? null);
      setDeleteTarget(null); setNotice("");
    } catch (cause) { setMutationError(errorMessage(cause)); }
    finally { setMutationBusy(false); }
  }
  async function saveGroup(group: ConnectionGroup) {
    const saved = await api.saveGroup(group);
    setGroups((previous) => previous.some((item) => item.id === saved.id)
      ? previous.map((item) => item.id === saved.id ? saved : item) : [...previous, saved]);
  }
  async function deleteGroup() {
    if (!deleteGroupTarget || mutationBusy) return;
    setMutationBusy(true); setMutationError("");
    try {
      const id = deleteGroupTarget.id;
      await api.deleteGroup(id);
      setGroups((previous) => previous.filter((item) => item.id !== id));
      setProfiles((previous) => previous.map((profile) => profile.groupId === id ? { ...profile, groupId: null } : profile));
      setDeleteGroupTarget(null);
    } catch (cause) { setMutationError(errorMessage(cause)); }
    finally { setMutationBusy(false); }
  }
  const closeProfileMenu = useCallback(() => setProfileMenu(null), []);
  function openCurrentMenu() {
    if (!selectedProfile) return;
    if (profileMenu) { setProfileMenu(null); return; }
    const bounds = menuTrigger.current?.getBoundingClientRect();
    setProfileMenu({ profile: selectedProfile, anchor: { x: bounds?.left ?? 16, y: bounds?.bottom ?? 100 }, trigger: menuTrigger.current });
  }

  return (
    <div className={`app-shell ${isDesktop ? "desktop-runtime" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileSidebarOpen ? "mobile-sidebar-open" : ""}`} data-active-pane={activePane}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "none"; }}
      onDrop={(event) => {
        event.preventDefault();
        drag.clear();
      }}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region><img data-tauri-drag-region src="/fileworker.svg" alt="" width={26} height={26} draggable={false} /><h1 data-tauri-drag-region>FileWorker</h1></div>
        <span className="titlebar-divider" data-tauri-drag-region />
        <span className="workspace-title" data-tauri-drag-region>文件工作区</span>
        <div className="titlebar-actions" data-tauri-drag-region>
          <span className={`runtime-label ${isDesktop ? "desktop" : ""}`} data-tauri-drag-region><span data-tauri-drag-region />{isDesktop ? "本地工作区" : "浏览器预览"}</span>
          <ThemeMenu onError={setNotice} />
          <IconButton label="切换侧栏" onClick={() => {
            if (window.innerWidth <= 760) setMobileSidebarOpen((value) => !value);
            else setSidebarCollapsed((value) => !value);
          }}><PanelLeft size={18} /></IconButton>
        </div>
      </header>
      <div className="workspace-body">
        {mobileSidebarOpen && <button type="button" className="sidebar-scrim" aria-label="关闭侧栏" onClick={() => setMobileSidebarOpen(false)} />}
        <Sidebar profiles={profiles} groups={groups} selectedId={selectedId} environment={environment} loading={profilesLoading} connectedId={remote.session?.profileId}
          localPath={listing?.path ?? ""} onNew={newProfile}
          onNewGroup={() => setGroupEditor({ group: null })} onEditGroup={(group) => setGroupEditor({ group })}
          onDeleteGroup={(group) => { setMutationError(""); setDeleteGroupTarget(group); }}
          onProfileMenu={(profile, anchor, trigger) => setProfileMenu((previous) =>
            trigger && previous?.trigger === trigger ? null : { profile, anchor, trigger })}
          onSelect={selectProfile}
          onNavigate={(nextPath) => { setMobileSidebarOpen(false); setActivePane("local"); void navigate(nextPath); }} />
        <main className="workspace-main">
          <div className="workspace-toolbar">
            <div className="workspace-heading"><ArrowRightLeft size={17} /><span>文件管理</span></div>
            <div className="mobile-pane-switch" role="tablist" aria-label="文件位置">
              <button type="button" role="tab" aria-selected={activePane === "local"} onClick={() => setActivePane("local")}>本地</button>
              <button type="button" role="tab" aria-selected={activePane === "remote"} onClick={() => setActivePane("remote")}>远程</button>
            </div>
            <div className="workspace-tools">
              <button type="button" className="button primary compact" onClick={() => newProfile()} disabled={profilesLoading} aria-label="添加 SFTP 连接"><Plus size={15} /><span>新建连接</span></button>
              <IconButton label="管理当前连接" ref={menuTrigger} disabled={!selectedProfile || mutationBusy} aria-haspopup="menu" aria-expanded={Boolean(profileMenu)}
                onClick={openCurrentMenu}><MoreHorizontal size={18} /></IconButton>
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
              drag={drag.pane("local")}
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
              drag={drag.pane("remote")}
              externalDropTarget={finderDrop.target} dropRef={finderDrop.dropRef}
              onMenu={openCurrentMenu} />
          </div>
          <TransferQueue snapshot={transfers.snapshot} sessionId={remote.session?.sessionId ?? null}
            dialogBlocked={Boolean(editor || groupEditor || deleteTarget || deleteGroupTarget || remote.attempt)}
            onCancel={(id) => { void transfers.cancel(id); }} onRetry={(id) => { void transfers.retry(id); }}
            onResolve={transfers.resolve}
            onConcurrency={(value) => { void transfers.concurrency(value); }} onClear={() => { void transfers.clear(); }} />
        </main>
      </div>
      <footer className="app-statusbar">
        <span className="status-left">{loading ? <LoaderCircle size={12} className="spinning" /> : <CircleCheck size={12} />}<span>{loading ? "正在读取目录" : isDesktop ? "本地文件可用" : "浏览器预览"}</span></span>
        <span className="status-connection">{remote.session ? <PlugZap size={12} /> : <Unplug size={12} />}{selectedProfile ? `${selectedProfile.host} · ${remote.session ? "已连接" : remote.attempt ? "连接中" : "未连接"}` : "未连接服务器"}</span>
        <div className="status-rates"><span><ArrowUpFromLine size={11} />{formatBytes(rates.upload)}/s</span><span><ArrowDownToLine size={11} />{formatBytes(rates.download)}/s</span></div>
      </footer>
      {profileMenu && <ProfileMenu profile={profileMenu.profile} anchor={profileMenu.anchor} trigger={profileMenu.trigger} busy={mutationBusy} desktop={isDesktop}
        onClose={closeProfileMenu} onConnect={() => requestConnect(profileMenu.profile.id)}
        onEdit={() => setEditor({ profile: profileMenu.profile })}
        onDuplicate={() => { void duplicateProfile(profileMenu.profile); }}
        onForget={() => { void api.forgetCredential(profileMenu.profile.id).then(() => setNotice("已移除此连接的已存凭据")).catch((cause) => setNotice(errorMessage(cause))); }}
        onDelete={() => { setMutationError(""); setDeleteTarget(profileMenu.profile); }} />}
      {editor && <ProfileDialog profile={editor.profile} groups={groups} initialGroupId={editor.groupId} credentialStorage={environment?.credentialStorage}
        onSave={saveProfile} onClose={() => setEditor(null)} />}
      {groupEditor && <GroupDialog group={groupEditor.group} onSave={saveGroup} onClose={() => setGroupEditor(null)} />}
      {remote.attempt && <ConnectionDialog key={remote.attempt.id} attempt={remote.attempt} working={remote.working}
        error={remote.dialogError} initialInput={remote.initialInput} onCancel={remote.cancel} onTrust={remote.trust} onAuthenticate={remote.authenticate} />}
      {deleteTarget && <Dialog title="删除连接" onClose={() => setDeleteTarget(null)} busy={mutationBusy} className="confirm-dialog">
        <div className="dialog-body"><p className="confirm-message">删除「{deleteTarget.name}」？</p><p className="muted">同时移除此连接的已存凭据，服务器上的文件不会受到影响。</p>
          {mutationError && <p className="form-error" role="alert">{mutationError}</p>}</div>
        <footer className="dialog-footer"><button type="button" className="button secondary" disabled={mutationBusy} onClick={() => setDeleteTarget(null)}>取消</button>
          <button type="button" className="button danger" disabled={mutationBusy} onClick={() => { void deleteProfile(); }}><Trash2 size={15} />{mutationBusy ? "正在删除" : "删除连接"}</button>
        </footer>
      </Dialog>}
      {deleteGroupTarget && <Dialog title="删除分组" onClose={() => setDeleteGroupTarget(null)} busy={mutationBusy} className="confirm-dialog">
        <div className="dialog-body"><p className="confirm-message">删除「{deleteGroupTarget.name}」？</p>
          <p className="muted">组内连接会移到未分组，不会删除连接、已存凭据或服务器文件。</p>
          {mutationError && <p className="form-error" role="alert">{mutationError}</p>}</div>
        <footer className="dialog-footer"><button type="button" className="button secondary" disabled={mutationBusy} onClick={() => setDeleteGroupTarget(null)}>取消</button>
          <button type="button" className="button danger" disabled={mutationBusy} onClick={() => { void deleteGroup(); }}><Trash2 size={15} />删除分组</button></footer>
      </Dialog>}
    </div>
  );
}
