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
];

const errorOf = (e: unknown) => ({ error: (e as Error).message, ...((e as { status?: number }).status ? { status: (e as { status: number }).status } : {}) });

const datasetOf = (d: Dataset) => ({
  description: d.description,
  connection: d.connection ?? null,
  snapshot: d.snapshot ?? null,
  sql: d.sql,
  params: d.params,
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
    await expect(`${JSON.stringify(cases, null, 2)}\n`).toMatchFileSnapshot("fixtures/sqlserver-cases.json");
  });
});
