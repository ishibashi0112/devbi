import { describe, expect, it } from "vitest";
import { downloadRanges, githubRepo, toCsv } from "../scripts/stats.mjs";

describe("fetch-stats", () => {
  it("reads the GitHub repository of an npm package", () => {
    expect(githubRepo("git+https://github.com/ishibashi0112/datasheet-grid.git")).toBe("ishibashi0112/datasheet-grid");
    expect(githubRepo("https://github.com/o/r/tree/main/packages/x")).toBe("o/r");
    expect(githubRepo("git@github.com:o/r.js.git")).toBe("o/r.js");
    expect(githubRepo("https://gitlab.com/o/r")).toBeUndefined();
    expect(githubRepo(undefined)).toBeUndefined();
  });

  it("asks npm for at most 18 months at a time, from the first day", () => {
    expect(downloadRanges("2026-10-10T08:00:00.000Z", "2026-11-08")).toEqual([["2026-10-10", "2026-11-08"]]);
    expect(downloadRanges("2024-01-01T00:00:00Z", "2026-11-08")).toEqual([
      ["2024-01-01", "2025-06-23"],
      ["2025-06-24", "2026-11-08"],
    ]);
    expect(downloadRanges("2010-05-01T00:00:00Z", "2015-01-12")).toEqual([["2015-01-10", "2015-01-12"]]);
    expect(downloadRanges("2026-11-09T01:00:00Z", "2026-11-08")).toEqual([]);
  });

  it("writes CSV with quotes only where needed", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          { a: "x,y", b: 'say "hi"' },
          { a: 1, b: null },
        ],
      ),
    ).toBe('a,b\n"x,y","say ""hi"""\n1,\n');
  });
});
