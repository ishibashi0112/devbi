import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDateFormat, listSheets, readXlsx, writeXlsx } from "../src/index.js";
import { readZip, writeZip } from "../src/xlsx/zip.js";

const fixture = readFileSync(new URL("./fixtures/openpyxl.xlsx", import.meta.url));

describe("readXlsx (file written by openpyxl)", () => {
  it("lists sheets", async () => {
    expect(await listSheets(fixture)).toEqual(["表紙", "明細"]);
  });

  it("reads typed columns and skips empty rows", async () => {
    const t = await readXlsx(fixture, { sheet: "明細" });
    expect(t.rowCount).toBe(3);
    expect(t.columns.map((c) => [c.name, c.type])).toEqual([
      ["受注日", "DATE"],
      ["受注番号", "VARCHAR"],
      ["顧客", "VARCHAR"],
      ["数量", "BIGINT"],
      ["金額", "DOUBLE"],
      ["確定", "BOOLEAN"],
      ["登録日時", "TIMESTAMP"],
      ["メモ", "VARCHAR"],
    ]);
    const col = (n: string) => t.columns.find((c) => c.name === n)!.values;
    expect(col("受注日")).toEqual([new Date("2026-01-05T00:00:00Z"), new Date("2026-01-06T00:00:00Z"), new Date("2026-02-01T00:00:00Z")]);
    expect(col("受注番号")).toEqual(["001", "002", "3"]);
    expect(col("顧客")).toEqual(["A社", "B社 & C", "A社"]);
    expect(col("金額")).toEqual([1200.5, 300, 800]);
    expect(col("確定")).toEqual([true, false, true]);
    expect(col("登録日時")[0]).toEqual(new Date("2026-01-05T09:30:00Z"));
    expect(col("メモ")).toEqual([null, "急ぎ", "<b>"]);
  });

  it("reads the first sheet by default and names headerless columns", async () => {
    const t = await readXlsx(fixture, { header: false });
    expect(t.sheet).toBe("表紙");
    expect(t.columns).toEqual([{ name: "column1", type: "VARCHAR", values: ["月次売上レポート"] }]);
  });

  it("limits to a range and reports missing sheets", async () => {
    const t = await readXlsx(fixture, { sheet: "明細", range: "C1:D3" });
    expect(t.columns.map((c) => c.name)).toEqual(["顧客", "数量"]);
    expect(t.rowCount).toBe(2);
    await expect(readXlsx(fixture, { sheet: "無い" })).rejects.toThrow("シート「無い」がありません（あるのは 「表紙」、「明細」）");
  });
});

describe("writeXlsx round trip", () => {
  it("writes what readXlsx reads back", async () => {
    const buf = await writeXlsx([
      {
        name: "data",
        rows: [
          ["日付", "名前", "値", "フラグ"],
          [new Date("2026-03-01T00:00:00Z"), "あ<&>", 1.25, true],
          [new Date("2026-03-02T00:00:00Z"), null, 2, false],
        ],
      },
    ]);
    const t = await readXlsx(buf);
    expect(t.columns).toEqual([
      { name: "日付", type: "DATE", values: [new Date("2026-03-01T00:00:00Z"), new Date("2026-03-02T00:00:00Z")] },
      { name: "名前", type: "VARCHAR", values: ["あ<&>", null] },
      { name: "値", type: "DOUBLE", values: [1.25, 2] },
      { name: "フラグ", type: "BOOLEAN", values: [true, false] },
    ]);
  });
});

describe("shared strings with furigana", () => {
  it("drops phonetic runs and joins rich text", async () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const buf = await writeZip([
      {
        name: "xl/workbook.xml",
        data: `<workbook ${ns} xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<Relationships><Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/s.xml"/></Relationships>`,
      },
      {
        name: "xl/sharedStrings.xml",
        data: `<sst ${ns}><si><t>顧客</t></si><si><r><t>東京</t></r><r><t xml:space="preserve"> 本社</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si><si/></sst>`,
      },
      {
        name: "xl/worksheets/s.xml",
        data: `<worksheet ${ns}><sheetData><row><c t="s"><v>0</v></c></row><row><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c></row><row><c t="str"><v>a&amp;b_x000D_</v></c></row></sheetData></worksheet>`,
      },
    ]);
    const t = await readXlsx(buf);
    expect(t.columns).toEqual([{ name: "顧客", type: "VARCHAR", values: ["東京 本社", "a&b\r"] }]);
  });

  it("reads stored and deflated entries", async () => {
    const z = readZip(await writeZip([{ name: "a.txt", data: "hello" }]));
    expect(await z.get("a.txt")!.text()).toBe("hello");
  });
});

describe("isDateFormat", () => {
  it.each([
    ["yyyy/m/d", true],
    ['[$-411]ggge"年"m"月"d"日"', true],
    ["h:mm", true],
    ["#,##0", false],
    ['#,##0"円"', false],
    ["0.00E+00", false],
    ["General", false],
    ["[Red]0.0", false],
  ])("%s → %s", (code, expected) => {
    expect(isDateFormat(code)).toBe(expected);
  });
});
