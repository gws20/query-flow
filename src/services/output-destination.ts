export type OutputDestinationMode = "downloads" | "custom-folder";

export interface OutputDestinationConfig {
  mode: OutputDestinationMode;
  folderName?: string;
}

export interface UploadSourceConfig {
  useDefaultOutput: boolean;
  folderName?: string;
}

const DESTINATION_STORAGE_KEY = "queryflow.outputDestination";
const UPLOAD_SOURCE_STORAGE_KEY = "queryflow.uploadSourceDestination";
const IDB_NAME = "queryflow-fs-handles";
const IDB_STORE = "handles";
const IDB_KEY = "outputDirectoryHandle";
const IDB_UPLOAD_KEY = "uploadSourceDirectoryHandle";

let cachedDirectoryHandle: FileSystemDirectoryHandle | null = null;
let cachedUploadDirectoryHandle: FileSystemDirectoryHandle | null = null;

function hasStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

export async function loadOutputDestinationConfig(): Promise<OutputDestinationConfig> {
  if (!hasStorage()) return { mode: "downloads" };
  try {
    const stored = await chrome.storage.local.get(DESTINATION_STORAGE_KEY);
    const raw = stored[DESTINATION_STORAGE_KEY] as Partial<OutputDestinationConfig> | undefined;
    if (raw && (raw.mode === "downloads" || raw.mode === "custom-folder")) {
      return {
        mode: raw.mode,
        folderName: typeof raw.folderName === "string" ? raw.folderName : undefined,
      };
    }
  } catch {
    // Fallback to default downloads mode
  }
  return { mode: "downloads" };
}

export async function saveOutputDestinationConfig(config: OutputDestinationConfig): Promise<void> {
  if (!hasStorage()) return;
  await chrome.storage.local.set({ [DESTINATION_STORAGE_KEY]: config });
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB tidak tersedia."));
      return;
    }
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Gagal membuka IndexedDB."));
  });
}

async function saveHandleToIdb(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Gagal menyimpan handle folder."));
    };
  });
}

async function loadHandleFromIdb(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

export function setMemoryDirectoryHandle(handle: FileSystemDirectoryHandle | null): void {
  cachedDirectoryHandle = handle;
}

export function setMemoryUploadDirectoryHandle(handle: FileSystemDirectoryHandle | null): void {
  cachedUploadDirectoryHandle = handle;
}

export async function loadUploadSourceConfig(): Promise<UploadSourceConfig> {
  if (!hasStorage()) return { useDefaultOutput: true };
  try {
    const stored = await chrome.storage.local.get(UPLOAD_SOURCE_STORAGE_KEY);
    const raw = stored[UPLOAD_SOURCE_STORAGE_KEY] as Partial<UploadSourceConfig> | undefined;
    if (raw && typeof raw.useDefaultOutput === "boolean") {
      return {
        useDefaultOutput: raw.useDefaultOutput,
        folderName: typeof raw.folderName === "string" ? raw.folderName : undefined,
      };
    }
  } catch {
    // Fallback
  }
  return { useDefaultOutput: true };
}

export async function saveUploadSourceConfig(config: UploadSourceConfig): Promise<void> {
  if (!hasStorage()) return;
  await chrome.storage.local.set({ [UPLOAD_SOURCE_STORAGE_KEY]: config });
}

async function saveUploadHandleToIdb(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, IDB_UPLOAD_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Gagal menyimpan handle folder upload."));
    };
  });
}

async function loadUploadHandleFromIdb(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_UPLOAD_KEY);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return null;
  }
}

export async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (cachedDirectoryHandle) return cachedDirectoryHandle;
  const loaded = await loadHandleFromIdb();
  if (loaded) cachedDirectoryHandle = loaded;
  return loaded;
}

/**
 * Returns the effective upload source handle.
 * By default, mirrors the output destination folder unless user chose a specific upload folder.
 */
export async function getEffectiveUploadDirectoryHandle(): Promise<{
  handle: FileSystemDirectoryHandle | null;
  folderName: string;
  isCustomUpload: boolean;
}> {
  const uploadCfg = await loadUploadSourceConfig();
  const outputCfg = await loadOutputDestinationConfig();

  if (!uploadCfg.useDefaultOutput) {
    if (cachedUploadDirectoryHandle) {
      return {
        handle: cachedUploadDirectoryHandle,
        folderName: uploadCfg.folderName ?? cachedUploadDirectoryHandle.name,
        isCustomUpload: true,
      };
    }
    const loaded = await loadUploadHandleFromIdb();
    if (loaded) {
      cachedUploadDirectoryHandle = loaded;
      return {
        handle: loaded,
        folderName: uploadCfg.folderName ?? loaded.name,
        isCustomUpload: true,
      };
    }
  }

  // Default: mirrors Section 01 Output Destination folder
  const defaultHandle = await getStoredDirectoryHandle();
  return {
    handle: defaultHandle,
    folderName: outputCfg.folderName ?? defaultHandle?.name ?? "",
    isCustomUpload: false,
  };
}

