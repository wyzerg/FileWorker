import { useId } from "react";
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AuthMethod } from "../lib/types";
import type { useAuthentication } from "../lib/useAuthentication";
import { IconButton } from "./IconButton";

export function CredentialFields({ authMethod, credentials, savedMatches = true, disabled = false }: {
  authMethod: AuthMethod;
  credentials: ReturnType<typeof useAuthentication>;
  savedMatches?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const privateKey = authMethod !== "password";
  const saved = savedMatches && credentials.status.available;
  const usingSaved = saved && credentials.useSaved;
  return (
    <div className="credential-fields">
      {usingSaved ? <div className="saved-credential">
        <ShieldCheck size={17} />
        <span>{privateKey ? "已保存私钥凭据" : "已保存密码"}</span>
        <button type="button" className="text-button" disabled={disabled} onClick={credentials.manual}>
          {privateKey ? "更换凭据" : "更换密码"}
        </button>
        <IconButton label="忘记已保存凭据" disabled={disabled} onClick={() => { void credentials.forget(); }}><Trash2 size={15} /></IconButton>
      </div> : <>
        {authMethod === "privateKeyContent" && <label className="field" htmlFor={`${id}-key`}>私钥内容
          <textarea id={`${id}-key`} value={credentials.privateKeyContent} disabled={disabled}
            onChange={(event) => credentials.setPrivateKeyContent(event.target.value)}
            spellCheck={false} autoComplete="off" rows={5} maxLength={1048576} />
        </label>}
        <div className="field">
          <label htmlFor={`${id}-secret`}>{privateKey ? "私钥口令" : "密码"}</label>
          <div className="input-with-action">
            <input ref={credentials.inputRef} id={`${id}-secret`} type={visible ? "text" : "password"}
              value={credentials.secret} onChange={(event) => credentials.setSecret(event.target.value)}
              disabled={disabled} autoComplete="off" spellCheck={false}
              placeholder={privateKey ? "未加密私钥可留空" : "输入服务器密码"} />
            <IconButton label={visible ? "隐藏密码" : "显示密码"} disabled={disabled}
              onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton>
          </div>
        </div>
        {credentials.status.supported && <label className="check-field">
          <input type="checkbox" checked={credentials.remember} disabled={disabled}
            onChange={(event) => credentials.setRemember(event.target.checked)} />
          {authMethod === "password" ? "连接成功后记住密码" : authMethod === "privateKeyContent" ? "连接成功后记住私钥和口令" : "连接成功后记住私钥口令"}
        </label>}
        {saved && <button type="button" className="text-button saved-return" disabled={disabled}
          onClick={() => credentials.setUseSaved(true)}><KeyRound size={14} />{privateKey ? "使用已保存的私钥凭据" : "使用已保存的密码"}</button>}
      </>}
      {credentials.statusError && <p className="form-error" role="alert">{credentials.statusError}</p>}
    </div>
  );
}
