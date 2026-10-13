import { describe, expect, it, vi } from "vitest";
import {
  checkDirectoryPermission,
  collectAllFilesFromNode,
  DirectoryPermissionRequiredError,
  readLocalDirectoryTree,
  readLocalFileBytes,
  requestDirectoryPermission,
} from "./local-tree";
import type { LocalFileNode } from "../types";

describe("local-tree service", () => {
  it("checks and requests directory permissions", async () => {
    const mockHandle = {
      name: "TestFolder",
      queryPermission: vi.fn(async () => "prompt"),
      requestPermission: vi.fn(async () => "granted"),
    } as unknown as FileSystemDirectoryHandle;

    expect(await checkDirectoryPermission(mockHandle, "read")).toBe("prompt");
    expect(await requestDirectoryPermission(mockHandle, "read")).toBe("granted");
  });

  it("throws DirectoryPermissionRequiredError if permission is not granted", async () => {
    const mockHandle = {
      name: "LockedFolder",
      queryPermission: vi.fn(async () => "prompt"),
    } as unknown as FileSystemDirectoryHandle;

    await expect(readLocalDirectoryTree(mockHandle)).rejects.toThrow(DirectoryPermissionRequiredError);
  });

  it("reads recursive directory tree using values iterator and sorts folders first", async () => {
    const file1 = {
      kind: "file",
      name: "2_data.xlsx",
      getFile: vi.fn(async () => ({ size: 2048 })),
    };
    const file2 = {
      kind: "file",
      name: "10_data.xlsx",
      getFile: vi.fn(async () => ({ size: 4096 })),
    };
    const subSubFile = {
      kind: "file",
      name: "child.xlsx",
      getFile: vi.fn(async () => ({ size: 1024 })),
    };
    const subDir = {
      kind: "directory",
      name: "SubFolder",
      queryPermission: vi.fn(async () => "granted"),
      values: async function* () {
        yield subSubFile;
      },
    };

    const rootHandle = {
      name: "Root",
      queryPermission: vi.fn(async () => "granted"),
      values: async function* () {
        yield file2;
        yield subDir;
        yield file1;
      },
    } as unknown as FileSystemDirectoryHandle;

    const tree = await readLocalDirectoryTree(rootHandle);

    expect(tree.name).toBe("Root");
    expect(tree.isDirectory).toBe(true);
    expect(tree.children?.length).toBe(3);

    // SubFolder should be first (folders before files)
    expect(tree.children?.[0]?.name).toBe("SubFolder");
    expect(tree.children?.[0]?.isDirectory).toBe(true);
    expect(tree.children?.[0]?.children?.[0]?.name).toBe("child.xlsx");
    expect(tree.children?.[0]?.children?.[0]?.relativePath).toBe("SubFolder/child.xlsx");

    // Files sorted naturally: 2_data.xlsx before 10_data.xlsx
    expect(tree.children?.[1]?.name).toBe("2_data.xlsx");
    expect(tree.children?.[1]?.relativePath).toBe("2_data.xlsx");
    expect(tree.children?.[1]?.size).toBe(2048);
    expect(tree.children?.[2]?.name).toBe("10_data.xlsx");
    expect(tree.children?.[2]?.relativePath).toBe("10_data.xlsx");
  });

  it("supports entries iterator as fallback", async () => {
    const file = {
      kind: "file",
      name: "tabel.xlsx",
      getFile: vi.fn(async () => ({ size: 500 })),
    };
    const handle = {
      name: "FallbackDir",
      queryPermission: vi.fn(async () => "granted"),
      entries: async function* () {
        yield ["tabel.xlsx", file];
      },
    } as unknown as FileSystemDirectoryHandle;

    const tree = await readLocalDirectoryTree(handle);
    expect(tree.children?.length).toBe(1);
    expect(tree.children?.[0]?.name).toBe("tabel.xlsx");
  });

  it("collectAllFilesFromNode flattens nested hierarchy", () => {
    const mockTree: LocalFileNode = {
      name: "Root",
      relativePath: "",
      isDirectory: true,
      children: [
        {
          name: "Wilayah_33",
          relativePath: "Wilayah_33",
          isDirectory: true,
          children: [
            {
              name: "file1.xlsx",
              relativePath: "Wilayah_33/file1.xlsx",
              isDirectory: false,
              size: 100,
            },
          ],
        },
        {
          name: "root_file.xlsx",
          relativePath: "root_file.xlsx",
          isDirectory: false,
          size: 200,
        },
      ],
    };

    const files = collectAllFilesFromNode(mockTree);
    expect(files).toEqual([
      { name: "file1.xlsx", relativePath: "Wilayah_33/file1.xlsx", size: 100 },
      { name: "root_file.xlsx", relativePath: "root_file.xlsx", size: 200 },
    ]);
  });

  it("reads local file bytes traversing subdirectories", async () => {
    const mockBytes = new Uint8Array([10, 20, 30]);
    const mockFileHandle = {
      getFile: vi.fn(async () => ({
        arrayBuffer: async () => mockBytes.buffer,
      })),
    };
    const mockSubDirHandle = {
      getFileHandle: vi.fn(async (name: string) => {
        expect(name).toBe("hasil.xlsx");
        return mockFileHandle;
      }),
    };
    const mockRootHandle = {
      getDirectoryHandle: vi.fn(async (dirName: string) => {
        expect(dirName).toBe("Kab_01");
        return mockSubDirHandle;
      }),
    } as unknown as FileSystemDirectoryHandle;

    const bytes = await readLocalFileBytes(mockRootHandle, "Kab_01/hasil.xlsx");
    expect(Array.from(bytes)).toEqual([10, 20, 30]);
  });
});
