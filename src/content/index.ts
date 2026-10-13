import { GitLabAdapter } from "./gitlab/adapter";
import type { ExtensionMessage, ScanResult, SqlRunProgress, SyncProgress } from "../types";

const SQL_PROGRESS_SOURCE = "queryflow-sql-run-progress";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  const data = event.data as { source?: unknown; progress?: unknown };
  if (data.source !== SQL_PROGRESS_SOURCE || !data.progress || typeof data.progress !== "object") return;
  const progress = data.progress as Partial<SqlRunProgress>;
  if (typeof progress.runId !== "string" || typeof progress.path !== "string" || typeof progress.iteration !== "number") return;
  void chrome.runtime.sendMessage({ type: "SQL_RUN_PROGRESS", progress: progress as SqlRunProgress } satisfies ExtensionMessage).catch(() => undefined);
});

function report(progress: SyncProgress): void {
  void chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", progress } satisfies ExtensionMessage).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type !== "GITLAB_SCAN") return false;
  const adapter = new GitLabAdapter(report);
  void adapter
    .scanSqlGroups()
    .then((snapshot) => sendResponse({ ok: true, snapshot } satisfies ScanResult))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Sinkronisasi gagal." } satisfies ScanResult),
    );
  return true;
});

// Detect Transdata session if loaded on transdata-cloud.bps.go.id
if (window.location.hostname === "transdata-cloud.bps.go.id") {
  const detectAndSendSession = () => {
    const head = document.querySelector("head");
    const body = document.querySelector("body");
    const win = window as unknown as {
      oc_config?: { currentUser?: string };
      OC?: { currentUser?: string; requestToken?: string };
      oc_requesttoken?: string;
    };
    const userId =
      head?.getAttribute("data-user") ||
      body?.getAttribute("data-user") ||
      win.oc_config?.currentUser ||
      win.OC?.currentUser ||
      null;
    const requestToken =
      head?.getAttribute("data-requesttoken") ||
      body?.getAttribute("data-requesttoken") ||
      win.oc_requesttoken ||
      win.OC?.requestToken ||
      null;

    if (userId && requestToken) {
      void chrome.runtime.sendMessage({
        type: "TRANSDATA_SESSION_DETECTED",
        session: { userId, requestToken, lastDetected: new Date().toISOString() },
      } satisfies ExtensionMessage).catch(() => undefined);
    }
  };

  detectAndSendSession();
  window.addEventListener("DOMContentLoaded", detectAndSendSession);
  window.addEventListener("load", detectAndSendSession);
}
