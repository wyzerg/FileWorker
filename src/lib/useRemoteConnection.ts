import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage } from "./api";
import type { AuthenticationInput, ConnectedSession, ConnectionAttempt, ConnectionProfile, DirectoryListing } from "./types";
import { credentialIdentity } from "./useAuthentication";
import { readRemoteLocation, rememberRemoteLocation } from "./remoteLocations";

export function useRemoteConnection(profile: ConnectionProfile | null, onNotice: (message: string) => void) {
  const [attempt, setAttempt] = useState<ConnectionAttempt | null>(null);
  const [session, setSession] = useState<ConnectedSession | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialInput, setInitialInput] = useState<AuthenticationInput | undefined>();
  const [history, setHistory] = useState({ paths: [] as string[], index: -1 });
  const historyRef = useRef(history);
  const sessionProfile = useRef<ConnectionProfile | null>(null);
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const sessionRef = useRef<ConnectedSession | null>(null);
  const request = useRef(0);
  const acceptedPath = useRef("/");
  const mounted = useRef(true);
  const operation = useRef<string | null>(null);
  const automatic = useRef<{ attemptId: string; input?: AuthenticationInput } | null>(null);
  const profileKey = profile ? credentialIdentity(profile) : "";

  const release = useCallback(() => {
    request.current += 1; acceptedPath.current = "/";
    const oldAttempt = attemptRef.current; attemptRef.current = null;
    const oldSession = sessionRef.current; sessionRef.current = null;
    automatic.current = null; operation.current = null;
    sessionProfile.current = null;
    historyRef.current = { paths: [], index: -1 };
    if (oldAttempt) void api.cancelConnection(oldAttempt.id).catch(() => {});
    if (oldSession) void api.disconnectSession(oldSession.sessionId).catch(() => {});
  }, []);

  // Release the old profile before the new connection controls become interactive.
  useLayoutEffect(() => {
    mounted.current = true;
    setAttempt(null); setSession(null); setListing(null); setPath(""); setParentPath(null); setError("");
    setDialogError(""); setWorking(false); setLoading(false);
    setInitialInput(undefined);
    setHistory(historyRef.current);
    return () => { mounted.current = false; release(); };
  }, [profileKey, release]);

  const cancel = () => {
    release(); setAttempt(null); setSession(null); setListing(null); setParentPath(null);
    setLoading(false); setWorking(false); setDialogError(""); setError("");
    setInitialInput(undefined);
    setHistory(historyRef.current);
  };

  const navigate = useCallback(async (nextPath: string, historyIndex?: number, fallback?: string) => {
    const active = sessionRef.current;
    if (!active) return;
    const current = ++request.current;
    const requestedPath = nextPath || acceptedPath.current;
    const absolutePath = requestedPath.startsWith("/")
      ? requestedPath : `${acceptedPath.current.replace(/\/$/u, "")}/${requestedPath}`;
    const target = absolutePath.replace(/\/+$/u, "");
    setParentPath(target ? target.slice(0, target.lastIndexOf("/")) || "/" : null);
    setPath(absolutePath); setLoading(true); setError(""); setListing(null);
    try {
      let result: DirectoryListing;
      try {
        result = await api.listRemoteDirectory(active.sessionId, absolutePath);
      } catch (cause) {
        if (!mounted.current || request.current !== current || sessionRef.current !== active) return;
        if (!fallback || fallback === absolutePath || errorCode(cause) !== "remote_directory") throw cause;
        onNotice("上次打开的目录不可用，已尝试返回连接的起始目录");
        result = await api.listRemoteDirectory(active.sessionId, fallback);
      }
      if (!mounted.current || request.current !== current || sessionRef.current !== active) return;
      acceptedPath.current = result.path;
      if (sessionProfile.current) rememberRemoteLocation(sessionProfile.current, result.path);
      const previous = historyRef.current;
      const next = historyIndex !== undefined
        ? { paths: previous.paths, index: historyIndex }
        : previous.paths[previous.index] === result.path ? previous
          : { paths: [...previous.paths.slice(0, previous.index + 1), result.path], index: previous.index + 1 };
      historyRef.current = next; setHistory(next);
      setListing(result); setPath(result.path); setParentPath(result.parentPath);
    } catch (cause) {
      if (!mounted.current || request.current !== current || sessionRef.current !== active) return;
      setError(errorMessage(cause));
      if (["connection_lost", "session_closed"].includes(errorCode(cause) ?? "")) {
        sessionRef.current = null; setSession(null);
        void api.disconnectSession(active.sessionId).catch(() => {});
      }
    } finally {
      if (mounted.current && request.current === current) setLoading(false);
    }
  }, []);

  const connect = async (input?: AuthenticationInput) => {
    if (!profile || attemptRef.current || sessionRef.current) return;
    const next: ConnectionAttempt = { id: crypto.randomUUID(), profile, phase: "probing" };
    automatic.current = { attemptId: next.id, input };
    setInitialInput(input);
    attemptRef.current = next; setAttempt(next); setDialogError(""); setError(""); setListing(null);
    try {
      const probe = await api.probeConnection(profile.id, next.id);
      if (!mounted.current || attemptRef.current?.id !== next.id) {
        void api.cancelConnection(next.id).catch(() => {}); return;
      }
      const ready = { ...next, probe, phase: probe.trusted ? "probing" as const : "trust" as const };
      attemptRef.current = ready; setAttempt(ready);
      if (probe.trusted) await authenticateAutomatic(ready);
    } catch (cause) {
      if (!mounted.current || attemptRef.current?.id !== next.id) return;
      attemptRef.current = null; setAttempt(null); setError(errorMessage(cause));
      automatic.current = null; setInitialInput(undefined);
      void api.cancelConnection(next.id).catch(() => {});
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
      cancel();
      setError(errorMessage(cause));
    } else {
      setDialogError(errorMessage(cause));
    }
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
    if (!active || operation.current) return;
    operation.current = active.id; automatic.current = null;
    setWorking(true); setDialogError("");
    try {
      const connected = await api.authenticateConnection(active.id, secret, remember, privateKeyContent);
      if (!mounted.current || attemptRef.current?.id !== active.id) {
        void api.disconnectSession(connected.sessionId).catch(() => {}); return;
      }
      attemptRef.current = null; setAttempt(null);
      setInitialInput(undefined);
      sessionRef.current = connected; setSession(connected);
      sessionProfile.current = active.profile;
      acceptedPath.current = connected.initialPath;
      if (connected.warning) onNotice(connected.warning);
      const remembered = readRemoteLocation(active.profile);
      await navigate(remembered ?? connected.initialPath, undefined, remembered ? connected.initialPath : undefined);
    } catch (cause) {
      if (mounted.current && attemptRef.current?.id === active.id) setAttempt({ ...active, phase: "auth" });
      handleAttemptError(active, cause);
    } finally {
      if (operation.current === active.id) operation.current = null;
      if (mounted.current && (!attemptRef.current || attemptRef.current.id === active.id)) setWorking(false);
    }
  };

  return {
    attempt, session, listing, path, parentPath, setPath, error, dialogError, working, loading, initialInput,
    connect, cancel, trust, authenticate, navigate,
    canGoBack: history.index > 0, canGoForward: history.index >= 0 && history.index < history.paths.length - 1,
    goBack: () => history.index > 0 ? navigate(history.paths[history.index - 1], history.index - 1) : Promise.resolve(),
    goForward: () => history.index < history.paths.length - 1 ? navigate(history.paths[history.index + 1], history.index + 1) : Promise.resolve(),
  };
}