/** Opens native OS directory picker specifically for upload source */
export async function pickUploadSourceDirectory(): Promise<UploadSourceConfig> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof pickerWindow.showDirectoryPicker !== "function") {
    throw new Error("Browser ini tidak mendukung pemilihan folder langsung (File System Access API).");
  }
  const handle = await pickerWindow.showDirectoryPicker({ mode: "read" });
  cachedUploadDirectoryHandle = handle;
  await saveUploadHandleToIdb(handle).catch(() => undefined);
  const config: UploadSourceConfig = {
    useDefaultOutput: false,
    folderName: handle.name,
  };
  await saveUploadSourceConfig(config);
  return config;
}

/** Resets the upload source to follow the output destination folder default */
export async function resetUploadSourceToDefault(): Promise<UploadSourceConfig> {
  cachedUploadDirectoryHandle = null;
  const config: UploadSourceConfig = {
    useDefaultOutput: true,
  };
  await saveUploadSourceConfig(config);
  return config;
}

/** Opens the native OS directory picker and persists the selected folder handle. */
export async function pickOutputDirectory(): Promise<OutputDestinationConfig> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof pickerWindow.showDirectoryPicker !== "function") {
    throw new Error("Browser ini tidak mendukung pemilihan folder langsung (File System Access API).");
  }
  const handle = await pickerWindow.showDirectoryPicker({ mode: "readwrite" });
  cachedDirectoryHandle = handle;
  await saveHandleToIdb(handle).catch(() => undefined);
  const config: OutputDestinationConfig = {
    mode: "custom-folder",
    folderName: handle.name,
  };
  await saveOutputDestinationConfig(config);
  return config;
}

/**
 * Verifies or requests readwrite permission on the selected custom folder if mode === "custom-folder".
 * Should be called at the start of a Run click handler while user gesture is active.
 */
export async function ensureOutputDirectoryAccess(): Promise<void> {
  const config = await loadOutputDestinationConfig();
  if (config.mode !== "custom-folder") return;

  const handle = await getStoredDirectoryHandle();
  if (!handle) {
    throw new Error("Folder tujuan belum dipilih. Klik 'Pilih Folder…' pada pengaturan Tujuan Output di bagian atas.");
  }

  const permHandle = handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
    requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };

  if (typeof permHandle.queryPermission === "function") {
    const state = await permHandle.queryPermission({ mode: "readwrite" });
    if (state === "granted") return;
  }
  if (typeof permHandle.requestPermission === "function") {
    const requested = await permHandle.requestPermission({ mode: "readwrite" });
    if (requested !== "granted") {
      throw new Error(`Izin tulis ke folder "${handle.name}" ditolak. Pilih ulang folder atau ganti ke mode Download Browser.`);
    }
  }
}

/** Writes a file buffer to a nested relative path inside a FileSystemDirectoryHandle. */
export async function writeBufferToDirectoryHandle(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const cleanSegments = relativePath
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (cleanSegments.length === 0) {
    throw new Error("Nama file tujuan kosong.");
  }

  let currentDir = rootHandle;
  for (let i = 0; i < cleanSegments.length - 1; i++) {
    const dirName = cleanSegments[i]!;
    currentDir = await currentDir.getDirectoryHandle(dirName, { create: true });
  }

  const fileName = cleanSegments[cleanSegments.length - 1]!;
  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(new Uint8Array(bytes));
  } finally {
    await writable.close();
  }
}

/**
 * Saves a file either directly to the user's chosen local folder (if "custom-folder" mode is active)
 * or via chrome.downloads.download (if "downloads" mode is active).
 */
export async function saveFileToDestination(
  relativePath: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  const config = await loadOutputDestinationConfig();
  if (config.mode === "custom-folder") {
    const handle = await getStoredDirectoryHandle();
    if (!handle) {
      throw new Error("Folder tujuan belum dipilih. Silakan pilih folder tujuan di bagian atas terlebih dahulu.");
    }
    await writeBufferToDirectoryHandle(handle, relativePath, bytes);
    return;
  }

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
  try {
    await chrome.downloads.download({
      url,
      filename: relativePath,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
