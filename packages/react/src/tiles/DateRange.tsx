import { dateRangePresets, isoDate, type Filter, type TileProps } from "devbi";
import { useEffect, useMemo, useRef } from "react";
import { useDevbi, useTimeExtent } from "../context.js";

const DAY = 86_400_000;

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  return null;
}

/**
 * A period picker for the time column. `options.default` picks the initial preset:
 * all, latest_month, last_12_months, latest_year, previous_year, year_to_date, latest_fiscal_year, previous_fiscal_year.
 */
export function DateRange({ tile, selection, select }: TileProps) {
  const ctx = useDevbi();
  const metrics = (tile.query?.metrics ?? tile.options?.metrics) as string | undefined;
  const view = ctx.view(metrics);
  const time = view.time;
  const extent = useTimeExtent(metrics);
  const list = useMemo(() => (extent.max ? dateRangePresets(extent.max, time?.fiscalYearStart ?? 1) : []), [extent.max, time]);
  const own = selection.find((f): f is Extract<Filter, { between: unknown }> => f.field === time?.name && "between" in f);
  const start = asDate(own?.between[0]);
  const end = asDate(own?.between[1]);
  const applied = useRef(false);

  const apply = (range: [Date, Date] | null) => {
    if (!time) return;
    select(range ? { field: time.name, between: range } : null);
  };

  useEffect(() => {
    if (applied.current || !list.length) return;
    applied.current = true;
    const def = list.find((p) => p.key === tile.options?.default);
    if (def && !own) apply(def.range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (!time) return <div className="devbi-empty">指標ファイルに time（日付の列）を書いてください</div>;
  if (extent.error) return <div className="devbi-error">{extent.error.message}</div>;
  const active = list.find((p) =>
    p.range === null ? !own : !!start && !!end && start.getTime() === p.range[0].getTime() && end.getTime() === p.range[1].getTime(),
  );
  const inputEnd = end ? isoDate(new Date(end.getTime() - DAY)) : "";
  return (
    <div className="devbi-daterange">
      <div className="devbi-chips" role="group" aria-label={`${time.label}の期間`}>
        {list.map((p) => (
          <button key={p.key} type="button" aria-pressed={active?.key === p.key} onClick={() => apply(p.range)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="devbi-daterange-inputs">
        <input
          type="date"
          name={`${tile.id}-start`}
          aria-label="開始日"
          value={start ? isoDate(start) : ""}
          min={extent.min ? isoDate(extent.min) : undefined}
          max={extent.max ? isoDate(extent.max) : undefined}
          onChange={(e) => {
            const s = asDate(e.target.value);
            if (s) apply([s, end ?? new Date((extent.max?.getTime() ?? s.getTime()) + DAY)]);
          }}
        />
        <span>〜</span>
        <input
          type="date"
          name={`${tile.id}-end`}
          aria-label="終了日"
          value={inputEnd}
          min={extent.min ? isoDate(extent.min) : undefined}
          max={extent.max ? isoDate(extent.max) : undefined}
          onChange={(e) => {
            const d = asDate(e.target.value);
            if (d) apply([start ?? extent.min ?? d, new Date(d.getTime() + DAY)]);
          }}
        />
      </div>
    </div>
  );
}
