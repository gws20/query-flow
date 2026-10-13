import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEffectiveUploadDirectoryHandle,
  loadOutputDestinationConfig,
  resetUploadSourceToDefault,
  saveFileToDestination,
  saveOutputDestinationConfig,
  saveUploadSourceConfig,
  setMemoryDirectoryHandle,
  setMemoryUploadDirectoryHandle,
  writeBufferToDirectoryHandle,
} from "./output-destination";

describe("output destination service", () => {
  const store: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    setMemoryDirectoryHandle(null);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(store, items);
          }),
        },
      },
      downloads: {
        download: vi.fn(async () => 1),
      },
    });
  });

  it("defaults to downloads mode and persists custom-folder configuration", async () => {
    expect(await loadOutputDestinationConfig()).toEqual({ mode: "downloads" });
    await saveOutputDestinationConfig({ mode: "custom-folder", folderName: "Hasil_BPS" });
    expect(await loadOutputDestinationConfig()).toEqual({
      mode: "custom-folder",
      folderName: "Hasil_BPS",
    });
  });

  it("creates nested subdirectories and writes file buffer when saving to a directory handle", async () => {
    const writtenChunks: Uint8Array[] = [];
    const close = vi.fn(async () => {});
    const write = vi.fn(async (data: Uint8Array) => {
      writtenChunks.push(data);
    });
    const getFileHandle = vi.fn(async () => ({
      createWritable: async () => ({ write, close }),
    }));

    const dirs: string[] = [];
    const mockDirHandle: FileSystemDirectoryHandle = {
      kind: "directory",
      name: "RootFolder",
      getDirectoryHandle: vi.fn(async (name: string) => {
        dirs.push(name);
        return mockDirHandle;
      }),
      getFileHandle,
    } as unknown as FileSystemDirectoryHandle;

    const payload = new Uint8Array([1, 2, 3, 4]);
    await writeBufferToDirectoryHandle(
      mockDirHandle,
      "2026-10-13/Mikro/Kategori A/[Tabel 1a] Judul.xlsx",
      payload,
    );

    expect(dirs).toEqual(["2026-10-13", "Mikro", "Kategori A"]);
    expect(getFileHandle).toHaveBeenCalledWith("[Tabel 1a] Judul.xlsx", { create: true });
    expect(writtenChunks[0]).toEqual(payload);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("routes saveFileToDestination to custom folder when mode is custom-folder", async () => {
    await saveOutputDestinationConfig({ mode: "custom-folder", folderName: "TargetDir" });
    const write = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const mockHandle = {
      kind: "directory",
      name: "TargetDir",
      getDirectoryHandle: vi.fn(async () => mockHandle),
      getFileHandle: vi.fn(async () => ({
        createWritable: async () => ({ write, close }),
      })),
    } as unknown as FileSystemDirectoryHandle;

    setMemoryDirectoryHandle(mockHandle);
    await saveFileToDestination("Sub/hasil.xlsx", new Uint8Array([9, 8]), "application/octet-stream");

    expect(mockHandle.getDirectoryHandle).toHaveBeenCalledWith("Sub", { create: true });
    expect(mockHandle.getFileHandle).toHaveBeenCalledWith("hasil.xlsx", { create: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("resolves upload source handle defaulting to output folder or custom upload folder", async () => {
    const mockOutputHandle = {
      kind: "directory",
      name: "OutputFolder",
    } as unknown as FileSystemDirectoryHandle;

    const mockCustomUploadHandle = {
      kind: "directory",
      name: "CustomUploadFolder",
    } as unknown as FileSystemDirectoryHandle;

    setMemoryDirectoryHandle(mockOutputHandle);
    await saveOutputDestinationConfig({ mode: "custom-folder", folderName: "OutputFolder" });

    // 1. By default, follows output folder
    const defInfo = await getEffectiveUploadDirectoryHandle();
    expect(defInfo.isCustomUpload).toBe(false);
    expect(defInfo.handle?.name).toBe("OutputFolder");
    expect(defInfo.folderName).toBe("OutputFolder");

    // 2. Set custom upload source
    setMemoryUploadDirectoryHandle(mockCustomUploadHandle);
    await saveUploadSourceConfig({ useDefaultOutput: false, folderName: "CustomUploadFolder" });

    const customInfo = await getEffectiveUploadDirectoryHandle();
    expect(customInfo.isCustomUpload).toBe(true);
    expect(customInfo.handle?.name).toBe("CustomUploadFolder");
    expect(customInfo.folderName).toBe("CustomUploadFolder");

    // 3. Reset back to default
    await resetUploadSourceToDefault();
    const resetInfo = await getEffectiveUploadDirectoryHandle();
    expect(resetInfo.isCustomUpload).toBe(false);
    expect(resetInfo.handle?.name).toBe("OutputFolder");
  });
});
