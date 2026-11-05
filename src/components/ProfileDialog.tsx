import { useEffect, useRef, useState, type FormEvent } from "react";
import { FolderOpen, KeyRound, LoaderCircle, LockKeyhole, PlugZap, Save, Server, ShieldCheck } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { AuthenticationInput, AuthMethod, ConnectionGroup, ConnectionProfile, HostProbe } from "../lib/types";
import { credentialIdentity, useAuthentication } from "../lib/useAuthentication";
import { CredentialFields } from "./CredentialFields";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";

export function ProfileDialog({ profile, groups = [], initialGroupId = null, credentialStorage, onSave, onClose }: {
  profile: ConnectionProfile | null;
  groups?: ConnectionGroup[];
  initialGroupId?: string | null;
  credentialStorage?: boolean;
  onSave: (profile: ConnectionProfile, input: AuthenticationInput, connect: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [id] = useState(() => profile?.id ?? crypto.randomUUID());
  const [name, setName] = useState(profile?.name ?? "");
  const [host, setHost] = useState(profile?.host ?? "");
  const [port, setPort] = useState(String(profile?.port ?? 22));
  const [username, setUsername] = useState(profile?.username ?? "");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(profile?.authMethod ?? "password");
  const [privateKeyPath, setPrivateKeyPath] = useState(profile?.privateKeyPath ?? "");
  const [remotePath, setRemotePath] = useState(profile?.remotePath ?? ".");
  const [groupId, setGroupId] = useState(profile?.groupId ?? initialGroupId ?? "");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [operation, setOperation] = useState<"save" | "test" | null>(null);
  const [trust, setTrust] = useState<HostProbe | null>(null);
  const testing = useRef<{ id: string; input: AuthenticationInput; confirming: boolean } | null>(null);
  const operationLock = useRef(false);
  const credentials = useAuthentication(profile, true, undefined, credentialStorage);
  const busy = operation !== null;
  const draft: ConnectionProfile = {
    id, name: name.trim(), host: host.trim(), port: Number(port), username: username.trim(), authMethod,
    privateKeyPath: authMethod === "privateKey" ? privateKeyPath.trim() : null,
    remotePath: remotePath || ".", groupId: groupId || null,
  };
  const savedMatches = Boolean(profile && credentialIdentity(profile) === credentialIdentity(draft));
  const cancelTest = () => {
    const active = testing.current;
    testing.current = null;
    if (active) void api.cancelTestConnection(active.id).catch(() => {});
    operationLock.current = false;
    setTrust(null); setOperation(null);
  };
  useEffect(() => () => {
    const active = testing.current;
    testing.current = null;
    if (active) void api.cancelTestConnection(active.id).catch(() => {});
  }, []);

  function validate(withAuthentication: boolean): AuthenticationInput | null {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("端口必须在 1 到 65535 之间"); return null;
    }
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError("请填写连接名称、主机地址和用户名"); return null;
    }
    if (/[\s/\\]/u.test(host.trim())) {
      setError("主机地址应为域名或 IP 地址，不包含协议和路径"); return null;
    }
    if (authMethod === "privateKey" && !privateKeyPath.trim()) {
      setError("请选择 SSH 私钥文件"); return null;
    }
    const input = credentials.input(savedMatches, authMethod);
    if (withAuthentication && authMethod === "password" && input.secret === "") {
      setError("请输入服务器密码"); credentials.inputRef.current?.focus(); return null;
    }
    if (withAuthentication && authMethod === "privateKeyContent" && input.secret !== null && !input.privateKeyContent?.trim()) {
      setError("请粘贴 SSH 私钥内容"); return null;
    }
    setError(""); setStatus("");
    return input;
  }
  async function save(connect: boolean) {
    if (operationLock.current) return;
    const input = validate(connect);
    if (!input) return;
    operationLock.current = true; setOperation("save");
    try {
      await onSave(draft, connect ? input : { secret: "", privateKeyContent: null, remember: false }, connect);
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { operationLock.current = false; setOperation(null); }
  }
  async function completeTest(active: NonNullable<typeof testing.current>) {
    try {
      await api.authenticateTestConnection(active.id, active.input);
      if (testing.current !== active) return;
      setStatus("连接测试成功");
    } catch (cause) {
      if (testing.current !== active) return;
      setError(errorMessage(cause));
      if (active.input.secret === null) credentials.manual();
    } finally {
      if (testing.current === active) cancelTest();
      else void api.cancelTestConnection(active.id).catch(() => {});
    }
  }
  async function test() {
    if (operationLock.current) return;
    const input = validate(true);
    if (!input) return;
    const active = { id: crypto.randomUUID(), input: { ...input, remember: false }, confirming: false };
    testing.current = active; operationLock.current = true; setOperation("test");
    try {
      const probe = await api.probeDraftConnection(draft, active.id);
      if (testing.current !== active) return;
      if (!probe.trusted) { setTrust(probe); return; }
      await completeTest(active);
    } catch (cause) {
      if (testing.current !== active) return;
      setError(errorMessage(cause)); cancelTest();
    }
  }
  async function trustTest() {
    const active = testing.current;
    if (!active || !trust || active.confirming) return;
    active.confirming = true; setTrust(null);
    try {
      await api.trustTestConnection(active.id);
      if (testing.current === active) await completeTest(active);
    } catch (cause) {
      if (testing.current !== active) return;
      setError(errorMessage(cause)); cancelTest();
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save(true);
  }
  return (
    <Dialog title={profile ? "编辑连接" : "新建连接"} onClose={onClose} busy={operation === "save"} className="profile-dialog">
      <form onSubmit={submit}>
        <div className="dialog-body">
          <div className="protocol-label"><Server size={16} /><strong>SFTP</strong><span>SSH 文件传输</span></div>
          <label className="field" htmlFor="profile-name">连接名称
            <input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="例如：开发服务器" autoComplete="off" disabled={busy} />
          </label>
          <label className="field" htmlFor="profile-group">连接分组
            <select id="profile-group" value={groupId} onChange={(event) => setGroupId(event.target.value)} disabled={busy}>
              <option value="">未分组</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
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
                <input aria-label="密码认证" type="radio" name="auth-method" value="password" checked={authMethod === "password"} onChange={() => setAuthMethod("password")} />
                <LockKeyhole size={15} />密码认证
              </label>
              <label className={authMethod !== "password" ? "active" : ""}>
                <input type="radio" name="auth-method" value="privateKey" checked={authMethod !== "password"} onChange={() => setAuthMethod("privateKey")} />
                <KeyRound size={15} />SSH 私钥
              </label>
            </div>
          </fieldset>
          {authMethod !== "password" && <fieldset className="auth-fieldset" disabled={busy}>
            <legend>私钥来源</legend>
            <div className="segmented">
              <label className={authMethod === "privateKey" ? "active" : ""}>
                <input type="radio" name="key-source" checked={authMethod === "privateKey"} onChange={() => setAuthMethod("privateKey")} />
                <FolderOpen size={15} />选择文件
              </label>
              <label className={authMethod === "privateKeyContent" ? "active" : ""}>
                <input type="radio" name="key-source" checked={authMethod === "privateKeyContent"} onChange={() => setAuthMethod("privateKeyContent")} />
                <KeyRound size={15} />粘贴私钥
              </label>
            </div>
          </fieldset>}
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
          <CredentialFields authMethod={authMethod} credentials={credentials} savedMatches={savedMatches} disabled={busy || credentials.checking} />
          <label className="field" htmlFor="profile-remote-path">默认远程目录
            <input id="profile-remote-path" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="." spellCheck={false} disabled={busy} />
          </label>
          {trust && <section className="draft-trust" aria-label="确认服务器指纹">
            <div className="trust-heading"><ShieldCheck size={20} /><p>首次连接此服务器，请向管理员核对指纹后再信任。</p></div>
            <dl className="fingerprint-details"><dt>密钥类型</dt><dd>{trust.identity.algorithm}</dd>
              <dt>主机指纹</dt><dd className="fingerprint">{trust.identity.fingerprint}</dd></dl>
          </section>}
          {status && <p role="status" className="form-success"><ShieldCheck size={16} />{status}</p>}
          {error && <p role="alert" className="form-error">{error}</p>}
        </div>
        <footer className="dialog-footer profile-footer">
          {operation === "test" ? <>
            <button type="button" className="button secondary" onClick={cancelTest}>取消测试</button>
            {trust ? <button type="button" className="button primary" onClick={() => { void trustTest(); }}><ShieldCheck size={16} />信任并测试</button>
              : <span className="test-progress" role="status"><LoaderCircle size={16} className="spinning" />正在测试连接</span>}
          </> : <>
            <button type="button" className="button secondary test-button" disabled={busy || credentials.checking} onClick={() => { void test(); }}><PlugZap size={16} />测试连接</button>
            <button type="button" className="button secondary" onClick={() => { void save(false); }} disabled={busy}><Save size={16} />仅保存配置</button>
            <button type="submit" className="button primary" disabled={busy || credentials.checking}><PlugZap size={16} />{busy ? "正在保存" : "保存并连接"}</button>
          </>}
        </footer>
      </form>
    </Dialog>
  );
}
