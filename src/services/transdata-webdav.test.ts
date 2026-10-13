import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildDavUrl,
  clearVerifiedRemoteDirs,
  createRemoteDirectory,
  ensureRemoteDirectory,
  parseDavMultistatusXml,
} from "./transdata-webdav";

const dummySession = {
  userId: "SSO-BPS-ceb0",
  requestToken: "token-123",
  lastDetected: "2026-10-13T04:00:00Z",
};

afterEach(() => {
  clearVerifiedRemoteDirs();
  vi.restoreAllMocks();
});

describe("transdata webdav url builder", () => {
  it("builds correct URL for root directory", () => {
    expect(buildDavUrl("SSO-BPS-ceb0")).toBe(
      "https://transdata-cloud.bps.go.id/remote.php/dav/files/SSO-BPS-ceb0/",
    );
  });

  it("builds correct URL with encoded path segments", () => {
    expect(buildDavUrl("SSO-BPS-ceb0", "SE2026/Kategori A/[Tabel 1a] Hasil.xlsx")).toBe(
      "https://transdata-cloud.bps.go.id/remote.php/dav/files/SSO-BPS-ceb0/SE2026/Kategori%20A/%5BTabel%201a%5D%20Hasil.xlsx",
    );
  });
});

describe("transdata webdav directory operations", () => {
  it("accepts 200 OK in createRemoteDirectory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 200, statusText: "OK" }),
    );
    await expect(createRemoteDirectory(dummySession, "Tim 30")).resolves.toBe(true);
  });

  it("skips MKCOL when folder already exists via PROPFIND in ensureRemoteDirectory", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<d:multistatus/>", { status: 207, statusText: "Multi-Status" }),
    );
    await ensureRemoteDirectory(dummySession, "Tim 30");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PROPFIND");
  });

  it("calls MKCOL only when PROPFIND indicates folder does not exist", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 404, statusText: "Not Found" }))
      .mockResolvedValueOnce(new Response("", { status: 201, statusText: "Created" }));

    await ensureRemoteDirectory(dummySession, "Tim 30");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PROPFIND");
    expect(fetchSpy.mock.calls[1]?.[1]?.method).toBe("MKCOL");
  });
});

describe("transdata webdav XML parser", () => {
  const sampleXml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/SSO-BPS-ceb0/SE2026/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/SSO-BPS-ceb0/SE2026/3507/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>3507</d:displayname>
        <d:getlastmodified>Tue, 13 Oct 2026 03:00:00 GMT</d:getlastmodified>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/SSO-BPS-ceb0/SE2026/Rekap.xlsx</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Rekap.xlsx</d:displayname>
        <d:getcontentlength>12345</d:getcontentlength>
        <d:getlastmodified>Tue, 13 Oct 2026 03:15:00 GMT</d:getlastmodified>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  it("parses multistatus response skipping current folder itself", () => {
    const items = parseDavMultistatusXml(sampleXml, "SE2026");
    expect(items).toHaveLength(2);

    expect(items[0]).toEqual({
      name: "3507",
      path: "SE2026/3507",
      href: "/remote.php/dav/files/SSO-BPS-ceb0/SE2026/3507/",
      isDirectory: true,
      size: undefined,
      lastModified: "Tue, 13 Oct 2026 03:00:00 GMT",
    });

    expect(items[1]).toEqual({
      name: "Rekap.xlsx",
      path: "SE2026/Rekap.xlsx",
      href: "/remote.php/dav/files/SSO-BPS-ceb0/SE2026/Rekap.xlsx",
      isDirectory: false,
      size: 12345,
      lastModified: "Tue, 13 Oct 2026 03:15:00 GMT",
    });
  });
});
