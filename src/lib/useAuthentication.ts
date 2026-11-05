import { useEffect, useRef, useState } from "react";
import { api, errorMessage, isDesktop } from "./api";
import type { AuthenticationInput, AuthMethod, ConnectionProfile, CredentialStatus } from "./types";

export function credentialIdentity(profile: ConnectionProfile): string {
  return JSON.stringify([
    profile.id, profile.host.trim().toLowerCase(), profile.port, profile.username.trim(),
    profile.authMethod, profile.privateKeyPath,
  ]);
}

export function useAuthentication(profile: ConnectionProfile | null, enabled = true, initial?: AuthenticationInput, supported?: boolean) {
  const [secret, setSecret] = useState(initial?.secret ?? "");
  const [privateKeyContent, setPrivateKeyContent] = useState(initial?.privateKeyContent ?? "");
  const [remember, setRemember] = useState(initial?.remember ?? false);
  const [useSaved, setUseSaved] = useState(initial?.secret === null);
  const [status, setStatus] = useState<CredentialStatus>({ available: false, supported: supported ?? isDesktop });
  const [checking, setChecking] = useState(Boolean(profile && enabled && isDesktop));
  const [statusError, setStatusError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(initial !== undefined);
  const identity = profile ? credentialIdentity(profile) : "";

  useEffect(() => {
    if (supported !== undefined) setStatus((previous) => ({ ...previous, supported }));
  }, [supported]);
  useEffect(() => {
    if (!profile || !enabled || !isDesktop || supported === false) { setChecking(false); return; }
    let active = true;
    setChecking(true);
    setStatusError("");
    api.credentialStatus(profile.id).then((result) => {
      if (!active) return;
      setStatus(result);
      if (!dirty.current) setUseSaved(result.available);
    }).catch((cause) => {
      if (!active) return;
      setStatus((previous) => ({ ...previous, available: false }));
      setStatusError(`${errorMessage(cause)}，可重新输入后连接`);
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [identity, enabled, supported]);

  const manual = () => {
    dirty.current = true;
    setUseSaved(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const forget = async () => {
    if (!profile) return;
    setStatusError("");
    try {
      await api.forgetCredential(profile.id);
      setStatus((previous) => ({ ...previous, available: false }));
      manual();
    } catch (cause) { setStatusError(errorMessage(cause)); }
  };
  const input = (savedMatches = true, authMethod: AuthMethod = profile?.authMethod ?? "password"): AuthenticationInput => ({
    secret: useSaved && status.available && savedMatches ? null : secret,
    privateKeyContent: authMethod !== "privateKeyContent" || (useSaved && status.available && savedMatches) ? null : privateKeyContent || null,
    remember: remember && status.supported && !(useSaved && status.available && savedMatches),
  });
  return {
    secret, setSecret: (value: string) => { dirty.current = true; setSecret(value); },
    privateKeyContent, setPrivateKeyContent: (value: string) => { dirty.current = true; setPrivateKeyContent(value); },
    remember, setRemember, useSaved, setUseSaved, status, checking, statusError, inputRef,
    manual, forget, input,
  };
}
