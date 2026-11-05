import { useEffect } from "react";
import { KeyRound, LoaderCircle, LockKeyhole, PlugZap, ShieldCheck } from "lucide-react";
import type { AuthenticationInput, ConnectionAttempt } from "../lib/types";
import { Dialog } from "./Dialog";
import { CredentialFields } from "./CredentialFields";
import { useAuthentication } from "../lib/useAuthentication";

export function ConnectionDialog({ attempt, working, error, initialInput, onCancel, onTrust, onAuthenticate }: {
  attempt: ConnectionAttempt; working: boolean; error: string;
  initialInput?: AuthenticationInput;
  onCancel: () => void; onTrust: () => Promise<void>;
  onAuthenticate: (secret: string | null, remember: boolean, privateKeyContent?: string | null) => Promise<void>;
}) {
  const credentials = useAuthentication(attempt.profile, attempt.phase === "auth", initialInput);
  const privateKey = attempt.profile.authMethod !== "password";
  const probing = attempt.phase === "probing";
  const trust = attempt.phase === "trust";
  const title = probing ? "正在连接服务器" : trust ? "确认服务器指纹" : "服务器认证";
  useEffect(() => {
    if (attempt.phase === "auth" && !credentials.useSaved && !working) credentials.inputRef.current?.focus();
  }, [attempt.phase, credentials.useSaved, working, credentials.checking]);
  useEffect(() => {
    if (error && credentials.useSaved) credentials.manual();
  }, [error, credentials.checking]);
  return (
    <Dialog title={title} onClose={onCancel} className="connection-dialog">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (working || probing || credentials.checking) return;
        if (trust) { void onTrust(); return; }
        const input = credentials.input();
        if (input.secret === "" && !privateKey) return;
        void onAuthenticate(input.secret, input.remember, input.privateKeyContent);
      }} aria-busy={working || probing}>
        <div className="dialog-body">
          <div className="connection-endpoint"><span>{attempt.profile.name}</span>
            <code>{attempt.profile.username}@{attempt.profile.host}:{attempt.profile.port}</code></div>
          {probing ? <div className="connection-progress"><LoaderCircle size={25} className="spinning" /><p>正在核对服务器身份</p></div>
            : trust ? <>
              <div className="trust-heading"><ShieldCheck size={22} /><p>首次连接此服务器，请向管理员核对指纹后再信任。</p></div>
              <dl className="fingerprint-details"><dt>密钥类型</dt><dd>{attempt.probe?.identity.algorithm}</dd>
                <dt>主机指纹</dt><dd className="fingerprint">{attempt.probe?.identity.fingerprint}</dd></dl>
            </> : <>
              <CredentialFields authMethod={attempt.profile.authMethod} credentials={credentials} disabled={working} />
              {attempt.profile.authMethod === "privateKey" && <p className="key-location"><KeyRound size={14} /><span>{attempt.profile.privateKeyPath}</span></p>}
            </>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button secondary" onClick={onCancel}>取消连接</button>
          {!probing && <button type="submit" className="button primary" disabled={working || credentials.checking}>
            {working ? <LoaderCircle size={16} className="spinning" /> : trust ? <ShieldCheck size={16} /> : credentials.useSaved ? <LockKeyhole size={16} /> : <PlugZap size={16} />}
            {working ? "正在处理" : trust ? "信任并继续" : "连接"}</button>}
        </footer>
      </form>
    </Dialog>
  );
}
