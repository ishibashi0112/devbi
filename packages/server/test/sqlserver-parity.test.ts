// The SQL Server cases the C# reference (dotnet/) must answer the same way: how a file is split, checked and
// bound. This test writes what the TypeScript code answers to fixtures/sqlserver-cases.json; the C# tests
// (dotnet/test/DevBI.Server.Tests/ParityTests.cs) read it and compare. When a change here alters an answer,
// `pnpm test -u` rewrites the file, and the C# tests then say whether the C# code still agrees.
import { describe, expect, it } from "vitest";
import { bindParameters, connectionOf, parameters, parseDataset, readOnlyProblem, snapshotOf, splitStatements, type Dataset } from "../src/index.js";

const texts = [
  "SELECT 1",
  "﻿-- 受注\r\n-- 二行目\r\nSELECT * FROM t;\r\n",
  "-- 上\n\n-- 説明\nSELECT a FROM t\nGO\nSELECT b FROM t\ngo 2\n/\nSELECT c",
  "/* 見出し\n * 二行目\n */\nSELECT 1 /* 中 */ ; -- 後ろ\n",
  "SELECT 'a;b', N'c''d;', [e;]]f], \"g;h\" FROM t;",
  "SELECT 1 -- 終わらない 'x\n; SELECT 'open",
  "SELECT 1\r\nGO\r\n\r\nSELECT 2\rGO\r",
  "  GO  \nSELECT 1\n  /  \n",
  "-- a\nSELECT 1\n-- b\n;\n-- c\n",
  "SELECT /* 終わらない",
  "SELECT 'GO\nGO\n' AS a\nGO -- 区切りではない\nSELECT 2",
  "/* /* 入れ子 */ SELECT 1 */ SELECT 2",
  "SELECT 1 -- 行の区切り? FROM t",
  "\n\n  -- 説明\n  SELECT 1 ;;; SELECT 2\n",
  'SELECT x AS "a""b;" FROM t',
];

const sqls = [
  "SELECT * FROM t",
  "WITH a AS (SELECT 1 AS x) SELECT * FROM a",
  "DELETE FROM t",
  "select * into copy from t",
  "SELECT id AS [update], 'delete' AS s, \"insert\" FROM t",
  "SELECT o.update_date, o.[drop] FROM orders o",
  "SELECT * FROM t WITH (UPDLOCK)",
  "SELECT * FROM t WITH (NOLOCK)",
  "SELECT NEXT VALUE FOR seq",
  "SELECT * FROM t FOR UPDATE",
  "SELECT * FROM t FOR SHARE",
  "SELECT * FROM t FOR JSON PATH",
  "SELECT 1; SELECT 2",
  "SELECT 'a';",
  "(SELECT 1)",
  "",
  "EXEC sp_who",
  "SELECT * FROM OPENROWSET('x', 'y')",
  "SELECT 受注番号, 地域 FROM 受注 WHERE 地域 = :地域",
  "SELECT a::date, ':skip', [col:x], \"q:y\" FROM t -- :nope\nWHERE d >= :from AND d < :to AND x = :FROM /* :no */",
  "SELECT :a1, :_b, :1, ::c, :ä, x:y FROM t",
  "SELECT * FROM t WHERE name = :name_that_is_long_and_has_digits_123",
  "SELECT 　* FROM t WHERE a = :a　AND b = :b",
  "SELECT e.@x, #tmp.a, $y FROM #tmp",
  "WITH FUNCTION f() RETURNS INT BEGIN RETURN 1 END SELECT f()",
  "SELECT * FROM t WHERE x IN (SELECT y FROM u FOR XML PATH(''))",
  "SELECT [a]]b], [c:d] FROM t WHERE x = :p",
  "SELECT\t:a\v:b :c FROM t WHERE （:受注日） = :受注日",
  "SELECT 1 FROM t -- 終わり",
  "SELECT n.nextval, NEXTVAL FROM t",
  "SELECT 1 FROM t WITH (TABLOCKX, HOLDLOCK)",
  "SELECT * FROM t FOR NO KEY UPDATE",
  "SELECT * FROM t FOR KEY SHARE",
  "SELECT o.[into], [o].exec FROM o",
  "SELECT a FROM t\nWHERE a = N'x'''';DROP TABLE t--'",
  `SELECT ${"a".repeat(300)}, update_x, x_update, "${"b".repeat(10)}" FROM t`,
];

