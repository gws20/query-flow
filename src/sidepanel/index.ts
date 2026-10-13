import "./style.css";
import packageJson from "../../package.json";
import { ChunkedExport, StreamingChunkedExport, collectQuery, EXPORT_CHECKPOINT_ROWS } from "../services/chunked-export";
import { SplitChunkedExport, validateSplitColumnInputs, type FolderExportOutput } from "../services/split-export";
import { applyWilayahConfig, extractSqlTitle, formatRunProgress } from "../services/sql";
import { downloadStandardWorkbook } from "../services/excel";
import { buildStandardDownloadPath } from "../services/standard-naming";
import {
  ensureOutputDirectoryAccess,
  getEffectiveUploadDirectoryHandle,
  loadOutputDestinationConfig,
  pickOutputDirectory,
  pickUploadSourceDirectory,
  resetUploadSourceToDefault,
  saveOutputDestinationConfig,
  type OutputDestinationConfig,
} from "../services/output-destination";
import {
  getCheckpoint,
  saveCheckpoint,
  markCheckpointCompleted,
  clearCheckpoint,
  clearGroupCheckpoints,
} from "../services/checkpoint";
import {
  loadFolderConfigs,
  loadSnapshot,
  loadWilayah,
  saveFolderConfigs,
  saveSnapshot,
  saveWilayah,
  type StoredFolderConfig,
} from "../services/storage";
import { groupSqlFiles, isSqlPath } from "../services/repository-sync/files";
import { addWilayahCode, validateWilayah } from "../services/wilayah";
import { detectTransdataSessionFromTabs, getTransdataTabId, loadTransdataSession } from "../services/transdata-session";
import {
  checkDirectoryPermission,
  DirectoryPermissionRequiredError,
  readLocalDirectoryTree,
  requestDirectoryPermission,
} from "../services/local-tree";
import { createRemoteDirectory, listRemoteDirectory } from "../services/transdata-webdav";
import { uploadLocalFilesToTransdata } from "../services/transdata-upload";
import {
  TARGET,
  type ExtensionMessage,
  type LocalFileNode,
  type RemoteDavItem,
  type RepositorySnapshot,
  type ScanResult,
  type SqlFile,
  type SqlRunProgress,
  type SqlChunkResponse,
  type SyncProgress,
  type TransdataSession,
  type TransdataUploadProgress,
  type WilayahConfig,
} from "../types";

let folderRunning = false;
let transdataSession: TransdataSession | null = null;
let currentRemoteDavPath = "";
let localTreeData: LocalFileNode | null = null;
let remoteDavItems: RemoteDavItem[] = [];
let uploadRunning = false;
let activeUploadController: AbortController | null = null;
let snapshot: RepositorySnapshot | null = null;
let wilayah: WilayahConfig = { level1: [], level2: [] };
let folderConfigs: Record<string, StoredFolderConfig> = {};
let outputDest: OutputDestinationConfig = { mode: "downloads" };
let outputDestError = "";
let progress: SyncProgress = { phase: "idle", message: "Not synced" };
let wilayahError = "";
const runProgressTargets = new Map<string, (progress: SqlRunProgress) => void>();

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /extension context invalidated/i.test(error.message);
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container is missing.");

app.innerHTML = `
  <main class="panel">
    <header class="app-header">
      <div class="app-brandline">
        <span class="eyebrow">Chrome Extension</span>
        <span class="version-badge">v${packageJson.version}</span>
      </div>
      <h1>QueryFlow</h1>
      <p class="field-note">Integrasi · FASIH SQL Lab</p>
      <p class="field-note">Case 1 · SE2026 — Sensus Ekonomi 2026</p>
    </header>
    <section class="section" aria-labelledby="source-title">
      <div class="section-heading"><span>01</span><h2 id="source-title">Sumber SQL &amp; Tujuan Output</h2></div>
      <div class="source-card">
        <p id="source-name" class="source-name">Belum ada folder SQL</p>
        <dl class="metadata">
          <div><dt>Branch</dt><dd id="branch">main</dd></div>
          <div><dt>Status</dt><dd id="status" class="status">Belum diimpor</dd></div>
          <div><dt>Commit</dt><dd id="commit">—</dd></div>
          <div><dt>File</dt><dd id="counts">0 SQL · 0 folder</dd></div>
          <div class="wide"><dt>Terakhir diperbarui</dt><dd id="synced-at">—</dd></div>
        </dl>
        <div id="progress" class="progress" aria-live="polite"></div>
        <div class="source-actions">
          <!-- Sync from GitLab sengaja dinonaktifkan. Sumber query aktif berasal dari impor folder lokal. -->
          <button id="import-folder" class="secondary-button" type="button">Import Folder SQL</button>
          <input id="folder-input" type="file" webkitdirectory multiple hidden />
        </div>
        <div class="output-dest-box">
          <p class="output-dest-title">Tujuan Penyimpanan Hasil Run</p>
          <div class="output-dest-options">
            <label class="output-dest-radio">
              <input id="dest-downloads" type="radio" name="output-dest" value="downloads" checked />
              <span>Run to Download (Folder Downloads Browser)</span>
            </label>
            <label class="output-dest-radio">
              <input id="dest-custom" type="radio" name="output-dest" value="custom-folder" />
              <span>Run to Save ke Folder Tertentu</span>
            </label>
          </div>
          <div id="output-folder-picker" class="output-folder-picker" hidden>
            <span id="output-folder-name" class="output-folder-name">Belum ada folder dipilih</span>
            <button id="pick-output-folder" class="output-folder-btn" type="button">📂 Pilih Folder…</button>
          </div>
          <p id="output-dest-error" class="error" aria-live="polite"></p>
        </div>
      </div>
    </section>
    <section class="section" aria-labelledby="wilayah-title">
      <div class="section-heading"><span>02</span><h2 id="wilayah-title">Filter Wilayah</h2></div>
      <p class="field-note">Case 1 · SE2026. Berlaku pada SQL dengan parameter filter_provinsi dan filter_kabupaten.</p>
      <div class="field">
        <label>Level 1 <span>/ Provinsi · kosong berarti semua</span></label>
        <div id="level1-list" class="code-list"></div>
        <div id="add-level1-row" class="add-row" hidden>
          <input id="new-level1" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PP)" />
          <button id="confirm-level1" type="button">Tambah</button>
        </div>
        <button id="show-level1-add" class="text-button" type="button">＋ Tambah Provinsi</button>
      </div>
      <div class="field">
        <label>Level 2 <span>/ Kabupaten/Kota · kosong berarti semua</span></label>
        <div id="level2-list" class="code-list"></div>
        <div id="add-level2-row" class="add-row" hidden>
          <input id="new-level2" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PPKK)" />
          <button id="confirm-level2" type="button">Tambah</button>
        </div>
        <button id="show-level2-add" class="text-button" type="button">＋ Tambah Kabupaten/Kota</button>
      </div>
      <p id="wilayah-error" class="error" aria-live="polite"></p>
      <p id="wilayah-mode" class="field-note"></p>
      <p id="wilayah-saved" class="saved" aria-live="polite"></p>
    </section>
    <section class="section groups-section" aria-labelledby="groups-title">
      <div class="section-heading"><span>03</span><h2 id="groups-title">Folder SQL</h2></div>
      <details class="run-guide">
        <summary><span class="help-icon">?</span><span>Panduan Run &amp; auto-loop</span></summary>
        <div class="run-guide-content">
          <p>Sekali Run, data diambil bertahap sampai selesai. Hasil besar otomatis diunduh menjadi beberapa file Excel bernomor.</p>
          <ul>
            <li>Tombol <strong>Run</strong> berubah menjadi <strong>Stop</strong> selama query berjalan.</li>
            <li>Editor SQL aktif akan diganti. Tetap buka tab SQL Lab dan side panel ini.</li>
            <li><strong>Stop</strong> atau error tetap mengunduh hasil yang sudah terkumpul sebagai Excel parsial.</li>
            <li>Opsi folder: atur baris awal (offset), batas total baris, pisah per kolom (ZIP), dan pilih query yang ingin dijalankan.</li>
            <li><strong>Single Sheet</strong> menyimpan progres otomatis (checkpoint) sehingga bila terputus dapat dilanjutkan tanpa mengulang dari awal.</li>
          </ul>
        </div>
      </details>
      <div id="empty-groups" class="empty-state">Import folder SQL untuk melihat daftar query dan menjalankannya di FASIH SQL Lab.</div>
      <div id="groups" class="groups"></div>
    </section>
    <section class="section" aria-labelledby="transdata-title">
      <div class="section-heading"><span>04</span><h2 id="transdata-title">Upload ke Transdata (Nextcloud WebDAV)</h2></div>
      <div class="transdata-card">
        <div class="transdata-status-badge disconnected" id="transdata-status-badge">
          <span id="transdata-status-dot">○</span>
          <span id="transdata-status-text">Memeriksa sesi Transdata…</span>
        </div>
        <div class="transdata-conn-actions">
          <button id="transdata-detect-btn" class="transdata-conn-btn" type="button">🔄 Deteksi Sesi Transdata</button>
          <button id="transdata-open-btn" class="transdata-link-btn" type="button">🌐 Buka Transdata BPS</button>
        </div>

        <div class="transdata-mapping-box">
          <div class="transdata-target-row">
            <span>Folder Target: <strong id="transdata-current-target" class="transdata-target-path">/ (Root)</strong></span>
            <button id="transdata-mkdir-btn" class="tree-mini-btn" type="button">📁 + Buat Folder</button>
          </div>
          <div class="field-note">Klik salah satu folder di panel kanan untuk mengganti folder target tujuan di Transdata.</div>
        </div>

        <div class="dual-tree-grid">
          <!-- Pane Kiri: Tree Lokal -->
          <div class="tree-pane">
            <div class="tree-pane-header">
              <span id="local-folder-label" title="Folder Lokal">📁 Folder Lokal</span>
              <div class="tree-header-actions">
                <button id="local-tree-pick" class="tree-mini-btn" type="button" title="Ganti ke folder khusus upload">📂 Ganti</button>
                <button id="local-tree-reset-default" class="tree-mini-btn" type="button" title="Kembalikan ke folder default Tujuan Output" hidden>↺ Default</button>
                <button id="local-tree-refresh" class="tree-mini-btn" type="button" title="Refresh file lokal">↺ Refresh</button>
                <button id="local-upload-all-btn" class="tree-mini-btn" type="button" title="Upload semua file lokal">⬆ Upload Semua</button>
              </div>
            </div>
            <div id="local-tree-container" class="tree-pane-content">
              <div class="tree-empty-note">Memuat file lokal…</div>
            </div>
          </div>

          <!-- Pane Kanan: Tree Transdata -->
          <div class="tree-pane">
            <div class="tree-pane-header">
              <span>☁ Transdata</span>
              <div class="tree-header-actions">
                <button id="remote-tree-up" class="tree-mini-btn" type="button" title="Naik 1 level">⬆ Naik</button>
                <button id="remote-tree-refresh" class="tree-mini-btn" type="button" title="Refresh Transdata">↺ Refresh</button>
              </div>
            </div>
            <div id="remote-tree-container" class="tree-pane-content">
              <div class="tree-empty-note">Hubungkan Transdata untuk melihat folder cloud.</div>
            </div>
          </div>
        </div>

        <div id="transdata-progress-box" class="batch-progress-box" hidden style="margin-top: 10px;">
          <div class="batch-progress-header">
            <span id="transdata-progress-title" class="batch-progress-title">Mengunggah ke Transdata…</span>
            <span id="transdata-progress-count" class="batch-progress-count">0/0</span>
          </div>
          <div class="progress-bar-track">
            <div id="transdata-progress-bar" class="progress-bar-fill"></div>
          </div>
          <p id="transdata-progress-detail" class="batch-progress-detail">Mempersiapkan…</p>
          <button id="transdata-cancel-upload-btn" class="secondary-button" type="button" style="margin-top: 6px; padding: 4px 8px; font-size: 11px;">■ Batal Upload</button>
        </div>
      </div>
    </section>
    <footer class="author-credit">Initiated by D. Agung Sungkono</footer>
  </main>
  <dialog id="preview-dialog">
    <div class="dialog-header"><div><span id="preview-path"></span><h3 id="preview-name"></h3></div><button id="close-preview" aria-label="Tutup">×</button></div>
    <pre id="preview-content"></pre>
  </dialog>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const syncButton = document.querySelector<HTMLButtonElement>("#sync");
const importButton = byId<HTMLButtonElement>("import-folder");
const folderInput = byId<HTMLInputElement>("folder-input");
const destDownloadsRadio = byId<HTMLInputElement>("dest-downloads");
const destCustomRadio = byId<HTMLInputElement>("dest-custom");
const pickOutputFolderBtn = byId<HTMLButtonElement>("pick-output-folder");
const newLevel1Input = byId<HTMLInputElement>("new-level1");
const newLevel2Input = byId<HTMLInputElement>("new-level2");

async function initialize(): Promise<void> {
  [snapshot, wilayah, folderConfigs, outputDest, transdataSession] = await Promise.all([
    loadSnapshot(),
    loadWilayah(),
    loadFolderConfigs(),
    loadOutputDestinationConfig(),
    loadTransdataSession(),
  ]);
  progress = snapshot
    ? { phase: "success", message: snapshot.repository.namespace === "local-folder" ? "Imported" : "Synced" }
    : { phase: "idle", message: "Belum diimpor" };
  render();

  if (!transdataSession) {
    void detectTransdataSessionFromTabs().then((detected) => {
      if (detected) {
        transdataSession = detected;
        renderTransdataSection();
      }
    });
  }
}

function render(): void {
  renderSource();
  renderOutputDestination();
  renderWilayah();
  renderGroups();
  renderTransdataSection();
}

function renderOutputDestination(): void {
  destDownloadsRadio.checked = outputDest.mode === "downloads";
  destCustomRadio.checked = outputDest.mode === "custom-folder";
  const pickerRow = byId("output-folder-picker");
  pickerRow.hidden = outputDest.mode !== "custom-folder";
  const folderNameEl = byId("output-folder-name");
  folderNameEl.textContent = outputDest.folderName
    ? `📂 ${outputDest.folderName}`
    : "Belum ada folder dipilih";
  folderNameEl.title = outputDest.folderName ?? "Belum ada folder dipilih";
  byId("output-dest-error").textContent = outputDestError;
  void refreshLocalTree();
}

function renderSource(): void {
  byId("source-name").textContent = snapshot?.repository.name ?? "Belum ada folder SQL";
  byId("branch").textContent = snapshot?.repository.branch ?? TARGET.defaultBranch;
  const status = byId("status");
  status.textContent = progress.phase === "success" ? `✓ ${progress.message}` : progress.message;
  status.className = `status status-${progress.phase}`;
  byId("commit").textContent = snapshot?.repository.commit?.slice(0, 8) ?? "—";
  byId("counts").textContent = `${snapshot?.repository.sqlCount ?? 0} SQL · ${snapshot?.groups.length ?? 0} folder`;
  byId("synced-at").textContent = snapshot ? formatDate(snapshot.repository.syncedAt) : "—";
  const progressElement = byId("progress");
  const showDetail = !["idle", "success"].includes(progress.phase);
  progressElement.textContent = showDetail
    ? `${progress.message}${progress.phase === "error" && snapshot ? " Last successful snapshot preserved." : ""}`
    : "";
  progressElement.classList.toggle("progress-error", progress.phase === "error");
  const busy = ["connecting", "scanning", "reading", "saving"].includes(progress.phase);
  if (syncButton) syncButton.disabled = busy;
  importButton.disabled = busy;
}

function renderWilayah(): void {
  renderCodeList("level1-list", "Level 1", wilayah.level1, (index, code) => updateCode("level1", index, code), (index) => removeCode("level1", index));
  renderCodeList("level2-list", "Level 2", wilayah.level2, (index, code) => updateCode("level2", index, code), (index) => removeCode("level2", index));
  byId("wilayah-error").textContent = wilayahError;
  byId("wilayah-mode").textContent = wilayah.level2.length > 0 && wilayah.level1.length > 0
    ? "Filter aktif: Kabupaten/Kota. Daftar provinsi diabaikan selama Level 2 terisi."
    : wilayah.level2.length > 0
      ? "Filter aktif: Kabupaten/Kota."
      : wilayah.level1.length > 0
        ? "Filter aktif: seluruh Kabupaten/Kota dalam provinsi terpilih."
        : "Filter wilayah kosong: semua wilayah akan dijalankan.";
}

function renderCodeList(
  elementId: string,
  label: string,
  codes: string[],
  update: (index: number, code: string) => void,
  removeCodeAt: (index: number) => void,
): void {
  const list = byId(elementId);
  list.replaceChildren();
  codes.forEach((code, index) => {
    const row = document.createElement("div");
    row.className = "code-row";
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.value = code;
    input.placeholder = label === "Level 1" ? "kode wilayah (PP)" : "kode wilayah (PPKK)";
    input.setAttribute("aria-label", `Kode ${label} ${index + 1}`);
    input.addEventListener("change", () => update(index, input.value));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Hapus ${code}`);
    remove.addEventListener("click", () => removeCodeAt(index));
    row.append(input, remove);
    list.append(row);
  });
}

