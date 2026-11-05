import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, TauriEvent, type Event as TauriEventPayload } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { AuthenticationInput, ConnectedSession, ConflictPolicy, ConnectionGroup, ConnectionProfile, CredentialStatus, DirectoryListing, FinderDropEvent, HostProbe, RemoteFileMutation, RemoteFileProperties, RemotePreview, RuntimeEnvironment, TransferRequest, TransferSnapshot } from "./types";

export const isDesktop = isTauri();
const previewStorageKey = "fileworker.preview.profiles.v1";
const previewDocumentKey = "fileworker.preview.connections.v2";
const profileFields = new Set([
  "id", "name", "host", "port", "username", "authMethod", "privateKeyPath", "remotePath", "groupId",
]);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

function isConnectionProfile(value: unknown): value is ConnectionProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => profileFields.has(key))
    && typeof item.id === "string" && uuidPattern.test(item.id)
    && typeof item.name === "string" && item.name.trim().length > 0
    && typeof item.host === "string" && item.host.trim().length > 0 && !/[\s/\\\0]/u.test(item.host)
    && typeof item.port === "number" && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
    && typeof item.username === "string" && item.username.trim().length > 0
    && (item.authMethod === "password" || item.authMethod === "privateKey" || item.authMethod === "privateKeyContent")
    && (item.privateKeyPath === null || typeof item.privateKeyPath === "string")
    && (item.authMethod !== "privateKey" || (typeof item.privateKeyPath === "string" && item.privateKeyPath.trim().length > 0))
    && typeof item.remotePath === "string"
    && (item.groupId === undefined || item.groupId === null || (typeof item.groupId === "string" && uuidPattern.test(item.groupId)));
}

type PreviewDocument = { version: 2; profiles: ConnectionProfile[]; groups: ConnectionGroup[] };
function isConnectionGroup(value: unknown): value is ConnectionGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => key === "id" || key === "name")
    && typeof item.id === "string" && uuidPattern.test(item.id)
    && typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 200
    && !/[\u0000-\u001f\u007f]/u.test(item.name);
}
function readPreviewDocument(): PreviewDocument {
  const current = localStorage.getItem(previewDocumentKey);
  const stored = current ?? localStorage.getItem(previewStorageKey);
  if (!stored) return { version: 2, profiles: [], groups: [] };
  const invalid = () => new Error("预览连接配置损坏，原数据未被修改，请检查浏览器本地存储");
  let value: unknown;
  try { value = JSON.parse(stored); }
  catch { throw invalid(); }
  const document = current ? value as PreviewDocument : { version: 2, profiles: value, groups: [] };
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.version !== 2 || Object.keys(document).some((key) => !["version", "profiles", "groups"].includes(key))
    || !Array.isArray(document.groups) || !document.groups.every(isConnectionGroup)) throw invalid();
  const { profiles, groups } = document;
  if (!Array.isArray(profiles) || !profiles.every(isConnectionProfile)) throw invalid();
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw invalid();
  if (new Set(groups.map((group) => group.id)).size !== groups.length
    || new Set(groups.map((group) => group.name.trim().toLowerCase())).size !== groups.length
    || profiles.some((profile) => profile.groupId && !groups.some((group) => group.id === profile.groupId))) throw invalid();
  return { version: 2, profiles, groups };
}
function writePreviewDocument(document: PreviewDocument) {
  localStorage.setItem(previewDocumentKey, JSON.stringify(document));
}
function authenticationSecret(secret: string | null, privateKeyContent?: string | null): string | null {
  return privateKeyContent == null ? secret
    : JSON.stringify({ version: 1, privateKey: privateKeyContent, passphrase: secret ?? "" });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return typeof error === "string" ? error : "操作未完成，请重试";
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function desktopCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop) throw new Error("请在 FileWorker 桌面应用中连接服务器，浏览器预览不支持 SSH");
  return invoke(command, args);
}

type NativeDragPayload = {
  paths?: string[];
  position?: { x: number; y: number };
} | null | undefined;