const datasets: { name: string; text: string }[] = [
  { name: "orders", text: "-- 受注の明細\n-- connection: erp\nSELECT * FROM orders WHERE d >= :from;\n" },
  { name: "daily", text: "-- 日ごと\n-- snapshot: 12:00、6:30, 06:30\n-- Connection : Sales-DB 2\n\nSELECT d, SUM(a) AS a FROM t WHERE d >= :From AND d < :to AND k = :from GROUP BY d" },
  { name: "bad_time", text: "-- snapshot: 24:00\nSELECT 1" },
  { name: "bad_time2", text: "-- snapshot: 6時\nSELECT 1" },
  { name: "no_time", text: "-- snapshot:\nSELECT 1" },
  { name: "late", text: "SELECT 1\n-- connection: erp\n-- snapshot: 06:00" },
  { name: "empty", text: "-- 何もない\n" },
  { name: "two", text: "SELECT 1;\nSELECT 2" },
  { name: "writes", text: "-- 書く\nUPDATE t SET a = 1" },
  { name: "into", text: "SELECT * INTO copy FROM orders" },
  { name: "locks", text: "SELECT * FROM t WITH (XLOCK)" },
  { name: "several", text: "SELECT 'a' + 'b;' FROM t WHERE x = ']'; DROP TABLE t" },
  { name: "not_select", text: "-- 説明\n(SELECT 1)" },
  { name: "spaces", text: "　-- connection:　erp　\n -- snapshot:　07:00　08:00\nSELECT 1" },
  // -- param: and -- key: (docs/design/sql-datasets.md 4 章)
  {
    name: "typed",
    text:
      "-- 受注の明細\n-- param: from date label=受注日（から） default=month_start\n-- param: regions text[] label=\"地域 （複数）\" values=regions default=all\n" +
      "--param:customer integer optional hidden\n-- key: 受注番号, \"行, 番号\"、 \"a\"\"b\"\n\n-- 説明の 2 行目\n-- Param : status text default=\"受付 \"\"中\"\"\"\n" +
      "SELECT * FROM t WHERE d >= :from AND r IN (:Regions) AND (:customer IS NULL OR c = :customer) AND s = :status AND x = :plain",
  },
  { name: "typed_late", text: "SELECT * FROM t WHERE a = :a\n-- param: a date" },
  {
    name: "typed_defaults",
    text:
      "-- param: a date default=today-30\n-- param: b datetime default=2024-04-01T09:00\n-- param: c text default=\"\"\n-- param: d number default=-1.5e3\n" +
      "-- param: e boolean default=false\n-- param: f integer[] default=1,2\n-- param: g text[] default=all\nSELECT :a, :b, :c, :d, :e FROM t WHERE x IN (:f) AND y IN (:g)",
  },
  ...[
    "-- param: d",
    "-- param:",
    "-- param: d day",
    "-- param: d text[ ]",
    "-- param: nope date",
    "-- param: d date\n-- param: D date",
    "-- param: d date colour=red",
    "-- param: d date label",
    "-- param: d date label=",
    "-- param: d date optional=yes",
    "-- param: d date label=a label=b",
    "-- param: d date label=\"a",
    "-- param: d=1 date",
    "-- param: d type=date",
    "-- param: r text[] optional",
    "-- param: user.region text",
    "-- param: 1d text",
    "-- param: d integer default=1.5",
    "-- param: d integer default=9007199254740992",
    "-- param: d date default=2024-02-30",
    "-- param: d date default=2024-02-29",
    "-- param: d date default=2023-02-29",
    "-- param: d datetime default=2024-04-01T24:00",
    "-- param: d date default=today+",
    "-- param: d date default=",
    "-- param: r integer[] default=1,,2",
    "-- param: r integer[] default=all",
    "-- param: d boolean default=yes",
    "-- param: d date values=../x",
    "-- key:",
    "-- key: a, a",
    "-- key: a\n-- key: b",
    "-- key: \"a\" b",
    "-- key: \"a",
    "-- param: r text[]\n-- 説明\n",
  ].map((head, i) => ({ name: `bad${i}`, text: `-- 説明\n${head}\nSELECT * FROM t WHERE d = :d AND r IN (:r)` })),
  { name: "multi_eq", text: "-- param: r text[]\nSELECT * FROM t\nWHERE\n  r = :r" },
  { name: "multi_two", text: "-- param: r text[]\nSELECT * FROM t WHERE r IN (:r, 'x')" },
  { name: "multi_name", text: "-- param: r text[]\nSELECT * FROM t WHERE rIN (:r)" },
  { name: "multi_not_in", text: "-- param: r text[]\nSELECT * FROM t WHERE r NOT IN(\n  :r\n) OR [x]IN (:r)" },
  { name: "multi_space", text: "-- param: r text[]\nSELECT * FROM t WHERE r\u3000In\u3000(\u3000:r )" },
  { name: "multi_dotless", text: "-- param: r text[]\nSELECT * FROM t WHERE r \u0131n (:r)" },
  { name: "late_block", text: "/* 受注 */\n-- param: r text[]\nSELECT * FROM t WHERE r IN (:r)" },
  { name: "late_key", text: "-- param: d date\nSELECT * FROM t\n-- key: id\nWHERE d = :d" },
  { name: "late_in_sql", text: "SELECT * FROM t WHERE d = :d -- param: d date\n  -- Param : d" },
  { name: "late_not", text: "-- 説明\nSELECT * FROM t WHERE d = :d -- the param: d\n-- keys: a" },
];

