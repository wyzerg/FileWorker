import { useState, type FormEvent } from "react";
import { FolderOpen, KeyRound, LockKeyhole, Save, Server } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { AuthMethod, ConnectionProfile } from "../lib/types";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";

export function ProfileDialog({ profile, onSave, onClose }: {
  profile: ConnectionProfile | null;
  onSave: (profile: ConnectionProfile) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? "");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(profile?.authMethod ?? "password");
  const [privateKeyPath, setPrivateKeyPath] = useState(profile?.privateKeyPath ?? "");
  const [remotePath, setRemotePath] = useState(profile?.remotePath ?? ".");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("端口必须在 1 到 65535 之间"); return;
    }
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError("请填写连接名称、主机地址和用户名"); return;
    }
    if (/[\s/\\]/u.test(host.trim())) {
      setError("主机地址应为域名或 IP 地址，不包含协议和路径"); return;
    }
    if (authMethod === "privateKey" && !privateKeyPath.trim()) {
      setError("请选择 SSH 私钥文件"); return;
    }
    setError(""); setBusy(true);
    try {
      await onSave({
        id: profile?.id ?? crypto.randomUUID(), name: name.trim(), host: host.trim(),
        port: portNumber, username: username.trim(), authMethod,
        privateKeyPath: authMethod === "privateKey" ? privateKeyPath : null,
        remotePath: remotePath || ".",
      });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setBusy(false); }
  }
  return (
    <Dialog title={profile ? "编辑连接" : "新建连接"} onClose={onClose} busy={busy}>
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          <div className="protocol-label"><Server size={16} /><strong>SFTP</strong><span>SSH 文件传输</span></div>
          <label className="field" htmlFor="profile-name">连接名称
            <input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="例如：开发服务器" autoComplete="off" disabled={busy} />
          </label>
          <div className="host-fields">
            <label className="field" htmlFor="profile-host">主机地址
              <input id="profile-host" value={host} onChange={(e) => setHost(e.target.value)} required placeholder="sftp.example.com" autoComplete="off" spellCheck={false} disabled={busy} />
            </label>
            <label className="field" htmlFor="profile-port">端口
              <input id="profile-port" type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required disabled={busy} />
            </label>
          </div>
          <label className="field" htmlFor="profile-username">用户名
            <input id="profile-username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" spellCheck={false} disabled={busy} placeholder="用户名" />
          </label>
          <fieldset className="auth-fieldset" disabled={busy}>
            <legend>认证方式</legend>
            <div className="segmented">
              <label className={authMethod === "password" ? "active" : ""}>
                <input type="radio" name="auth-method" value="password" checked={authMethod === "password"} onChange={() => setAuthMethod("password")} />
                <LockKeyhole size={15} />密码
              </label>
              <label className={authMethod === "privateKey" ? "active" : ""}>
                <input type="radio" name="auth-method" value="privateKey" checked={authMethod === "privateKey"} onChange={() => setAuthMethod("privateKey")} />
                <KeyRound size={15} />SSH 私钥
              </label>
            </div>
          </fieldset>
          {authMethod === "privateKey" && <div className="field">
            <label htmlFor="profile-key">私钥文件</label>
            <div className="input-with-action">
              <input id="profile-key" value={privateKeyPath} onChange={(e) => setPrivateKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" required disabled={busy} spellCheck={false} />
              <IconButton label="选择私钥文件" disabled={busy} onClick={async () => {
                try { const path = await api.choosePrivateKey(); if (path) setPrivateKeyPath(path); }
                catch (cause) { setError(errorMessage(cause)); }
              }}><FolderOpen size={17} /></IconButton>
            </div>
          </div>}
          <label className="field" htmlFor="profile-remote-path">默认远程目录
            <input id="profile-remote-path" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="." spellCheck={false} disabled={busy} />
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? "正在保存" : "保存连接"}</button>
        </footer>
      </form>
    </Dialog>
  );
}
