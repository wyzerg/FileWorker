import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ConnectedSession, ConflictPolicy, ConnectionProfile, DirectoryListing, HostProbe, RuntimeEnvironment, TransferRequest, TransferSnapshot } from "./types";

export const isDesktop = isTauri();
const previewStorageKey = "fileworker.preview.profiles.v1";
const profileFields = new Set([
  "id", "name", "host", "port", "username", "authMethod", "privateKeyPath", "remotePath",
]);

function isConnectionProfile(value: unknown): value is ConnectionProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => profileFields.has(key))
    && typeof item.id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(item.id)
    && typeof item.name === "string" && item.name.trim().length > 0
    && typeof item.host === "string" && item.host.trim().length > 0 && !/[\s/\\\0]/u.test(item.host)
    && typeof item.port === "number" && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
    && typeof item.username === "string" && item.username.trim().length > 0
    && (item.authMethod === "password" || item.authMethod === "privateKey")
    && (item.privateKeyPath === null || typeof item.privateKeyPath === "string")
    && (item.authMethod !== "privateKey" || (typeof item.privateKeyPath === "string" && item.privateKeyPath.trim().length > 0))
    && typeof item.remotePath === "string";
}

function readPreviewProfiles(): ConnectionProfile[] {
  const stored = localStorage.getItem(previewStorageKey);
  if (!stored) return [];
  const invalid = () => new Error("预览连接配置损坏，原数据未被修改，请检查浏览器本地存储");
  let profiles: unknown;
  try { profiles = JSON.parse(stored); }
  catch { throw invalid(); }
  if (!Array.isArray(profiles) || !profiles.every(isConnectionProfile)) throw invalid();
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw invalid();
  return profiles;
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

export const api = {
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
  authenticateConnection: (attemptId: string, secret: string | null, remember: boolean): Promise<ConnectedSession> =>
    desktopCommand("authenticate_connection", { attemptId, secret, remember }),
  cancelConnection: (attemptId: string): Promise<void> =>
    desktopCommand("cancel_connection", { attemptId }),
  listRemoteDirectory: (sessionId: string, path: string): Promise<DirectoryListing> =>
    desktopCommand("list_remote_directory", { sessionId, path }),
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
    return isDesktop ? invoke("list_profiles") : readPreviewProfiles();
  },
  async saveProfile(profile: ConnectionProfile): Promise<ConnectionProfile> {
    if (isDesktop) return invoke("save_profile", { profile });
    const safeProfile: ConnectionProfile = {
      id: profile.id, name: profile.name, host: profile.host, port: profile.port,
      username: profile.username, authMethod: profile.authMethod,
      privateKeyPath: profile.authMethod === "privateKey" ? profile.privateKeyPath : null,
      remotePath: profile.remotePath,
    };
    const profiles = readPreviewProfiles().filter((item) => item.id !== profile.id);
    localStorage.setItem(previewStorageKey, JSON.stringify([...profiles, safeProfile]));
    return safeProfile;
  },
  async deleteProfile(id: string): Promise<void> {
    if (isDesktop) return invoke("delete_profile", { id });
    localStorage.setItem(previewStorageKey, JSON.stringify(readPreviewProfiles().filter((item) => item.id !== id)));
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
