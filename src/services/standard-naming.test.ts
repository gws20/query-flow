import { describe, expect, it } from "vitest";
import {
  formatLocalDate,
  formatTableNumber,
  extractTableNumberFromFilename,
  parseSqlCommentMeta,
  buildStandardFileName,
  buildStandardDownloadPath,
} from "./standard-naming";

describe("standard-naming service", () => {
  it("formats local date as YYYY-MM-DD", () => {
    const fixed = new Date(2026, 9, 3); // 2026-10-03 (months are 0-indexed)
    expect(formatLocalDate(fixed)).toBe("2026-10-03");
  });

  it("normalizes table numbers to [Tabel ...]", () => {
    expect(formatTableNumber("1a")).toBe("[Tabel 1a]");
    expect(formatTableNumber("Tabel 1a")).toBe("[Tabel 1a]");
    expect(formatTableNumber("[Tabel 1a]")).toBe("[Tabel 1a]");
    expect(formatTableNumber("11-15")).toBe("[Tabel 11-15]");
    expect(formatTableNumber("Tabel 11-15")).toBe("[Tabel 11-15]");
  });

  it("extracts table numbers from various filename patterns", () => {
    expect(extractTableNumberFromFilename("Agregat_1a.sql")).toBe("1a");
    expect(extractTableNumberFromFilename("Mikro_2a.sql")).toBe("2a");
    expect(extractTableNumberFromFilename("Tabel_1a.sql")).toBe("1a");
    expect(extractTableNumberFromFilename("Tabel 11-15.sql")).toBe("11-15");
    expect(extractTableNumberFromFilename("Agregat_11_15.sql")).toBe("11-15");
    expect(extractTableNumberFromFilename("[Tabel 3a] Judul.sql")).toBe("3a");
  });

  it("parses SQL comment metadata correctly", () => {
    const sql1 = `
/*
Judul       : [Tabel 1a] Jumlah Penduduk Berdasarkan Wilayah
Kategori    : Agregat
*/
SELECT * FROM table;
`;
    const meta1 = parseSqlCommentMeta(sql1);
    expect(meta1.judul).toBe("[Tabel 1a] Jumlah Penduduk Berdasarkan Wilayah");
    expect(meta1.tipe).toBe("Agregat");

    const sql2 = `
/*
Nomor Tabel : Tabel 11-15
Judul Tabel : Jumlah Perusahaan Pertanian Breakdown KBLI 2 Digit
Kategori    : Kategori A
Tipe        : Mikro
*/
SELECT * FROM table;
`;
    const meta2 = parseSqlCommentMeta(sql2);
    expect(meta2.nomorTabel).toBe("Tabel 11-15");
    expect(meta2.judul).toBe("Jumlah Perusahaan Pertanian Breakdown KBLI 2 Digit");
    expect(meta2.kategori).toBe("Kategori A");
    expect(meta2.tipe).toBe("Mikro");
  });

  it("builds standard filename [Nomor Tabel] Judul Tabel.xlsx", () => {
    const sql = `
/*
Judul       : Jumlah Penduduk Berdasarkan Wilayah
*/
SELECT * FROM table;
`;
    const res = buildStandardFileName("Agregat/Kategori_A/Agregat_1a.sql", sql, "Agregat_1a.sql");
    expect(res.fileName).toBe("[Tabel 1a] Jumlah Penduduk Berdasarkan Wilayah.xlsx");
    expect(res.sheetTitle).toBe("[Tabel 1a] Jumlah Penduduk Berdasarkan Wilayah");
  });

  it("builds full standard download path according to specification", () => {
    const runDate = new Date(2026, 9, 3); // 2026-10-03

    // Case 1: Mikro -> Kategori A -> [Tabel 1a]
    const sql1 = `
/*
Judul : Jumlah Penduduk Berdasarkan Wilayah
*/
SELECT 1;
`;
    const res1 = buildStandardDownloadPath("Mikro/Kategori_A/Mikro_1a.sql", sql1, "Mikro_1a.sql", runDate);
    expect(res1.relativePath).toBe("2026-10-03/Mikro/Kategori A/[Tabel 1a] Jumlah Penduduk Berdasarkan Wilayah.xlsx");

    // Case 2: Agregat -> Kategori A -> [Tabel 11-15]
    const sql2 = `
/*
Nomor Tabel : 11-15
Judul       : Jumlah Perusahaan Pertanian Breakdown KBLI 2 Digit
*/
SELECT 1;
`;
    const res2 = buildStandardDownloadPath("Agregat/Kategori_A/Agregat_11-15.sql", sql2, "Agregat_11-15.sql", runDate);
    expect(res2.relativePath).toBe("2026-10-03/Agregat/Kategori A/[Tabel 11-15] Jumlah Perusahaan Pertanian Breakdown KBLI 2 Digit.xlsx");

    // Case 3: Sosek -> [Tabel 3a]
    const sql3 = `
/*
Judul : [Tabel 3a] Indikator Sosek
Kategori : Sosek
*/
SELECT 1;
`;
    const res3 = buildStandardDownloadPath("Agregat/Sosek/tabel3a.sql", sql3, "tabel3a.sql", runDate);
    expect(res3.relativePath).toBe("2026-10-03/Agregat/Sosek/[Tabel 3a] Indikator Sosek.xlsx");

    // Case 4: DSD -> [Tabel 4a]
    const sql4 = `
/*
Judul : [Tabel 4a] Hasil DSD
*/
`;
    const res4 = buildStandardDownloadPath("Mikro/DSD/tabel4a.sql", sql4, "tabel4a.sql", runDate);
    expect(res4.relativePath).toBe("2026-10-03/Mikro/DSD/[Tabel 4a] Hasil DSD.xlsx");
  });
});
