export interface ParsedSqlMeta {
  nomorTabel?: string;
  judul?: string;
  tipe?: "Mikro" | "Agregat";
  kategori?: string;
}

/** Format Date to YYYY-MM-DD in local time */
export function formatLocalDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Normalizes table number to standard format "[Tabel ...]" */
export function formatTableNumber(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\[.+\]$/.test(trimmed)) return trimmed;
  if (/^tabel\b/i.test(trimmed)) {
    return `[${trimmed.charAt(0).toUpperCase() + trimmed.slice(1)}]`;
  }
  return `[Tabel ${trimmed}]`;
}

/** Try to extract table number from filename like Agregat_1a.sql, Tabel_11-15.sql, etc. */
export function extractTableNumberFromFilename(filename: string): string | null {
  const base = filename.replace(/\.sql$/i, "").trim();
  
  // Pattern: [Tabel 1a] or [1a]
  const bracketMatch = base.match(/^\[(?:Tabel\s+)?([^\]]+)\]/i);
  if (bracketMatch) return bracketMatch[1]?.trim() ?? null;

  // Pattern: Tabel_1a or Tabel 1a or Tabel-1a or Tabel1a
  const tabelMatch = base.match(/^Tabel[_\s-]?([0-9]+[a-z]*(?:[-_][0-9]+[a-z]*)?)/i);
  if (tabelMatch) return tabelMatch[1]?.replace(/_/g, "-").trim() ?? null;

  // Pattern: Agregat_1a, Mikro_11-15, Agregat_11_15
  const prefixMatch = base.match(/^(?:Agregat|Mikro)[_\s-]+([0-9]+[a-z]*(?:[-_][0-9]+[a-z]*)?)/i);
  if (prefixMatch) return prefixMatch[1]?.replace(/_/g, "-").trim() ?? null;

  // Pattern: Starts with number like 1a_... or 11-15_...
  const leadingNumMatch = base.match(/^([0-9]+[a-z]*(?:[-_][0-9]+[a-z]*)?)\b/i);
  if (leadingNumMatch) return leadingNumMatch[1]?.replace(/_/g, "-").trim() ?? null;

  return null;
}

