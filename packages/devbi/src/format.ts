import type { FieldInfo, Grain } from "./types.js";

interface NumberPattern {
  prefix: string;
  suffix: string;
  minFrac: number;
  maxFrac: number;
  group: boolean;
  percent: boolean;
  /** Divide by 1000 per trailing comma (`#,##0,` = thousands). */
  scale: number;
  minInt: number;
  /** The section has no digit placeholders: show only its text. */
  literal: boolean;
}

const cache = new Map<string, NumberPattern[]>();

/** Read literal text: quoted strings, backslash escapes and plain characters. */
function literalText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      const close = s.indexOf('"', i + 1);
      out += s.slice(i + 1, close < 0 ? s.length : close);
      i = close < 0 ? s.length : close;
    } else if (ch === "\\") {
      out += s[i + 1] ?? "";
      i++;
    } else if (ch === "_" || ch === "*") {
      i++; // Excel padding directives: skip the following character
    } else if (ch === "[") {
      const close = s.indexOf("]", i);
      const inner = s.slice(i + 1, close);
      // [$¥-411] currency markers keep their symbol; colors and conditions are dropped.
      if (inner.startsWith("$")) out += inner.slice(1).split("-")[0];
      i = close < 0 ? s.length : close;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Index of the first digit placeholder outside quotes and brackets. */
function findNumberSpan(s: string): [number, number] | undefined {
  let start = -1;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      const close = s.indexOf('"', i + 1);
      i = close < 0 ? s.length : close;
      continue;
    }
    if (ch === "[") {
      const close = s.indexOf("]", i);
      i = close < 0 ? s.length : close;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (/[0#?]/.test(ch) || ((ch === "," || ch === ".") && start >= 0)) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  return start < 0 ? undefined : [start, end];
}

function parseSection(section: string): NumberPattern {
  const span = findNumberSpan(section);
  if (!span) {
    return { prefix: literalText(section), suffix: "", minFrac: 0, maxFrac: 0, group: false, percent: false, scale: 1, minInt: 0, literal: true };
  }
  const [start, end] = span;
  let num = section.slice(start, end);
  const prefix = literalText(section.slice(0, start));
  const suffix = literalText(section.slice(end));
  let scale = 1;
  while (num.endsWith(",")) {
    scale *= 1000;
    num = num.slice(0, -1);
  }
  const [intPart = "", fracPart = ""] = num.split(".");
  return {
    prefix,
    suffix,
    minFrac: (fracPart.match(/0/g) ?? []).length,
    maxFrac: (fracPart.match(/[0#?]/g) ?? []).length,
    group: intPart.includes(","),
    percent: section.includes("%") && !/"[^"]*%[^"]*"/.test(section),
    scale,
    minInt: (intPart.match(/0/g) ?? []).length,
    literal: false,
  };
}

function patterns(format: string): NumberPattern[] {
  let p = cache.get(format);
  if (!p) {
    p = format.split(";").map(parseSection);
    cache.set(format, p);
  }
  return p;
}

const compact = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Format a number with a subset of Excel number formats:
 * `#,##0`, `0.0`, `0.0%`, literal prefixes / suffixes (`¥#,##0`, `#,##0"円"`),
 * trailing commas for thousands, and `positive;negative;zero` sections.
 * `compact` gives Japanese short units (1.2億, 3,400万).
 */
export function formatNumber(value: number, format?: string): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? "" : value > 0 ? "∞" : "-∞";
  if (!format) {
    return value.toLocaleString("ja-JP", { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
  }
  if (format === "compact") return compact.format(value);
  if (format.startsWith("compact:")) {
    const [, pre = "", post = ""] = format.split(":");
    return `${pre}${compact.format(value)}${post}`;
  }
  const sections = patterns(format);
  let p = sections[0]!;
  let v = value;
  let sign = value < 0 ? "-" : "";
  if (value < 0 && sections[1]) {
    p = sections[1];
    v = -value;
    sign = "";
  } else if (value === 0 && sections[2]) {
    p = sections[2];
  } else {
    v = Math.abs(value);
  }
  if (p.literal) return p.prefix;
  if (p.percent) v *= 100;
  v /= p.scale;
  const body = v.toLocaleString("ja-JP", {
    minimumFractionDigits: p.minFrac,
    maximumFractionDigits: p.maxFrac,
    useGrouping: p.group,
    minimumIntegerDigits: Math.max(1, p.minInt),
  });
  const rounded = Number(body.replace(/,/g, "")) === 0;
  return `${rounded ? "" : sign}${p.prefix}${body}${p.suffix}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Label of a time bucket that starts at `d` (UTC). */
export function formatTime(d: Date, grain?: Grain, fiscalYearStart = 1): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  switch (grain) {
    case "year":
      return `${y}年`;
    case "fiscal_year":
      return fiscalYearStart === 1 ? `${y}年` : `${y}年度`;
    case "quarter":
      return `${y}年Q${Math.floor((m - 1) / 3) + 1}`;
    case "month":
      return `${y}年${m}月`;
    case "week":
      return `${y}/${m}/${day}週`;
    default: {
      const hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
      return hasTime
        ? `${y}/${m}/${day} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
        : `${y}/${m}/${day}`;
    }
  }
}

/** Format any result value for display, using the field's format or time grain. */
export function formatValue(value: unknown, field?: Pick<FieldInfo, "format" | "grain" | "kind">, fiscalYearStart = 1): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return formatTime(value, field?.grain, fiscalYearStart);
  if (typeof value === "number") return formatNumber(value, field?.format);
  if (typeof value === "bigint") return formatNumber(Number(value), field?.format);
  if (typeof value === "boolean") return value ? "はい" : "いいえ";
  return String(value);
}

/** Literal text in an Excel number format: quoted, a `"` escaped; `%` left bare where it scales by 100. */
function excelLiteral(text: string, percent: boolean): string {
  const quote = (s: string) =>
    s
      .split('"')
      .map((p) => (p ? `"${p}"` : ""))
      .join('\\"');
  return percent ? text.split("%").map(quote).join("%") : quote(text);
}

/**
 * The Excel number format for a DevBI one (`format` in metrics.yaml), so a value written to xlsx shows in Excel as on
 * the dashboard. Rebuilt from what {@link formatNumber} reads, so it is always a code Excel accepts: literal text quoted,
 * colors and conditions (`[Red]`, `[>100]`) left out. `compact` (万・億) has no Excel format: `#,##0`.
 */
export function excelNumberFormat(format: string): string {
  if (format === "compact" || format.startsWith("compact:")) {
    const [, pre = "", post = ""] = format.split(":");
    return `${excelLiteral(pre, false)}#,##0${excelLiteral(post, false)}`;
  }
  return patterns(format)
    .slice(0, 4)
    .map((p) => {
      if (p.literal) return excelLiteral(p.prefix, false);
      const int = p.group ? `#,##${"0".repeat(Math.max(1, p.minInt))}` : "0".repeat(Math.max(1, p.minInt));
      const frac = p.maxFrac > 0 ? `.${"0".repeat(p.minFrac)}${"#".repeat(p.maxFrac - p.minFrac)}` : "";
      const scale = ",".repeat(Math.round(Math.log10(p.scale) / 3));
      return `${excelLiteral(p.prefix, p.percent)}${int}${frac}${scale}${excelLiteral(p.suffix, p.percent)}`;
    })
    .join(";");
}

/**
 * The Excel date format that shows a time bucket as {@link formatTime} labels it (`2026年4月`). None for quarters,
 * which Excel cannot show: write their label as text.
 */
export function excelTimeFormat(grain: Grain | undefined, fiscalYearStart = 1, withTime = false): string | undefined {
  switch (grain) {
    case "year":
      return 'yyyy"年"';
    case "fiscal_year":
      return fiscalYearStart === 1 ? 'yyyy"年"' : 'yyyy"年度"';
    case "quarter":
      return undefined;
    case "month":
      return 'yyyy"年"m"月"';
    case "week":
      return 'yyyy/m/d"週"';
    default:
      return withTime ? "yyyy/m/d hh:mm" : "yyyy/m/d";
  }
}
