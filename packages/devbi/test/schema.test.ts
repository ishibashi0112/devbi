import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { dashboardJsonSchema, metricsJsonSchema, TILE_TYPE_NAMES } from "../src/index.js";

const example = (p: string) => readFileSync(new URL(`../../../examples/sales/${p}`, import.meta.url), "utf8");
const ajv = () => new Ajv({ allErrors: true, strict: false });

describe("JSON Schema", () => {
  // The schema files in packages/devbi/schema are generated from the zod definitions; `vitest -u` rewrites them.
  it("matches the published schema files", async () => {
    await expect(`${JSON.stringify(dashboardJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../schema/dash.schema.json");
    await expect(`${JSON.stringify(metricsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../schema/metrics.schema.json");
  });

  it("accepts the example files", () => {
    const dash = ajv().compile(dashboardJsonSchema());
    const metrics = ajv().compile(metricsJsonSchema());
    expect(dash(JSON.parse(example("dashboards/sales.dash.json"))), JSON.stringify(dash.errors)).toBe(true);
    expect(metrics(parseYaml(example("models/sales.metrics.yaml"))), JSON.stringify(metrics.errors)).toBe(true);
  });

  it("rejects what the runtime rejects, and checks tile options", () => {
    const dash = ajv().compile(dashboardJsonSchema());
    const tile = (t: object) => ({ tiles: [{ id: "a", x: 0, y: 0, w: 4, h: 2, ...t }] });
    expect(dash(tile({ type: "kpi" }))).toBe(true);
    expect(dash(tile({ type: "chart" }))).toBe(false);
    expect(dash(tile({}))).toBe(false);
    expect(dash(tile({ type: "kpi", component: "./x.tsx" }))).toBe(false);
    expect(dash(tile({ type: "pivot", options: { columns: "region", totals: false } }))).toBe(true);
    expect(dash(tile({ type: "pivot", options: { colums: "region" } }))).toBe(false);
    expect(dash(tile({ type: "date-range", options: { default: "latest_fiscal_year" } }))).toBe(true);
    expect(dash(tile({ type: "date-range", options: { default: "this_year" } }))).toBe(false);
    expect(dash(tile({ type: "date-range", options: { default: "last_7_days" } }))).toBe(true);
    expect(dash(tile({ type: "kpi", query: { measures: ["n"], period: false } }))).toBe(true);
    expect(dash(tile({ type: "kpi", query: { measures: ["n"], period: "no" } }))).toBe(false);
    expect(dash(tile({ type: "kpi", query: { filters: [{ field: "d", between: ["2026-10-01", null], unit: "month" }] } }))).toBe(true);
    expect(dash(tile({ type: "kpi", query: { filters: [{ field: "d", in: ["x"], unit: "month" }] } }))).toBe(false);
    expect(dash(tile({ component: "./x.tsx", options: { anything: 1 } }))).toBe(true);
    expect(dash(tile({ type: "explore", query: {}, options: { layout: { group_by: ["地域"], aggregates: { 金額: "sum" } } } }))).toBe(true);
    expect(dash(tile({ type: "explore", options: { layout: "地域" } }))).toBe(false);

    const metrics = ajv().compile(metricsJsonSchema());
    expect(metrics({ model: "SELECT 1", measures: { n: "COUNT(*)" } })).toBe(true);
    expect(metrics({ model: "SELECT 1", measures: { n: { of: "x", compare: "last_year" } } })).toBe(false);
    expect(metrics({ model: "SELECT 1", measures: { n: { sql: "COUNT(*)", better: "lower" } } })).toBe(true);
    expect(metrics({ model: "SELECT 1", measures: { n: { sql: "COUNT(*)", better: "less" } } })).toBe(false);
    expect(metrics({ measures: { n: "COUNT(*)" } })).toBe(false);
  });

  it("limits names to the project's when given", () => {
    const dash = ajv().compile(
      dashboardJsonSchema({ metrics: ["sales"], measures: ["revenue"], dimensions: ["region"], fields: ["region", "受注日"] }),
    );
    const q = (query: object) => ({ metrics: "sales", tiles: [{ id: "a", x: 0, y: 0, w: 4, h: 2, type: "bar", query }] });
    expect(dash(q({ measures: ["revenue"], dimensions: ["region"], filters: [{ field: "受注日", between: ["2026-01-01", null] }] }))).toBe(true);
    expect(dash(q({ measures: ["revenu"] }))).toBe(false);
    expect(dash(q({ dimensions: ["地域"] }))).toBe(false);
    expect(dash({ metrics: "sale", tiles: [] })).toBe(false);
  });

  it("describes every built-in tile type", () => {
    const tile = ((dashboardJsonSchema().properties as any).tiles.items as any).properties.type;
    expect(tile.enum).toEqual(TILE_TYPE_NAMES);
    expect(tile.enumDescriptions).toHaveLength(TILE_TYPE_NAMES.length);
  });
});
