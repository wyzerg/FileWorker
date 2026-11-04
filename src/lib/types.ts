export type AuthMethod = "password" | "privateKey";

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath: string | null;
  remotePath: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number | null;
  modifiedMs: number | null;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  entries: FileEntry[];
  warnings: string[];
}

export interface RuntimeEnvironment {
  homePath: string | null;
  shortcuts: { name: string; path: string }[];
  runtime: "desktop" | "browser";
}

export type SortKey = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";

export interface HostProbe {
  attemptId: string;
  host: string;
  port: number;
  identity: { algorithm: string; fingerprint: string };
  trusted: boolean;
}

export interface ConnectedSession {
  sessionId: string;
  profileId: string;
  initialPath: string;
  warning: string | null;
}

export interface ConnectionAttempt {
  id: string;
  profile: ConnectionProfile;
  phase: "probing" | "trust" | "auth";
  probe?: HostProbe;
}

export type TransferDirection = "upload" | "download";
export type TransferState = "queued" | "running" | "canceling" | "conflict" | "completed" | "failed" | "canceled" | "skipped";
export type ConflictPolicy = "skip" | "overwrite" | "keepBoth";
export interface TransferRequest {
  sessionId: string;
  direction: TransferDirection;
  sourcePath: string;
  destinationDir: string;
}
export interface TransferJob extends TransferRequest {
  id: string;
  name: string;
  attempt: number;
  destinationPath: string | null;
  state: TransferState;
  transferredBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error: string | null;
  warning: string | null;
}
export interface TransferSnapshot {
  revision: number;
  concurrency: number;
  jobs: TransferJob[];
}
