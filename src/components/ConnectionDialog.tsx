import { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, LockKeyhole, PlugZap, ShieldCheck } from "lucide-react";
import type { ConnectionAttempt } from "../lib/types";
import { Dialog } from "./Dialog";

export function ConnectionDialog({ attempt, working, error, onCancel, onTrust, onAuthenticate }: {
  attempt: ConnectionAttempt; working: boolean; error: string;
  onCancel: () => void; onTrust: () => Promise<void>;
  onAuthenticate: (secret: string | null, remember: boolean) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [useSaved, setUseSaved] = useState(false);
  const [remember, setRemember] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);
  const privateKey = attempt.profile.authMethod === "privateKey";
  const probing = attempt.phase === "probing";
  const trust = attempt.phase === "trust";
  const title = probing ? "正在连接服务器" : trust ? "确认服务器指纹" : "服务器认证";
  useEffect(() => {
    if (attempt.phase === "auth" && !useSaved && !working) secretInput.current?.focus();
  }, [attempt.phase, useSaved, working]);
  return (
    <Dialog title={title} onClose={onCancel} className="connection-dialog">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (working || probing) return;
        if (trust) { void onTrust(); return; }
        const value = useSaved ? null : secret;
        setSecret("");
        void onAuthenticate(value, remember && !useSaved);
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
              <label className="check-field"><input type="checkbox" checked={useSaved} disabled={working}
                onChange={(event) => { setUseSaved(event.target.checked); setSecret(""); }} />使用已保存的凭据</label>
              {!useSaved && <>
                <label className="field" htmlFor="connection-secret">{privateKey ? "私钥口令" : "密码"}
                  <input ref={secretInput} id="connection-secret" type="password" value={secret} required={!privateKey}
                    onChange={(event) => setSecret(event.target.value)} disabled={working}
                    autoComplete="off" spellCheck={false} placeholder={privateKey ? "未加密私钥可留空" : "输入服务器密码"} />
                </label>
                {privateKey && <p className="key-location"><KeyRound size={14} /><span>{attempt.profile.privateKeyPath}</span></p>}
                <label className="check-field"><input type="checkbox" checked={remember} disabled={working}
                  onChange={(event) => setRemember(event.target.checked)} />认证成功后保存到 macOS 钥匙串</label>
              </>}
            </>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button secondary" onClick={onCancel}>取消连接</button>
          {!probing && <button type="submit" className="button primary" disabled={working}>
            {working ? <LoaderCircle size={16} className="spinning" /> : trust ? <ShieldCheck size={16} /> : useSaved ? <LockKeyhole size={16} /> : <PlugZap size={16} />}
            {working ? "正在处理" : trust ? "信任并继续" : "连接"}</button>}
        </footer>
      </form>
    </Dialog>
  );
}
