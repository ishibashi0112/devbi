import { describe, expect, it } from "vitest";
import { dateRangePresets } from "../src/index.js";

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("dateRangePresets", () => {
  it("counts from the latest date in the data, and ends the periods that hold it the day after it", () => {
    const list = dateRangePresets(day("2026-10-30"), 4);
    const range = (key: string) => list.find((p) => p.key === key)?.range?.map(iso);
    expect(list.map((p) => [p.key, p.label])).toEqual([
      ["all", "全期間"],
      ["latest_month", "2026年10月"],
      ["last_12_months", "直近12ヶ月"],
      ["latest_year", "2026年"],
      ["previous_year", "2025年"],
      ["year_to_date", "2026年累計"],
      ["latest_fiscal_year", "2026年度"],
      ["previous_fiscal_year", "2025年度"],
    ]);
    expect(list[0]!.range).toBeNull();
    expect(range("latest_month")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(range("last_12_months")).toEqual(["2025-11-01", "2026-10-31"]);
    expect(range("previous_year")).toEqual(["2025-01-01", "2026-01-01"]);
    expect(range("latest_fiscal_year")).toEqual(["2026-04-01", "2026-10-31"]);
    expect(range("previous_fiscal_year")).toEqual(["2025-04-01", "2026-04-01"]);
    // The year starts in January: no fiscal years.
    expect(dateRangePresets(day("2026-03-15")).map((p) => p.key)).not.toContain("latest_fiscal_year");
  });
});
