import type { FieldInfo, Filter, Grain, Scalar } from "devbi";
import { createContext, useContext } from "react";

export const TileSizeContext = createContext<{ width: number; height: number }>({ width: 0, height: 0 });

/** Size in pixels of the tile body, for tiles that draw (charts). */
export function useTileSize(): { width: number; height: number } {
  return useContext(TileSizeContext);
}

export function measures(fields: FieldInfo[]): FieldInfo[] {
  return fields.filter((f) => f.kind === "measure");
}

export function dimensions(fields: FieldInfo[]): FieldInfo[] {
  return fields.filter((f) => f.kind === "dimension");
}

export function timeField(fields: FieldInfo[]): FieldInfo | undefined {
  return fields.find((f) => f.kind === "time");
}

/** Start of the next time bucket after `d` (UTC). */
export function nextBucket(d: Date, grain: Grain | undefined): Date {
  const n = new Date(d.getTime());
  switch (grain) {
    case "week":
      n.setUTCDate(n.getUTCDate() + 7);
      break;
    case "month":
      n.setUTCMonth(n.getUTCMonth() + 1);
      break;
    case "quarter":
      n.setUTCMonth(n.getUTCMonth() + 3);
      break;
    case "year":
    case "fiscal_year":
      n.setUTCFullYear(n.getUTCFullYear() + 1);
      break;
    default:
      n.setUTCDate(n.getUTCDate() + 1);
  }
  return n;
}

function same(a: Scalar | undefined, b: Scalar | undefined): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : typeof a === "string" ? Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a) : a;
    const tb = b instanceof Date ? b.getTime() : typeof b === "string" ? Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) : b;
    return ta === tb;
  }
  return a === b;
}

/** The filter that selects one row value of a field (a time bucket becomes a range). */
export function filterFor(field: FieldInfo, value: Scalar): Filter {
  if (field.kind === "time" && value instanceof Date) {
    return { field: field.name, between: [value, nextBucket(value, field.grain)] };
  }
  return { field: field.name, in: [value] };
}

/** Whether a row value is selected by the tile's own filters on that field. Undefined when nothing is selected. */
export function isSelected(selection: Filter[], field: string, value: Scalar): boolean | undefined {
  const f = selection.find((x) => x.field === field);
  if (!f) return undefined;
  if ("in" in f) return f.in.some((v) => same(v, value));
  const [lo] = f.between;
  return same(lo, value);
}

/** Toggle one value in an `in` filter. Returns null when nothing remains selected. */
export function toggleValue(selection: Filter[], field: string, value: Scalar, multi: boolean): Filter[] | null {
  const f = selection.find((x) => x.field === field);
  const current = f && "in" in f ? f.in : [];
  const has = current.some((v) => same(v, value));
  const next = has ? current.filter((v) => !same(v, value)) : multi ? [...current, value] : [value];
  return next.length ? [{ field, in: next }] : null;
}