/** Parses metadata from SQL first block comment */
export function parseSqlCommentMeta(sql: string): ParsedSqlMeta {
  const comment = sql.match(/\/\*([\s\S]*?)\*\//)?.[1] ?? "";
  if (!comment) return {};

  const meta: ParsedSqlMeta = {};

  const nomorMatch = comment.match(/^[\t ]*(?:\*[\t ]*)?(?:Nomor[\t ]+Tabel|No[\t ]+Tabel|No\.?[\t ]+Tabel)[\t ]*:[\t ]*(\S[^\r\n]*)/im);
  if (nomorMatch) meta.nomorTabel = nomorMatch[1]?.trim();

  const judulMatch = comment.match(/^[\t ]*(?:\*[\t ]*)?(?:Judul[\t ]+Tabel|Nama[\t ]+Tabel|Judul)[\t ]*:[\t ]*(\S[^\r\n]*)/im);
  if (judulMatch) meta.judul = judulMatch[1]?.trim();

  const tipeMatch = comment.match(/^[\t ]*(?:\*[\t ]*)?(?:Tipe|Jenis|Tipe[\t ]+Data)[\t ]*:[\t ]*(Mikro|Agregat)/im);
  if (tipeMatch) {
    meta.tipe = /mikro/i.test(tipeMatch[1] ?? "") ? "Mikro" : "Agregat";
  }

  const kategoriMatch = comment.match(/^[\t ]*(?:\*[\t ]*)?(?:Kategori[\t ]+Tabel|Subkategori|Kategori)[\t ]*:[\t ]*(\S[^\r\n]*)/im);
  if (kategoriMatch) {
    const val = kategoriMatch[1]?.trim() ?? "";
    if (/^mikro$/i.test(val)) {
      meta.tipe = "Mikro";
    } else if (/^agregat$/i.test(val)) {
      meta.tipe = "Agregat";
    } else {
      meta.kategori = val;
    }
  }

  return meta;
}

/** Sanitize string for valid file or folder name */
export function sanitizePathSegment(name: string): string {
  return name
    .replace(/[\\/*?:"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize category name (e.g. Kategori_A -> Kategori A, Sosek -> Sosek) */
export function normalizeCategoryName(raw: string): string {
  let cleaned = raw.replace(/^📂\s*/, "").trim();
  // If Kategori_A, convert underscore to space
  if (/^kategori[_\s]+[a-z0-9]+/i.test(cleaned)) {
    cleaned = cleaned.replace(/_/g, " ");
  }
  return sanitizePathSegment(cleaned) || "Kategori Umum";
}

/** Builds standard file name: "[Nomor Tabel] Judul Tabel.xlsx" */
export function buildStandardFileName(
  filePath: string,
  sqlContent: string,
  filename: string,
): { fileName: string; sheetTitle: string } {
  const meta = parseSqlCommentMeta(sqlContent);
  const baseName = filename.replace(/\.sql$/i, "").trim();
  
  let nomorTabel = meta.nomorTabel;
  let rawJudul = meta.judul;

  // Check if rawJudul already has bracketed table number: [Tabel 1a] Judul...
  const judulBracketMatch = rawJudul?.match(/^\[([^\]]+)\]\s*(.*)$/);
  if (judulBracketMatch) {
    nomorTabel = judulBracketMatch[1];
    rawJudul = judulBracketMatch[2]?.trim();
  }

  // If table number not found in comment, try from filename or filePath
  if (!nomorTabel) {
    const inferredNumber = extractTableNumberFromFilename(filename) ?? extractTableNumberFromFilename(filePath);
    if (inferredNumber) nomorTabel = inferredNumber;
  }


  // If title is missing, fallback to filename cleaned
  const fallbackJudul = baseName
    .replace(/^(?:Agregat|Mikro)[_\s-]*/i, "")
    .replace(/^(?:Tabel)[_\s-]*/i, "")
    .replace(/^[0-9]+[a-z]*(?:[-_][0-9]+[a-z]*)?[_\s-]*/i, "")
    .replace(/_/g, " ")
    .trim();

  const finalJudul = rawJudul || fallbackJudul || baseName;
  const formattedNomor = nomorTabel ? formatTableNumber(nomorTabel) : "";

  let combined = formattedNomor ? `${formattedNomor} ${finalJudul}` : finalJudul;
  combined = sanitizePathSegment(combined);

  // If still completely empty
  if (!combined) combined = `[Tabel] ${baseName}`;

  const fileName = `${combined}.xlsx`;
  const sheetTitle = combined;

  return { fileName, sheetTitle };
}

/**
 * Builds standard relative download path:
 * YYYY-MM-DD/[Mikro|Agregat]/[Kategori]/[Nomor Tabel] Judul Tabel.xlsx
 */
export function buildStandardDownloadPath(
  filePath: string,
  sqlContent: string,
  filename: string,
  runDate: Date = new Date(),
): { relativePath: string; fileName: string; sheetTitle: string } {
  const dateStr = formatLocalDate(runDate);
  const meta = parseSqlCommentMeta(sqlContent);
  const segments = filePath.split("/").filter(Boolean);
  
  // 1. Determine Type: Mikro or Agregat
  let tipe: "Mikro" | "Agregat" = meta.tipe ?? "Agregat";
  const hasMikro = segments.some((s) => /mikro/i.test(s)) || /mikro/i.test(filename);
  const hasAgregat = segments.some((s) => /agregat/i.test(s)) || /agregat/i.test(filename);
  
  if (hasMikro && !hasAgregat) {
    tipe = "Mikro";
  } else if (hasAgregat && !hasMikro) {
    tipe = "Agregat";
  }

  // 2. Determine Category (Kategori A, Kategori B, Sosek, DSD, etc.)
  let kategori = meta.kategori;
  if (!kategori) {
    // Look in path segments
    const folderSegments = segments.slice(0, -1); // exclude filename
    const nonTypeSegments = folderSegments.filter((s) => !/^(?:mikro|agregat)$/i.test(s));
    if (nonTypeSegments.length > 0) {
      kategori = nonTypeSegments[nonTypeSegments.length - 1];
    }
  }
  if (!kategori) {
    kategori = "Umum";
  }
  const cleanKategori = normalizeCategoryName(kategori);

  // 3. Determine File Name
  const { fileName, sheetTitle } = buildStandardFileName(filePath, sqlContent, filename);

  const relativePath = `${dateStr}/${tipe}/${cleanKategori}/${fileName}`;

  return { relativePath, fileName, sheetTitle };
}