const binds: { text: string; values: Record<string, unknown> }[] = [
  { text: "SELECT * FROM t WHERE d >= :from AND d < :to AND x = :FROM", values: { to: "2024-05-01", from: "2024-04-01" } },
  { text: "SELECT * FROM t WHERE a = :a", values: { A: 1 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: 1.5 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: -9007199254740991 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: 2 ** 60 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: 1e300 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: true } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: null } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: { x: 1 } } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: [1] } },
  { text: "SELECT * FROM t WHERE a = :a", values: {} },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: 1, b: 2 } },
  { text: "SELECT * FROM t WHERE a = :a", values: { a: 1, A: 2 } },
  { text: "SELECT 1", values: { a: 1 } },
  { text: "SELECT '::a', :a, [:b], :b FROM t", values: { a: "x", b: "y" } },
  { text: "SELECT :地域, :ｘ FROM t", values: { 地域: "関東", ｘ: 0 } },
  { text: "SELECT * FROM t WHERE r = :user", values: { "user.region": "関東", user: "x" } },
  { text: "SELECT * FROM t WHERE r = :user", values: { user: "x" } },
  ...((): { text: string; values: Record<string, unknown> }[] => {
    const typed =
      "-- param: from date\n-- param: at datetime optional\n-- param: n integer\n-- param: r number\n-- param: ok boolean\n-- param: s text\n-- param: regions text[]\n" +
      "SELECT * FROM t WHERE d >= :from AND t < :at AND n = :n AND r = :r AND ok = :ok AND s = :s AND x IN (:regions) AND d < :from";
    const values = { from: "2024-04-01", at: "2024-04-01T09:00", n: 10, r: 1.5, ok: true, s: "関東", regions: ["関東", "近畿"] };
    const patches: Record<string, unknown>[] = [
      {},
      { at: null },
      { at: "2024-04-01" },
      { at: "2024-04-01 09:00:30.123456" },
      { at: "2024-04-01T09:00:30.1234567" },
      { at: "2024-04-01T24:00" },
      { at: "2024-04-01T09:60" },
      { at: "2024-04-01T09:00Z" },
      { at: "2024-04-01T9:00" },
      { from: "2024-02-30" },
      { from: "2024-02-29" },
      { from: "1900-02-29" },
      { from: "2000-02-29" },
      { from: "0000-01-01" },
      { from: "２０２４-04-01" },
      { from: 20240401 },
      { from: null },
      { n: 1.5 },
      { n: "10" },
      { n: -9007199254740991 },
      { n: 9007199254740992 },
      { n: 1e300 },
      { n: 1.5e-7 },
      { n: -0.000001 },
      { n: 1e21 },
      { n: 123456789012345680000 },
      { n: 0.1 + 0.2 },
      { r: "1.5" },
      { r: 10 },
      { ok: 1 },
      { ok: false },
      { s: 1 },
      { s: "x".repeat(4000) },
      { s: "x".repeat(4001) },
      { s: "😀".repeat(2001) },
      { s: ["a"] },
      { s: { a: 1 } },
      { regions: [] },
      { regions: null },
      { regions: ["a", null] },
      { regions: ["a", 1] },
      { regions: ["a", ["b"]] },
      { regions: "関東" },
      { regions: Array.from({ length: 1001 }, (_, i) => String(i)) },
    ];
    return patches.map((p) => ({ text: typed, values: { ...values, ...p } }));
  })(),
  // the echoed value is cut at 40 characters, not between the two halves of 𠮷
  { text: "-- param: n integer\nSELECT * FROM t WHERE a = :n", values: { n: `${"a".repeat(38)}\u{20BB7}bc` } },
  { text: "-- param: n integer\nSELECT * FROM t WHERE a = :n", values: { n: `${"a".repeat(37)}\u{20BB7}bc` } },
  { text: "-- param: n integer[]\nSELECT * FROM t WHERE a IN (:n)", values: { n: [`${"a".repeat(37)}\u{20BB7}bc`] } },
  // the echoed value is written as JSON.stringify writes it
  { text: "-- param: n integer\nSELECT * FROM t WHERE a = :n", values: { n: '😀\n"x\\\u0001\u2028<>&\'' } },
  { text: "-- param: n integer[]\nSELECT * FROM t WHERE a IN (:n)", values: { n: [1, [2.5, "😀", null, true]] } },
  { text: "-- param: n integer[]\nSELECT * FROM t WHERE a IN (:n)", values: { n: [{ "😀": "\t", b: 1e21, c: [] }] } },
  { text: "-- param: ids integer[]\nSELECT * FROM t WHERE a IN (:ids) OR b IN (:ids)", values: { ids: Array.from({ length: 1000 }, (_, i) => i) } },
  {
    text: "-- param: ids integer[]\n-- param: more integer[]\nSELECT * FROM t WHERE a IN (:ids) OR b IN (:more) OR c = :x",
    values: { ids: Array.from({ length: 1000 }, (_, i) => i), more: Array.from({ length: 1000 }, (_, i) => i), x: 1 },
  },
];

