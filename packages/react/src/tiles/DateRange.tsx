import { dateRangePresets, isoDate, type DateRangeOption, type Filter, type Grain, type TileProps } from "devbi";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDevbi, useTimeExtent } from "../context.js";

const DAY = 86_400_000;

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  return null;
}

/**
 * A period picker for the time column. `options.default` picks the initial preset (DATE_RANGE_PRESETS). The main
 * periods are buttons, the others are in a list.
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
  // The period last picked: of periods with the same days (this year and this year so far), the one pressed.
  const [pickedKey, setPickedKey] = useState<string>();

  // A period's unit goes with it: previous_period then compares with the same days of the month (week…) before.
  const apply = (range: [Date, Date] | null, unit?: Grain) => {
    if (!time) return;
    select(range ? { field: time.name, between: range, ...(unit ? { unit } : {}) } : null);
  };
  const pick = (p: DateRangeOption) => {
    setPickedKey(p.key);
    apply(p.range, p.unit);
  };

  useEffect(() => {
    if (applied.current || !list.length) return;
    applied.current = true;
    const def = list.find((p) => p.key === tile.options?.default);
    if (def && !own) pick(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (!time) return <div className="devbi-empty">指標ファイルに time（日付の列）を書いてください</div>;
  if (extent.error) return <div className="devbi-error">{extent.error.message}</div>;
  const matches = list.filter((p) =>
    p.range === null
      ? !own
      : !!start && !!end && start.getTime() === p.range[0].getTime() && end.getTime() === p.range[1].getTime() && p.unit === own?.unit,
  );
  const active = matches.find((p) => p.key === pickedKey) ?? matches[0];
  // The main periods (and the first one) are buttons; the rest are in a list.
  const buttons = list.filter((p) => p.button || p.key === tile.options?.default);
  const more = list.filter((p) => !buttons.includes(p));
  const picked = active && more.includes(active) ? active : undefined;
  const inputEnd = end ? isoDate(new Date(end.getTime() - DAY)) : "";
  return (
    <div className="devbi-daterange">
      <div className="devbi-chips" role="group" aria-label={`${time.label}の期間`}>
        {buttons.map((p) => (
          <button key={p.key} type="button" aria-pressed={active?.key === p.key} onClick={() => pick(p)}>
            {p.label}
          </button>
        ))}
        {more.length > 0 && (
          <select
            name={`${tile.id}-more`}
            aria-label="ほかの期間"
            data-active={picked ? true : undefined}
            value={picked?.key ?? ""}
            onChange={(e) => {
              const p = more.find((x) => x.key === e.target.value);
              if (p) pick(p);
            }}
          >
            <option value="" disabled>
              ほかの期間
            </option>
            {more.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        )}
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
