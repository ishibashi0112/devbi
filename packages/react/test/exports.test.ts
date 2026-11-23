import { afterEach, describe, expect, it, vi } from "vitest";
import { optionsFromAttributes } from "../src/embed.js";
import { exportKinds } from "../src/ExportMenu.js";

describe("exportKinds", () => {
  it("offers every kind by default, none for false, and only those listed (in the menu's order)", () => {
    expect(exportKinds(undefined)).toEqual(["xlsx", "pdf", "csv"]);
    expect(exportKinds(true)).toEqual(["xlsx", "pdf", "csv"]);
    expect(exportKinds(false)).toEqual([]);
    expect(exportKinds(["csv", "xlsx"])).toEqual(["xlsx", "csv"]);
    expect(exportKinds([])).toEqual([]);
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
