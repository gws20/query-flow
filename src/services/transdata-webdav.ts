import type { RemoteDavItem, TransdataSession } from "../types";

export function buildDavUrl(userId: string, relativePath = ""): string {
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, "");
  const encodedSegments = cleanPath
    ? cleanPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")
    : "";
  const base = `https://transdata-cloud.bps.go.id/remote.php/dav/files/${encodeURIComponent(userId)}`;
  return encodedSegments ? `${base}/${encodedSegments}` : `${base}/`;
}

/** Parses Nextcloud WebDAV PROPFIND XML response in an environment-agnostic way */
export function parseDavMultistatusXml(xmlText: string, currentPath: string): RemoteDavItem[] {
  const items: RemoteDavItem[] = [];
  const normalizedCurrent = currentPath.replace(/^\/+|\/+$/g, "").toLowerCase();

  const responseRegex = /<(?:[a-zA-Z0-9_-]+:)?response[\s>]([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?response>/gi;
  let match: RegExpExecArray | null;

  while ((match = responseRegex.exec(xmlText)) !== null) {
    const block = match[1] ?? "";

    const hrefMatch = block.match(/<(?:[a-zA-Z0-9_-]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i);
    const rawHref = hrefMatch?.[1]?.trim() ?? "";
    if (!rawHref) continue;

    const decodedHref = decodeURIComponent(rawHref);
    const pathMatch = decodedHref.match(/\/remote\.php\/dav\/files\/[^/]+(\/.*)?$/);
    const relPath = pathMatch?.[1]?.replace(/^\/+|\/+$/g, "") ?? "";

    if (relPath.toLowerCase() === normalizedCurrent) {
      continue;
    }

    const isDirectory = /<(?:[a-zA-Z0-9_-]+:)?collection\b/i.test(block);

    const nameMatch = block.match(/<(?:[a-zA-Z0-9_-]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?displayname>/i);
    let name = nameMatch?.[1]?.trim() || "";
    if (!name) {
      const segments = relPath.split("/").filter(Boolean);
      name = segments[segments.length - 1] || "Unnamed";
    }

    const lengthMatch = block.match(/<(?:[a-zA-Z0-9_-]+:)?getcontentlength[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getcontentlength>/i);
    const size = lengthMatch?.[1] ? parseInt(lengthMatch[1].trim(), 10) : undefined;

    const modMatch = block.match(/<(?:[a-zA-Z0-9_-]+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getlastmodified>/i);
    const lastModified = modMatch?.[1]?.trim() || undefined;

    items.push({
      name,
      path: relPath,
      href: rawHref,
      isDirectory,
      size: typeof size === "number" && !Number.isNaN(size) ? size : undefined,
      lastModified,
    });
  }

  return items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

import { getTransdataTabId } from "./transdata-session";

const verifiedRemoteDirs = new Set<string>();

export function clearVerifiedRemoteDirs(): void {
  verifiedRemoteDirs.clear();
}

/** Executes a WebDAV request inside the active Transdata tab context for perfect cookies and origin alignment */
export async function executeDavViaTab(
  tabId: number,
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyBytes?: Uint8Array,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const payloadNumbers = bodyBytes ? Array.from(bodyBytes) : undefined;

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (
      fetchUrl: string,
      fetchMethod: string,
      fetchHeaders: Record<string, string>,
      payload: number[] | undefined,
      timeout: number,
    ) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const body = payload ? new Uint8Array(payload) : undefined;
        const win = window as unknown as {
          oc_requesttoken?: string;
          OC?: { requestToken?: string };
        };
        const freshToken =
          document.querySelector("head")?.getAttribute("data-requesttoken") ||
          document.querySelector("body")?.getAttribute("data-requesttoken") ||
          win.oc_requesttoken ||
          win.OC?.requestToken;
        if (freshToken && fetchHeaders) {
          fetchHeaders["requesttoken"] = freshToken;
        }

        const res = await fetch(fetchUrl, {
          method: fetchMethod,
          headers: fetchHeaders,
          body,
          credentials: "include",
          signal: controller.signal,
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, statusText: res.statusText, text };
      } catch (err: unknown) {
        const isAbort = (err as { name?: string })?.name === "AbortError";
        return {
          ok: false,
          status: isAbort ? 408 : 0,
          statusText: isAbort ? "Request Timeout (60 detik)" : ((err as Error)?.message || "Fetch failed in tab"),
          text: "",
        };
      } finally {
        clearTimeout(timer);
      }
    },
    args: [url, method, headers, payloadNumbers, timeoutMs],
  });

  const res = results?.[0]?.result;
  if (!res) {
    throw new Error("Tidak ada respon dari tab Transdata.");
  }
  return res;
}

/** Unified WebDAV request dispatcher: prefers active Transdata tab, fallbacks to direct fetch */
export async function sendDavRequest(
  _session: TransdataSession,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: Uint8Array,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; statusText: string; text: string }> {
  const tabId = await getTransdataTabId();

  if (tabId !== null && typeof chrome !== "undefined" && Boolean(chrome.scripting?.executeScript)) {
    try {
      const tabRes = await executeDavViaTab(tabId, url, method, headers, body);
      if (tabRes.status !== 0) {
        return tabRes;
      }
    } catch (tabError) {
      console.warn("Could not execute WebDAV via tab, falling back to direct fetch", tabError);
    }
  }

  // Fallback to direct fetch (also used in Node/vitest tests)
  const fetchSignal = signal ?? (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(60_000) : undefined);
  const response = await fetch(url, {
    method,
    headers,
    body: body as unknown as BodyInit,
    credentials: "include",
    signal: fetchSignal,
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text,
  };
}

/** Lists items inside a Transdata directory via WebDAV PROPFIND */
export async function listRemoteDirectory(
  session: TransdataSession,
  remotePath = "",
  signal?: AbortSignal,
): Promise<RemoteDavItem[]> {
  const url = buildDavUrl(session.userId, remotePath);
  const xmlBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

  const headers: Record<string, string> = {
    requesttoken: session.requestToken,
    "X-Requested-With": "XMLHttpRequest",
    Depth: "1",
    "Content-Type": "application/xml; charset=utf-8",
  };

  const response = await sendDavRequest(
    session,
    url,
    "PROPFIND",
    headers,
    new TextEncoder().encode(xmlBody),
    signal,
  );

  if (response.status !== 207 && !response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Akses Transdata ditolak (${response.status}). Token kedaluwarsa atau belum login.`);
    }
    if (response.status === 404) {
      throw new Error(`Folder Transdata tidak ditemukan: /${remotePath}`);
    }
    throw new Error(`Gagal membaca folder Transdata (${response.status} ${response.statusText})`);
  }

  return parseDavMultistatusXml(response.text, remotePath);
}

/** Checks whether a remote directory already exists via WebDAV PROPFIND (Depth: 0) */
export async function checkRemoteDirectoryExists(
  session: TransdataSession,
  remotePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const clean = remotePath.replace(/^\/+|\/+$/g, "");
  if (!clean) return true;
  const url = buildDavUrl(session.userId, clean);
  const headers: Record<string, string> = {
    requesttoken: session.requestToken,
    "X-Requested-With": "XMLHttpRequest",
    Depth: "0",
  };
  const response = await sendDavRequest(session, url, "PROPFIND", headers, undefined, signal);
  return response.status === 207 || response.ok;
}

/** Creates a single directory via WebDAV MKCOL */
export async function createRemoteDirectory(
  session: TransdataSession,
  remotePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const clean = remotePath.replace(/^\/+|\/+$/g, "");
  if (!clean) return true;
  const url = buildDavUrl(session.userId, clean);

  const headers: Record<string, string> = {
    requesttoken: session.requestToken,
    "X-Requested-With": "XMLHttpRequest",
  };

  const response = await sendDavRequest(session, url, "MKCOL", headers, undefined, signal);

  // 200 OK / 201 Created / 204 No Content: folder created or handled OK
  // 405 Method Not Allowed: already exists
  // 409 Conflict: in some WebDAV setups means already existing or collection
  if (
    response.ok ||
    response.status === 200 ||
    response.status === 201 ||
    response.status === 204 ||
    response.status === 405 ||
    response.status === 409
  ) {
    return true;
  }

  throw new Error(`Gagal membuat folder /${clean} (${response.status} ${response.statusText})`);
}

/** Recursively ensures all parent directories and target directory exist */
export async function ensureRemoteDirectory(
  session: TransdataSession,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  const clean = remotePath.replace(/^\/+|\/+$/g, "");
  if (!clean) return;

  const segments = clean.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (verifiedRemoteDirs.has(current)) {
      continue;
    }
    const exists = await checkRemoteDirectoryExists(session, current, signal);
    if (!exists) {
      await createRemoteDirectory(session, current, signal);
    }
    verifiedRemoteDirs.add(current);
  }
}

/** Uploads a file buffer via WebDAV PUT */
export async function uploadRemoteFile(
  session: TransdataSession,
  remoteFilePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const cleanPath = remoteFilePath.replace(/^\/+|\/+$/g, "");
  const lastSlash = cleanPath.lastIndexOf("/");
  if (lastSlash > 0) {
    const parentDir = cleanPath.slice(0, lastSlash);
    await ensureRemoteDirectory(session, parentDir, signal);
  }

  const url = buildDavUrl(session.userId, cleanPath);
  const headers: Record<string, string> = {
    requesttoken: session.requestToken,
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  const response = await sendDavRequest(session, url, "PUT", headers, bytes, signal);

  if (response.status === 200 || response.status === 201 || response.status === 204) {
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Sesi Transdata ditolak (${response.status}). Pastikan tab Transdata masih login.`);
  }

  const errorPreview = response.text ? `: ${response.text.slice(0, 120)}` : "";
  throw new Error(`Gagal upload file ${cleanPath} (${response.status} ${response.statusText})${errorPreview}`);
}
