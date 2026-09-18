/**
 * SpreadsheetML (.xlsx) — reading a workbook into rows, and writing one.
 *
 * ## Supported on read
 *
 * - Sheet order and names from `xl/workbook.xml`, resolved to their parts
 *   through the workbook's relationships (not by guessing `sheet1.xml`).
 * - The shared-string table (`xl/sharedStrings.xml`), including strings
 *   split across several `r`/`t` runs, which is what Excel writes whenever a
 *   cell has mixed formatting.
 * - Cell types: `s` (shared string), `str` (formula string result),
 *   `inlineStr`, `b` (boolean), `e` (error, reported as its error text),
 *   `d` (ISO-8601 date, the newer form) and the default numeric type.
 * - Formulas: the formula text is reported ALONGSIDE the cached value that
 *   the producing application last computed. Nothing here evaluates a
 *   formula, and a workbook saved with stale caches will report stale
 *   values — `cachedValue` is named that way for exactly this reason.
 * - Dates: a numeric cell whose number format is a date format is converted
 *   to an ISO-8601 string. Both the 1900 and the 1904 date systems are
 *   honoured (`workbookPr/@date1904`).
 * - Sparse rows and sparse columns: a missing cell is `null`, and rows are
 *   padded to the width of the widest row in the sheet.
 *
 * ## Not supported — stated rather than faked
 *
 * - Formula evaluation, defined names, pivot tables, charts, conditional
 *   formatting, data validation, merged-cell geometry, comments, and every
 *   other presentation concern. This reads VALUES.
 * - `.xlsb` (the binary workbook) and `.xls` (the pre-2007 OLE format) are
 *   not SpreadsheetML and are refused by the ZIP layer, which is correct:
 *   they need a different reader entirely.
 * - A cell's style beyond "is this number format a date format".
 */
import { XML_DECL, assertSafePartNames, readCoreProperties, relationshipMap, utf8 } from "./ooxml";
import {
  type XmlElement,
  childNamed,
  descendants,
  escapeXml,
  isElement,
  parseXml,
  rootElement,
  textOf,
} from "./xml";
import { type ZipArchive, ZipError, type ZipInput, writeZip } from "./zip";

export type CellValue = string | number | boolean | null;

export type SheetFormula = {
  readonly ref: string;
  readonly formula: string;
  readonly cachedValue: CellValue;
};

export type Sheet = {
  readonly name: string;
  readonly rows: ReadonlyArray<ReadonlyArray<CellValue>>;
  readonly formulas: ReadonlyArray<SheetFormula>;
  /** True when the sheet was cut short by the caller's row limit. */
  readonly truncated: boolean;
};

export type Workbook = {
  readonly sheets: ReadonlyArray<Sheet>;
  readonly properties: Record<string, string>;
  readonly date1904: boolean;
};

const WORKBOOK_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

/**
 * Excel's serial dates, converted exactly.
 *
 * THE 1900 LEAP-YEAR BUG: Lotus 1-2-3 treated 1900 as a leap year, and Excel
 * copied the mistake for file-format compatibility. So in the 1900 system
 * serial 60 is "1900-02-29", a day that never existed, and every serial from
 * 61 onwards is offset by one relative to a correct day count. The
 * conversion below therefore uses TWO epochs: serials below 60 count from
 * 1899-12-31, serials above 60 count from 1899-12-30, and serial 60 itself
 * has no real date and is refused rather than silently rendered as March 1st.
 *
 * The 1904 system (the old Mac default, `workbookPr/@date1904="1"`) has no
 * such bug: it counts from 1904-01-01 with no phantom day.
 */
export function serialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const whole = Math.floor(serial);
  const fraction = serial - whole;
  let ms: number;
  if (date1904) {
    ms = (serial + 1462 - 25569) * 86_400_000;
  } else {
    if (whole === 60) return null; // the phantom 1900-02-29
    ms = (serial - (whole < 60 ? 25568 : 25569)) * 86_400_000;
  }
  const date = new Date(Math.round(ms));
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  // A serial with no fractional part is a date, not an instant; saying
  // "2024-01-05" is truer than "2024-01-05T00:00:00.000Z". Serial 0 is a
  // real date in the 1904 system and a placeholder in the 1900 one.
  const isWholeDay = fraction === 0 && (date1904 ? whole >= 0 : whole >= 1);
  return isWholeDay ? (iso.slice(0, 10) as string) : iso.replace(".000Z", "Z");
}