export const api = {
  async listenFinderDrop(handler: (event: FinderDropEvent) => void): Promise<() => void> {
    if (!isDesktop) return () => {};
    const target = { kind: "Webview" as const, label: getCurrentWebview().label };
    const dispatch = (
      phase: FinderDropEvent["phase"],
      event: TauriEventPayload<NativeDragPayload>,
    ) => {
      const payload = event.payload;
      const position = payload?.position
        ? {
            x: payload.position.x / Math.max(1, window.innerWidth * window.devicePixelRatio),
            y: payload.position.y / Math.max(1, window.innerHeight * window.devicePixelRatio),
          }
        : { x: -1, y: -1 };
      handler({
        phase,
        paths: payload?.paths,
        position,
      });
    };
    const unlisten = await Promise.all([
      listen<NativeDragPayload>(TauriEvent.DRAG_ENTER, (event) => dispatch("enter", event), { target }),
      listen<NativeDragPayload>(TauriEvent.DRAG_OVER, (event) => dispatch("over", event), { target }),
      listen<NativeDragPayload>(TauriEvent.DRAG_DROP, (event) => dispatch("drop", event), { target }),
      listen<NativeDragPayload>(TauriEvent.DRAG_LEAVE, (event) => dispatch("leave", event), { target }),
    ]);
    return () => { void Promise.all(unlisten.map((stop) => stop())); };
  },
  enqueueFinderUpload: (paths: string[], sessionId: string, destinationDir: string): Promise<string[]> =>
    desktopCommand("enqueue_finder_upload", { paths, sessionId, destinationDir }),
  enqueueTransfers: (requests: TransferRequest[]): Promise<string[]> =>
    desktopCommand("enqueue_transfers", { requests }),
  transferSnapshot: (): Promise<TransferSnapshot> =>
    desktopCommand("transfer_snapshot", {}),
  cancelTransfer: (id: string): Promise<void> =>
    desktopCommand("cancel_transfer", { id }),
  retryTransfer: (id: string): Promise<void> =>
    desktopCommand("retry_transfer", { id }),
  resolveTransferConflict: (id: string, policy: ConflictPolicy): Promise<void> =>
    desktopCommand("resolve_transfer_conflict", { id, policy }),
  setTransferConcurrency: (concurrency: number): Promise<void> =>
    desktopCommand("set_transfer_concurrency", { concurrency }),
  clearFinishedTransfers: (): Promise<void> =>
    desktopCommand("clear_finished_transfers", {}),
  probeConnection: (profileId: string, attemptId: string): Promise<HostProbe> =>
    desktopCommand("probe_connection", { profileId, attemptId }),
  trustConnection: (attemptId: string): Promise<void> =>
    desktopCommand("trust_connection", { attemptId }),
  authenticateConnection: (attemptId: string, secret: string | null, remember: boolean, privateKeyContent?: string | null): Promise<ConnectedSession> =>
    desktopCommand("authenticate_connection", { attemptId, secret: authenticationSecret(secret, privateKeyContent), remember }),
  credentialStatus: (profileId: string): Promise<CredentialStatus> =>
    desktopCommand("credential_status", { profileId }),
  probeDraftConnection: (profile: ConnectionProfile, attemptId: string): Promise<HostProbe> =>
    desktopCommand("probe_draft_connection", { profile, attemptId }),
  trustTestConnection: (attemptId: string): Promise<void> =>
    desktopCommand("trust_test_connection", { attemptId }),
  authenticateTestConnection: (attemptId: string, input: AuthenticationInput): Promise<ConnectedSession> =>
    desktopCommand("authenticate_test_connection", { attemptId, secret: authenticationSecret(input.secret, input.privateKeyContent) }),
  cancelTestConnection: (attemptId: string): Promise<void> =>
    desktopCommand("cancel_test_connection", { attemptId }),
  cancelConnection: (attemptId: string): Promise<void> =>
    desktopCommand("cancel_connection", { attemptId }),
  listRemoteDirectory: (sessionId: string, path: string): Promise<DirectoryListing> =>
    desktopCommand("list_remote_directory", { sessionId, path }),
  previewRemoteFile: (sessionId: string, path: string): Promise<RemotePreview> =>
    desktopCommand("preview_remote_file", { sessionId, path }),
  remoteFileProperties: (sessionId: string, path: string): Promise<RemoteFileProperties> =>
    desktopCommand("remote_file_properties", { sessionId, path }),
  mutateRemoteFile: (sessionId: string, path: string, action: RemoteFileMutation): Promise<void> =>
    desktopCommand("mutate_remote_file", { sessionId, path, action }),
  disconnectSession: (sessionId: string): Promise<void> =>
    desktopCommand("disconnect_session", { sessionId }),
  forgetCredential: (profileId: string): Promise<void> =>
    desktopCommand("forget_credential", { profileId }),
  async getEnvironment(): Promise<RuntimeEnvironment> {
    if (isDesktop) return invoke("get_environment");
    return { homePath: null, shortcuts: [], runtime: "browser" };
  },
  async listDirectory(path: string | null): Promise<DirectoryListing> {
    if (!isDesktop) throw new Error("浏览器无法读取本地目录，请打开 FileWorker 桌面应用");
    return invoke("list_local_directory", { path });
  },
  async listProfiles(): Promise<ConnectionProfile[]> {
    return isDesktop ? invoke("list_profiles") : readPreviewDocument().profiles;
  },
  async listGroups(): Promise<ConnectionGroup[]> {
    return isDesktop ? invoke("list_groups") : readPreviewDocument().groups;
  },
  async saveGroup(group: ConnectionGroup): Promise<ConnectionGroup> {
    if (isDesktop) return invoke("save_group", { group });
    const safe = { id: group.id, name: group.name.trim() };
    if (!isConnectionGroup(safe)) throw new Error("请填写有效的分组名称");
    const document = readPreviewDocument();
    if (document.groups.some((item) => item.id !== safe.id && item.name.toLowerCase() === safe.name.toLowerCase())) {
      throw new Error("已有同名分组，请换一个名称");
    }
    const index = document.groups.findIndex((item) => item.id === safe.id);
    if (index === -1) document.groups.push(safe);
    else document.groups[index] = safe;
    writePreviewDocument(document);
    return safe;
  },
  async deleteGroup(id: string): Promise<void> {
    if (isDesktop) return invoke("delete_group", { id });
    const document = readPreviewDocument();
    document.groups = document.groups.filter((group) => group.id !== id);
    document.profiles = document.profiles.map((profile) => profile.groupId === id ? { ...profile, groupId: null } : profile);
    writePreviewDocument(document);
  },
  async saveProfile(profile: ConnectionProfile): Promise<ConnectionProfile> {
    if (isDesktop) return invoke("save_profile", { profile });
    const safeProfile: ConnectionProfile = {
      id: profile.id, name: profile.name, host: profile.host, port: profile.port,
      username: profile.username, authMethod: profile.authMethod,
      privateKeyPath: profile.authMethod === "privateKey" ? profile.privateKeyPath : null,
      remotePath: profile.remotePath,
      ...(profile.groupId !== undefined ? { groupId: profile.groupId } : {}),
    };
    const document = readPreviewDocument();
    if (!isConnectionProfile(safeProfile) || (safeProfile.groupId && !document.groups.some((group) => group.id === safeProfile.groupId))) {
      throw new Error("连接配置或分组无效");
    }
    const index = document.profiles.findIndex((item) => item.id === profile.id);
    if (index === -1) document.profiles.push(safeProfile);
    else document.profiles[index] = safeProfile;
    writePreviewDocument(document);
    return safeProfile;
  },
  async deleteProfile(id: string): Promise<void> {
    if (isDesktop) return invoke("delete_profile", { id });
    const document = readPreviewDocument();
    document.profiles = document.profiles.filter((item) => item.id !== id);
    writePreviewDocument(document);
  },
  async chooseDirectory(): Promise<string | null> {
    if (!isDesktop) throw new Error("浏览器无法打开桌面目录选择器");
    return open({ directory: true, multiple: false, title: "选择本地目录" });
  },
  async choosePrivateKey(): Promise<string | null> {
    if (!isDesktop) throw new Error("浏览器无法选择本地私钥文件");
    return open({ directory: false, multiple: false, title: "选择 SSH 私钥文件" });
  },
};
