import type { LocalFileNode } from "../types";

export class DirectoryPermissionRequiredError extends Error {
  constructor(message = "Izin akses folder diperlukan untuk membaca file lokal.") {
    super(message);
    this.name = "DirectoryPermissionRequiredError";
  }
}

/** Queries read or readwrite permission on a directory handle without triggering a prompt */
export async function checkDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "read",
): Promise<PermissionState> {
  const permHandle = handle as unknown as {
    queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };
  if (typeof permHandle.queryPermission === "function") {
    try {
      return await permHandle.queryPermission({ mode });
    } catch {
      return "prompt";
    }
  }
  return "granted";
}

/** Requests permission with a browser prompt; must be triggered from a user gesture */
export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "read",
): Promise<PermissionState> {
  const permHandle = handle as unknown as {
    requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  };
  if (typeof permHandle.requestPermission === "function") {
    try {
      return await permHandle.requestPermission({ mode });
    } catch {
      return "denied";
    }
  }
  return "granted";
}

/** Extracts child entries from FileSystemDirectoryHandle across different Chromium iterator implementations */
async function getDirectoryEntries(handle: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
  const entries: FileSystemHandle[] = [];
  const anyHandle = handle as unknown as {
    values?: () => AsyncIterable<FileSystemHandle>;
    entries?: () => AsyncIterable<[string, FileSystemHandle]>;
    [Symbol.asyncIterator]?: () => AsyncIterable<FileSystemHandle | [string, FileSystemHandle]>;
  };

  if (typeof anyHandle.values === "function") {
    for await (const entry of anyHandle.values()) {
      entries.push(entry);
    }
    return entries;
  }

  if (typeof anyHandle.entries === "function") {
    for await (const [, entry] of anyHandle.entries()) {
      entries.push(entry);
    }
    return entries;
  }

  if (typeof anyHandle[Symbol.asyncIterator] === "function") {
    for await (const item of anyHandle[Symbol.asyncIterator]!()) {
      if (Array.isArray(item) && item[1]) {
        entries.push(item[1]);
      } else if (item && typeof (item as FileSystemHandle).kind === "string") {
        entries.push(item as FileSystemHandle);
      }
    }
    return entries;
  }

  return entries;
}

/** Reads a recursive tree of files and directories from a FileSystemDirectoryHandle */
export async function readLocalDirectoryTree(
  handle: FileSystemDirectoryHandle,
  currentRelPath = "",
  maxDepth = 6,
): Promise<LocalFileNode> {
  const rootNode: LocalFileNode = {
    name: handle.name,
    relativePath: currentRelPath,
    isDirectory: true,
    children: [],
  };

  if (maxDepth <= 0) return rootNode;

  // Check read permission if available
  const permState = await checkDirectoryPermission(handle, "read");
  if (permState !== "granted") {
    throw new DirectoryPermissionRequiredError(
      `Akses baca ke folder "${handle.name}" belum diizinkan oleh browser.`
    );
  }

  let childHandles: FileSystemHandle[] = [];
  try {
    childHandles = await getDirectoryEntries(handle);
  } catch (error) {
    if (
      (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) ||
      (error instanceof Error && error.name === "NotAllowedError")
    ) {
      throw new DirectoryPermissionRequiredError(
        `Akses baca ke folder "${handle.name}" ditolak atau memerlukan konfirmasi ulang.`
      );
    }
    throw error;
  }

  const entries: LocalFileNode[] = [];
  for (const entry of childHandles) {
    const itemRelPath = currentRelPath ? `${currentRelPath}/${entry.name}` : entry.name;
    if (entry.kind === "file") {
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        entries.push({
          name: entry.name,
          relativePath: itemRelPath,
          isDirectory: false,
          size: file.size,
        });
      } catch {
        entries.push({
          name: entry.name,
          relativePath: itemRelPath,
          isDirectory: false,
        });
      }
    } else if (entry.kind === "directory") {
      const subDirHandle = entry as FileSystemDirectoryHandle;
      const subTree = await readLocalDirectoryTree(subDirHandle, itemRelPath, maxDepth - 1);
      entries.push(subTree);
    }
  }

  // Sort: folders first, then alphabetical (natural number ordering)
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  rootNode.children = entries;
  return rootNode;
}

/** Traverses a relative path down the root handle and returns the binary content */
export async function readLocalFileBytes(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<Uint8Array> {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("Path file kosong.");

  let currentDir = rootHandle;
  for (let i = 0; i < segments.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(segments[i]!);
  }

  const fileName = segments[segments.length - 1]!;
  const fileHandle = await currentDir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Flattens all file nodes under a given tree node */
export function collectAllFilesFromNode(
  node: LocalFileNode,
): { name: string; relativePath: string; size?: number }[] {
  if (!node.isDirectory) {
    return [{ name: node.name, relativePath: node.relativePath, size: node.size }];
  }
  const result: { name: string; relativePath: string; size?: number }[] = [];
  if (node.children) {
    for (const child of node.children) {
      result.push(...collectAllFilesFromNode(child));
    }
  }
  return result;
}
