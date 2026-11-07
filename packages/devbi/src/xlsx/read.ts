import { readZip, type ZipEntry } from "./zip.js";

export type XlsxColumnType = "VARCHAR" | "DOUBLE" | "BIGINT" | "BOOLEAN" | "DATE" | "TIMESTAMP";
export type XlsxValue = string | number | boolean | Date | null;

export interface XlsxColumn {
  name: string;
  type: XlsxColumnType;
  values: XlsxValue[];
}

export interface XlsxTable {
  sheet: string;
  rowCount: number;
  columns: XlsxColumn[];
}

export interface ReadXlsxOptions {
  /** Sheet name. Defaults to the first sheet. */
  sheet?: string;
  /** Whether the first non-empty row holds column names. Default true. */
  header?: boolean;
  /** Cell range such as `A1:F500`. Defaults to the used range. */
  range?: string;
  /** Read every column as text. */
  allVarchar?: boolean;
}

type Cell =
  | { kind: "number"; value: number; date: boolean }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "date"; value: Date };

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
      return ENTITY[e] ?? m;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = m[1]!;
    const value = decodeXml(m[2] ?? m[3] ?? "");
    out[key] = value;
    const local = key.includes(":") ? key.slice(key.indexOf(":") + 1) : undefined;
    if (local && !(local in out)) out[local] = value;
  }
  return out;
}

/** Text of a shared string or inline string item, without phonetic (furigana) runs. */
function itemText(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<phoneticPr\b[^>]*\/>/g, "");
  let out = "";
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]!);
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Whether an Excel number format code displays a date or time. */
export function isDateFormat(code: string): boolean {
  if (/^general$/i.test(code.trim())) return false;
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .replace(/E[+-]/gi, "");
  return /[ydhsgem]/i.test(stripped);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.replaceAll("$", ""));
  if (!m) throw new Error(`セル番地として読めません: ${ref}`);
  return { col: colIndex(m[1]!), row: Number(m[2]) - 1 };
}

const MS_PER_DAY = 86_400_000;

function serialToDate(serial: number, date1904: boolean): Date {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial * MS_PER_DAY));
}

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  return out.join("/");
}

interface Workbook {
  entries: Map<string, ZipEntry>;
  sheets: { name: string; path: string }[];
  date1904: boolean;
}

async function openWorkbook(data: Uint8Array | ArrayBuffer): Promise<Workbook> {
  const entries = readZip(data instanceof Uint8Array ? data : new Uint8Array(data));
  const wb = entries.get("xl/workbook.xml");
  if (!wb) throw new Error("xlsx として読めません: xl/workbook.xml がありません");
  const wbXml = await wb.text();
  const relsXml = (await entries.get("xl/_rels/workbook.xml.rels")?.text()) ?? "";
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    if (a.Id && a.Target) rels.set(a.Id, resolveTarget(a.Target));
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    const rid = a["r:id"] ?? a.id;
    const path = rid ? rels.get(rid) : undefined;
    if (a.name && path) sheets.push({ name: a.name, path });
  }
  const pr = /<workbookPr\b([^>]*)>/.exec(wbXml);
  const date1904 = pr ? /^(1|true)$/i.test(attrs(pr[1]!).date1904 ?? "") : false;
  return { entries, sheets, date1904 };
}

/** Names of the sheets in a workbook, in order. */
export async function listSheets(data: Uint8Array | ArrayBuffer): Promise<string[]> {
  return (await openWorkbook(data)).sheets.map((s) => s.name);
}

async function dateStyles(entries: Map<string, ZipEntry>): Promise<boolean[]> {
  const xml = (await entries.get("xl/styles.xml")?.text()) ?? "";
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]!);
    if (a.numFmtId && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const out: boolean[] = [];
  for (const m of xfs.matchAll(/<xf\b([^>]*)>/g)) {
    const id = Number(attrs(m[1]!).numFmtId ?? 0);
    const code = custom.get(id);
    out.push(code !== undefined ? isDateFormat(code) : BUILTIN_DATE_FORMATS.has(id));
  }
  return out;
}

async function sharedStrings(entries: Map<string, ZipEntry>): Promise<string[]> {
  const xml = (await entries.get("xl/sharedStrings.xml")?.text()) ?? "";
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\s*\/>/g)) out.push(m[1] ? itemText(m[1]) : "");
  return out;
}

function parseRange(range: string): { r0: number; c0: number; r1: number; c1: number } {
  const [a, b = a] = range.split(":");
  const p = parseRef(a!);
  const q = parseRef(b!);
  return { r0: Math.min(p.row, q.row), c0: Math.min(p.col, q.col), r1: Math.max(p.row, q.row), c1: Math.max(p.col, q.col) };
}

function isEmpty(c: Cell | undefined): boolean {
  return !c || (c.kind === "string" && c.value === "");
}

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function cellText(c: Cell, date1904: boolean): string {
  switch (c.kind) {
    case "string":
      return c.value;
    case "bool":
      return c.value ? "TRUE" : "FALSE";
    case "date":
      return c.value.toISOString();
    case "number": {
      if (!c.date) return String(c.value);
      const d = serialToDate(c.value, date1904);
      const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      return Number.isInteger(c.value) ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }
  }
}

/**
 * Read one sheet of an xlsx file into typed columns.
 * Column types are inferred from the cells: numbers, dates (by cell style), booleans, otherwise text.
 * Empty rows are skipped. Formula cells use the value Excel saved with the file.
 */
