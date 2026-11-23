import { afterEach, describe, expect, it, vi } from "vitest";
import { optionsFromAttributes } from "../src/embed.js";
import { exportKinds } from "../src/ExportMenu.js";
import { exportFileName } from "../src/export/tile-data.js";

describe("exportKinds", () => {
  it("offers every kind by default, none for false, and only those listed (in the menu's order)", () => {
    expect(exportKinds(undefined)).toEqual(["xlsx", "pdf", "csv"]);
    expect(exportKinds(true)).toEqual(["xlsx", "pdf", "csv"]);
    expect(exportKinds(false)).toEqual([]);
    expect(exportKinds(["csv", "xlsx"])).toEqual(["xlsx", "csv"]);
    expect(exportKinds([])).toEqual([]);
    // null from plain JavaScript: as false
    expect(exportKinds(null)).toEqual([]);
  });
});

describe("exportFileName", () => {
  const now = new Date(2026, 10, 23, 20, 33);
  it("is the title, the tile's name and the time, without characters file systems refuse", () => {
    expect(exportFileName("売上ダッシュボード", now, "xlsx")).toBe("売上ダッシュボード_20261123-2033.xlsx");
    expect(exportFileName("売上/月次", now, "csv", "地域: 関東")).toBe("売上_月次_地域_ 関東_20261123-2033.csv");
    expect(exportFileName("  ", now, "zip")).toBe("dashboard_20261123-2033.zip");
  });

  it("stays under 255 bytes however long the titles are (日本語 is 3 bytes a character)", () => {
    const long = "売".repeat(200);
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    expect(bytes(exportFileName(long, now, "csv", long))).toBeLessThan(255);
    expect(bytes(exportFileName(long, now, "xlsx"))).toBeLessThan(255);
    expect(exportFileName(long, now, "xlsx")).toMatch(/^売+_20261123-2033\.xlsx$/);
  });
});

describe("data-devbi-exports", () => {
  const el = (value: string | null) => ({ getAttribute: (name: string) => (name === "data-devbi-exports" ? value : null) }) as unknown as Element;
  afterEach(() => vi.restoreAllMocks());

  it("false leaves the menu out; a list offers only those; true, empty or none is the default", () => {
    expect(optionsFromAttributes(el("false")).exports).toBe(false);
    expect(optionsFromAttributes(el(" xlsx, PDF ")).exports).toEqual(["xlsx", "pdf"]);
    expect(optionsFromAttributes(el("csv pdf")).exports).toEqual(["pdf", "csv"]);
    expect(optionsFromAttributes(el("true"))).not.toHaveProperty("exports");
    expect(optionsFromAttributes(el(""))).not.toHaveProperty("exports");
    expect(optionsFromAttributes(el(null))).not.toHaveProperty("exports");
  });

  it("a name it does not know is left out, with an error in the console (a mistyped list offers less)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(optionsFromAttributes(el("excel,pdf")).exports).toEqual(["pdf"]);
    expect(optionsFromAttributes(el("excel")).exports).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]![0]).toContain("excel");
  });
});
