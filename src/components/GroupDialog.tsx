import { useState, type FormEvent } from "react";
import { Folder, Save } from "lucide-react";
import type { ConnectionGroup } from "../lib/types";
import { errorMessage } from "../lib/api";
import { Dialog } from "./Dialog";

export function GroupDialog({ group, onSave, onClose }: {
  group: ConnectionGroup | null;
  onSave: (group: ConnectionGroup) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setError("");
    try {
      await onSave({ id: group?.id ?? crypto.randomUUID(), name: name.trim() });
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title={group ? "编辑分组" : "新建分组"} onClose={onClose} busy={busy} className="confirm-dialog">
    <form onSubmit={(event) => { void submit(event); }}>
      <div className="dialog-body">
        <label className="field" htmlFor="group-name"><span><Folder size={14} /> 分组名称</span>
          <input id="group-name" value={name} onChange={(event) => setName(event.target.value)}
            autoComplete="off" required maxLength={200} disabled={busy} placeholder="例如：生产环境" />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}><Save size={15} />保存分组</button>
      </footer>
    </form>
  </Dialog>;
}