/** Number-format ids that are dates or times in every Excel locale. */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

/**
 * True when a custom format code formats a date or time. Date tokens inside
 * a quoted literal (`"May"`), a colour (`[Red]`) or an escape (`\d`) are not
 * tokens, so those are stripped before looking.
 */
export function isDateFormatCode(code: string): boolean {
  let stripped = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === "[") inBracket = true;
    else if (!inQuote && ch === "]") inBracket = false;
    else if (!inQuote && !inBracket) stripped += ch;
  }
  return /[ymdhs]/i.test(stripped);
}

/** style index -> is this a date format, from `xl/styles.xml`. */
function dateStyles(zip: ZipArchive, part: string): boolean[] {
  if (!zip.has(part)) return [];
  const root = rootElement(parseXml(zip.readText(part)));
  const custom = new Map<number, string>();
  for (const fmt of descendants(root, "numFmt")) {
    const id = Number.parseInt(fmt.attributes["numFmtId"] ?? "", 10);
    const code = fmt.attributes["formatCode"];
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const cellXfs = childNamed(root, "cellXfs");
  if (cellXfs === undefined) return [];
  const out: boolean[] = [];
  for (const xf of descendants(cellXfs, "xf")) {
    const id = Number.parseInt(xf.attributes["numFmtId"] ?? "0", 10);
    if (!Number.isFinite(id)) {
      out.push(false);
      continue;
    }
    const code = custom.get(id);
    out.push(code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormatCode(code));
  }
  return out;
}

/** The shared-string table, in index order. */
function sharedStrings(zip: ZipArchive, part: string): string[] {
  if (!zip.has(part)) return [];
  const root = rootElement(parseXml(zip.readText(part)));
  const out: string[] = [];
  for (const si of descendants(root, "si")) {
    // A plain string is one `t`; a rich string is a list of `r` runs each
    // holding a `t`. `textOf` would also pick up `rPh` phonetic hints, so
    // the runs are walked explicitly.
    const direct = childNamed(si, "t");
    if (direct !== undefined) {
      out.push(textOf(direct));
      continue;
    }
    let text = "";
    for (const run of descendants(si, "r")) {
      const t = childNamed(run, "t");
      if (t !== undefined) text += textOf(t);
    }
    out.push(text);
  }
  return out;
}

/** `A1` / `BC12` -> zero-based column index. `-1` when unparseable. */
export function columnIndex(ref: string): number {
  let index = 0;
  let seen = false;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
      seen = true;
    } else if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
      seen = true;
    } else break;
  }
  return seen ? index - 1 : -1;
}

