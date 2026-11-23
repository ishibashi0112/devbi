import { describe, expect, it } from "vitest";
import { CSV_BOM, csvParts, csvValue, writeZip } from "../src/index.js";
import { readZip } from "../src/xlsx/zip.js";

describe("csvValue", () => {
  it("writes numbers without a format, and drops a float's trailing noise", () => {
    expect(csvValue(2622450)).toBe("2622450");
    expect(csvValue(-0.1297)).toBe("-0.1297");
    expect(csvValue(0.1 + 0.2)).toBe("0.3");
    expect(csvValue(12345678901234567n)).toBe("12345678901234567");
    expect(csvValue(Number.NaN)).toBe("");
    expect(csvValue(Infinity)).toBe("");
  });

  it("writes dates as 2026-04-01 and times with their seconds (UTC parts)", () => {
    expect(csvValue(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04-01");
    expect(csvValue(new Date("2026-04-01T09:30:00Z"))).toBe("2026-04-01 09:30:00");
    expect(csvValue(new Date("1969-12-31T23:00:00Z"))).toBe("1969-12-31 23:00:00");
    expect(csvValue(new Date("x"))).toBe("");
  });

  it("writes true / false, empty for none, objects as JSON", () => {
    expect(csvValue(true)).toBe("true");
    expect(csvValue(null)).toBe("");
    expect(csvValue(undefined)).toBe("");
    expect(csvValue({ a: 1 })).toBe('{"a":1}');
  });

  it("keeps text that a spreadsheet would run as a formula from running (a leading ')", () => {
    expect(csvValue("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(csvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvValue("+81-3-1234-5678")).toBe("'+81-3-1234-5678");
    expect(csvValue("-abc")).toBe("'-abc");
    // a number as text, or a dash, is no formula
    expect(csvValue("-12.5")).toBe("-12.5");
    expect(csvValue("-")).toBe("-");
    expect(csvValue("A=1")).toBe("A=1");
  });
});

describe("csvParts", () => {
  const fields = [
    { name: "d", label: "受注日" },
    { name: "c", label: "顧客, 名" },
    { name: "v", label: "売上" },
  ];

  it("writes a header of labels and a line per row, CRLF, after the UTF-8 BOM", () => {
    const text = csvParts(
      [
        { d: new Date("2026-04-01T00:00:00Z"), c: 'A社 "本店"', v: 1200 },
        { d: null, c: "改行\nあり", v: 0.5 },
        { d: new Date("2026-04-02T00:00:00Z"), c: " 前の空白", v: null },
      ],
      fields,
    ).join("");
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text.slice(1)).toBe(
      ['受注日,"顧客, 名",売上', '2026-04-01,"A社 ""本店""",1200', ',"改行\nあり",0.5', '2026-04-02," 前の空白",', ""].join("\r\n"),
    );
  });

  it("splits a large result into parts", () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => ({ d: new Date(Date.UTC(2026, 0, 1)), c: `顧客${i}`, v: i }));
    const parts = csvParts(rows, fields);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join("").split("\r\n")).toHaveLength(60_002);
  });
});

describe("writeZip", () => {
  it("keeps each file's time (MS-DOS: local time, to 2 seconds)", async () => {
    const modified = new Date(2026, 10, 23, 20, 33, 41);
    const zip = await writeZip([{ name: "売上.csv", data: ["a,b\r\n", "1,2\r\n"], modified }]);
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(["売上.csv"]);
    expect(await entries.get("売上.csv")!.text()).toBe("a,b\r\n1,2\r\n");
    const view = new DataView(zip.buffer, zip.byteOffset);
    const time = view.getUint16(10, true);
    const date = view.getUint16(12, true);
    expect([date >> 9, (date >> 5) & 15, date & 31]).toEqual([2026 - 1980, 11, 23]);
    expect([time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([20, 33, 40]);
  });
});
