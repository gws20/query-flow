export const TARGET = {
  origin: "https://git.bps.go.id",
  namespace: "rafifhasabi",
  repository: "query-cleaning-data-sensus-ekonomi-2026",
  defaultBranch: "main",
} as const;

export interface SqlFile {
  name: string;
  path: string;
  content: string;
}

export interface QueryGroup {
  name: string;
  path: string;
  files: SqlFile[];
}

export interface RepositoryInfo {
  name: string;
  namespace: string;
  branch: string;
  commit?: string;
  syncedAt: string;
  sqlCount: number;
}

export interface RepositorySnapshot {
  version: 1;
  repository: RepositoryInfo;
  groups: QueryGroup[];
}

export interface WilayahConfig {
  level1: string[];
  level2: string[];
}

export type SyncPhase =
  | "idle"
  | "connecting"
  | "scanning"
  | "reading"
  | "saving"
  | "success"
  | "error";

export interface SyncProgress {
  phase: SyncPhase;
  message: string;
  current?: number;
  total?: number;
}

export interface SqlRunProgress {
  runId: string;
  path: string;
  iteration: number;
  state: "running" | "completed";
  rowsCollected: number;
  batchRows?: number;
  offset?: number;
  limit?: number;
}

export interface SqlRunOptions {
  startRow?: number;
  maxRows?: number;
}

export interface SqlRunResult {
  ok: boolean;
  message: string;
  columns?: string[];
  rows?: unknown[][];
  partial?: boolean;
}

export interface FolderRunConfig {
  selectedPaths: string[];
  startRow?: number;
  maxRows?: number;
}

export interface TransdataSession {
  userId: string;
  requestToken: string;
  lastDetected?: string;
}

export interface RemoteDavItem {
  name: string;
  path: string; // e.g. "SE2026/3507" or ""
  href: string;
  isDirectory: boolean;
  size?: number;
  lastModified?: string;
}

export interface LocalFileNode {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  children?: LocalFileNode[];
}

export interface TransdataUploadProgress {
  state: "idle" | "uploading" | "completed" | "error" | "cancelled";
  currentFile?: string;
  currentFileIndex: number;
  totalFiles: number;
  bytesUploaded?: number;
  message: string;
}

export type ExtensionMessage =
  | { type: "RUN_SQL_FILE"; path: string; tabId: number; runId: string; offset: number; limit: number; iteration: number }
  | { type: "CLEAR_SQL_RUN"; runId: string; tabId: number }
  | { type: "STOP_SQL_RUN"; runId: string; tabId: number }
  | { type: "SQL_RUN_PROGRESS"; progress: SqlRunProgress }
  | { type: "SYNC_REPOSITORY" }
  | { type: "SYNC_PROGRESS"; progress: SyncProgress }
  | { type: "GITLAB_SCAN" }
  | { type: "TRANSDATA_SESSION_DETECTED"; session: TransdataSession };

export type ScanResult =
  | { ok: true; snapshot: RepositorySnapshot }
  | { ok: false; error: string };

export type SqlChunkResponse =
  | { ok: true; message: string; columns: string[]; rows: unknown[][]; hasMore: boolean; continuation?: boolean; pageSize?: number }
  | { ok: false; message: string };

