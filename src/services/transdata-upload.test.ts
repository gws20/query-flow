import { describe, expect, it } from "vitest";
import { computeRemotePath } from "./transdata-upload";

describe("transdata upload computeRemotePath", () => {
  it("mirrors local relative path under remote base folder", () => {
    expect(
      computeRemotePath(
        "3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx",
        "SE2026",
        "mirror",
      ),
    ).toBe("SE2026/3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx");
  });

  it("mirrors to root if remoteBaseFolder is empty", () => {
    expect(
      computeRemotePath(
        "3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx",
        "",
        "mirror",
      ),
    ).toBe("3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx");
  });

  it("strips selected subfolder root in direct-in-target mode", () => {
    expect(
      computeRemotePath(
        "3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx",
        "SE2026/Kab_3507",
        "direct-in-target",
        "3507",
      ),
    ).toBe("SE2026/Kab_3507/2026-10-13/Mikro/Kategori A/[Tabel 1a] Hasil.xlsx");
  });
});
