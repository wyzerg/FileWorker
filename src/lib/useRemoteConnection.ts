import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorCode, errorMessage, isDesktop } from "./api";
import type { AuthenticationInput, ConnectedSession, ConnectionAttempt, ConnectionProfile, DirectoryListing } from "./types";
import { credentialIdentity } from "./useAuthentication";
import { readRemoteLocation, rememberRemoteLocation } from "./remoteLocations";

interface Workspace {
  profile: ConnectionProfile;
  identity: string;
  session: ConnectedSession | null;
  listing: DirectoryListing | null;
  path: string;
  parentPath: string | null;
  error: string;
  loading: boolean;
  acceptedPath: string;
  history: { paths: string[]; index: number };
  request: number;
}

function workspace(profile: ConnectionProfile): Workspace {
  return {
    profile, identity: credentialIdentity(profile), session: null, listing: null, path: "", parentPath: null,
    error: "", loading: false, acceptedPath: "/", history: { paths: [], index: -1 }, request: 0,
  };
}

function isSessionFailure(cause: unknown): boolean {
  const code = errorCode(cause);
  return code === "connection_lost" || code === "session_closed";
}

export function useRemoteConnection(
  profile: ConnectionProfile | null, onNotice: (message: string) => void, profiles?: readonly ConnectionProfile[],
) {
  const [attempt, setAttempt] = useState<ConnectionAttempt | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [working, setWorking] = useState(false);
  const [initialInput, setInitialInput] = useState<AuthenticationInput | undefined>();
  const [revision, setRevision] = useState(0);
  const workspaces = useRef(new Map<string, Workspace>());
  const selected = useRef<Workspace | null>(null);
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const mounted = useRef(false);
  const operation = useRef<string | null>(null);
  const automatic = useRef<{ attemptId: string; input?: AuthenticationInput } | null>(null);
  const notice = useRef(onNotice); notice.current = onNotice;
  const update = useCallback(() => { if (mounted.current) setRevision((value) => value + 1); }, []);

  const cancelAttempt = useCallback(() => {
    const old = attemptRef.current; attemptRef.current = null;
    automatic.current = null; operation.current = null;
    if (old) void api.cancelConnection(old.id).catch(() => {});
    if (mounted.current) {
      setAttempt(null); setDialogError(""); setWorking(false); setInitialInput(undefined);
    }
  }, []);

  const release = useCallback((view: Workspace) => {
    const old = view.session;
    const request = view.request + 1;
    Object.assign(view, workspace(view.profile), { request });
    if (old) void api.disconnectSession(old.sessionId).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAttempt();
      for (const view of workspaces.current.values()) release(view);
      workspaces.current.clear(); selected.current = null;
    };
  }, [cancelAttempt, release]);

  // Selection owns the visible workspace, never the lifetime of another session.
  useLayoutEffect(() => {
    let changed = false;
    if (attemptRef.current && (!profile || credentialIdentity(attemptRef.current.profile) !== credentialIdentity(profile))) {
      cancelAttempt();
    }
    const known = profiles ?? (profile ? [profile] : []);
    for (const [id, view] of workspaces.current) {
      const saved = known.find((item) => item.id === id);
      if ((profiles && !saved) || (saved && credentialIdentity(saved) !== view.identity)) {
        if (attemptRef.current?.profile.id === id) cancelAttempt();
        release(view); workspaces.current.delete(id); changed = true;
      } else if (saved) view.profile = saved;
    }
    let next: Workspace | null = null;
    if (profile) {
      next = workspaces.current.get(profile.id) ?? workspace(profile);
      if (!workspaces.current.has(profile.id)) {
        workspaces.current.set(profile.id, next); changed = true;
      }
    }
    if (selected.current !== next) { selected.current = next; changed = true; }
    if (changed) update();
  }, [profile, profiles, cancelAttempt, release, update]);

  const isCurrentSession = useCallback((view: Workspace, active: ConnectedSession) =>
    mounted.current && workspaces.current.get(view.profile.id) === view && view.session === active, []);
  const invalidateSession = useCallback((view: Workspace, active: ConnectedSession, cause: unknown) => {
    if (!isSessionFailure(cause) || !isCurrentSession(view, active)) return;
    view.request += 1;
    view.session = null; view.listing = null; view.loading = false; view.error = errorMessage(cause);
    update();
    notice.current(`${view.profile.name}：${view.error}`);
    void api.disconnectSession(active.sessionId).catch(() => {});
  }, [isCurrentSession, update]);

  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    const checking = new Set<ConnectedSession>();
    const check = async (view: Workspace, session: ConnectedSession) => {
      checking.add(session);
      try {
        await api.checkSession(session.sessionId);
      } catch (cause) {
        if (active) invalidateSession(view, session, cause);
      } finally {
        checking.delete(session);
      }
    };
    const checkAll = () => {
      if (!active || !mounted.current) return;
      for (const view of workspaces.current.values()) {
        const session = view.session;
        if (session && !checking.has(session)) void check(view, session);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkAll();
    };
    const timer = window.setInterval(checkAll, 30_000);
    window.addEventListener("focus", checkAll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkAll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [invalidateSession]);

  const disconnectProfile = useCallback((id: string) => {
    if (attemptRef.current?.profile.id === id) cancelAttempt();
    const view = workspaces.current.get(id);
    if (view) { release(view); update(); }
  }, [cancelAttempt, release, update]);
  const cancel = () => {
    const view = selected.current;
    if (view) disconnectProfile(view.profile.id);
    else cancelAttempt();
  };

  const loadDirectory = useCallback(async (view: Workspace, nextPath: string, historyIndex?: number, fallback?: string) => {
    const active = view.session;
    if (!active) return;
    const current = ++view.request;
    const valid = () => isCurrentSession(view, active) && view.request === current;
    const requestedPath = nextPath || view.acceptedPath;
    const absolutePath = requestedPath.startsWith("/")
      ? requestedPath : `${view.acceptedPath.replace(/\/$/u, "")}/${requestedPath}`;
    const target = absolutePath.replace(/\/+$/u, "");
    view.parentPath = target ? target.slice(0, target.lastIndexOf("/")) || "/" : null;
    view.path = absolutePath; view.loading = true; view.error = ""; view.listing = null;
    update();
    try {
      let result: DirectoryListing;
      try {
        result = await api.listRemoteDirectory(active.sessionId, absolutePath);
      } catch (cause) {
        // A superseded directory request can still prove this exact session is dead.
        if (isSessionFailure(cause)) throw cause;
        if (!valid()) return;
        if (!fallback || fallback === absolutePath || errorCode(cause) !== "remote_directory") throw cause;
        notice.current("上次打开的目录不可用，已尝试返回连接的起始目录");
        result = await api.listRemoteDirectory(active.sessionId, fallback);
      }
      if (!valid()) return;
      view.acceptedPath = result.path;
      rememberRemoteLocation(view.profile, result.path);
      const previous = view.history;
      view.history = historyIndex !== undefined
        ? { paths: previous.paths, index: historyIndex }
        : previous.paths[previous.index] === result.path ? previous
          : { paths: [...previous.paths.slice(0, previous.index + 1), result.path], index: previous.index + 1 };
      view.listing = result; view.path = result.path; view.parentPath = result.parentPath;
    } catch (cause) {
      if (isSessionFailure(cause)) invalidateSession(view, active, cause);
      else if (valid()) view.error = errorMessage(cause);
    } finally {
      if (valid()) {
        view.loading = false; update();
      }
    }
  }, [invalidateSession, isCurrentSession, update]);
  const navigate = useCallback((nextPath: string, historyIndex?: number, fallback?: string) => {
    const view = selected.current;
    return view ? loadDirectory(view, nextPath, historyIndex, fallback) : Promise.resolve();
  }, [loadDirectory]);
  const setPath = useCallback((path: string) => {
    if (selected.current) { selected.current.path = path; update(); }
  }, [update]);

  const connect = async (input?: AuthenticationInput) => {
    const view = selected.current;
    if (!view || attemptRef.current || view.session) return;
    const next: ConnectionAttempt = { id: crypto.randomUUID(), profile: view.profile, phase: "probing" };
    automatic.current = { attemptId: next.id, input };
    setInitialInput(input);
    attemptRef.current = next; setAttempt(next); setDialogError(""); view.error = ""; view.listing = null;
    update();
    try {
      const probe = await api.probeConnection(view.profile.id, next.id);
      if (!mounted.current || attemptRef.current?.id !== next.id) {
        void api.cancelConnection(next.id).catch(() => {}); return;
      }
      const ready = { ...next, probe, phase: probe.trusted ? "probing" as const : "trust" as const };
      attemptRef.current = ready; setAttempt(ready);
      if (probe.trusted) await authenticateAutomatic(ready);
    } catch (cause) {
      if (!mounted.current || attemptRef.current?.id !== next.id) return;
      cancelAttempt(); view.error = errorMessage(cause); update();
    }
  };

  const authenticateAutomatic = async (active: ConnectionAttempt) => {
    const pending = automatic.current;
    if (pending?.attemptId !== active.id) return;
    let input = pending.input;
    if (!input) {
      try {
        const status = await api.credentialStatus(active.profile.id);
        if (status.available && status.supported) input = { secret: null, remember: false, privateKeyContent: null };
      } catch { /* A failed status check leaves manual authentication available. */ }
    }
    if (!mounted.current || attemptRef.current?.id !== active.id) return;
    const next = { ...active, phase: "auth" as const };
    attemptRef.current = next;
    if (input) await authenticate(input.secret, input.remember, input.privateKeyContent);
    else { automatic.current = null; setAttempt(next); }
  };

  const handleAttemptError = (active: ConnectionAttempt, cause: unknown) => {
    if (!mounted.current || attemptRef.current?.id !== active.id) return;
    if (errorCode(cause) === "attempt_expired") {
      cancelAttempt();
      const view = workspaces.current.get(active.profile.id);
      if (view) { view.error = errorMessage(cause); update(); }
    } else setDialogError(errorMessage(cause));
  };

  const trust = async () => {
    const active = attemptRef.current;
    if (!active || operation.current) return;
    operation.current = active.id;
    setWorking(true); setDialogError("");
    try {
      await api.trustConnection(active.id);
      if (!mounted.current || attemptRef.current?.id !== active.id) return;
      const next = { ...active, phase: "probing" as const };
      attemptRef.current = next; setAttempt(next);
    } catch (cause) {
      handleAttemptError(active, cause);
    } finally {
      if (operation.current === active.id) operation.current = null;
      if (mounted.current && attemptRef.current?.id === active.id) setWorking(false);
    }
    if (attemptRef.current?.id === active.id && attemptRef.current.phase === "probing") {
      await authenticateAutomatic(attemptRef.current);
    }
  };

  const authenticate = async (secret: string | null, remember: boolean, privateKeyContent?: string | null) => {
    const active = attemptRef.current;
    const view = active && workspaces.current.get(active.profile.id);
    if (!active || !view || operation.current) return;
    operation.current = active.id; automatic.current = null;
    setWorking(true); setDialogError("");
    try {
      const connected = await api.authenticateConnection(active.id, secret, remember, privateKeyContent);
      if (!mounted.current || attemptRef.current?.id !== active.id) {
        void api.disconnectSession(connected.sessionId).catch(() => {}); return;
      }
      attemptRef.current = null; setAttempt(null); setInitialInput(undefined);
      operation.current = null; setWorking(false);
      view.session = connected; view.acceptedPath = connected.initialPath;
      update();
      if (connected.warning) notice.current(connected.warning);
      const remembered = readRemoteLocation(active.profile);
      await loadDirectory(view, remembered ?? connected.initialPath, undefined, remembered ? connected.initialPath : undefined);
    } catch (cause) {
      if (mounted.current && attemptRef.current?.id === active.id) setAttempt({ ...active, phase: "auth" });
      handleAttemptError(active, cause);
    } finally {
      if (operation.current === active.id) operation.current = null;
      if (mounted.current && (!attemptRef.current || attemptRef.current.id === active.id)) setWorking(false);
    }
  };

  const view = profile ? workspaces.current.get(profile.id) : undefined;
  const visible = view?.identity === (profile && credentialIdentity(profile)) ? view : undefined;
  const sessions = useMemo(() => [...workspaces.current.values()].flatMap((item) => item.session ? [item.session] : []), [revision]);
  const history = visible?.history ?? { paths: [], index: -1 };
  return {
    attempt, session: visible?.session ?? null, sessions, listing: visible?.listing ?? null,
    path: visible?.path ?? "", parentPath: visible?.parentPath ?? null, setPath, error: visible?.error ?? "",
    dialogError, working, loading: visible?.loading ?? false, initialInput,
    connect, cancel, disconnectProfile, trust, authenticate, navigate,
    canGoBack: history.index > 0, canGoForward: history.index >= 0 && history.index < history.paths.length - 1,
    goBack: () => history.index > 0 ? navigate(history.paths[history.index - 1], history.index - 1) : Promise.resolve(),
    goForward: () => history.index < history.paths.length - 1 ? navigate(history.paths[history.index + 1], history.index + 1) : Promise.resolve(),
  };
}
