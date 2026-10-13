import JSZip from "jszip";
import { ChunkedExport, EXPORT_CHECKPOINT_ROWS, MAX_EXPORT_BYTES } from "./chunked-export";
import { downloadStandardWorkbook, serializeWorkbook, workbookFilename, type QueryResult } from "./excel";
import { loadOutputDestinationConfig, saveFileToDestination } from "./output-destination";
import { sanitizePathSegment } from "./standard-naming";

type ArchiveEntry = { name: string; excelPath: string; bytes: Uint8Array };
type ArchiveDownload = (filename: string, bytes: Uint8Array) => Promise<void>;
type WorkbookSerialize = (results: QueryResult[]) => Promise<Uint8Array>;

export interface SplitExportOptions {
  checkpointRows?: number;
  maxWorkbookBytes?: number;
  maxArchiveBytes?: number;
  preserveDirectoryPath?: boolean;
  archiveMode?: "zip" | "excel";
  serialize?: WorkbookSerialize;
  downloadArchive?: ArchiveDownload;
  downloadWorkbook?: ArchiveDownload;
}

export interface FolderExportOutput {
  readonly totalRows: number;
  readonly parts: number;
  append(result: QueryResult): Promise<void>;
  flush(final: boolean, partial?: boolean, reason?: string): Promise<void>;
}

export function validateSplitColumnInputs(first: string, second: string): string | null {
  const normalizedFirst = first.trim().toLocaleLowerCase();
  const normalizedSecond = second.trim().toLocaleLowerCase();
  if (!normalizedFirst && normalizedSecond) return "Isi kolom pisah pertama sebelum kolom kedua.";
  if (normalizedFirst && normalizedSecond && normalizedFirst === normalizedSecond) {
    return "Kolom pisah pertama dan kedua harus berbeda.";
  }
  return null;
}

export function resolveSplitColumnIndexes(columns: string[], requested: string[], filename: string): number[] {
  return requested.map((requestedName) => {
    const normalizedName = requestedName.trim().toLocaleLowerCase();
    const matches = columns.flatMap((column, index) =>
      column.trim().toLocaleLowerCase() === normalizedName ? [index] : [],
    );
    if (matches.length === 0) {
      const available = columns.length ? columns.join(", ") : "(tidak ada)";
      throw new Error(`Kolom pembagi "${requestedName}" tidak ditemukan pada ${filename}. Header tersedia: ${available}.`);
    }
    if (matches.length > 1) {
      throw new Error(`Kolom pembagi "${requestedName}" ambigu pada ${filename}; header hasil mengandung nama duplikat.`);
    }
    return matches[0]!;
  });
}

