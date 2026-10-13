import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCheckpoint,
  clearGroupCheckpoints,
  getCheckpoint,
  getCheckpointKey,
  markCheckpointCompleted,
  saveCheckpoint,
} from "./checkpoint";

describe("checkpoint service", () => {
  const storageMock: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(storageMock)) delete storageMock[key];
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storageMock[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(storageMock, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete storageMock[k];
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("generates deterministic keys including wilayah filter", () => {
    const key1 = getCheckpointKey("Agregat/A/1.sql", { level1: ["35"], level2: [] });
    const key2 = getCheckpointKey("Agregat/A/1.sql", { level1: ["35"], level2: ["3507"] });
    expect(key1).not.toBe(key2);
    expect(key1).toContain("Agregat/A/1.sql");
  });

  it("saves, retrieves, and updates checkpoints", async () => {
    const cp = await saveCheckpoint("Agregat/A/1.sql", {
      lastOffset: 18000,
      totalRows: 18000,
      partsDownloaded: 0,
    });
    expect(cp.lastOffset).toBe(18000);
    expect(cp.completed).toBe(false);

    const fetched = await getCheckpoint("Agregat/A/1.sql");
    expect(fetched?.lastOffset).toBe(18000);
    expect(fetched?.totalRows).toBe(18000);

    await markCheckpointCompleted("Agregat/A/1.sql", 54000, 1);
    const completed = await getCheckpoint("Agregat/A/1.sql");
    expect(completed?.completed).toBe(true);
    expect(completed?.totalRows).toBe(54000);
    expect(completed?.partsDownloaded).toBe(1);
  });

  it("clears single and group checkpoints", async () => {
    await saveCheckpoint("a.sql", { lastOffset: 10, totalRows: 10 });
    await saveCheckpoint("b.sql", { lastOffset: 20, totalRows: 20 });
    expect(await getCheckpoint("a.sql")).not.toBeNull();

    await clearCheckpoint("a.sql");
    expect(await getCheckpoint("a.sql")).toBeNull();
    expect(await getCheckpoint("b.sql")).not.toBeNull();

    await clearGroupCheckpoints([{ path: "b.sql" }]);
    expect(await getCheckpoint("b.sql")).toBeNull();
  });
});
