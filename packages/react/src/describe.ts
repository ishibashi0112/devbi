import { formatTime, type Filter } from "devbi";
import type { SnapshotInfo } from "./engine.js";
import { formatTimesOfDay } from "./project.js";

const DAY = 86_400_000;

/** A selected value as the filter chips show it. */
export function filterValueText(v: unknown): string {
  return v === null ? "（空欄）" : v instanceof Date ? formatTime(v, "day") : String(v);
}

/** What a filter keeps: `関東、近畿`, `2026年4月〜2026年6月`, `2026/4/1〜2026/4/15`. */
export function describeFilter(f: Filter, isTime: boolean, format: (v: unknown) => string = filterValueText): string {
  if ("in" in f) return f.in.map((v) => format(v)).join("、");
  const [lo, hi] = f.between;
  if (isTime && lo instanceof Date && hi instanceof Date) {
    const last = new Date(hi.getTime() - DAY);
    const monthly = lo.getUTCDate() === 1 && hi.getUTCDate() === 1;
    if (monthly) {
      const months = (hi.getUTCFullYear() - lo.getUTCFullYear()) * 12 + hi.getUTCMonth() - lo.getUTCMonth();
      if (months === 1) return formatTime(lo, "month");
      return `${formatTime(lo, "month")}〜${formatTime(last, "month")}`;
    }
    return `${formatTime(lo, "day")}〜${formatTime(last, "day")}`;
  }
  return `${lo === null ? "" : format(lo)}〜${hi === null ? "" : format(hi)}`;
}

/** `11月8日 6:00` */
export function formatMadeAt(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** When the data was taken, for a dashboard that reads snapshots (the oldest of them). Undefined for live data. */
export function snapshotText(info: SnapshotInfo[]): string | undefined {
  if (info.length === 0) return undefined;
  const oldest = info.reduce((a, b) => (a.at <= b.at ? a : b));
  const times = [...new Set(info.flatMap((i) => i.times))].sort();
  return `データは ${formatMadeAt(oldest.at)} の時点（毎日 ${formatTimesOfDay(times)} に更新）`;
}