export async function readXlsx(data: Uint8Array | ArrayBuffer, options: ReadXlsxOptions = {}): Promise<XlsxTable> {
  const wb = await openWorkbook(data);
  const sheet = options.sheet === undefined ? wb.sheets[0] : wb.sheets.find((s) => s.name === options.sheet);
  if (!sheet) {
    throw new Error(
      options.sheet === undefined
        ? "シートがありません"
        : `シート「${options.sheet}」がありません（あるのは ${wb.sheets.map((s) => `「${s.name}」`).join("、")}）`,
    );
  }
  const entry = wb.entries.get(sheet.path);
  if (!entry) throw new Error(`シート「${sheet.name}」の中身（${sheet.path}）がありません`);
  const [xml, strings, dates] = await Promise.all([entry.text(), sharedStrings(wb.entries), dateStyles(wb.entries)]);
  const bounds = options.range ? parseRange(options.range) : undefined;

  const rows: (Cell | undefined)[][] = [];
  let rowIndex = -1;
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? "";
  for (const rm of sheetData.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]!);
    rowIndex = ra.r ? Number(ra.r) - 1 : rowIndex + 1;
    if (bounds && (rowIndex < bounds.r0 || rowIndex > bounds.r1)) continue;
    const row: (Cell | undefined)[] = [];
    let col = -1;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]!);
      col = ca.r ? parseRef(ca.r).col : col + 1;
      if (bounds && (col < bounds.c0 || col > bounds.c1)) continue;
      const inner = cm[2] ?? "";
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let cell: Cell | undefined;
      switch (ca.t) {
        case "s":
          if (v !== undefined) cell = { kind: "string", value: strings[Number(v)] ?? "" };
          break;
        case "inlineStr":
          cell = { kind: "string", value: itemText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "") };
          break;
        case "str":
          if (v !== undefined) cell = { kind: "string", value: decodeXml(v) };
          break;
        case "b":
          if (v !== undefined) cell = { kind: "bool", value: v.trim() === "1" };
          break;
        case "e":
          break;
        case "d": {
          const d = v === undefined ? undefined : new Date(decodeXml(v));
          if (d && !Number.isNaN(d.getTime())) cell = { kind: "date", value: d };
          break;
        }
        default:
          if (v !== undefined && v.trim() !== "") {
            const n = Number(v);
            if (Number.isFinite(n)) cell = { kind: "number", value: n, date: dates[Number(ca.s ?? 0)] ?? false };
          }
      }
      if (cell) row[col] = cell;
    }
    rows[rowIndex] = row;
  }

  const present = rows.filter((r): r is (Cell | undefined)[] => !!r && r.some((c) => !isEmpty(c)));
  let c0 = bounds?.c0 ?? Infinity;
  let c1 = bounds?.c1 ?? -1;
  if (!bounds) {
    for (const r of present) {
      r.forEach((c, i) => {
        if (!isEmpty(c)) {
          c0 = Math.min(c0, i);
          c1 = Math.max(c1, i);
        }
      });
    }
  }
  if (c1 < c0) return { sheet: sheet.name, rowCount: 0, columns: [] };

  const header = options.header ?? true;
  const headRow = header ? present.shift() : undefined;
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (let c = c0; c <= c1; c++) {
    const h = headRow?.[c];
    let name = h && !isEmpty(h) ? cellText(h, wb.date1904).trim() : `column${c - c0 + 1}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (n) name = `${name}_${n + 1}`;
    names.push(name);
  }

  const columns: XlsxColumn[] = names.map((name, i) => {
    const c = c0 + i;
    const cells = present.map((r) => (isEmpty(r[c]) ? undefined : r[c]));
    return toColumn(name, cells, wb.date1904, !!options.allVarchar);
  });
  return { sheet: sheet.name, rowCount: present.length, columns };
}

function toColumn(name: string, cells: (Cell | undefined)[], date1904: boolean, allVarchar: boolean): XlsxColumn {
  const filled = cells.filter((c): c is Cell => !!c);
  const all = (pred: (c: Cell) => boolean) => filled.length > 0 && filled.every(pred);
  if (!allVarchar) {
    if (all((c) => c.kind === "bool")) {
      return { name, type: "BOOLEAN", values: cells.map((c) => (c ? (c as { value: boolean }).value : null)) };
    }
    if (all((c) => (c.kind === "number" && c.date) || c.kind === "date")) {
      const dateOnly = filled.every((c) =>
        c.kind === "number" ? Number.isInteger(c.value) : c.kind === "date" && c.value.getTime() % MS_PER_DAY === 0,
      );
      return {
        name,
        type: dateOnly ? "DATE" : "TIMESTAMP",
        values: cells.map((c) => (!c ? null : c.kind === "date" ? c.value : serialToDate((c as { value: number }).value, date1904))),
      };
    }
    if (all((c) => c.kind === "number" && !c.date)) {
      const ints = filled.every((c) => Number.isSafeInteger((c as { value: number }).value));
      return { name, type: ints ? "BIGINT" : "DOUBLE", values: cells.map((c) => (c ? (c as { value: number }).value : null)) };
    }
  }
  return { name, type: "VARCHAR", values: cells.map((c) => (c ? cellText(c, date1904) : null)) };
}