const errorOf = (e: unknown) => ({ error: (e as Error).message, ...((e as { status?: number }).status ? { status: (e as { status: number }).status } : {}) });

const datasetOf = (d: Dataset) => ({
  description: d.description,
  connection: d.connection ?? null,
  snapshot: d.snapshot ?? null,
  sql: d.sql,
  params: d.params,
  parameters: d.parameters,
  key: d.key ?? null,
});

describe("the SQL Server cases the C# reference checks against", () => {
  it("are what the TypeScript code answers", async () => {
    const cases = {
      statements: texts.map((text) => ({ text, statements: splitStatements(text, "mssql") })),
      problems: sqls.map((sql) => {
        const p = readOnlyProblem(sql, "mssql");
        return { sql, problem: p ? { code: p.code, word: p.word ?? null } : null };
      }),
      parameters: sqls.map((sql) => ({ sql, parameters: parameters(sql, "mssql") })),
      datasets: datasets.map(({ name, text }) => {
        const header = { connection: connectionOf(text) ?? null, snapshot: (() => { try { return snapshotOf(text, name) ?? null; } catch (e) { return errorOf(e); } })() };
        try {
          return { name, text, header, dataset: datasetOf(parseDataset(name, text, "mssql")) };
        } catch (e) {
          return { name, text, header, dataset: errorOf(e) };
        }
      }),
      binds: binds.map(({ text, values }) => {
        try {
          const { sql, params } = bindParameters(parseDataset("x", text, "mssql"), "mssql", values);
          return { text, values, bound: { sql, values: params } };
        } catch (e) {
          return { text, values, bound: errorOf(e) };
        }
      }),
    };
    // Long lists of values (1,000 for one IN) on one line each: the file stays readable.
    const scalar = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?[0-9.e+]+|null|true|false)`;
    const list = new RegExp(String.raw`\[\n( +)(${scalar}(?:,\n\1${scalar})*)\n *\]`, "g");
    const text = JSON.stringify(cases, null, 2).replace(list, (all, indent: string, body: string) => {
      const items = body.split(`,\n${indent}`);
      return items.length > 10 ? `[${items.join(", ")}]` : all;
    });
    await expect(`${text}\n`).toMatchFileSnapshot("fixtures/sqlserver-cases.json");
  });
});
