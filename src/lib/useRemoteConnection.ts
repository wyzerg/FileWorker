import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { api, errorCode, errorMessage } from "./api";
import type { AuthenticationInput, ConnectedSession, ConnectionAttempt, ConnectionProfile, DirectoryListing } from "./types";
import { credentialIdentity } from "./useAuthentication";

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
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const sessionRef = useRef<ConnectedSession | null>(null);
  const request = useRef(0);
  const acceptedPath = useRef("/");
  const mounted = useRef(true);
  const operation = useRef<string | null>(null);
  const automatic = useRef<{ attemptId: string; input: AuthenticationInput } | null>(null);
  const profileKey = profile ? credentialIdentity(profile) : "";

  const release = useCallback(() => {
    request.current += 1; acceptedPath.current = "/";
    const oldAttempt = attemptRef.current; attemptRef.current = null;
    const oldSession = sessionRef.current; sessionRef.current = null;
    automatic.current = null; operation.current = null;
    if (oldAttempt) void api.cancelConnection(oldAttempt.id).catch(() => {});
    if (oldSession) void api.disconnectSession(oldSession.sessionId).catch(() => {});
  }, []);

  // Release the old profile before the new connection controls become interactive.
  useLayoutEffect(() => {
    mounted.current = true;
    setAttempt(null); setSession(null); setListing(null); setPath(""); setParentPath(null); setError("");
    setDialogError(""); setWorking(false); setLoading(false);
    setInitialInput(undefined);
    return () => { mounted.current = false; release(); };
  }, [profileKey, release]);

  const cancel = () => {
    release(); setAttempt(null); setSession(null); setListing(null); setParentPath(null);
    setLoading(false); setWorking(false); setDialogError(""); setError("");
    setInitialInput(undefined);
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

  const connect = async (input?: AuthenticationInput) => {
    if (!profile || attemptRef.current || sessionRef.current) return;
    const next: ConnectionAttempt = { id: crypto.randomUUID(), profile, phase: "probing" };
    automatic.current = input ? { attemptId: next.id, input } : null;
    setInitialInput(input);
    attemptRef.current = next; setAttempt(next); setDialogError(""); setError(""); setListing(null);
    try {
      const probe = await api.probeConnection(profile.id, next.id);
      if (!mounted.current || attemptRef.current?.id !== next.id) {
        void api.cancelConnection(next.id).catch(() => {}); return;
      }
      const ready = { ...next, probe, phase: probe.trusted ? "auth" as const : "trust" as const };
      attemptRef.current = ready; setAttempt(ready);
      if (probe.trusted && input) await authenticate(input.secret, input.remember, input.privateKeyContent);
    } catch (cause) {
      if (!mounted.current || attemptRef.current?.id !== next.id) return;
      attemptRef.current = null; setAttempt(null); setError(errorMessage(cause));
      automatic.current = null; setInitialInput(undefined);
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
    if (!active || operation.current) return;
    operation.current = active.id;
    setWorking(true); setDialogError("");
    try {
      await api.trustConnection(active.id);
      if (!mounted.current || attemptRef.current?.id !== active.id) return;
      const next = { ...active, phase: "auth" as const };
      attemptRef.current = next; setAttempt(next);
    } catch (cause) {
      handleAttemptError(active, cause);
    } finally {
      if (operation.current === active.id) operation.current = null;
      if (mounted.current && attemptRef.current?.id === active.id) setWorking(false);
    }
    const pending = automatic.current;
    if (pending?.attemptId === active.id && attemptRef.current?.id === active.id && attemptRef.current.phase === "auth") {
      await authenticate(pending.input.secret, pending.input.remember, pending.input.privateKeyContent);
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
      acceptedPath.current = connected.initialPath;
      if (connected.warning) onNotice(connected.warning);
      void navigate(connected.initialPath);
    } catch (cause) {
      handleAttemptError(active, cause);
    } finally {
      if (operation.current === active.id) operation.current = null;
      if (mounted.current && (!attemptRef.current || attemptRef.current.id === active.id)) setWorking(false);
    }
  };

  return {
    attempt, session, listing, path, parentPath, setPath, error, dialogError, working, loading, initialInput,
    connect, cancel, trust, authenticate, navigate,
  };
}