function valueIdentity(value: unknown): unknown[] {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return ["blank"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "number") return ["number", Number.isNaN(value) ? "NaN" : String(value)];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  try {
    return ["object", JSON.stringify(value) ?? String(value)];
  } catch {
    return ["object", String(value)];
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return "(blank)";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "blank";
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function safeWorkbookPath(path: string): string {
  return path.replace(/\.xlsx$/i, "").replace(/[^a-z0-9_-]/gi, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "hasil";
}

async function downloadArchive(filename: string, bytes: Uint8Array): Promise<void> {
  await saveFileToDestination(filename, bytes, "application/zip");
}

/** Routes result rows into per-value workbooks and downloads bounded ZIP checkpoints or direct Excel files. */
export class SplitChunkedExport implements FolderExportOutput {
  private readonly requestedColumns: string[];
  private readonly groups = new Map<string, { output: ChunkedExport }>();
  private readonly usedWorkbookPaths = new Set<string>();
  private readonly usedSplitFolders = new Set<string>();
  private readonly indexesByFile = new Map<string, { headers: string[]; indexes: number[] }>();
  private readonly pendingEntries: ArchiveEntry[] = [];
  private readonly archiveNames: string[] = [];
  private readonly preserveDirectoryPath: boolean;
  private readonly workbookBase: string;
  private readonly archivePrefix: string;
  private readonly checkpointRows: number;
  private readonly maxWorkbookBytes: number;
  private readonly maxArchiveBytes: number;
  private readonly archiveMode?: "zip" | "excel";
  private readonly hasCustomArchiveDownload: boolean;
  private readonly serialize: WorkbookSerialize;
  private readonly archiveDownload: ArchiveDownload;
  private readonly workbookDownload: ArchiveDownload;
  private checkpointRowCount = 0;
  totalRows = 0;
  parts = 0;

  constructor(
    path: string,
    private readonly runId: string,
    columns: string[],
    options: SplitExportOptions = {},
  ) {
    this.requestedColumns = columns.map((column) => column.trim()).filter(Boolean);
    if (this.requestedColumns.length < 1 || this.requestedColumns.length > 2) {
      throw new Error("Pilih satu atau dua kolom pembagi.");
    }
    const configError = validateSplitColumnInputs(this.requestedColumns[0] ?? "", this.requestedColumns[1] ?? "");
    if (configError) throw new Error(configError);
    this.preserveDirectoryPath = Boolean(options.preserveDirectoryPath);
    if (this.preserveDirectoryPath) {
      const cleaned = path.replace(/\.xlsx$/i, "");
      const lastSlash = cleaned.lastIndexOf("/");
      const fileStem = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
      this.workbookBase = workbookFilename(fileStem).replace(/\.xlsx$/i, "");
      this.archivePrefix = cleaned;
    } else {
      this.workbookBase = workbookFilename(path).replace(/\.xlsx$/i, "");
      this.archivePrefix = this.workbookBase;
    }
    this.checkpointRows = options.checkpointRows ?? EXPORT_CHECKPOINT_ROWS;
    this.maxWorkbookBytes = options.maxWorkbookBytes ?? MAX_EXPORT_BYTES;
    this.maxArchiveBytes = options.maxArchiveBytes ?? MAX_EXPORT_BYTES + 64 * 1024;
    this.archiveMode = options.archiveMode;
    this.hasCustomArchiveDownload = Boolean(options.downloadArchive);
    this.serialize = options.serialize ?? serializeWorkbook;
    this.archiveDownload = options.downloadArchive ?? downloadArchive;
    this.workbookDownload = options.downloadWorkbook ?? downloadStandardWorkbook;
  }

  validateHeaders(filename: string, columns: string[]): void {
    const normalizedHeaders = columns.map((column) => column.trim().toLocaleLowerCase());
    const previous = this.indexesByFile.get(filename);
    if (previous) {
      if (JSON.stringify(previous.headers) !== JSON.stringify(normalizedHeaders)) {
        throw new Error(`Header hasil berubah selama pagination pada ${filename}.`);
      }
      return;
    }
    const indexes = resolveSplitColumnIndexes(columns, this.requestedColumns, filename);
    this.indexesByFile.set(filename, { headers: normalizedHeaders, indexes });
  }

  async append(result: QueryResult): Promise<void> {
    this.validateHeaders(result.filename, result.columns);
    const indexes = this.indexesByFile.get(result.filename)?.indexes;
    if (!indexes) throw new Error(`Header hasil tidak tervalidasi pada ${result.filename}.`);
    if (result.rows.length === 0) return;

    const groupedRows = new Map<string, { values: unknown[]; rows: unknown[][] }>();
    for (const row of result.rows) {
      const values = indexes.map((index) => row[index] ?? null);
      const key = JSON.stringify(values.map(valueIdentity));
      const groupRows = groupedRows.get(key) ?? { values, rows: [] };
      groupRows.rows.push(row);
      groupedRows.set(key, groupRows);
    }

    for (const [key, groupRows] of groupedRows) {
      let group = this.groups.get(key);
      if (!group) {
        const label = groupRows.values.map(displayValue).map(slug).join("_").slice(0, 40) || "blank";
        const stem = `${this.workbookBase.slice(0, 40)}_${label}_${hashKey(key)}`;
        let path = stem;
        let collisionIndex = 2;
        while (this.usedWorkbookPaths.has(path)) path = `${stem}_${collisionIndex++}`;
        this.usedWorkbookPaths.add(path);

        const folderSegments = groupRows.values.map((val) => sanitizePathSegment(displayValue(val)) || "blank");
        const baseSplitFolder = folderSegments.join("/");
        let splitFolder = baseSplitFolder;
        let folderCollisionIndex = 2;
        while (this.usedSplitFolders.has(splitFolder)) {
          splitFolder = `${baseSplitFolder}_${folderCollisionIndex++}`;
        }
        this.usedSplitFolders.add(splitFolder);

        const output = new ChunkedExport(
          path,
          async (workbookPath, bytes) => {
            const partSuffix = workbookPath.slice(path.length);
            const baseRelPath = this.preserveDirectoryPath ? this.archivePrefix : this.workbookBase;
            const excelPath = `${splitFolder}/${baseRelPath}${partSuffix}.xlsx`;
            this.pendingEntries.push({
              name: `${safeWorkbookPath(workbookPath)}.xlsx`,
              excelPath,
              bytes,
            });
          },
          this.maxWorkbookBytes,
          this.serialize,
        );
        group = { output };
        this.groups.set(key, group);
      }
      await group.output.append({ ...result, rows: groupRows.rows });
    }

    this.totalRows += result.rows.length;
    this.checkpointRowCount += result.rows.length;
    if (this.checkpointRows > 0 && this.checkpointRowCount >= this.checkpointRows) {
      await this.flush(false);
      this.checkpointRowCount = 0;
    }
  }

  async flush(final: boolean, partial = false, reason?: string): Promise<void> {
    for (const group of this.groups.values()) {
      await group.output.flush(final, partial);
    }
    await this.writeArchives(final, partial, reason);
    if (!final) this.checkpointRowCount = 0;
  }

  private async writeArchives(final: boolean, partial: boolean, reason?: string): Promise<void> {
    const effectiveMode =
      this.archiveMode ??
      (!this.hasCustomArchiveDownload && (await loadOutputDestinationConfig()).mode === "custom-folder"
        ? "excel"
        : "zip");

    if (effectiveMode === "excel") {
      while (this.pendingEntries.length > 0) {
        const entry = this.pendingEntries.shift()!;
        await this.workbookDownload(entry.excelPath, entry.bytes);
        this.parts++;
      }
      return;
    }

    const batches: ArchiveEntry[][] = [];
    let current: ArchiveEntry[] = [];
    let currentBytes = 0;
    for (const entry of this.pendingEntries) {
      if (current.length > 0 && currentBytes + entry.bytes.byteLength > this.maxArchiveBytes) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(entry);
      currentBytes += entry.bytes.byteLength;
    }
    if (current.length > 0) batches.push(current);
    if (final && batches.length === 0) batches.push([]);

    for (const [index, batch] of batches.entries()) {
      const isLast = index === batches.length - 1;
      const status = final && isLast ? (partial ? "incomplete" : "complete") : "in_progress";
      const archive = new JSZip();
      for (const entry of batch) archive.file(entry.name, entry.bytes, { binary: true });
      const filename = `${this.archivePrefix}_run-${this.runId}_part-${String(this.parts + 1).padStart(3, "0")}.zip`;
      archive.file("manifest.json", JSON.stringify({
        runId: this.runId,
        status,
        part: this.parts + 1,
        rowsCollected: this.totalRows,
        workbooks: batch.map((entry) => entry.name),
        previousArchives: [...this.archiveNames],
        ...(partial && reason ? { failure: reason } : {}),
      }, null, 2));
      const bytes = await archive.generateAsync({ type: "uint8array", compression: "STORE" });
      await this.archiveDownload(filename, bytes);
      this.archiveNames.push(filename);
      this.parts++;
      this.pendingEntries.splice(0, batch.length);
    }
  }
}
