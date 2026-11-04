import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage } from "./api";
import type { ConnectedSession, ConnectionAttempt, ConnectionProfile, DirectoryListing } from "./types";

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
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const sessionRef = useRef<ConnectedSession | null>(null);
  const request = useRef(0);
  const acceptedPath = useRef("/");
  const mounted = useRef(true);
  const profileKey = JSON.stringify(profile);

  const release = useCallback(() => {
    request.current += 1; acceptedPath.current = "/";
    const oldAttempt = attemptRef.current; attemptRef.current = null;
    const oldSession = sessionRef.current; sessionRef.current = null;
    if (oldAttempt) void api.cancelConnection(oldAttempt.id).catch(() => {});
    if (oldSession) void api.disconnectSession(oldSession.sessionId).catch(() => {});
  }, []);

  // Release the old profile before the new connection controls become interactive.
  useLayoutEffect(() => {
    mounted.current = true;
    setAttempt(null); setSession(null); setListing(null); setPath(""); setParentPath(null); setError("");
    setDialogError(""); setWorking(false); setLoading(false);
    return () => { mounted.current = false; release(); };
  }, [profileKey, release]);

  const cancel = () => {
    release(); setAttempt(null); setSession(null); setListing(null); setParentPath(null);
    setLoading(false); setWorking(false); setDialogError(""); setError("");
  };

  const navigate = useCallback(async (nextPath: string) => {
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
      const result = await api.listRemoteDirectory(active.sessionId, absolutePath);
      if (!mounted.current || request.current !== current || sessionRef.current !== active) return;
      acceptedPath.current = result.path;
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

  const connect = async () => {
    if (!profile || attemptRef.current || sessionRef.current) return;
    const next: ConnectionAttempt = { id: crypto.randomUUID(), profile, phase: "probing" };
    attemptRef.current = next; setAttempt(next); setDialogError(""); setError(""); setListing(null);
    try {
      const probe = await api.probeConnection(profile.id, next.id);
      if (!mounted.current || attemptRef.current?.id !== next.id) {
        void api.cancelConnection(next.id).catch(() => {}); return;
      }
      const ready = { ...next, probe, phase: probe.trusted ? "auth" as const : "trust" as const };
      attemptRef.current = ready; setAttempt(ready);
    } catch (cause) {
      if (!mounted.current || attemptRef.current?.id !== next.id) return;
      attemptRef.current = null; setAttempt(null); setError(errorMessage(cause));
      void api.cancelConnection(next.id).catch(() => {});
    }
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
    if (!active || working) return;
    setWorking(true); setDialogError("");
    try {
      await api.trustConnection(active.id);
      if (!mounted.current || attemptRef.current?.id !== active.id) return;
      const next = { ...active, phase: "auth" as const };
      attemptRef.current = next; setAttempt(next);
    } catch (cause) {
      handleAttemptError(active, cause);
    } finally {
      if (mounted.current && attemptRef.current?.id === active.id) setWorking(false);
    }
  };

  const authenticate = async (secret: string | null, remember: boolean) => {
    const active = attemptRef.current;
    if (!active || working) return;
    setWorking(true); setDialogError("");
    try {
      const connected = await api.authenticateConnection(active.id, secret, remember);
      if (!mounted.current || attemptRef.current?.id !== active.id) {
        void api.disconnectSession(connected.sessionId).catch(() => {}); return;
      }
      attemptRef.current = null; setAttempt(null);
      sessionRef.current = connected; setSession(connected);
      acceptedPath.current = connected.initialPath;
      if (connected.warning) onNotice(connected.warning);
      void navigate(connected.initialPath);
    } catch (cause) {
      handleAttemptError(active, cause);
    } finally {
      if (mounted.current && (!attemptRef.current || attemptRef.current.id === active.id)) setWorking(false);
    }
  };

  return {
    attempt, session, listing, path, parentPath, setPath, error, dialogError, working, loading,
    connect, cancel, trust, authenticate, navigate,
  };
}