/** Zero-based column index -> `A`, `Z`, `AA`. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - rem) / 26);
  }
  return out;
}

type SheetRef = { name: string; part: string };

function sheetRefs(zip: ZipArchive, workbookPart: string): SheetRef[] {
  const root = rootElement(parseXml(zip.readText(workbookPart)));
  const rels = relationshipMap(zip, workbookPart);
  const out: SheetRef[] = [];
  const sheets = childNamed(root, "sheets");
  if (sheets === undefined) return out;
  for (const sheet of descendants(sheets, "sheet")) {
    const name = sheet.attributes["name"] ?? `Sheet${out.length + 1}`;
    const relId = sheet.attributes["r:id"] ?? sheet.attributes["relationships:id"];
    const target = relId === undefined ? undefined : rels.get(relId)?.target;
    if (target !== undefined && zip.has(target)) out.push({ name, part: target });
  }
  return out;
}

function cellValue(
  cell: XmlElement,
  strings: ReadonlyArray<string>,
  isDate: ReadonlyArray<boolean>,
  date1904: boolean,
): CellValue {
  const type = cell.attributes["t"] ?? "n";
  if (type === "inlineStr") {
    const is = childNamed(cell, "is");
    return is === undefined ? "" : textOf(is);
  }
  const v = childNamed(cell, "v");
  const raw = v === undefined ? "" : textOf(v);
  switch (type) {
    case "s": {
      const index = Number.parseInt(raw, 10);
      return strings[index] ?? "";
    }
    case "str":
      return raw;
    case "b":
      return raw === "1" || raw.toLowerCase() === "true";
    case "e":
      return raw; // "#DIV/0!" and friends: the error text IS the value
    case "d":
      return raw; // already ISO-8601
    default: {
      if (raw === "") return null;
      const num = Number(raw);
      if (!Number.isFinite(num)) return raw;
      const styleIndex = Number.parseInt(cell.attributes["s"] ?? "", 10);
      if (Number.isFinite(styleIndex) && isDate[styleIndex] === true) {
        const iso = serialToIso(num, date1904);
        // Serial 60 has no real date. Saying so beats inventing March 1st.
        return iso ?? "#1900-02-29 (Excel phantom date)";
      }
      return num;
    }
  }
}

export type XlsxReadOptions = {
  /** Sheets to read; every sheet when omitted. Matched by exact name. */
  readonly sheetNames?: ReadonlyArray<string>;
  readonly maxRowsPerSheet: number;
  readonly maxColumns: number;
};

export function readXlsx(zip: ZipArchive, options: XlsxReadOptions): Workbook {
  assertSafePartNames(zip);
  let workbookPart: string | undefined;
  for (const rel of relationshipMap(zip, "").values()) {
    if (rel.type === WORKBOOK_REL && !rel.external) workbookPart = rel.target;
  }
  if (workbookPart === undefined && zip.has("xl/workbook.xml")) workbookPart = "xl/workbook.xml";
  if (workbookPart === undefined) {
    throw new ZipError("this package declares no workbook part (is it really a .xlsx?)");
  }
  const workbookRoot = rootElement(parseXml(zip.readText(workbookPart)));
  const date1904 = childNamed(workbookRoot, "workbookPr")?.attributes["date1904"] === "1";
  const dir = workbookPart.slice(0, workbookPart.lastIndexOf("/") + 1);
  const strings = sharedStrings(zip, `${dir}sharedStrings.xml`);
  const isDate = dateStyles(zip, `${dir}styles.xml`);

  const wanted = options.sheetNames === undefined ? undefined : new Set(options.sheetNames);
  const sheets: Sheet[] = [];
  for (const ref of sheetRefs(zip, workbookPart)) {
    if (wanted !== undefined && !wanted.has(ref.name)) continue;
    const root = rootElement(parseXml(zip.readText(ref.part)));
    const sheetData = childNamed(root, "sheetData");
    const rows: CellValue[][] = [];
    const formulas: SheetFormula[] = [];
    let truncated = false;
    let width = 0;
    if (sheetData !== undefined) {
      for (const row of sheetData.children) {
        if (!isElement(row) || row.name !== "row") continue;
        if (rows.length >= options.maxRowsPerSheet) {
          truncated = true;
          break;
        }
        // `row/@r` is 1-based and may skip rows entirely; blank rows in
        // between are materialised so a caller's row index means something.
        // A gap that runs past the row limit is where that guarantee breaks:
        // padding stops, and this row's data would land at an index that is
        // not its row number. Stop and SAY the sheet was cut short instead.
        const declared = Number.parseInt(row.attributes["r"] ?? "", 10);
        if (Number.isFinite(declared) && declared > rows.length + 1) {
          if (declared > options.maxRowsPerSheet) {
            truncated = true;
            break;
          }
          while (rows.length < declared - 1) rows.push([]);
        }
        const cells: CellValue[] = [];
        for (const cell of row.children) {
          if (!isElement(cell) || cell.name !== "c") continue;
          const ref2 = cell.attributes["r"] ?? "";
          const col = columnIndex(ref2);
          const at = col >= 0 ? col : cells.length;
          if (at >= options.maxColumns) {
            truncated = true;
            continue;
          }
          while (cells.length < at) cells.push(null);
          const value = cellValue(cell, strings, isDate, date1904);
          cells[at] = value;
          const f = childNamed(cell, "f");
          if (f !== undefined) {
            const text = textOf(f);
            // A shared formula's followers carry `t="shared"` with no body;
            // reporting an empty formula would be a lie, so they are skipped
            // and only the master (which carries the text) is reported.
            if (text !== "") formulas.push({ ref: ref2, formula: `=${text}`, cachedValue: value });
          }
        }
        width = Math.max(width, cells.length);
        rows.push(cells);
      }
    }
    for (const row of rows) while (row.length < width) row.push(null);
    sheets.push({ name: ref.name, rows, formulas, truncated });
  }
  return { sheets, properties: readCoreProperties(zip), date1904 };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

export type XlsxWriteSheet = {
  readonly name: string;
  /** The first row is written as a bold header when `header` is true. */
  readonly rows: ReadonlyArray<ReadonlyArray<CellValue>>;
  readonly header?: boolean;
  /**
   * Zero-based column indexes whose ISO-8601 string values become real date
   * cells. Opt-in: guessing at which strings are dates is how a spreadsheet
   * turns a part number into a date, and this tool will not do that.
   */
  readonly dateColumns?: ReadonlyArray<number>;
};

/** ISO-8601 date or date-time -> an Excel 1900-system serial. */
export function isoToSerial(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso);
  if (match === null) return null;
  const [, y, m, d, hh, mm, ss] = match;
  const ms = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh ?? "0"),
    Number(mm ?? "0"),
    Number(ss ?? "0"),
  );
  if (Number.isNaN(ms)) return null;
  const days = ms / 86_400_000 + 25569;
  // The +1 restores Excel's phantom 1900-02-29 for anything at or after
  // 1900-03-01, which is what makes the value round-trip in Excel.
  return days >= 61 ? days : days - 1;
}

