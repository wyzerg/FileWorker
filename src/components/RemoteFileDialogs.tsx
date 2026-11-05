import { useEffect, useState } from "react";
import { FolderPlus, LoaderCircle, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { Dialog } from "./Dialog";
import type { RemoteFileController } from "../lib/useRemoteFiles";
import { formatBytes, formatDate } from "../lib/files";
import "./remote-files.css";

const titles = { preview: "预览文件", properties: "远程属性", createDirectory: "新建文件夹", rename: "重命名", delete: "删除远程项目" };
const kinds = { file: "普通文件", directory: "目录", symlink: "符号链接", special: "特殊文件" };

export function RemoteFileDialogs({ controller }: { controller: RemoteFileController }) {
  const { dialog, close, submit, setName, retry } = controller;
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [dialog?.preview]);
  if (!dialog) return null;
  const mutation = ["createDirectory", "rename", "delete"].includes(dialog.kind);
  const properties = dialog.properties;
  const error = dialog.error || (imageError ? "图片无法显示，请重试或下载后查看" : "");
  const Icon = dialog.kind === "delete" ? Trash2 : dialog.kind === "createDirectory" ? FolderPlus : Pencil;
  return <Dialog title={titles[dialog.kind]} onClose={close} busy={mutation && dialog.busy}
    className={`remote-file-dialog ${dialog.kind === "preview" ? "remote-preview-dialog" : ""}`}>
    <form onSubmit={(event) => { event.preventDefault(); if (mutation) void submit(); }}>
      <div className="dialog-body">
        <p className="remote-action-path">{dialog.path}</p>
        {dialog.kind === "delete" ? <p className="remote-delete-warning">确认删除此项目？此操作无法撤销。目录必须为空，不会递归删除。</p>
          : dialog.kind === "createDirectory" || dialog.kind === "rename" ? <label className="remote-name-field">
            <span>{dialog.kind === "rename" ? "新名称" : "文件夹名称"}</span>
            <input aria-label={dialog.kind === "rename" ? "新名称" : "文件夹名称"} value={dialog.name}
              disabled={dialog.busy} onChange={(event) => setName(event.target.value)} autoComplete="off" spellCheck={false} />
          </label> : null}
        {dialog.busy && !mutation && <div className="remote-reading" role="status"><LoaderCircle size={21} className="spinning" />正在读取</div>}
        {!dialog.busy && dialog.preview?.kind === "text" && <textarea className="remote-text-preview" aria-label="远程文本预览"
          value={dialog.preview.text} readOnly spellCheck={false} wrap="off" />}
        {!dialog.busy && dialog.preview?.kind === "image" && !imageError && <div className="remote-image-preview">
          <img src={`data:${dialog.preview.mime};base64,${dialog.preview.data}`} alt={dialog.name} onError={() => setImageError(true)} />
        </div>}
        {properties && <dl className="remote-properties">
          <dt>类型</dt><dd>{kinds[properties.kind]}</dd>
          <dt>大小</dt><dd>{formatBytes(properties.size)}</dd>
          <dt>修改时间</dt><dd>{formatDate(properties.modifiedMs)}</dd>
          <dt>权限</dt><dd>{properties.permissions ?? "未提供"}</dd>
          <dt>所有者 UID</dt><dd>{properties.uid ?? "未提供"}</dd>
          <dt>组 GID</dt><dd>{properties.gid ?? "未提供"}</dd>
        </dl>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="dialog-footer">
        {error && !mutation && <button type="button" className="button secondary" onClick={retry}><RefreshCw size={15} />重试</button>}
        <button type="button" className="button secondary" disabled={mutation && dialog.busy} onClick={close}><X size={15} />{mutation ? "取消" : "关闭"}</button>
        {mutation && <button type="submit" className={`button ${dialog.kind === "delete" ? "danger" : "primary"}`} disabled={dialog.busy}>
          {dialog.busy ? <LoaderCircle size={15} className="spinning" /> : <Icon size={15} />}
          {dialog.busy ? "正在处理" : dialog.kind === "delete" ? "删除" : dialog.kind === "createDirectory" ? "创建" : "重命名"}
        </button>}
      </footer>
    </form>
  </Dialog>;
}
