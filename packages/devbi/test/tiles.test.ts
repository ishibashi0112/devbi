import { describe, expect, it } from "vitest";
import { dateRangePresets } from "../src/index.js";

const day = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("dateRangePresets", () => {
  it("counts from the latest date in the data, and ends the periods that hold it the day after it", () => {
    const list = dateRangePresets(day("2026-10-30"), 4);
    const range = (key: string) => list.find((p) => p.key === key)?.range?.map(iso);
    expect(list.map((p) => [p.key, p.label, p.unit ?? null, p.button])).toEqual([
      ["all", "全期間", null, true],
      ["latest_day", "2026/10/30", "day", false],
      ["last_7_days", "直近7日", null, false],
      ["last_30_days", "直近30日", null, false],
      ["latest_week", "2026/10/26週", "week", false],
      ["latest_month", "2026年10月", "month", true],
      ["previous_month", "2026年9月", "month", false],
      ["latest_quarter", "2026年Q4", "quarter", false],
      ["previous_quarter", "2026年Q3", "quarter", false],
      ["last_12_months", "直近12ヶ月", "year", true],
      ["latest_year", "2026年", "year", true],
      ["previous_year", "2025年", "year", true],
      ["year_to_date", "2026年累計", "year", true],
      ["latest_fiscal_year", "2026年度", "fiscal_year", true],
      ["previous_fiscal_year", "2025年度", "fiscal_year", true],
    ]);
    expect(list[0]!.range).toBeNull();
    expect(range("latest_day")).toEqual(["2026-10-30", "2026-10-31"]);
    expect(range("last_7_days")).toEqual(["2026-10-24", "2026-10-31"]);
    expect(range("last_30_days")).toEqual(["2026-10-01", "2026-10-31"]);
    // Weeks start on Monday (2026-10-26).
    expect(range("latest_week")).toEqual(["2026-10-26", "2026-10-31"]);
    expect(range("latest_month")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(range("previous_month")).toEqual(["2026-09-01", "2026-10-01"]);
    expect(range("latest_quarter")).toEqual(["2026-10-01", "2026-10-31"]);
    expect(range("previous_quarter")).toEqual(["2026-07-01", "2026-10-01"]);
    expect(range("last_12_months")).toEqual(["2025-11-01", "2026-10-31"]);
    expect(range("previous_year")).toEqual(["2025-01-01", "2026-01-01"]);
    expect(range("latest_fiscal_year")).toEqual(["2026-04-01", "2026-10-31"]);
    expect(range("previous_fiscal_year")).toEqual(["2025-04-01", "2026-04-01"]);
    // The year starts in January: no fiscal years.
    expect(dateRangePresets(day("2026-03-15")).map((p) => p.key)).not.toContain("latest_fiscal_year");
  });
});