function renderGroups(): void {
  const groupsElement = byId("groups");
  groupsElement.replaceChildren();
  byId("empty-groups").hidden = Boolean(snapshot?.groups.length);
  for (const group of snapshot?.groups ?? []) {
    const currentConfig = folderConfigs[group.path] ?? {};
    const allPaths = group.files.map((file) => file.path);
    const selectedPaths = new Set<string>(
      currentConfig.selectedPaths !== undefined
        ? currentConfig.selectedPaths.filter((path) => allPaths.includes(path))
        : allPaths,
    );
    const configuredStartRow = typeof currentConfig.startRow === "number" && currentConfig.startRow >= 1 ? currentConfig.startRow : 1;
    const configuredMaxRows = typeof currentConfig.maxRows === "number" && currentConfig.maxRows > 0 ? currentConfig.maxRows : undefined;
    const configuredCheckpointRows = typeof currentConfig.checkpointRows === "number" && currentConfig.checkpointRows > 0
      ? Math.floor(currentConfig.checkpointRows)
      : EXPORT_CHECKPOINT_ROWS;
    let advancedSettings = typeof currentConfig.advancedSettings === "boolean"
      ? currentConfig.advancedSettings
      : configuredStartRow !== 1 || configuredMaxRows !== undefined || configuredCheckpointRows !== EXPORT_CHECKPOINT_ROWS;
    let startRow = advancedSettings ? configuredStartRow : 1;
    let maxRows = advancedSettings ? configuredMaxRows : undefined;
    let checkpointRows = advancedSettings ? configuredCheckpointRows : EXPORT_CHECKPOINT_ROWS;
    const configuredSplitColumns = Array.isArray(currentConfig.splitColumns) ? currentConfig.splitColumns : [];
    let splitColumn1 = typeof configuredSplitColumns[0] === "string" ? configuredSplitColumns[0] : "";
    let splitColumn2 = typeof configuredSplitColumns[1] === "string" ? configuredSplitColumns[1] : "";
    let splitEnabled = typeof currentConfig.splitEnabled === "boolean" ? currentConfig.splitEnabled : Boolean(splitColumn1);

    const details = document.createElement("details");
    details.className = "group";
    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "group-name";
    const repeatedName = (snapshot?.groups ?? []).filter((candidate) => candidate.name === group.name).length > 1;
    heading.textContent = repeatedName ? group.path.replaceAll("/", " / ") : group.name;
    const meta = document.createElement("span");
    meta.className = "group-count";
    meta.textContent = `${group.path} · ${group.files.length} SQL file${group.files.length === 1 ? "" : "s"}`;
    summary.append(heading, meta);

    const files = document.createElement("div");
    files.className = "file-list";

    const fileStatusElements = new Map<string, HTMLParagraphElement>();

    // Folder Options: Start Row, Max Rows, Checkpoint Rows, Split by Column & Query Selection
    const configBox = document.createElement("div");
    configBox.className = "folder-config-box";

    const advancedSettingsLabel = document.createElement("label");
    advancedSettingsLabel.className = "advanced-settings-toggle";
    const advancedSettingsInput = document.createElement("input");
    advancedSettingsInput.type = "checkbox";
    advancedSettingsInput.checked = advancedSettings;
    const advancedSettingsText = document.createElement("span");
    advancedSettingsText.textContent = "Advanced settings";
    advancedSettingsLabel.append(advancedSettingsInput, advancedSettingsText);

    const rowGroup = document.createElement("div");
    rowGroup.className = "config-row-group";
    const advancedSettingsContent = document.createElement("div");
    advancedSettingsContent.className = "advanced-settings-content";

    const startRowField = document.createElement("div");
    startRowField.className = "config-field";
    const startRowLabel = document.createElement("label");
    startRowLabel.textContent = "Mulai baris";
    const startRowInput = document.createElement("input");
    startRowInput.type = "number";
    startRowInput.min = "1";
    startRowInput.placeholder = "1 (awal)";
    startRowInput.value = String(startRow);
    startRowInput.title = "Baris awal pengambilan data (1-based offset)";
    startRowField.append(startRowLabel, startRowInput);

    const maxRowsField = document.createElement("div");
    maxRowsField.className = "config-field";
    const maxRowsLabel = document.createElement("label");
    maxRowsLabel.textContent = "Batas baris";
    const maxRowsInput = document.createElement("input");
    maxRowsInput.type = "number";
    maxRowsInput.min = "1";
    maxRowsInput.placeholder = "Semua (tanpa batas)";
    maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
    maxRowsInput.title = "Total maksimal baris sebelum berhenti mengambil data";
    maxRowsField.append(maxRowsLabel, maxRowsInput);

    const checkpointRowsField = document.createElement("div");
    checkpointRowsField.className = "config-field";
    const checkpointRowsLabel = document.createElement("label");
    checkpointRowsLabel.textContent = "Unduh tiap X baris";
    const checkpointRowsInput = document.createElement("input");
    checkpointRowsInput.type = "number";
    checkpointRowsInput.min = "1";
    checkpointRowsInput.step = "10000";
    checkpointRowsInput.value = String(checkpointRows);
    checkpointRowsInput.title = "Unduh bagian Excel setelah jumlah baris ini terkumpul di folder";
    checkpointRowsField.append(checkpointRowsLabel, checkpointRowsInput);

    rowGroup.append(startRowField, maxRowsField, checkpointRowsField);

    const splitSettings = document.createElement("div");
    splitSettings.className = "split-settings";
    const splitSettingsLabel = document.createElement("label");
    splitSettingsLabel.className = "advanced-settings-toggle split-settings-toggle";
    const splitSettingsInput = document.createElement("input");
    splitSettingsInput.type = "checkbox";
    splitSettingsInput.checked = splitEnabled;
    const splitSettingsText = document.createElement("span");
    splitSettingsText.textContent = "Split Excel by column";
    splitSettingsLabel.append(splitSettingsInput, splitSettingsText);

    const splitColumnFields = document.createElement("div");
    splitColumnFields.className = "split-column-fields";
    const splitColumn1Field = document.createElement("div");
    splitColumn1Field.className = "config-field";
    const splitColumn1Label = document.createElement("label");
    splitColumn1Label.textContent = "Pisahkan berdasarkan kolom";
    const splitColumn1Input = document.createElement("input");
    splitColumn1Input.type = "text";
    splitColumn1Input.value = splitColumn1;
    splitColumn1Input.placeholder = "Contoh: kode_kabupaten";
    splitColumn1Input.autocomplete = "off";
    splitColumn1Input.setAttribute("aria-label", "Kolom pertama untuk memisahkan hasil Excel");
    splitColumn1Field.append(splitColumn1Label, splitColumn1Input);

    const splitColumn2Field = document.createElement("div");
    splitColumn2Field.className = "config-field split-column-field";
    const splitColumn2Label = document.createElement("label");
    splitColumn2Label.textContent = "Kolom kedua (opsional)";
    const splitColumn2Input = document.createElement("input");
    splitColumn2Input.type = "text";
    splitColumn2Input.value = splitColumn2;
    splitColumn2Input.placeholder = "Contoh: kategori";
    splitColumn2Input.autocomplete = "off";
    splitColumn2Input.setAttribute("aria-label", "Kolom kedua untuk memisahkan hasil Excel");
    splitColumn2Field.append(splitColumn2Label, splitColumn2Input);
    splitColumnFields.append(splitColumn1Field, splitColumn2Field);

    const splitColumnNote = document.createElement("p");
    splitColumnNote.className = "split-column-note";
    splitColumnNote.textContent = "Kolom pertama wajib; kolom kedua opsional. Nama kolom divalidasi dari hasil SQL.";
    splitSettings.append(splitSettingsLabel, splitColumnFields, splitColumnNote);
    advancedSettingsContent.append(rowGroup, splitSettings);

    const toolbar = document.createElement("div");
    toolbar.className = "config-selection-toolbar";
    const selectionBadge = document.createElement("span");
    selectionBadge.className = "selection-badge";

    const selectionActions = document.createElement("div");
    selectionActions.className = "selection-actions";
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "micro-btn";
    selectAllBtn.textContent = "Pilih Semua";
    const deselectAllBtn = document.createElement("button");
    deselectAllBtn.type = "button";
    deselectAllBtn.className = "micro-btn";
    deselectAllBtn.textContent = "Batal Semua";
    selectionActions.append(selectAllBtn, deselectAllBtn);

    toolbar.append(selectionBadge, selectionActions);
    configBox.append(advancedSettingsLabel, advancedSettingsContent, toolbar);

    const batchGroup = document.createElement("div");
    batchGroup.className = "group-actions";

    const batchSingle = document.createElement("button");
    batchSingle.textContent = "▶ Run Folder (Single Sheet)";
    batchSingle.className = "secondary-button btn-single-sheet";
    batchSingle.title = "Jalankan query terpilih dalam folder dan simpan per query sebagai 1 file Excel standar";

    const batch = document.createElement("button");
    batch.textContent = "▶ Run Folder (Multi Sheet)";
    batch.className = "secondary-button";
    batch.title = "Jalankan query terpilih dalam folder dan gabungkan ke 1 file Excel (multi-sheet) atau ZIP per kolom";

    const batchReset = document.createElement("button");
    batchReset.type = "button";
    batchReset.textContent = "↺ Reset Checkpoint Folder";
    batchReset.className = "reset-checkpoint-btn";
    batchReset.title = "Hapus checkpoint progress untuk folder ini (mulai dari baris 0)";

    const batchProgressBox = document.createElement("div");
    batchProgressBox.className = "batch-progress-card";
    batchProgressBox.hidden = true;

    const batchProgressHeader = document.createElement("div");
    batchProgressHeader.className = "batch-progress-header";

    const batchProgressTitle = document.createElement("span");
    batchProgressTitle.className = "batch-progress-title";
    batchProgressTitle.textContent = "Progress Folder";

    const batchProgressCount = document.createElement("span");
    batchProgressCount.className = "batch-progress-count";
    batchProgressCount.textContent = "0%";

    batchProgressHeader.append(batchProgressTitle, batchProgressCount);

    const progressBarTrack = document.createElement("div");
    progressBarTrack.className = "progress-bar-track";

    const progressBarFill = document.createElement("div");
    progressBarFill.className = "progress-bar-fill";
    progressBarTrack.append(progressBarFill);

    const batchProgressDetail = document.createElement("p");
    batchProgressDetail.className = "batch-progress-detail";
    batchProgressDetail.setAttribute("role", "status");

    batchProgressBox.append(batchProgressHeader, progressBarTrack, batchProgressDetail);

    const checkboxMap = new Map<string, { checkbox: HTMLInputElement; row: HTMLDivElement }>();

    const persistCurrentFolderConfig = async (): Promise<void> => {
      folderConfigs[group.path] = {
        selectedPaths: [...selectedPaths],
        advancedSettings,
        startRow,
        maxRows,
        checkpointRows,
        splitColumns: [splitColumn1.trim(), splitColumn2.trim()],
        splitEnabled,
      };
      try {
        await saveFolderConfigs(folderConfigs);
      } catch (error) {
        if (!isContextInvalidated(error)) {
          batchProgressBox.hidden = false;
          batchProgressDetail.textContent = error instanceof Error ? error.message : "Konfigurasi folder gagal disimpan.";
        }
      }
    };

    const updateAdvancedSettingsState = (): void => {
      startRowInput.disabled = !advancedSettings;
      maxRowsInput.disabled = !advancedSettings;
      checkpointRowsInput.disabled = !advancedSettings;
      rowGroup.classList.toggle("is-disabled", !advancedSettings);
      advancedSettingsContent.hidden = !advancedSettings;
    };

    const updateSplitSettingsState = (): void => {
      splitColumnFields.hidden = !splitEnabled;
      splitColumn1Input.disabled = !splitEnabled;
      splitColumn2Input.disabled = !splitEnabled || !splitColumn1.trim();
      splitColumn2Field.classList.toggle("is-disabled", splitColumn2Input.disabled);
    };

    updateAdvancedSettingsState();
    updateSplitSettingsState();

    const updateSelectionDisplay = (): void => {
      const count = selectedPaths.size;
      selectionBadge.textContent = `${count} / ${group.files.length} query dipilih`;
      if (!folderRunning) {
        batchSingle.textContent = `▶ Run Folder (Single Sheet · ${count}/${group.files.length})`;
        batch.textContent = `▶ Run Folder (Multi Sheet · ${count}/${group.files.length})`;
        batchSingle.disabled = count === 0;
        batch.disabled = count === 0;
      }
    };

    startRowInput.addEventListener("change", () => {
      const val = parseInt(startRowInput.value, 10);
      startRow = !isNaN(val) && val >= 1 ? val : 1;
      startRowInput.value = String(startRow);
      void persistCurrentFolderConfig();
    });

    maxRowsInput.addEventListener("change", () => {
      const val = parseInt(maxRowsInput.value, 10);
      maxRows = !isNaN(val) && val > 0 ? val : undefined;
      maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
      void persistCurrentFolderConfig();
    });

    checkpointRowsInput.addEventListener("change", () => {
      const val = parseInt(checkpointRowsInput.value, 10);
      checkpointRows = !isNaN(val) && val > 0 ? val : EXPORT_CHECKPOINT_ROWS;
      checkpointRowsInput.value = String(checkpointRows);
      void persistCurrentFolderConfig();
    });

    splitColumn1Input.addEventListener("change", () => {
      splitColumn1 = splitColumn1Input.value.trim();
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });
    splitColumn2Input.addEventListener("change", () => {
      splitColumn2 = splitColumn2Input.value.trim();
      void persistCurrentFolderConfig();
    });
    splitSettingsInput.addEventListener("change", () => {
      splitEnabled = splitSettingsInput.checked;
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });

    advancedSettingsInput.addEventListener("change", () => {
      advancedSettings = advancedSettingsInput.checked;
      if (!advancedSettings) {
        startRow = 1;
        maxRows = undefined;
        checkpointRows = EXPORT_CHECKPOINT_ROWS;
        startRowInput.value = String(startRow);
        maxRowsInput.value = "";
        checkpointRowsInput.value = String(checkpointRows);
      }
      updateAdvancedSettingsState();
      void persistCurrentFolderConfig();
    });

    selectAllBtn.addEventListener("click", () => {
      for (const file of group.files) {
        selectedPaths.add(file.path);
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = true;
          item.row.classList.remove("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    deselectAllBtn.addEventListener("click", () => {
      selectedPaths.clear();
      for (const file of group.files) {
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = false;
          item.row.classList.add("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    updateSelectionDisplay();

    let batchRunId: string | null = null;
    let batchTabId: number | null = null;
    let batchStopRequested = false;
    let batchController = new AbortController();
    let activeBatchMode: "multi" | "single" | null = null;

    batchReset.addEventListener("click", async () => {
      await clearGroupCheckpoints(group.files, wilayah);
      batchProgressBox.hidden = false;
      progressBarFill.style.width = "0%";
      progressBarFill.className = "progress-bar-fill";
      batchProgressTitle.textContent = "↺ Checkpoint folder di-reset";
      batchProgressCount.textContent = "0%";
      batchProgressDetail.textContent = "Semua checkpoint folder ini telah di-reset ke nol. Run berikutnya akan mulai dari awal.";
      for (const f of group.files) {
        const fileStatus = fileStatusElements.get(f.path);
        if (fileStatus) fileStatus.textContent = "";
      }
    });

    batch.addEventListener("click", async () => {
      if (folderRunning) {
        if (activeBatchMode !== "multi" || !batchRunId || batchTabId === null) {
          batchProgressBox.hidden = false;
          batchProgressDetail.textContent = "Proses lain masih berjalan.";
          return;
        }
        batchStopRequested = true;
        batchController.abort();
        batch.disabled = true;
        batch.textContent = "■ Stopping…";
        batchProgressTitle.textContent = "■ Menghentikan Run Folder…";
        batchProgressDetail.textContent = "Menunggu query aktif berhenti...";
        progressBarFill.className = "progress-bar-fill warning";
        void stopRun(batchRunId, batchTabId);
        return;
      }

      const filesToRun = group.files.filter((file) => selectedPaths.has(file.path));
      if (filesToRun.length === 0) {
        batchProgressBox.hidden = false;
        batchProgressDetail.textContent = "Pilih minimal 1 file SQL untuk dijalankan.";
        return;
      }
      splitColumn1 = splitColumn1Input.value.trim();
      splitColumn2 = splitColumn2Input.value.trim();
      const useSplitColumns = advancedSettings && splitEnabled;
      if (useSplitColumns) {
        const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
        if (splitColumnsError) {
          batchProgressBox.hidden = false;
          batchProgressDetail.textContent = splitColumnsError;
          return;
        }
      }
      const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
      await persistCurrentFolderConfig();
      try {
        await ensureOutputDirectoryAccess();
        outputDestError = "";
        renderOutputDestination();
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Folder tujuan belum siap.";
        outputDestError = msg;
        renderOutputDestination();
        batchProgressBox.hidden = false;
        batchProgressDetail.textContent = msg;
        return;
      }

      folderRunning = true;
      activeBatchMode = "multi";
      batchStopRequested = false;
      batchController = new AbortController();
      batch.textContent = "■ Stop";
      batch.classList.add("stop-button");
      batchSingle.disabled = true;

      const totalTables = filesToRun.length;
      let currentFileIndex = 0;
      const isCustomFolder = outputDest.mode === "custom-folder";
      const output: FolderExportOutput = splitColumns.length
        ? new SplitChunkedExport(group.path, createRunId(), splitColumns, {
            checkpointRows,
            archiveMode: isCustomFolder ? "excel" : "zip",
          })
        : new ChunkedExport(group.path, undefined, undefined, undefined, checkpointRows);

      batchProgressBox.hidden = false;
      progressBarFill.className = "progress-bar-fill";
      progressBarFill.style.width = "0%";
      batchProgressTitle.textContent = `Memulai: Folder ${group.name} (Multi Sheet)`;
      batchProgressCount.textContent = `0/${totalTables} (0%)`;
      batchProgressDetail.textContent = "Mempersiapkan query...";

      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
        batchTabId = tab.id;

        for (const [index, file] of filesToRun.entries()) {
          currentFileIndex = index;
          if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");

          const fileStatus = fileStatusElements.get(file.path);
          const percentStart = Math.round((index / totalTables) * 100);
          progressBarFill.style.width = `${percentStart}%`;
          batchProgressCount.textContent = `${index}/${totalTables} (${percentStart}%)`;

          const resumeText = "Mengirim SQL ke editor aktif...";
          batchProgressTitle.textContent = `[Tabel ${index + 1}/${totalTables}] ${file.name}`;
          batchProgressDetail.textContent = resumeText;
          if (fileStatus) fileStatus.textContent = resumeText;

          const runId = createRunId();
          batchRunId = runId;
          runProgressTargets.set(runId, (runProgress) => {
            const partsInfo = output.parts > 0 ? ` · ${output.parts} part diunduh` : "";
            const progressText = `${formatRunProgress(runProgress)}${partsInfo}`;
            batchProgressDetail.textContent = progressText;
            if (fileStatus) fileStatus.textContent = progressText;
          });

          let pending: Promise<SqlChunkResponse> | undefined;
          try {
            await collectQuery(
              (offset, limit, iteration) => {
                pending = chrome.runtime.sendMessage({
                  type: "RUN_SQL_FILE",
                  path: file.path,
                  tabId: tab.id!,
                  runId,
                  offset,
                  limit,
                  iteration,
                } satisfies ExtensionMessage) as Promise<SqlChunkResponse>;
                return pending;
              },
              (columns, rows) => output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows }),
              () => batchStopRequested,
              (message) => {
                batchProgressDetail.textContent = message;
                if (fileStatus) fileStatus.textContent = message;
              },
              batchController.signal,
              {
                startRow,
                maxRows,
                onColumns: (columns) => {
                  if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
                },
              },
            );

            const tableDoneMsg = "✓ Selesai: chunk diterima";
            if (fileStatus) fileStatus.textContent = tableDoneMsg;

            const percentEnd = Math.round(((index + 1) / totalTables) * 100);
            progressBarFill.style.width = `${percentEnd}%`;
            batchProgressCount.textContent = `${index + 1}/${totalTables} (${percentEnd}%)`;
          } finally {
            runProgressTargets.delete(runId);
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tab.id!), () => clearRun(runId, tab.id!));
          }
        }
        await output.flush(true);
        const outputType = output instanceof SplitChunkedExport && !isCustomFolder ? "file ZIP" : "file Excel";
        progressBarFill.style.width = "100%";
        progressBarFill.className = "progress-bar-fill";
        batchProgressTitle.textContent = `✓ Selesai: Semua ${totalTables} tabel diproses`;
        batchProgressCount.textContent = "100%";
        batchProgressDetail.textContent = `Total ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.`;
      } catch (error) {
        progressBarFill.className = batchStopRequested ? "progress-bar-fill warning" : "progress-bar-fill error";
        batchProgressTitle.textContent = batchStopRequested
          ? `■ Run Folder dihentikan pada tabel ${currentFileIndex + 1}/${totalTables}`
          : `⚠ Gagal pada tabel ${currentFileIndex + 1}/${totalTables}`;
        batchProgressDetail.textContent = await finishPartial(output, error);
      } finally {
        folderRunning = false;
        activeBatchMode = null;
        batchRunId = null;
        batchTabId = null;
        batchStopRequested = false;
        batch.disabled = false;
        batchSingle.disabled = false;
        batch.classList.remove("stop-button");
        updateSelectionDisplay();
      }
    });

    batchSingle.addEventListener("click", async () => {
      if (folderRunning) {
        if (activeBatchMode !== "single" || !batchRunId || batchTabId === null) {
          batchProgressBox.hidden = false;
          batchProgressDetail.textContent = "Proses lain masih berjalan.";
          return;
        }
        batchStopRequested = true;
        batchController.abort();
        batchSingle.disabled = true;
        batchSingle.textContent = "■ Stopping…";
        batchProgressTitle.textContent = "■ Menghentikan Run Folder…";
        batchProgressDetail.textContent = "Menunggu query aktif berhenti dan menyimpan checkpoint...";
        progressBarFill.className = "progress-bar-fill warning";
        void stopRun(batchRunId, batchTabId);
        return;
      }

      const filesToRun = group.files.filter((file) => selectedPaths.has(file.path));
      if (filesToRun.length === 0) {
        batchProgressBox.hidden = false;
        batchProgressDetail.textContent = "Pilih minimal 1 file SQL untuk dijalankan.";
        return;
      }
      splitColumn1 = splitColumn1Input.value.trim();
      splitColumn2 = splitColumn2Input.value.trim();
      const useSplitColumns = advancedSettings && splitEnabled;
      if (useSplitColumns) {
        const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
        if (splitColumnsError) {
          batchProgressBox.hidden = false;
          batchProgressDetail.textContent = splitColumnsError;
          return;
        }
      }
      const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
      await persistCurrentFolderConfig();
      try {
        await ensureOutputDirectoryAccess();
        outputDestError = "";
        renderOutputDestination();
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Folder tujuan belum siap.";
        outputDestError = msg;
        renderOutputDestination();
        batchProgressBox.hidden = false;
        batchProgressDetail.textContent = msg;
        return;
      }

      folderRunning = true;
      activeBatchMode = "single";
      batchStopRequested = false;
      batchController = new AbortController();
      batchSingle.textContent = "■ Stop";
      batchSingle.classList.add("stop-button");
      batch.disabled = true;

      const totalTables = filesToRun.length;
      const isCustomFolder = outputDest.mode === "custom-folder";
      let currentFileIndex = 0;
      let totalFilesExported = 0;
      let totalRowsCollected = 0;
      let activeSingleOutput: FolderExportOutput | StreamingChunkedExport | null = null;

      batchProgressBox.hidden = false;
      progressBarFill.className = "progress-bar-fill";
      progressBarFill.style.width = "0%";
      batchProgressTitle.textContent = `Memulai: Folder ${group.name} (Single Sheet)`;
      batchProgressCount.textContent = `0/${totalTables} (0%)`;
      batchProgressDetail.textContent = "Mempersiapkan query...";

      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
        batchTabId = tab.id;

        for (const [index, file] of filesToRun.entries()) {
          currentFileIndex = index;
          if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");

          const fileStatus = fileStatusElements.get(file.path);
          const percentStart = Math.round((index / totalTables) * 100);
          progressBarFill.style.width = `${percentStart}%`;
          batchProgressCount.textContent = `${index}/${totalTables} (${percentStart}%)`;

          const cp = await getCheckpoint(file.path, wilayah);
          if (!advancedSettings && cp?.completed) {
            const skipMsg = `Dilewati (sudah lengkap: ${cp.totalRows.toLocaleString("id-ID")} baris · ${cp.partsDownloaded || 1} part)`;
            batchProgressTitle.textContent = `[Tabel ${index + 1}/${totalTables}] ${file.name}`;
            batchProgressDetail.textContent = `⏭ ${skipMsg}`;
            if (fileStatus) fileStatus.textContent = `⏭ ${skipMsg}`;
            totalFilesExported += cp.partsDownloaded || 1;
            totalRowsCollected += cp.totalRows;
            const percentEnd = Math.round(((index + 1) / totalTables) * 100);
            progressBarFill.style.width = `${percentEnd}%`;
            batchProgressCount.textContent = `${index + 1}/${totalTables} (${percentEnd}%)`;
            continue;
          }

          const startOffset = advancedSettings ? Math.max(0, startRow - 1) : cp ? cp.lastOffset : 0;
          const startParts = !advancedSettings && cp ? cp.partsDownloaded : 0;
          const startRows = !advancedSettings && cp ? cp.totalRows : 0;
          const maxBufferRows = advancedSettings ? checkpointRows : 50_000;

          const { relativePath, sheetTitle } = buildStandardDownloadPath(file.path, file.content, file.name);
          const basePath = relativePath.replace(/\.xlsx$/i, "");
          const runId = createRunId();
          batchRunId = runId;

          const output: FolderExportOutput | StreamingChunkedExport = splitColumns.length
            ? new SplitChunkedExport(basePath, runId, splitColumns, {
                checkpointRows,
                preserveDirectoryPath: true,
                archiveMode: isCustomFolder ? "excel" : "zip",
              })
            : new StreamingChunkedExport(basePath, {
                maxBufferRows,
                initialParts: startParts,
                initialRows: startRows,
                download: downloadStandardWorkbook,
                onPartitionFlushed: async (partNum, rowsInPart, totalRowsSoFar) => {
                  if (!advancedSettings) {
                    await saveCheckpoint(file.path, {
                      lastOffset: totalRowsSoFar,
                      totalRows: totalRowsSoFar,
                      partsDownloaded: partNum,
                      completed: false,
                    }, wilayah);
                  }
                  const partMsg = `📥 [Part-${partNum}] ${rowsInPart.toLocaleString("id-ID")} baris diunduh ke disk · Total ${totalRowsSoFar.toLocaleString("id-ID")} baris`;
                  batchProgressDetail.textContent = partMsg;
                  if (fileStatus) fileStatus.textContent = partMsg;
                },
              });
          activeSingleOutput = output;

          const resumeText = startOffset > 0
            ? `Melanjutkan dari baris ${(startOffset + 1).toLocaleString("id-ID")} (part-${startParts + 1})…`
            : "Mengirim SQL ke editor aktif...";

          batchProgressTitle.textContent = `[Tabel ${index + 1}/${totalTables}] ${file.name}`;
          batchProgressDetail.textContent = resumeText;
          if (fileStatus) fileStatus.textContent = resumeText;

          runProgressTargets.set(runId, (runProgress) => {
            const partsInfo = output.parts > 0 ? ` · ${output.parts} part diunduh` : "";
            const progressText = `${formatRunProgress(runProgress)}${partsInfo}`;
            batchProgressDetail.textContent = progressText;
            if (fileStatus) fileStatus.textContent = progressText;
          });

          let pending: Promise<SqlChunkResponse> | undefined;
          try {
            await collectQuery(
              (offset, limit, iteration) =>
                (pending = chrome.runtime.sendMessage({
                  type: "RUN_SQL_FILE",
                  path: file.path,
                  tabId: tab.id!,
                  runId,
                  offset,
                  limit,
                  iteration,
                } satisfies ExtensionMessage) as Promise<SqlChunkResponse>),
              (columns, rows) => output.append({ filename: file.path, title: sheetTitle, columns, rows }),
              () => batchStopRequested,
              (message) => {
                batchProgressDetail.textContent = message;
                if (fileStatus) fileStatus.textContent = message;
              },
              batchController.signal,
              advancedSettings
                ? {
                    startRow,
                    maxRows,
                    onColumns: (columns) => {
                      if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
                    },
                  }
                : startOffset,
            );
            await output.flush(true);
            if (!advancedSettings) {
              await markCheckpointCompleted(file.path, output.totalRows, output.parts, wilayah);
            }
            totalFilesExported += output.parts;
            totalRowsCollected += output.totalRows;
            activeSingleOutput = null;

            const outputType = output instanceof SplitChunkedExport && !isCustomFolder ? "file ZIP" : "file Excel";
            const tableDoneMsg = `✓ Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType}`;
            if (fileStatus) fileStatus.textContent = tableDoneMsg;

            const percentEnd = Math.round(((index + 1) / totalTables) * 100);
            progressBarFill.style.width = `${percentEnd}%`;
            batchProgressCount.textContent = `${index + 1}/${totalTables} (${percentEnd}%)`;
          } catch (fileError) {
            if (activeSingleOutput) {
              const partialMsg = await finishPartial(activeSingleOutput, fileError);
              if (!advancedSettings && activeSingleOutput.totalRows > 0) {
                await saveCheckpoint(file.path, {
                  lastOffset: activeSingleOutput.totalRows,
                  totalRows: activeSingleOutput.totalRows,
                  partsDownloaded: activeSingleOutput.parts,
                  completed: false,
                }, wilayah);
              }
              if (fileStatus) fileStatus.textContent = partialMsg;
            }
            throw fileError;
          } finally {
            runProgressTargets.delete(runId);
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tab.id!), () => clearRun(runId, tab.id!));
          }
        }

        const finalOutputType = splitColumns.length
          ? isCustomFolder
            ? "file Excel (Split per Kolom)"
            : "file ZIP (Split per Kolom)"
          : "file Excel (Single Sheet)";
        progressBarFill.style.width = "100%";
        progressBarFill.className = "progress-bar-fill";
        batchProgressTitle.textContent = `✓ Selesai: Semua ${totalTables} tabel berhasil diproses!`;
        batchProgressCount.textContent = "100%";
        batchProgressDetail.textContent = `Total ${totalFilesExported} ${finalOutputType} diunduh · Total ${totalRowsCollected.toLocaleString("id-ID")} baris.`;
      } catch (error) {
        progressBarFill.className = batchStopRequested ? "progress-bar-fill warning" : "progress-bar-fill error";
        batchProgressTitle.textContent = batchStopRequested
          ? `■ Run Folder dihentikan pada tabel ${currentFileIndex + 1}/${totalTables}`
          : `⚠ Gagal pada tabel ${currentFileIndex + 1}/${totalTables}`;
        batchProgressDetail.textContent = error instanceof Error ? error.message : "Run Folder gagal.";
      } finally {
        folderRunning = false;
        activeBatchMode = null;
        batchRunId = null;
        batchTabId = null;
        batchStopRequested = false;
        batch.disabled = false;
        batchSingle.disabled = false;
        batchSingle.classList.remove("stop-button");
        updateSelectionDisplay();
      }
    });

    batchGroup.append(batchSingle, batch, batchReset);
    files.append(configBox, batchGroup, batchProgressBox);

    for (const file of group.files) {
      const isSelected = selectedPaths.has(file.path);
      const row = document.createElement("div");
      row.style.display = "grid";
      row.className = `file-row ${isSelected ? "" : "is-unselected"}`;

      const checkTitle = document.createElement("div");
      checkTitle.className = "file-check-title";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "file-select-check";
      checkbox.checked = isSelected;
      checkbox.setAttribute("aria-label", `Pilih ${file.name}`);
      checkbox.title = "Pilih query ini untuk dijalankan pada Run Folder";

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedPaths.add(file.path);
          row.classList.remove("is-unselected");
        } else {
          selectedPaths.delete(file.path);
          row.classList.add("is-unselected");
        }
        updateSelectionDisplay();
        void persistCurrentFolderConfig();
      });

      checkboxMap.set(file.path, { checkbox, row });

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "file-title-btn";
      nameBtn.textContent = file.name;
      nameBtn.addEventListener("click", () => showPreview(file.name, file.path, file.content));

      checkTitle.append(checkbox, nameBtn);

      const actions = document.createElement("div");
      actions.className = "file-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "⧉ Copy";
      copy.title = "Salin SQL dengan filter wilayah aktif";
      const run = document.createElement("button");
      run.type = "button";
      run.textContent = "▶ Run";
      run.title = "Jalankan query dengan rentang baris dan opsi split kolom yang dikonfigurasi; Stop mengunduh hasil parsial";
      const runSingle = document.createElement("button");
      runSingle.type = "button";
      runSingle.textContent = "▶ Single Sheet";
      runSingle.className = "btn-single-sheet-sm";
      runSingle.title = "Jalankan SQL dan unduh file Excel standar (Single Sheet) atau ZIP terpisah per kolom";

      const resetFile = document.createElement("button");
      resetFile.type = "button";
      resetFile.textContent = "↺";
      resetFile.className = "reset-checkpoint-btn";
      resetFile.title = "Reset checkpoint query ini (mulai dari baris 0)";
      resetFile.addEventListener("click", async () => {
        await clearCheckpoint(file.path, wilayah);
        status.textContent = "↺ Checkpoint tabel ini di-reset ke awal (baris 0).";
      });

      const status = document.createElement("p");
      status.className = "progress";
      status.setAttribute("role", "status");
      fileStatusElements.set(file.path, status);

      void getCheckpoint(file.path, wilayah).then((cp) => {
        if (cp?.completed) {
          status.textContent = `✓ Lengkap (${cp.totalRows.toLocaleString("id-ID")} baris · ${cp.partsDownloaded || 1} file)`;
        } else if (cp && cp.lastOffset > 0) {
          status.textContent = `⏸ Checkpoint di baris ${cp.lastOffset.toLocaleString("id-ID")} (${cp.partsDownloaded} part tersimpan)`;
        }
      });

      let activeRun: { runId: string; tabId: number; mode: "classic" | "single" } | null = null;
      let stopRequested = false;
      let controller = new AbortController();
      copy.addEventListener("click", async () => {
        try {
          await copyText(applyWilayahConfig(file.content, wilayah));
          status.textContent = "SQL tersalin ke clipboard.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "SQL gagal disalin.";
        }
      });
      run.addEventListener("click", async () => {
        if (activeRun) {
          if (activeRun.mode !== "classic") return;
          stopRequested = true;
          controller.abort();
          run.disabled = true;
          run.textContent = "■ Stopping…";
          void stopRun(activeRun.runId, activeRun.tabId);
          return;
        }
        if (folderRunning) { status.textContent = "Tunggu Run Folder selesai."; return; }

        splitColumn1 = splitColumn1Input.value.trim();
        splitColumn2 = splitColumn2Input.value.trim();
        const useSplitColumns = advancedSettings && splitEnabled;
        if (useSplitColumns) {
          const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
          if (splitColumnsError) {
            status.textContent = splitColumnsError;
            return;
          }
        }
        const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
        await persistCurrentFolderConfig();
        try {
          await ensureOutputDirectoryAccess();
          outputDestError = "";
          renderOutputDestination();
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Folder tujuan belum siap.";
          outputDestError = msg;
          renderOutputDestination();
          status.textContent = msg;
          return;
        }

        folderRunning = true;
        stopRequested = false;
        controller = new AbortController();
        const runId = createRunId();
        const isCustomFolder = outputDest.mode === "custom-folder";
        const output: FolderExportOutput = splitColumns.length
          ? new SplitChunkedExport(file.path.replace(/\.sql$/i, ""), runId, splitColumns, {
              checkpointRows,
              archiveMode: isCustomFolder ? "excel" : "zip",
            })
          : new ChunkedExport(file.path.replace(/\.sql$/i, ""), undefined, undefined, undefined, checkpointRows);
        status.textContent = "Mengirim SQL ke editor aktif...";
        let tabId: number | undefined;
        let pending: Promise<SqlChunkResponse> | undefined;
        runProgressTargets.set(runId, (runProgress) => {
          const partsInfo = output.parts > 0 ? ` · ${output.parts} part diunduh` : "";
          status.textContent = `${formatRunProgress(runProgress)}${partsInfo}`;
        });
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
          tabId = tab.id;
          activeRun = { runId, tabId, mode: "classic" };
          run.textContent = "■ Stop";
          run.classList.add("stop-button");
          runSingle.disabled = true;
          await collectQuery(
            (offset, limit, iteration) =>
              (pending = chrome.runtime.sendMessage({
                type: "RUN_SQL_FILE",
                path: file.path,
                tabId: tab.id!,
                runId,
                offset,
                limit,
                iteration,
              } satisfies ExtensionMessage) as Promise<SqlChunkResponse>),
            (columns, rows) => output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows }),
            () => stopRequested,
            (message) => { status.textContent = message; },
            controller.signal,
            {
              startRow,
              maxRows,
              onColumns: (columns) => {
                if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
              },
            },
          );
          await output.flush(true);
          const outputType = output instanceof SplitChunkedExport && !isCustomFolder ? "file ZIP" : "file Excel";
          status.textContent = `✓ Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.`;
        } catch (error) {
          status.textContent = await finishPartial(output, error);
        } finally {
          if (tabId !== undefined) {
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tabId!), () => clearRun(runId, tabId!));
          }
          folderRunning = false;
          runProgressTargets.delete(runId);
          activeRun = null;
          run.disabled = false;
          runSingle.disabled = false;
          run.textContent = "▶ Run";
          run.classList.remove("stop-button");
        }
      });

      runSingle.addEventListener("click", async () => {
        if (activeRun) {
          if (activeRun.mode !== "single") return;
          stopRequested = true;
          controller.abort();
          runSingle.disabled = true;
          runSingle.textContent = "■ Stopping…";
          void stopRun(activeRun.runId, activeRun.tabId);
          return;
        }
        if (folderRunning) { status.textContent = "Tunggu Run Folder selesai."; return; }

        splitColumn1 = splitColumn1Input.value.trim();
        splitColumn2 = splitColumn2Input.value.trim();
        const useSplitColumns = advancedSettings && splitEnabled;
        if (useSplitColumns) {
          const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
          if (splitColumnsError) {
            status.textContent = splitColumnsError;
            return;
          }
        }
        const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
        await persistCurrentFolderConfig();
        try {
          await ensureOutputDirectoryAccess();
          outputDestError = "";
          renderOutputDestination();
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Folder tujuan belum siap.";
          outputDestError = msg;
          renderOutputDestination();
          status.textContent = msg;
          return;
        }

        const cp = await getCheckpoint(file.path, wilayah);
        if (!advancedSettings && cp?.completed) {
          status.textContent = `Tabel sudah lengkap (${cp.totalRows.toLocaleString("id-ID")} baris). Klik tombol ↺ jika ingin mengulang dari nol.`;
        }

        folderRunning = true;
        stopRequested = false;
        controller = new AbortController();

        const startOffset = advancedSettings ? Math.max(0, startRow - 1) : cp && !cp.completed ? cp.lastOffset : 0;
        const startParts = !advancedSettings && cp && !cp.completed ? cp.partsDownloaded : 0;
        const startRows = !advancedSettings && cp && !cp.completed ? cp.totalRows : 0;
        const maxBufferRows = advancedSettings ? checkpointRows : 50_000;

        const { relativePath, sheetTitle } = buildStandardDownloadPath(file.path, file.content, file.name);
        const basePath = relativePath.replace(/\.xlsx$/i, "");
        const runId = createRunId();
        const isCustomFolder = outputDest.mode === "custom-folder";
        const output: FolderExportOutput | StreamingChunkedExport = splitColumns.length
          ? new SplitChunkedExport(basePath, runId, splitColumns, {
              checkpointRows,
              preserveDirectoryPath: true,
              archiveMode: isCustomFolder ? "excel" : "zip",
            })
          : new StreamingChunkedExport(basePath, {
              maxBufferRows,
              initialParts: startParts,
              initialRows: startRows,
              download: downloadStandardWorkbook,
              onPartitionFlushed: async (partNum, rowsInPart, totalRowsSoFar) => {
                if (!advancedSettings) {
                  await saveCheckpoint(file.path, {
                    lastOffset: totalRowsSoFar,
                    totalRows: totalRowsSoFar,
                    partsDownloaded: partNum,
                    completed: false,
                  }, wilayah);
                }
                status.textContent = `📥 [Part-${partNum}] ${rowsInPart.toLocaleString("id-ID")} baris diunduh ke disk · Total ${totalRowsSoFar.toLocaleString("id-ID")} baris`;
              },
            });

        const resumeMsg = startOffset > 0
          ? `Melanjutkan dari baris ${(startOffset + 1).toLocaleString("id-ID")} (part-${startParts + 1})…`
          : "Mengirim SQL ke editor aktif...";
        status.textContent = resumeMsg;

        let tabId: number | undefined;
        let pending: Promise<SqlChunkResponse> | undefined;
        runProgressTargets.set(runId, (runProgress) => {
          const partsInfo = output.parts > 0 ? ` · ${output.parts} part diunduh` : "";
          status.textContent = `${formatRunProgress(runProgress)}${partsInfo}`;
        });
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
          tabId = tab.id;
          activeRun = { runId, tabId, mode: "single" };
          runSingle.textContent = "■ Stop";
          runSingle.classList.add("stop-button");
          run.disabled = true;
          await collectQuery(
            (offset, limit, iteration) =>
              (pending = chrome.runtime.sendMessage({
                type: "RUN_SQL_FILE",
                path: file.path,
                tabId: tab.id!,
                runId,
                offset,
                limit,
                iteration,
              } satisfies ExtensionMessage) as Promise<SqlChunkResponse>),
            (columns, rows) => output.append({ filename: file.path, title: sheetTitle, columns, rows }),
            () => stopRequested,
            (message) => { status.textContent = message; },
            controller.signal,
            advancedSettings
              ? {
                  startRow,
                  maxRows,
                  onColumns: (columns) => {
                    if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
                  },
                }
              : startOffset,
          );
          await output.flush(true);
          if (!advancedSettings) {
            await markCheckpointCompleted(file.path, output.totalRows, output.parts, wilayah);
          }
          const outputType = output instanceof SplitChunkedExport && !isCustomFolder ? "file ZIP" : "file Excel";
          status.textContent = `✓ Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.`;
        } catch (error) {
          if (!advancedSettings && output.totalRows > 0) {
            await saveCheckpoint(file.path, {
              lastOffset: output.totalRows,
              totalRows: output.totalRows,
              partsDownloaded: output.parts,
              completed: false,
            }, wilayah);
          }
          status.textContent = await finishPartial(output, error);
        } finally {
          if (tabId !== undefined) {
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tabId!), () => clearRun(runId, tabId!));
          }
          folderRunning = false;
          runProgressTargets.delete(runId);
          activeRun = null;
          run.disabled = false;
          runSingle.disabled = false;
          runSingle.textContent = "▶ Single Sheet";
          runSingle.classList.remove("stop-button");
        }
      });

      actions.append(copy, run, runSingle, resetFile);
      row.append(checkTitle, actions);
      files.append(row, status);
    }
    details.append(summary, files);
    groupsElement.append(details);
  }
}

