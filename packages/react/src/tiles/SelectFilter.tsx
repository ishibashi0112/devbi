import type { Scalar, TileProps } from "devbi";
import { useState } from "react";
import { dimensions, isSelected, measures, toggleValue } from "./util.js";

/**
 * A list of values of one dimension to filter by. Other tiles' selections narrow the list.
 * `options.multiple: false` allows one value at a time.
 */
export function SelectFilter({ rows, fields, format, selection, select, tile }: TileProps) {
  const [search, setSearch] = useState("");
  const dim = dimensions(fields)[0];
  const m = measures(fields)[0];
  if (!dim) return <div className="devbi-empty">dimensions を一つ指定してください</div>;
  const multiple = tile.options?.multiple !== false;
  const own = selection.find((f) => f.field === dim.name);
  const chosen: Scalar[] = own && "in" in own ? own.in : [];
  const values = rows.map((r) => r[dim.name] ?? null);
  const missing = chosen.filter((c) => !values.includes(c));
  const all = [...missing.map((v) => ({ v, row: undefined })), ...rows.map((r) => ({ v: r[dim.name] ?? null, row: r }))];
  const q = search.trim().toLowerCase();
  const shown = q ? all.filter(({ v }) => format(v, dim.name).toLowerCase().includes(q)) : all;
  return (
    <div className="devbi-select">
      <div className="devbi-select-head">
        {all.length > 8 && (
          <input type="search" name={`${tile.id}-search`} aria-label={`${dim.label}を検索`} placeholder={`${dim.label}を検索`} value={search} onChange={(e) => setSearch(e.target.value)} />
        )}
        <button type="button" disabled={!chosen.length} onClick={() => select(null)}>
          すべて
        </button>
      </div>
      <ul>
        {shown.map(({ v, row }, i) => (
          <li key={i}>
            <label>
              <input
                type={multiple ? "checkbox" : "radio"}
                name={`${tile.id}-${dim.name}`}
                checked={!!isSelected(selection, dim.name, v)}
                onChange={() => select(toggleValue(selection, dim.name, v, multiple))}
              />
              <span>{format(v, dim.name)}</span>
              {m && row && <small>{format(row[m.name], m.name)}</small>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