function sheetXml(sheet: XlsxWriteSheet): string {
  const dateCols = new Set(sheet.dateColumns ?? []);
  const rowsXml = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          const headerStyle = sheet.header === true && r === 0 ? ' s="1"' : "";
          if (value === null || value === undefined) return "";
          if (typeof value === "number") {
            return `<c r="${ref}"${headerStyle}><v>${value}</v></c>`;
          }
          if (typeof value === "boolean") {
            return `<c r="${ref}"${headerStyle} t="b"><v>${value ? 1 : 0}</v></c>`;
          }
          if (dateCols.has(c)) {
            const serial = isoToSerial(value);
            if (serial !== null) return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
          }
          return `<c r="${ref}"${headerStyle} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");
  return `${XML_DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

/**
 * Build a .xlsx. Three cell formats are defined: 0 (general), 1 (bold, for a
 * header row) and 2 (the `yyyy-mm-dd` date format).
 */
export function writeXlsx(sheets: ReadonlyArray<XlsxWriteSheet>): Uint8Array {
  if (sheets.length === 0) throw new ZipError("a workbook needs at least one sheet");
  const sheetEntries = sheets.map((sheet, i) => ({
    sheet,
    part: `xl/worksheets/sheet${i + 1}.xml`,
  }));

  const workbookXml = `${XML_DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries
    .map(
      ({ sheet }, i) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("")}</sheets></workbook>`;

  const workbookRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries
    .map(
      (_entry, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join(
      "",
    )}<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  const stylesXml = `${XML_DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetEntries
    .map(
      ({ part }) =>
        `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")}</Types>`;

  const rootRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${WORKBOOK_REL}" Target="xl/workbook.xml"/></Relationships>`;

  const parts: ZipInput[] = [
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "xl/workbook.xml", data: utf8(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels) },
    { name: "xl/styles.xml", data: utf8(stylesXml) },
    ...sheetEntries.map(({ sheet, part }) => ({ name: part, data: utf8(sheetXml(sheet)) })),
  ];
  return writeZip(parts);
}
