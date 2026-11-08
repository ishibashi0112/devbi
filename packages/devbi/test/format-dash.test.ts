import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatDashboardJson } from "../src/index.js";

const examples = path.resolve(import.meta.dirname, "../../../examples/sales/dashboards");

describe("formatDashboardJson", () => {
  it.each(readdirSync(examples).filter((f) => f.endsWith(".dash.json")))("writes %s back exactly as it was written by hand", (f) => {
    const text = readFileSync(path.join(examples, f), "utf8");
    expect(formatDashboardJson(JSON.parse(text))).toBe(text);
  });

  it("puts x, y, w, h on one line where the first of them is, and keeps the other keys' order", () => {
    const text = formatDashboardJson({ tiles: [{ title: "a", y: 1, id: "t", x: 0, w: 2, h: 3, type: "kpi" }] });
    expect(text).toBe(
      ["{", `  "tiles": [`, "    {", `      "title": "a",`, `      "x": 0, "y": 1, "w": 2, "h": 3,`, `      "id": "t",`, `      "type": "kpi"`, "    }", "  ]", "}", ""].join("\n"),
    );
  });

  it("puts a value on one line when it fits in 100 columns, else one entry per line", () => {
    const short = { measures: ["revenue"], dimensions: ["region"], time: "quarter" };
    const long = { measures: ["revenue", "revenue_yoy", "quantity", "orders"], dimensions: ["category", "product"], limit: 100 };
    const text = formatDashboardJson({ tiles: [{ id: "a", x: 0, y: 0, w: 1, h: 1, query: short }, { id: "b", x: 1, y: 0, w: 1, h: 1, query: long }] });
    expect(text).toContain(`      "query": { "measures": ["revenue"], "dimensions": ["region"], "time": "quarter" }\n`);
    expect(text).toContain(
      `      "query": {\n        "measures": ["revenue", "revenue_yoy", "quantity", "orders"],\n        "dimensions": ["category", "product"],\n        "limit": 100\n      }`,
    );
  });

  it("counts a full-width character as two columns", () => {
    const text = formatDashboardJson({ tiles: [{ id: "a", x: 0, y: 0, w: 1, h: 1, options: { text: "あ".repeat(36) } }] });
    expect(text).toContain(`      "options": {\n        "text": "${"あ".repeat(36)}"\n      }`);
    const ascii = formatDashboardJson({ tiles: [{ id: "a", x: 0, y: 0, w: 1, h: 1, options: { text: "a".repeat(36) } }] });
    expect(ascii).toContain(`      "options": { "text": "${"a".repeat(36)}" }`);
  });

  it("writes an empty dashboard, empty objects and arrays, and parses back to the same value", () => {
    const spec = { $schema: "../.devbi/dash.schema.json", title: "空", tiles: [] };
    expect(formatDashboardJson(spec)).toBe(`{\n  "$schema": "../.devbi/dash.schema.json",\n  "title": "空",\n  "tiles": []\n}\n`);
    const odd = { tiles: [{ id: "a", x: 0, y: 0, w: 1, h: 1, options: {}, query: { measures: [] } }], description: 'a "quote"\nand a line' };
    expect(JSON.parse(formatDashboardJson(odd))).toEqual(odd);
  });
});
