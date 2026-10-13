import type { LocalFileNode, TransdataSession, TransdataUploadProgress } from "../types";
import { readLocalFileBytes, collectAllFilesFromNode } from "./local-tree";
import { clearVerifiedRemoteDirs, uploadRemoteFile } from "./transdata-webdav";

export type FolderMappingMode = "mirror" | "direct-in-target";

export interface UploadOptions {
  remoteBaseFolder?: string; // e.g. "SE2026" or ""
  mappingMode?: FolderMappingMode;
  signal?: AbortSignal;
  onProgress?: (progress: TransdataUploadProgress) => void;
}

export function computeRemotePath(
  localFileRelativePath: string,
  remoteBaseFolder = "",
  mappingMode: FolderMappingMode = "mirror",
  selectedSubfolderRoot = "",
): string {
  const cleanBase = remoteBaseFolder.replace(/^\/+|\/+$/g, "");
  let relPath = localFileRelativePath.replace(/^\/+|\/+$/g, "");

  if (mappingMode === "direct-in-target" && selectedSubfolderRoot) {
    const cleanSub = selectedSubfolderRoot.replace(/^\/+|\/+$/g, "");
    if (relPath.startsWith(cleanSub)) {
      relPath = relPath.slice(cleanSub.length).replace(/^\/+/, "");
    }
  }

  return cleanBase ? `${cleanBase}/${relPath}` : relPath;
}

/** Executes upload of files from local FileSystemDirectoryHandle to Transdata WebDAV */
export async function uploadLocalFilesToTransdata(
  rootHandle: FileSystemDirectoryHandle,
  session: TransdataSession,
  itemsToUpload: LocalFileNode[],
  options: UploadOptions = {},
): Promise<{ totalUploaded: number; errors: string[] }> {
  clearVerifiedRemoteDirs();

  const files: { name: string; relativePath: string; size?: number }[] = [];
  for (const item of itemsToUpload) {
    files.push(...collectAllFilesFromNode(item));
  }

  const totalFiles = files.length;
  if (totalFiles === 0) {
    options.onProgress?.({
      state: "error",
      currentFileIndex: 0,
      totalFiles: 0,
      bytesUploaded: 0,
      message: "Tidak ada file lokal yang ditemukan untuk diunggah.",
    });
    return { totalUploaded: 0, errors: ["Tidak ada file yang ditemukan untuk diunggah."] };
  }

  const errors: string[] = [];
  let totalUploaded = 0;
  let totalBytes = 0;

  for (let index = 0; index < totalFiles; index++) {
    if (options.signal?.aborted) {
      options.onProgress?.({
        state: "cancelled",
        currentFileIndex: index,
        totalFiles,
        bytesUploaded: totalBytes,
        message: "Upload dibatalkan oleh pengguna.",
      });
      break;
    }

    const file = files[index]!;
    const remotePath = computeRemotePath(
      file.relativePath,
      options.remoteBaseFolder ?? "",
      options.mappingMode ?? "mirror",
    );

    options.onProgress?.({
      state: "uploading",
      currentFile: file.name,
      currentFileIndex: index,
      totalFiles,
      bytesUploaded: totalBytes,
      message: `[${index + 1}/${totalFiles}] Mengunggah ${file.name} ke /${remotePath}…`,
    });

    try {
      const bytes = await readLocalFileBytes(rootHandle, file.relativePath);
      await uploadRemoteFile(session, remotePath, bytes, options.signal);
      totalUploaded++;
      totalBytes += bytes.byteLength;

      options.onProgress?.({
        state: "uploading",
        currentFile: file.name,
        currentFileIndex: index + 1,
        totalFiles,
        bytesUploaded: totalBytes,
        message: `✓ [${index + 1}/${totalFiles}] Berhasil: ${file.name}`,
      });
    } catch (uploadError) {
      const msg = uploadError instanceof Error ? uploadError.message : "Gagal upload";
      errors.push(`${file.name}: ${msg}`);
      console.warn("Upload error for file", file.relativePath, uploadError);

      options.onProgress?.({
        state: "uploading",
        currentFile: file.name,
        currentFileIndex: index + 1,
        totalFiles,
        bytesUploaded: totalBytes,
        message: `⚠ [${index + 1}/${totalFiles}] Gagal: ${file.name} (${msg})`,
      });
    }
  }

  const isCompleted = errors.length === 0 && !options.signal?.aborted;
  options.onProgress?.({
    state: isCompleted ? "completed" : errors.length > 0 ? "error" : "cancelled",
    currentFileIndex: totalFiles,
    totalFiles,
    bytesUploaded: totalBytes,
    message: isCompleted
      ? `✓ Selesai: Semua ${totalUploaded} file berhasil diunggah ke Transdata.`
      : `Selesai: ${totalUploaded}/${totalFiles} berhasil diunggah (${errors.length} gagal).`,
  });

  return { totalUploaded, errors };
}
