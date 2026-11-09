// The parts of fetch-stats.mjs that do not touch the network (tested in test/stats.test.ts).

/** `owner/name` of a GitHub repository URL as npm has it (`git+https://github.com/o/r.git`), or undefined. */
export function githubRepo(url) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** `YYYY-MM-DD` of a date (UTC). */
export const day = (d) => d.toISOString().slice(0, 10);

/**
 * The ranges to ask npm's downloads API for, from the package's first day to `end` (both included): npm answers at
 * most 18 months at a time, and keeps them only from 2015-01-10.
 */
export function downloadRanges(created, end, maxDays = 540) {
  const out = [];
  let start = new Date(Math.max(Date.parse(`${day(new Date(created))}T00:00:00Z`), Date.parse("2015-01-10T00:00:00Z")));
  const last = Date.parse(`${end}T00:00:00Z`);
  while (start.getTime() <= last) {
    const stop = new Date(Math.min(start.getTime() + (maxDays - 1) * 86_400_000, last));
    out.push([day(start), day(stop)]);
    start = new Date(stop.getTime() + 86_400_000);
  }
  return out;
}

/** CSV text (with a header line) of rows, in the order of `columns`. */
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
