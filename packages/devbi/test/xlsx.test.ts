import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TABLE_STYLES, Workbook, addResultTable, isDateFormat, listSheets, readXlsx, resultCell, sheetRef, writeXlsx } from "../src/index.js";
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

  it("reads ISO date cells (t=\"d\") as wall-clock time, whatever the local time zone", async () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const sheet = (rows: string) =>
      writeZip([
        { name: "xl/workbook.xml", data: `<workbook ${ns} xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
        { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/s.xml"/></Relationships>` },
        { name: "xl/worksheets/s.xml", data: `<worksheet ${ns}><sheetData><row><c t="str"><v>日付</v></c></row>${rows}</sheetData></worksheet>` },
      ]);
    const t = await readXlsx(await sheet(`<row><c t="d"><v>2024-04-01T00:00:00</v></c></row><row><c t="d"><v>2024-04-02</v></c></row>`));
    expect(t.columns).toEqual([{ name: "日付", type: "DATE", values: [new Date("2024-04-01T00:00:00Z"), new Date("2024-04-02T00:00:00Z")] }]);
    const ts = await readXlsx(await sheet(`<row><c t="d"><v>2024-04-01T09:30:00</v></c></row>`));
    expect(ts.columns[0]).toMatchObject({ type: "TIMESTAMP", values: [new Date("2024-04-01T09:30:00Z")] });
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

describe("Workbook (styles, number formats, frozen headers)", () => {
  const xml = async (bytes: Uint8Array, name: string) => (await readZip(bytes).get(name)!.text()) as string;

  it("writes numbers, dates and text that readXlsx reads back, with their formats", async () => {
    const book = new Workbook();
    const sheet = book.sheet("売上");
    sheet.add({ v: "月", s: TABLE_STYLES.header }, { v: "売上", s: TABLE_STYLES.header }, { v: "比", s: TABLE_STYLES.header });
    sheet.add({ v: new Date("2026-04-01T00:00:00Z"), s: { format: 'yyyy"年"m"月"' } }, { v: 1234567, s: { format: '"¥"#,##0' } }, { v: 1.0614167144132196, s: { format: "0.0%" } });
    sheet.add(new Date("2026-05-01T09:30:00Z"), -500, 0.5);
    sheet.freeze = { rows: 1 };
    sheet.filter = [0, 2, 3];
    const bytes = await book.toBytes();
    const t = await readXlsx(bytes);
    expect(t.columns).toEqual([
      { name: "月", type: "TIMESTAMP", values: [new Date("2026-04-01T00:00:00Z"), new Date("2026-05-01T09:30:00Z")] },
      { name: "売上", type: "BIGINT", values: [1234567, -500] },
      { name: "比", type: "DOUBLE", values: [1.0614167144132196, 0.5] },
    ]);
    const styles = await xml(bytes, "xl/styles.xml");
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;"/>');
    expect(styles).toContain('formatCode="&quot;¥&quot;#,##0"');
    expect(styles).toContain('formatCode="yyyy/m/d h:mm"'); // a date without a format
    expect(styles).toContain('<xf numFmtId="0" fontId="1" fillId="2" borderId="1"'); // the header: bold, gray, bordered
    const sheetXml = await xml(bytes, "xl/worksheets/sheet1.xml");
    expect(sheetXml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheetXml).toContain('<autoFilter ref="A1:C3"/>');
    expect(await xml(bytes, "xl/workbook.xml")).toContain(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'売上'!$A$1:$C$3</definedName>`);
  });

  it("names sheets as Excel allows: 31 characters, no []:*?/\\, each once", async () => {
    const book = new Workbook();
    const names = ["地域 / 四半期", "a".repeat(40), "A".repeat(40), "[x]", "", "'q'"].map((n) => book.sheet(n).name);
    expect(names).toEqual(["地域   四半期", "a".repeat(31), `${"A".repeat(27)} (2)`, "x", "Sheet", "q"]);
    expect(await listSheets(await book.toBytes())).toEqual(names);
  });

  it("links to other sheets, keeps long whole numbers as text and sizes the columns", async () => {
    const book = new Workbook();
    const first = book.sheet("概要");
    const other = book.sheet("O'Neil");
    first.add({ v: "見る", link: `${sheetRef(other.name)}!A1` }, { v: 1234567890123456789 }, { v: 12345678901234 });
    first.add({ v: "とても長い見出しの列です", noWidth: true }, { v: 1, text: "¥1,000,000,000" });
    const bytes = await book.toBytes();
    const s = await xml(bytes, "xl/worksheets/sheet1.xml");
    expect(s).toContain(`<hyperlink ref="A1" location="'O''Neil'!A1"/>`);
    expect(s).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">1234567890123456800</t></is></c>');
    expect(s).toContain('<c r="C1"><v>12345678901234</v></c>');
    // A: 見る (4 wide; the long text is left out), B: the 14 characters shown
    expect(s).toContain('<col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="21" customWidth="1"/>');
  });
});

describe("resultCell and addResultTable (a query result in xlsx)", () => {
  it("keeps numbers and dates, in the formats the dashboard shows", () => {
    const month = { kind: "time", grain: "month" } as const;
    expect(resultCell(1234, { kind: "measure", format: "¥#,##0" })).toMatchObject({ v: 1234, s: { format: '"¥"#,##0', border: true }, text: "¥1,234" });
    expect(resultCell(123456789, { kind: "measure", format: "compact" })).toMatchObject({ v: 123456789, s: { format: "#,##0" }, text: "123,456,789" });
    expect(resultCell(3.25, { kind: "measure" })).toMatchObject({ v: 3.25, s: { format: "#,##0.0#" } });
    expect(resultCell(4, { kind: "measure" })).toMatchObject({ v: 4, s: { format: "#,##0" } });
    expect(resultCell(10n, { kind: "measure" })).toMatchObject({ v: 10 });
    expect(resultCell(new Date("2026-04-01T00:00:00Z"), month)).toMatchObject({ s: { format: 'yyyy"年"m"月"' }, text: "2026年4月" });
    expect(resultCell(new Date("2026-04-01T00:00:00Z"), { kind: "time", grain: "quarter" })).toMatchObject({ v: "2026年Q2" });
    expect(resultCell(new Date("2026-04-01T00:00:00Z"), { kind: "time", grain: "fiscal_year" }, 4)).toMatchObject({ s: { format: 'yyyy"年度"' } });
    expect(resultCell(new Date("2026-04-01T09:30:00Z"), { kind: "dimension" })).toMatchObject({ s: { format: "yyyy/m/d hh:mm" }, text: "2026/4/1 09:30" });
    expect(resultCell(true, { kind: "dimension" })).toMatchObject({ v: "はい" });
    expect(resultCell(null, { kind: "dimension" })).toEqual({ v: null, s: TABLE_STYLES.cell });
    // the same style object for the same format, so the workbook looks it up once
    expect(resultCell(1, { kind: "measure", format: "0.0" }).s).toBe(resultCell(2, { kind: "measure", format: "0.0" }).s);
  });

  it("writes a table with its header kept in view and an auto filter", async () => {
    const book = new Workbook();
    const sheet = book.sheet("t");
    sheet.add("タイトル");
    sheet.skip();
    const fields = [
      { name: "region", label: "地域", kind: "dimension" as const },
      { name: "revenue", label: "売上", kind: "measure" as const, format: "¥#,##0" },
    ];
    expect(addResultTable(sheet, [{ region: "関東", revenue: 100 }, { region: null, revenue: 50 }], fields)).toBe(2);
    expect(sheet.freeze).toEqual({ rows: 3 });
    expect(sheet.filter).toEqual([2, 4, 2]);
    const t = await readXlsx(await book.toBytes(), { range: "A3:B5" });
    expect(t.columns).toEqual([
      { name: "地域", type: "VARCHAR", values: ["関東", null] },
      { name: "売上", type: "BIGINT", values: [100, 50] },
    ]);
  });
});
