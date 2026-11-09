import { describe, expect, it } from "vitest";
import { trendClass } from "../src/tiles/Kpi.js";
import { filterFor } from "../src/tiles/util.js";

describe("trendClass", () => {
  it("colours a change by which way is good, and no change not at all", () => {
    expect(trendClass({ compare: "ratio" }, 1.2)).toBe("devbi-up");
    expect(trendClass({ compare: "ratio" }, 0.8)).toBe("devbi-down");
    expect(trendClass({ compare: "ratio" }, 1)).toBe("");
    expect(trendClass({ compare: "change" }, -0.1)).toBe("devbi-down");
    expect(trendClass({ compare: "delta" }, 0)).toBe("");
    // Less is better: an increase is bad.
    expect(trendClass({ compare: "ratio", better: "lower" }, 1.2)).toBe("devbi-down");
    expect(trendClass({ compare: "delta", better: "lower" }, -3)).toBe("devbi-up");
    // The previous value itself, a measure that is not a comparison, no value: no colour.
    expect(trendClass({ compare: "value" }, 120)).toBe("");
    expect(trendClass({}, 120)).toBe("");
    expect(trendClass({ compare: "ratio" }, null)).toBe("");
  });
});

describe("filterFor", () => {
  it("selects a clicked time bucket as a period of its grain", () => {
    const month = new Date("2026-10-01T00:00:00Z");
    expect(filterFor({ name: "受注日", label: "受注日", kind: "time", grain: "month" }, month)).toEqual({
      field: "受注日",
      between: [month, new Date("2026-11-01T00:00:00Z")],
      unit: "month",
    });
    expect(filterFor({ name: "region", label: "地域", kind: "dimension" }, "関東")).toEqual({ field: "region", in: ["関東"] });
  });
});
