import { describe, expect, it } from "vitest";
import { formatNumber, formatTime, formatValue } from "../src/index.js";

describe("formatNumber", () => {
  it.each([
    [1234567.891, undefined, "1,234,567.89"],
    [1234567, undefined, "1,234,567"],
    [12.345, undefined, "12.35"],
    [1234567, "¥#,##0", "¥1,234,567"],
    [-1234, "¥#,##0", "-¥1,234"],
    [1234.5, '#,##0"円"', "1,235円"],
    [0.1234, "0.0%", "12.3%"],
    [1.5, "0.00", "1.50"],
    [1.5, "0.0#", "1.5"],
    [1234567, "#,##0,", "1,235"],
    [1234567, '#,##0,,"百万円"', "1百万円"],
    [-5, "0;(0)", "(5)"],
    [0, '0;-0;"なし"', "なし"],
    [123456789, "compact", "1.2億"],
    [34000000, "compact:¥", "¥3400万"],
    [-0.001, "0.0", "0.0"],
  ])("%s with %s → %s", (value, fmt, expected) => {
    expect(formatNumber(value, fmt)).toBe(expected);
  });
});

describe("formatTime", () => {
  const d = new Date(Date.UTC(2026, 3, 1));
  it.each([
    ["year", "2026年"],
    ["quarter", "2026年Q2"],
    ["month", "2026年4月"],
    ["day", "2026/4/1"],
  ] as const)("%s", (grain, expected) => {
    expect(formatTime(d, grain)).toBe(expected);
  });
  it("labels fiscal years", () => {
    expect(formatTime(d, "fiscal_year", 4)).toBe("2026年度");
  });
  it("formats values of any kind", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(true)).toBe("はい");
    expect(formatValue(10n)).toBe("10");
    expect(formatValue(0.5, { kind: "measure", format: "0%" })).toBe("50%");
  });
});
