import { describe, expect, it } from "vitest";
import { applyWilayahConfig, extractSqlTitle, formatRunProgress } from ".";

it.each(["Nama Tabel", "Judul", "Judul Tabel", "nama tabel", "JUDUL TABEL"])("reads the %s metadata alias", (label) => {
  expect(extractSqlTitle(`/*\n  ${label}: Konsistensi Hortikultura KBLI 02101 - Pengelolaan Hutan\n Creator: Susanto\n*/\nSELECT 1;`, "q_1.sql"))
    .toBe("Konsistensi Hortikultura KBLI 02101 - Pengelolaan Hutan");
});

it("supports starred comments and ignores an empty title", () => {
  expect(extractSqlTitle("/**\n * Judul Tabel: Usaha\n */", "q_1.sql")).toBe("Usaha");
  expect(extractSqlTitle("/*\nJudul:\nCreator: Susanto\n*/", "q_1.sql")).toBe("q_1");
});

const sql = `
/*
Judul       : Nilai Produksi Konstruksi
Tujuan      : Contoh
*/
WITH param_wilayah AS (
  SELECT '' AS filter_provinsi, '' AS filter_kabupaten
)
SELECT *
FROM data A
CROSS JOIN param_wilayah P
WHERE (P.filter_provinsi = '' AND P.filter_kabupaten = '')
   OR (P.filter_provinsi <> '' AND LEFT(A.level_2_full_code, 2) = P.filter_provinsi);
`;

describe("SQL metadata and wilayah parameters", () => {
  it("reads Judul from the leading metadata comment", () => {
    expect(extractSqlTitle(sql, "fallback.sql")).toBe("Nilai Produksi Konstruksi");
    expect(extractSqlTitle("SELECT 1", "fallback.sql")).toBe("fallback");
  });

  it("prioritizes selected regencies so a province does not broaden the result", () => {
    const prepared = applyWilayahConfig(sql, { level1: ["32", "35"], level2: ["3201", "3507"] });
    expect(prepared).toContain("'' AS filter_provinsi");
    expect(prepared).toContain("'3201|3507' AS filter_kabupaten");
    expect(prepared).toContain("CONCAT('|', P.filter_provinsi, '|') LIKE CONCAT('%|', LEFT(A.level_2_full_code, 2), '|%')");
  });

  it("uses multiple provinces only when no regency is selected", () => {
    const prepared = applyWilayahConfig(sql, { level1: ["32", "35"], level2: [] });
    expect(prepared).toContain("'32|35' AS filter_provinsi");
    expect(prepared).toContain("'' AS filter_kabupaten");

    const unfiltered = applyWilayahConfig(sql, { level1: [], level2: [] });
    expect(unfiltered).toContain("'' AS filter_provinsi");
    expect(unfiltered).toContain("'' AS filter_kabupaten");
  });

  it("leaves legacy SQL without the standard aliases unchanged", () => {
    expect(applyWilayahConfig("SELECT 1;", { level1: ["35"], level2: [] })).toBe("SELECT 1;");
  });

  it("supports the other province comparison styles used by the repository", () => {
    const variants = `${sql}\nAND CAST(ur.level_1_full_code AS CHAR) = pw.filter_provinsi\nAND ba.level_1_full_code = pw.filter_provinsi`;
    const prepared = applyWilayahConfig(variants, { level1: ["32", "35"], level2: [] });
    expect(prepared).toContain("CONCAT('|', pw.filter_provinsi, '|') LIKE CONCAT('%|', CAST(ur.level_1_full_code AS CHAR), '|%')");
    expect(prepared).toContain("CONCAT('|', pw.filter_provinsi, '|') LIKE CONCAT('%|', ba.level_1_full_code, '|%')");
  });
});

describe("formatRunProgress", () => {
  it("formats running state with offset and limit", () => {
    expect(formatRunProgress({
      runId: "1",
      path: "test.sql",
      iteration: 1,
      state: "running",
      rowsCollected: 0,
      offset: 0,
      limit: 9000,
    })).toBe("⏳ Batch ke-1 (baris 1–9.000) sedang diambil · 0 baris terkumpul");
  });

  it("formats running state for subsequent pagination batches", () => {
    expect(formatRunProgress({
      runId: "1",
      path: "test.sql",
      iteration: 2,
      state: "running",
      rowsCollected: 9000,
      offset: 9000,
      limit: 9000,
    })).toBe("⏳ Batch ke-2 (baris 9.001–18.000) sedang diambil · 9.000 baris terkumpul");
  });

  it("formats completed state with batchRows count", () => {
    expect(formatRunProgress({
      runId: "1",
      path: "test.sql",
      iteration: 1,
      state: "completed",
      rowsCollected: 9000,
      batchRows: 9000,
    })).toBe("✓ Batch ke-1 selesai (+9.000 baris) · 9.000 baris terkumpul");
  });

  it("formats fallback running and completed without optional fields", () => {
    expect(formatRunProgress({
      runId: "1",
      path: "test.sql",
      iteration: 3,
      state: "running",
      rowsCollected: 18000,
    })).toBe("⏳ Batch ke-3 sedang berjalan · 18.000 baris terkumpul");

    expect(formatRunProgress({
      runId: "1",
      path: "test.sql",
      iteration: 3,
      state: "completed",
      rowsCollected: 20000,
    })).toBe("✓ Batch ke-3 selesai · 20.000 baris terkumpul");
  });
});
