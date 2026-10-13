import type { WilayahConfig } from "../types";

export interface QueryCheckpoint {
  key: string;
  filePath: string;
  lastOffset: number;
  totalRows: number;
  partsDownloaded: number;
  completed: boolean;
  updatedAt: string;
}

const STORAGE_PREFIX = "qf_cp:";

export function getCheckpointKey(filePath: string, wilayah?: WilayahConfig): string {
  const l1 = (wilayah?.level1 ?? []).join(",");
  const l2 = (wilayah?.level2 ?? []).join(",");
  return `${STORAGE_PREFIX}${filePath}#l1:${l1}#l2:${l2}`;
}

export async function getCheckpoint(
  filePath: string,
  wilayah?: WilayahConfig,
): Promise<QueryCheckpoint | null> {
  const key = getCheckpointKey(filePath, wilayah);
  if (!chrome.storage?.local) return null;
  const data = await chrome.storage.local.get(key);
  return (data[key] as QueryCheckpoint) ?? null;
}

export async function saveCheckpoint(
  filePath: string,
  data: {
    lastOffset: number;
    totalRows: number;
    partsDownloaded?: number;
    completed?: boolean;
  },
  wilayah?: WilayahConfig,
): Promise<QueryCheckpoint> {
  const key = getCheckpointKey(filePath, wilayah);
  const existing = await getCheckpoint(filePath, wilayah);
  const updated: QueryCheckpoint = {
    key,
    filePath,
    lastOffset: data.lastOffset,
    totalRows: data.totalRows,
    partsDownloaded: data.partsDownloaded ?? existing?.partsDownloaded ?? 0,
    completed: data.completed ?? false,
    updatedAt: new Date().toISOString(),
  };

  if (chrome.storage?.local) {
    await chrome.storage.local.set({ [key]: updated });
  }
  return updated;
}

export async function markCheckpointCompleted(
  filePath: string,
  totalRows: number,
  partsDownloaded: number,
  wilayah?: WilayahConfig,
): Promise<void> {
  await saveCheckpoint(
    filePath,
    {
      lastOffset: totalRows,
      totalRows,
      partsDownloaded,
      completed: true,
    },
    wilayah,
  );
}

export async function clearCheckpoint(
  filePath: string,
  wilayah?: WilayahConfig,
): Promise<void> {
  const key = getCheckpointKey(filePath, wilayah);
  if (chrome.storage?.local) {
    await chrome.storage.local.remove(key);
  }
}

export async function clearGroupCheckpoints(
  files: { path: string }[],
  wilayah?: WilayahConfig,
): Promise<void> {
  const keys = files.map((file) => getCheckpointKey(file.path, wilayah));
  if (chrome.storage?.local && keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
}
