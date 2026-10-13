import type { TransdataSession } from "../types";

const TRANSDATA_STORAGE_KEY = "queryflow-transdata-session";

export async function loadTransdataSession(): Promise<TransdataSession | null> {
  try {
    const data = await chrome.storage.local.get(TRANSDATA_STORAGE_KEY);
    const session = data[TRANSDATA_STORAGE_KEY] as TransdataSession | undefined;
    if (session?.userId && session?.requestToken) {
      return session;
    }
  } catch {
    // context invalidated or storage error
  }
  return null;
}

export async function saveTransdataSession(session: TransdataSession): Promise<void> {
  try {
    await chrome.storage.local.set({
      [TRANSDATA_STORAGE_KEY]: {
        ...session,
        lastDetected: new Date().toISOString(),
      },
    });
  } catch {
    // ignore
  }
}

export async function clearTransdataSession(): Promise<void> {
  try {
    await chrome.storage.local.remove(TRANSDATA_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Function injected into Transdata tab to extract session info */
export function extractTransdataFromDom(): { userId: string | null; requestToken: string | null } {
  const head = document.querySelector("head");
  const body = document.querySelector("body");
  const win = window as unknown as {
    oc_config?: { currentUser?: string };
    OC?: { currentUser?: string; requestToken?: string };
    oc_current_user?: string;
    oc_requesttoken?: string;
  };

  const userId =
    head?.getAttribute("data-user") ||
    body?.getAttribute("data-user") ||
    win.oc_config?.currentUser ||
    win.OC?.currentUser ||
    win.oc_current_user ||
    null;

  const requestToken =
    head?.getAttribute("data-requesttoken") ||
    body?.getAttribute("data-requesttoken") ||
    win.oc_requesttoken ||
    win.OC?.requestToken ||
    null;

  return { userId, requestToken };
}

/** Queries any open Transdata tab and inspects DOM/JS variables for session */
export async function detectTransdataSessionFromTabs(): Promise<TransdataSession | null> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://transdata-cloud.bps.go.id/*" });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: extractTransdataFromDom,
        });
        const extracted = results[0]?.result;
        if (extracted?.userId && extracted?.requestToken) {
          const session: TransdataSession = {
            userId: extracted.userId,
            requestToken: extracted.requestToken,
            lastDetected: new Date().toISOString(),
          };
          await saveTransdataSession(session);
          return session;
        }
      } catch (scriptError) {
        console.warn("Could not inspect tab", tab.id, scriptError);
      }
    }
  } catch (error) {
    console.warn("Failed querying Transdata tabs", error);
  }
  return null;
}

/** Queries any open Transdata tab and returns its tab ID */
export async function getTransdataTabId(): Promise<number | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  try {
    const tabs = await chrome.tabs.query({ url: "https://transdata-cloud.bps.go.id/*" });
    const tab = tabs.find((t) => t.id !== undefined && !t.discarded);
    return tab?.id ?? tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

