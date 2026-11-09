import * as Plot from "@observablehq/plot";
import { formatNumber, type Scalar, type TileProps } from "devbi";
import { useEffect, useMemo, useRef } from "react";
import { dimensions, filterFor, isSelected, measures, timeField, useTileSize } from "./util.js";

type Kind = "bar" | "line" | "area";

interface Datum {
  x: Scalar;
  xLabel: string;
  y: number | null;
  series: string;
  measure: string;
}

const ACCENT = "#3b6fe0";

/** Axis labels: use Japanese short units for large numbers unless the measure is a percentage. */
function axisFormat(format: string | undefined): (v: number) => string {
  if (format?.includes("%")) return (v) => formatNumber(v, format);
  return (v) => (Math.abs(v) >= 10_000 ? formatNumber(v, "compact") : formatNumber(v));
}

/**
 * Bar, line and area charts drawn with Observable Plot.
 * x is the time grain if the query has one, otherwise the first dimension.
 * A further dimension, or several measures, become colored series.
 * Clicking a bar or point selects that x value (a time bucket selects its range).
 */
export function makeChart(kind: Kind) {
  function Chart({ rows, fields, format, selection, select, query }: TileProps) {
    const ref = useRef<HTMLDivElement>(null);
    const { width, height } = useTileSize();
    const { time, ms, xField, seriesField } = useMemo(() => {
      const time = timeField(fields);
      const dims = dimensions(fields);
      return { time, ms: measures(fields), xField: time ?? dims[0], seriesField: time ? dims[0] : dims[1] };
    }, [fields]);

    const byTime = !!time && !query.sort;
    useEffect(() => {
      const el = ref.current;
      if (!el || !xField || !ms.length || width < 40 || height < 40) return;
      const multi = ms.length > 1 && !seriesField;
      const data: Datum[] = rows.flatMap((r) =>
        (multi ? ms : ms.slice(0, 1)).map((m) => ({
          x: r[xField.name] ?? null,
          xLabel: format(r[xField.name], xField.name),
          y: typeof r[m.name] === "number" ? (r[m.name] as number) : null,
          series: multi ? m.label : seriesField ? format(r[seriesField.name], seriesField.name) : "",
          measure: m.name,
        })),
      );
      // Stack series in the same order at every x (Plot stacks in input order): largest total first.
      const totals = new Map<string, number>();
      for (const d of data) totals.set(d.series, (totals.get(d.series) ?? 0) + (d.y ?? 0));
      const rank = new Map([...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i]));
      if (!multi) data.sort((a, b) => rank.get(a.series)! - rank.get(b.series)!);
      const colored = multi || !!seriesField;
      const anySelected = selection.some((f) => f.field === xField.name);
      const opacity = (d: Datum) => (!anySelected || isSelected(selection, xField.name, d.x) ? 1 : 0.3);
      // Bars over time go oldest first unless the query sorts them (Malloy sorts time newest first).
      const at = (v: unknown) => (v instanceof Date ? v.getTime() : Infinity);
      const labels = byTime
        ? [...new Map(data.map((d) => [d.xLabel, at(d.x)])).entries()].sort((a, b) => a[1] - b[1] || 0).map(([l]) => l)
        : [...new Set(data.map((d) => d.xLabel))];
      const xTime = !!time && kind !== "bar";
      const xChannel = xTime ? (d: Datum) => d.x as Date : (d: Datum) => d.xLabel;
      const title = (d: Datum) => `${d.xLabel}${d.series ? `　${d.series}` : ""}\n${format(d.y, d.measure)}`;
      const rotate = !xTime && labels.length * 70 > width;
      // Time axes: label every k-th bucket (k = 1, 2, 3, 6, 12 … buckets) so labels like "2024年10月" never overlap.
      const buckets = xTime ? [...new Set(data.map((d) => (d.x as Date).getTime()))].sort((a, b) => a - b) : [];
      const maxLabels = Math.max(2, Math.floor((width - 60) / 84));
      const step = [1, 2, 3, 4, 6, 12, 24, 36, 48, 60].find((k) => Math.ceil(buckets.length / k) <= maxLabels) ?? Math.ceil(buckets.length / maxLabels);
      const timeTicks = buckets.filter((_, i) => i % step === 0).map((t) => new Date(t));
      const fill = colored ? (d: Datum) => d.series : ACCENT;

      const marks: Plot.Markish[] = [];
      if (kind === "bar") {
        marks.push(Plot.barY(data, { x: xChannel, y: (d: Datum) => d.y, fill, fillOpacity: opacity }));
      } else if (kind === "area") {
        marks.push(Plot.areaY(data, { x: xChannel, y: (d: Datum) => d.y, fill, z: (d: Datum) => d.series, fillOpacity: 0.55 }));
        marks.push(Plot.lineY(data, Plot.stackY2({ x: xChannel, y: (d: Datum) => d.y, stroke: colored ? (d: Datum) => d.series : ACCENT, z: (d: Datum) => d.series })));
      } else {
        marks.push(Plot.lineY(data, { x: xChannel, y: (d: Datum) => d.y, stroke: colored ? (d: Datum) => d.series : ACCENT, z: (d: Datum) => d.series, strokeWidth: 2 }));
        marks.push(Plot.dot(data, { x: xChannel, y: (d: Datum) => d.y, fill: colored ? (d: Datum) => d.series : ACCENT, r: 3, fillOpacity: opacity }));
      }
      marks.push(Plot.ruleY([0]));
      marks.push(Plot.tip(data, Plot.pointerX({ x: xChannel, y: (d: Datum) => d.y, title })));

      const plot = Plot.plot({
        width,
        height: Math.max(80, height - (colored ? 30 : 0)),
        marginLeft: 56,
        marginBottom: rotate ? 64 : 30,
        style: { fontFamily: "inherit", fontSize: "12px", background: "transparent", color: "currentColor", overflow: "visible" },
        x: xTime
          ? { type: "utc", label: null, ticks: timeTicks, tickFormat: (d: Date) => format(d, xField.name) }
          : { type: "band", domain: labels, label: null, tickRotate: rotate ? -40 : 0, padding: 0.2 },
        y: { label: null, grid: true, tickFormat: axisFormat(ms[0]?.format) },
        color: colored ? { legend: true, type: "categorical" } : {},
        marks,
      }) as (HTMLElement | SVGSVGElement) & { value?: Datum | null };

      // Plot sets `value` from pointer moves; a tap or a click without a prior hover has none, so find the x under the pointer.
      const nearest = (event: MouseEvent): Datum | undefined => {
        const svg = plot instanceof SVGSVGElement ? plot : plot.querySelector<SVGSVGElement>(":scope > svg");
        const sx = (plot as unknown as { scale(n: string): { apply(v: unknown): number; invert?(px: number): unknown; bandwidth?: number } }).scale("x");
        if (!svg || !sx) return undefined;
        const px = event.clientX - svg.getBoundingClientRect().left;
        if (sx.bandwidth !== undefined) {
          const label = labels.find((l) => px >= sx.apply(l) - 2 && px <= sx.apply(l) + sx.bandwidth! + 2);
          return data.find((d) => d.xLabel === label);
        }
        let best: Datum | undefined;
        let bestDist = Infinity;
        for (const d of data) {
          const dist = Math.abs(sx.apply(d.x) - px);
          if (dist < bestDist) [best, bestDist] = [d, dist];
        }
        return bestDist < 40 ? best : undefined;
      };
      plot.addEventListener("click", (event) => {
        const d = plot.value ?? nearest(event as MouseEvent);
        if (!d) return select(null);
        const already = isSelected(selection, xField.name, d.x);
        select(already ? null : filterFor(xField, d.x));
      });
      el.replaceChildren(plot);
      return () => plot.remove();
    }, [rows, fields, width, height, selection, format, select, xField, seriesField, ms, time, byTime]);

    if (!xField || !ms.length) return <div className="devbi-empty">measures と、time か dimensions を指定してください</div>;
    return <div ref={ref} className="devbi-chart" />;
  }
  Chart.displayName = `Chart(${kind})`;
  return Chart;
}