async function persistWilayah(next: WilayahConfig): Promise<boolean> {
  const validation = validateWilayah(next);
  if (!validation.valid) {
    wilayahError = validation.errors[0] ?? "Konfigurasi wilayah tidak valid.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  wilayah = next;
  wilayahError = "";
  try {
    await saveWilayah(wilayah);
  } catch (error) {
    if (isContextInvalidated(error)) return false;
    wilayahError = error instanceof Error ? error.message : "Konfigurasi wilayah gagal disimpan.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  byId("wilayah-error").textContent = "";
  const saved = byId("wilayah-saved");
  saved.textContent = "Tersimpan";
  window.setTimeout(() => (saved.textContent = ""), 1200);
  return true;
}

async function updateCode(level: keyof WilayahConfig, index: number, code: string): Promise<void> {
  const next = [...wilayah[level]];
  next[index] = code.trim();
  await persistWilayah({ ...wilayah, [level]: next });
  renderWilayah();
}

async function removeCode(level: keyof WilayahConfig, index: number): Promise<void> {
  await persistWilayah({ ...wilayah, [level]: wilayah[level].filter((_, candidate) => candidate !== index) });
  renderWilayah();
}

async function confirmAdd(level: keyof WilayahConfig, input: HTMLInputElement, rowId: string): Promise<void> {
  const code = input.value.trim();
  const next = addWilayahCode(wilayah, level, code);
  if (next === wilayah) {
    const label = level === "level1" ? "Level 1" : "Level 2";
    wilayahError = wilayah[level].includes(code) ? `Kode ${label} tidak boleh duplikat.` : `Kode ${label} harus berisi angka.`;
    renderWilayah();
    return;
  }
  await persistWilayah(next);
  input.value = "";
  byId(rowId).hidden = true;
  renderWilayah();
}

function showPreview(name: string, path: string, content: string): void {
  byId("preview-name").textContent = name;
  byId("preview-path").textContent = path;
  byId("preview-content").textContent = content;
  byId<HTMLDialogElement>("preview-dialog").showModal();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function createRunId(): string {
  return crypto.randomUUID();
}

async function finishPartial(output: FolderExportOutput | StreamingChunkedExport, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : "Run gagal.";
  try {
    await output.flush(true, true, reason);
    const isCustomFolder = outputDest.mode === "custom-folder";
    const outputType = output instanceof SplitChunkedExport && !isCustomFolder ? "file ZIP" : "file Excel";
    return `${reason} ${output.parts ? `Hasil parsial: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.` : "Belum ada hasil yang dapat diunduh."}`;
  } catch (exportError) {
    return `${reason} Ekspor sisa hasil gagal: ${exportError instanceof Error ? exportError.message : "Error Excel"}. ${output.parts} bagian sebelumnya sudah diunduh.`;
  }
}

async function clearRun(runId: string, tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: "CLEAR_SQL_RUN", runId, tabId } satisfies ExtensionMessage).catch(() => undefined);
}

async function stopRun(runId: string, tabId: number): Promise<{ ok: boolean; message: string }> {
  try {
    return await chrome.runtime.sendMessage({ type: "STOP_SQL_RUN", runId, tabId } satisfies ExtensionMessage) as { ok: boolean; message: string };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Query gagal dihentikan." };
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("SQL gagal disalin ke clipboard.");
}

// Handler dipertahankan agar fitur GitLab dapat diaktifkan kembali cukup dengan
// mengembalikan tombol #sync pada template di atas.
syncButton?.addEventListener("click", async () => {
  progress = { phase: "connecting", message: "Connecting to GitLab..." };
  renderSource();
  try {
    const result = (await chrome.runtime.sendMessage({ type: "SYNC_REPOSITORY" } satisfies ExtensionMessage)) as ScanResult;
    if (!result.ok) throw new Error(result.error);
    snapshot = result.snapshot;
    progress = { phase: "success", message: "Synced" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Sync failed" };
    renderSource();
  }
});

importButton.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => void importRepositoryFolder(folderInput.files));

destDownloadsRadio.addEventListener("change", async () => {
  if (!destDownloadsRadio.checked) return;
  outputDest = { ...outputDest, mode: "downloads" };
  outputDestError = "";
  await saveOutputDestinationConfig(outputDest).catch(() => undefined);
  renderOutputDestination();
});

destCustomRadio.addEventListener("change", async () => {
  if (!destCustomRadio.checked) return;
  outputDest = { ...outputDest, mode: "custom-folder" };
  outputDestError = "";
  await saveOutputDestinationConfig(outputDest).catch(() => undefined);
  renderOutputDestination();
  if (!outputDest.folderName) {
    pickOutputFolderBtn.click();
  }
});

pickOutputFolderBtn.addEventListener("click", async () => {
  try {
    outputDest = await pickOutputDirectory();
    outputDestError = "";
    renderOutputDestination();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    outputDestError = error instanceof Error ? error.message : "Gagal memilih folder tujuan.";
    renderOutputDestination();
  }
});

async function importRepositoryFolder(fileList: FileList | null): Promise<void> {
  if (!fileList?.length) return;
  const selected = [...fileList];
  const sqlFiles = selected.filter((file) => isSqlPath(file.name) && file.webkitRelativePath.split("/").length > 2);
  if (sqlFiles.length === 0) {
    progress = { phase: "error", message: "Tidak ada SQL dalam subfolder. SQL di root diabaikan; pilih folder repository yang membungkus query groups." };
    renderSource();
    folderInput.value = "";
    return;
  }

  const firstPath = selected[0]?.webkitRelativePath || selected[0]?.name || "repository";
  const rootFolder = firstPath.split("/")[0] || "repository";
  try {
    const importedFiles: SqlFile[] = [];
    for (const [index, file] of sqlFiles.entries()) {
      progress = {
        phase: "reading",
        message: `Reading ${index + 1} / ${sqlFiles.length} SQL files...`,
        current: index + 1,
        total: sqlFiles.length,
      };
      renderSource();
      const fullPath = file.webkitRelativePath || file.name;
      const relativePath = fullPath.startsWith(`${rootFolder}/`) ? fullPath.slice(rootFolder.length + 1) : fullPath;
      importedFiles.push({ name: file.name, path: relativePath, content: await file.text() });
    }

    const nextSnapshot: RepositorySnapshot = {
      version: 1,
      repository: {
        name: rootFolder,
        namespace: "local-folder",
        branch: "local import",
        syncedAt: new Date().toISOString(),
        sqlCount: importedFiles.length,
      },
      groups: groupSqlFiles(importedFiles),
    };
    progress = { phase: "saving", message: "Mengganti seluruh cache SQL dengan folder impor terbaru..." };
    renderSource();
    await saveSnapshot(nextSnapshot);
    snapshot = nextSnapshot;
    progress = { phase: "success", message: "Imported — cache lama diganti" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Import folder gagal." };
    renderSource();
  } finally {
    folderInput.value = "";
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "SQL_RUN_PROGRESS") {
    runProgressTargets.get(message.progress.runId)?.(message.progress);
    return;
  }
  if (message.type === "TRANSDATA_SESSION_DETECTED") {
    transdataSession = message.session;
    renderTransdataSection();
    return;
  }
  if (message.type !== "SYNC_PROGRESS") return;
  progress = message.progress;
  renderSource();
});

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderTransdataSection(): void {
  const badge = byId("transdata-status-badge");
  const dot = byId("transdata-status-dot");
  const text = byId("transdata-status-text");

  if (transdataSession) {
    badge.className = "transdata-status-badge connected";
    dot.textContent = "●";
    text.textContent = `Terhubung (User: ${transdataSession.userId})`;
  } else {
    badge.className = "transdata-status-badge disconnected";
    dot.textContent = "○";
    text.textContent = "Belum terhubung ke Transdata";
  }

  void refreshLocalTree();
  void refreshRemoteTree();
}

async function refreshLocalTree(): Promise<void> {
  const container = byId("local-tree-container");
  container.replaceChildren();

  const { handle, isCustomUpload } = await getEffectiveUploadDirectoryHandle();
  const headerLabel = document.getElementById("local-folder-label");
  const resetBtn = document.getElementById("local-tree-reset-default") as HTMLButtonElement | null;

  if (resetBtn) {
    resetBtn.hidden = !isCustomUpload;
  }

  if (!handle) {
    if (headerLabel) {
      headerLabel.innerHTML = `<span>📁 Folder Lokal</span>`;
      headerLabel.title = "Belum ada folder dipilih";
    }

    const card = document.createElement("div");
    card.className = "tree-empty-card";

    const icon = document.createElement("div");
    icon.className = "tree-empty-icon";
    icon.textContent = "📁";

    const title = document.createElement("div");
    title.className = "tree-empty-title";

    const desc = document.createElement("p");
    desc.className = "tree-empty-desc";

    const actions = document.createElement("div");
    actions.className = "tree-empty-actions";

    const pickBtn = document.createElement("button");
    pickBtn.className = "tree-mini-btn";
    pickBtn.type = "button";
    pickBtn.textContent = "📂 Pilih Folder Upload…";
    pickBtn.addEventListener("click", async () => {
      try {
        await pickUploadSourceDirectory();
        await refreshLocalTree();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        alert(err instanceof Error ? err.message : "Gagal memilih folder upload.");
      }
    });

    if (outputDest.mode === "downloads") {
      title.textContent = "Mode Download Browser Aktif";
      desc.textContent =
        "Tujuan output saat ini menggunakan download browser. Browser membatasi akses baca folder Downloads otomatis demi keamanan. Hubungkan folder lokal untuk mengunggah ke Transdata:";
    } else {
      title.textContent = "Belum Ada Folder Terpilih";
      desc.textContent =
        "Pilih folder tujuan di bagian atas (01) atau pilih folder khusus upload di bawah:";
    }

    actions.append(pickBtn);
    card.append(icon, title, desc, actions);
    container.append(card);
    return;
  }

  if (headerLabel) {
    const badgeText = isCustomUpload ? "Khusus Upload" : "Default Output";
    const badgeClass = isCustomUpload ? "badge-custom-folder" : "badge-default-folder";
    headerLabel.innerHTML = `<span>📁 ${handle.name}</span><span class="${badgeClass}">${badgeText}</span>`;
    headerLabel.title = isCustomUpload
      ? `Folder khusus upload: ${handle.name}`
      : `Folder default dari Tujuan Output (01): ${handle.name}`;
  }

  // Check read permission before scanning
  const permState = await checkDirectoryPermission(handle, "read");
  if (permState !== "granted") {
    const card = document.createElement("div");
    card.className = "tree-empty-card";

    const icon = document.createElement("div");
    icon.className = "tree-empty-icon";
    icon.textContent = "🔒";

    const title = document.createElement("div");
    title.className = "tree-empty-title";
    title.textContent = "Izin Akses Folder Diperlukan";

    const desc = document.createElement("p");
    desc.className = "tree-empty-desc";
    desc.textContent = `Browser memerlukan konfirmasi Anda untuk membuka folder "${handle.name}".`;

    const actions = document.createElement("div");
    actions.className = "tree-empty-actions";

    const grantBtn = document.createElement("button");
    grantBtn.className = "tree-mini-btn";
    grantBtn.type = "button";
    grantBtn.textContent = "🔓 Izinkan Akses";
    grantBtn.addEventListener("click", async () => {
      const state = await requestDirectoryPermission(handle, "read");
      if (state === "granted") {
        await refreshLocalTree();
      } else {
        alert(`Izin akses ke folder "${handle.name}" belum disetujui.`);
      }
    });

    const repickBtn = document.createElement("button");
    repickBtn.className = "tree-mini-btn";
    repickBtn.type = "button";
    repickBtn.textContent = "📂 Ganti Folder";
    repickBtn.addEventListener("click", async () => {
      try {
        await pickUploadSourceDirectory();
        await refreshLocalTree();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        alert(err instanceof Error ? err.message : "Gagal memilih folder upload.");
      }
    });

    actions.append(grantBtn, repickBtn);
    card.append(icon, title, desc, actions);
    container.append(card);
    return;
  }

  try {
    localTreeData = await readLocalDirectoryTree(handle);
    if (!localTreeData.children || localTreeData.children.length === 0) {
      const card = document.createElement("div");
      card.className = "tree-empty-card";

      const icon = document.createElement("div");
      icon.className = "tree-empty-icon";
      icon.textContent = "📂";

      const title = document.createElement("div");
      title.className = "tree-empty-title";
      title.textContent = `Folder "${handle.name}" Masih Kosong`;

      const desc = document.createElement("p");
      desc.className = "tree-empty-desc";
      desc.textContent =
        "Belum ada file di folder ini. Jalankan query SQL di bagian (03) untuk menghasilkan file Excel, atau pilih folder lain jika file disimpan di folder berbeda.";

      const actions = document.createElement("div");
      actions.className = "tree-empty-actions";

      const recheckBtn = document.createElement("button");
      recheckBtn.className = "tree-mini-btn";
      recheckBtn.type = "button";
      recheckBtn.textContent = "↺ Cek Ulang";
      recheckBtn.addEventListener("click", () => void refreshLocalTree());

      const repickBtn = document.createElement("button");
      repickBtn.className = "tree-mini-btn";
      repickBtn.type = "button";
      repickBtn.textContent = "📂 Ganti Folder";
      repickBtn.addEventListener("click", async () => {
        try {
          await pickUploadSourceDirectory();
          await refreshLocalTree();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          alert(err instanceof Error ? err.message : "Gagal memilih folder upload.");
        }
      });

      actions.append(recheckBtn, repickBtn);
      card.append(icon, title, desc, actions);
      container.append(card);
      return;
    }

    for (const child of localTreeData.children) {
      container.append(createLocalTreeNodeElement(child));
    }
  } catch (error) {
    if (error instanceof DirectoryPermissionRequiredError) {
      const card = document.createElement("div");
      card.className = "tree-empty-card";

      const icon = document.createElement("div");
      icon.className = "tree-empty-icon";
      icon.textContent = "🔒";

      const title = document.createElement("div");
      title.className = "tree-empty-title";
      title.textContent = "Izin Akses Folder Diperlukan";

      const desc = document.createElement("p");
      desc.className = "tree-empty-desc";
      desc.textContent = error.message;

      const actions = document.createElement("div");
      actions.className = "tree-empty-actions";

      const grantBtn = document.createElement("button");
      grantBtn.className = "tree-mini-btn";
      grantBtn.type = "button";
      grantBtn.textContent = "🔓 Izinkan Akses";
      grantBtn.addEventListener("click", async () => {
        const state = await requestDirectoryPermission(handle, "read");
        if (state === "granted") {
          await refreshLocalTree();
        }
      });

      actions.append(grantBtn);
      card.append(icon, title, desc, actions);
      container.append(card);
      return;
    }

    const errEl = document.createElement("div");
    errEl.className = "tree-empty-note";
    errEl.textContent = error instanceof Error ? error.message : "Gagal membaca folder lokal.";
    container.append(errEl);
  }
}

function createLocalTreeNodeElement(node: LocalFileNode): HTMLElement {
  const container = document.createElement("div");
  const row = document.createElement("div");
  row.className = "tree-node-item";

  const label = document.createElement("div");
  label.className = "tree-node-label";

  const icon = document.createElement("span");
  icon.className = "tree-node-icon";
  icon.textContent = node.isDirectory ? "📁" : "📄";

  const text = document.createElement("span");
  text.className = "tree-node-text";
  text.textContent = node.name;
  text.title = node.relativePath || node.name;

  label.append(icon, text);

  if (!node.isDirectory && typeof node.size === "number") {
    const sizeEl = document.createElement("span");
    sizeEl.className = "tree-node-size";
    sizeEl.textContent = `(${formatFileSize(node.size)})`;
    label.append(sizeEl);
  }

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "tree-node-action";
  uploadBtn.textContent = "⬆ Upload";
  uploadBtn.title = node.isDirectory ? `Upload folder "${node.name}"` : `Upload file "${node.name}"`;
  uploadBtn.addEventListener("click", () => void startUpload([node]));

  row.append(label, uploadBtn);
  container.append(row);

  if (node.isDirectory && node.children && node.children.length > 0) {
    const childrenDiv = document.createElement("div");
    childrenDiv.className = "tree-children-container";
    for (const child of node.children) {
      childrenDiv.append(createLocalTreeNodeElement(child));
    }
    container.append(childrenDiv);
  }

  return container;
}

async function refreshRemoteTree(): Promise<void> {
  const container = byId("remote-tree-container");
  container.replaceChildren();

  const targetEl = byId("transdata-current-target");
  targetEl.textContent = currentRemoteDavPath ? `/${currentRemoteDavPath}` : "/ (Root)";

  if (!transdataSession) {
    const note = document.createElement("div");
    note.className = "tree-empty-note";
    note.textContent = "Login ke transdata-cloud.bps.go.id lalu klik Deteksi Sesi.";
    container.append(note);
    return;
  }

  try {
    remoteDavItems = await listRemoteDirectory(transdataSession, currentRemoteDavPath);
    if (remoteDavItems.length === 0) {
      const note = document.createElement("div");
      note.className = "tree-empty-note";
      note.textContent = "(Folder ini kosong di Transdata)";
      container.append(note);
      return;
    }

    for (const item of remoteDavItems) {
      const row = document.createElement("div");
      row.className = "tree-node-item";

      const label = document.createElement("div");
      label.className = "tree-node-label";

      const icon = document.createElement("span");
      icon.className = "tree-node-icon";
      icon.textContent = item.isDirectory ? "📁" : "📄";

      const text = document.createElement("span");
      text.className = "tree-node-text";
      text.textContent = item.name;
      text.title = item.path;

      label.append(icon, text);

      if (!item.isDirectory && typeof item.size === "number") {
        const sizeEl = document.createElement("span");
        sizeEl.className = "tree-node-size";
        sizeEl.textContent = `(${formatFileSize(item.size)})`;
        label.append(sizeEl);
      }

      row.append(label);

      if (item.isDirectory) {
        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "4px";

        const enterBtn = document.createElement("button");
        enterBtn.type = "button";
        enterBtn.className = "tree-node-action";
        enterBtn.textContent = "Buka ➔";
        enterBtn.title = `Buka folder ${item.name}`;
        enterBtn.addEventListener("click", () => {
          currentRemoteDavPath = item.path;
          void refreshRemoteTree();
        });

        const setTargetBtn = document.createElement("button");
        setTargetBtn.type = "button";
        setTargetBtn.className = "tree-node-action";
        setTargetBtn.textContent = "✔ Target";
        setTargetBtn.title = `Pilih ${item.name} sebagai folder target upload`;
        setTargetBtn.addEventListener("click", () => {
          currentRemoteDavPath = item.path;
          byId("transdata-current-target").textContent = `/${currentRemoteDavPath}`;
        });

        actions.append(enterBtn, setTargetBtn);
        row.append(actions);
      }

      container.append(row);
    }
  } catch (error) {
    const errEl = document.createElement("div");
    errEl.className = "tree-empty-note";
    errEl.textContent = error instanceof Error ? error.message : "Gagal membaca folder Transdata.";
    container.append(errEl);
  }
}

async function startUpload(nodes: LocalFileNode[]): Promise<void> {
  if (uploadRunning) {
    alert("Proses upload lain masih berjalan.");
    return;
  }
  if (!transdataSession) {
    alert("Transdata belum terhubung. Silakan buka transdata-cloud.bps.go.id lalu klik Deteksi Sesi.");
    return;
  }

  const activeTabId = await getTransdataTabId();
  if (activeTabId === null) {
    const shouldOpen = window.confirm(
      "Tab Transdata (https://transdata-cloud.bps.go.id/) belum terbuka di browser Anda.\n\n" +
      "WebDAV memerlukan tab Transdata tetap terbuka agar sesi login & cookies dapat digunakan.\n\n" +
      "Klik OK untuk membuka Transdata, lalu login terlebih dahulu."
    );
    if (shouldOpen) {
      await chrome.tabs.create({ url: "https://transdata-cloud.bps.go.id/" });
    }
    return;
  }

  const { handle: rootHandle } = await getEffectiveUploadDirectoryHandle();
  if (!rootHandle) {
    alert("Pilih folder upload terlebih dahulu.");
    return;
  }

  const permState = await checkDirectoryPermission(rootHandle, "read");
  if (permState !== "granted") {
    const requested = await requestDirectoryPermission(rootHandle, "read");
    if (requested !== "granted") {
      alert(`Izin akses ke folder "${rootHandle.name}" diperlukan untuk mengunggah file.`);
      return;
    }
  }

  const progressBox = byId("transdata-progress-box");
  const progressTitle = byId("transdata-progress-title");
  const progressCount = byId("transdata-progress-count");
  const progressBar = byId("transdata-progress-bar");
  const progressDetail = byId("transdata-progress-detail");

  uploadRunning = true;
  activeUploadController = new AbortController();
  progressBox.hidden = false;
  progressBar.style.width = "0%";
  progressBar.className = "progress-bar-fill";
  progressTitle.textContent = "Memulai Upload ke Transdata…";
  progressCount.textContent = "0%";
  progressDetail.textContent = "Mempersiapkan daftar file…";

  try {
    const result = await uploadLocalFilesToTransdata(rootHandle, transdataSession, nodes, {
      remoteBaseFolder: currentRemoteDavPath,
      signal: activeUploadController.signal,
      onProgress: (p: TransdataUploadProgress) => {
        const percent = p.totalFiles > 0 ? Math.round((p.currentFileIndex / p.totalFiles) * 100) : 0;
        progressBar.style.width = `${percent}%`;
        progressCount.textContent = `${p.currentFileIndex}/${p.totalFiles} (${percent}%)`;
        progressTitle.textContent = p.currentFile ? `Mengunggah: ${p.currentFile}` : "Upload Transdata";
        progressDetail.textContent = p.message;
        if (p.state === "error") {
          progressBar.className = "progress-bar-fill error";
        } else if (p.state === "cancelled") {
          progressBar.className = "progress-bar-fill warning";
        }
      },
    });

    if (result.errors.length === 0) {
      progressBar.style.width = "100%";
      progressBar.className = "progress-bar-fill";
      progressTitle.textContent = `✓ Selesai: ${result.totalUploaded} file terunggah`;
      progressCount.textContent = "100%";
      progressDetail.textContent = `Semua ${result.totalUploaded} file berhasil diunggah ke Transdata.`;
    } else {
      progressBar.style.width = "100%";
      progressBar.className = "progress-bar-fill error";
      progressTitle.textContent = `⚠ Upload Gagal (${result.errors.length} file bermasalah)`;
      progressCount.textContent = `${result.totalUploaded}/${result.totalUploaded + result.errors.length}`;
      const sample = result.errors.slice(0, 3).join("\n• ");
      progressDetail.textContent = `${result.totalUploaded} file berhasil, ${result.errors.length} file gagal:\n• ${sample}`;
    }
  } catch (error) {
    progressBar.style.width = "100%";
    progressBar.className = "progress-bar-fill error";
    progressTitle.textContent = "⚠ Upload Gagal";
    progressDetail.textContent = error instanceof Error ? error.message : "Error upload ke Transdata.";
  } finally {
    uploadRunning = false;
    activeUploadController = null;
    void refreshRemoteTree();
  }
}

// Transdata UI Event Listeners
byId("transdata-detect-btn").addEventListener("click", async () => {
  const badge = byId("transdata-status-badge");
  const text = byId("transdata-status-text");
  text.textContent = "Mencari tab Transdata aktif…";
  const detected = await detectTransdataSessionFromTabs();
  if (detected) {
    transdataSession = detected;
    renderTransdataSection();
  } else {
    badge.className = "transdata-status-badge disconnected";
    text.textContent = "Tidak menemukan sesi aktif di transdata-cloud.bps.go.id. Silakan login di tab Transdata.";
  }
});

byId("transdata-open-btn").addEventListener("click", () => {
  void chrome.tabs.create({ url: "https://transdata-cloud.bps.go.id/" });
});

byId("transdata-mkdir-btn").addEventListener("click", async () => {
  if (!transdataSession) {
    alert("Transdata belum terhubung.");
    return;
  }
  const folderName = window.prompt("Masukkan nama folder baru di Transdata:");
  if (!folderName?.trim()) return;
  const targetPath = currentRemoteDavPath ? `${currentRemoteDavPath}/${folderName.trim()}` : folderName.trim();
  try {
    await createRemoteDirectory(transdataSession, targetPath);
    currentRemoteDavPath = targetPath;
    await refreshRemoteTree();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Gagal membuat folder di Transdata.");
  }
});

byId("local-tree-pick")?.addEventListener("click", async () => {
  try {
    await pickUploadSourceDirectory();
    await refreshLocalTree();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    alert(error instanceof Error ? error.message : "Gagal memilih folder upload.");
  }
});

byId("local-tree-reset-default")?.addEventListener("click", async () => {
  await resetUploadSourceToDefault();
  await refreshLocalTree();
});

byId("local-tree-refresh").addEventListener("click", async () => {
  const { handle } = await getEffectiveUploadDirectoryHandle();
  if (handle) {
    const perm = await checkDirectoryPermission(handle, "read");
    if (perm === "prompt") {
      await requestDirectoryPermission(handle, "read");
    }
  }
  await refreshLocalTree();
});

byId("local-upload-all-btn").addEventListener("click", () => {
  if (!localTreeData) {
    alert("Belum ada file lokal.");
    return;
  }
  void startUpload([localTreeData]);
});

byId("remote-tree-up").addEventListener("click", () => {
  if (!currentRemoteDavPath) return;
  const lastSlash = currentRemoteDavPath.lastIndexOf("/");
  currentRemoteDavPath = lastSlash > 0 ? currentRemoteDavPath.slice(0, lastSlash) : "";
  void refreshRemoteTree();
});

byId("remote-tree-refresh").addEventListener("click", () => void refreshRemoteTree());

byId("transdata-cancel-upload-btn").addEventListener("click", () => {
  if (activeUploadController) {
    activeUploadController.abort();
  }
});

byId("show-level1-add").addEventListener("click", () => {
  byId("add-level1-row").hidden = false;
  newLevel1Input.focus();
});
byId("confirm-level1").addEventListener("click", () => void confirmAdd("level1", newLevel1Input, "add-level1-row"));
newLevel1Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level1", newLevel1Input, "add-level1-row");
});
byId("show-level2-add").addEventListener("click", () => {
  byId("add-level2-row").hidden = false;
  newLevel2Input.focus();
});
byId("confirm-level2").addEventListener("click", () => void confirmAdd("level2", newLevel2Input, "add-level2-row"));
newLevel2Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level2", newLevel2Input, "add-level2-row");
});
byId("close-preview").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());

void initialize().catch((error: unknown) => {
  if (isContextInvalidated(error)) {
    const status = document.getElementById("status");
    if (status) status.textContent = "Extension diperbarui. Tutup lalu buka kembali panel QueryFlow.";
    return;
  }
  progress = { phase: "error", message: error instanceof Error ? error.message : "QueryFlow gagal dimuat." };
  renderSource();
});
