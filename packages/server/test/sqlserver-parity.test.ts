// The SQL Server cases the C# reference (dotnet/) must answer the same way: how a file is split, checked and
// bound. This test writes what the TypeScript code answers to fixtures/sqlserver-cases.json; the C# tests
// (dotnet/test/DevBI.Server.Tests/ParityTests.cs) read it and compare. When a change here alters an answer,
// `pnpm test -u` rewrites the file, and the C# tests then say whether the C# code still agrees.
import { describe, expect, it } from "vitest";
import {
  accessLines,
  bindParameters,
  connectionOf,
  parameters,
  parseDataset,
  readOnlyProblem,
  rowLevelSignal,
  snapshotOf,
  splitStatements,
  viewerOf,
  type Dataset,
  type DevBIUser,
} from "../src/index.js";
import { tableUserOf } from "../src/access.js";
import type { ColumnType } from "../src/result.js";

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
  // :user.<attribute>, the signed-in user's values (docs/design/row-level-security.md 6.1): `user` in ASCII letters only
  "SELECT * FROM t WHERE r = :user.region AND s = :USER.Region AND o = :User.id AND x = :user.地域 AND y = :user_id",
  "SELECT :user., :user..x, :user.1x, :userx.y, :user .x, x:user.y, :user.a.b, ':user.q', [:user.w], \"q:user.e\" FROM t",
  "SELECT :ｕｓｅｒ.x, :uſer.x, :user.ſ, :user, :user.region::text, ::user.x FROM t -- :user.c",
  `SELECT :user.${"a".repeat(130)}, :${"u".repeat(125)}ser.x FROM t`,
  "SELECT :user.update, :user.into, :user.delete FROM t",
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
  // -- roles:, -- access: and :user.<attribute> (docs/design/row-level-security.md 6 章)
  {
    name: "rls",
    text: "-- 地域で絞る\n-- roles: 経理, CORP\\Managers、 経理\n\n-- 説明の 2 行目\nSELECT * FROM t WHERE r = :user.Region AND d >= :from AND o = :USER.id AND r2 = :user.region",
  },
  { name: "rls_all", text: "-- 全員\n-- Access : ALL\nSELECT * FROM t WHERE d >= :from" },
  { name: "rls_both", text: "-- access: all\nSELECT * FROM t WHERE r = :user.region" },
  { name: "rls_snapshot_user", text: "-- snapshot: 06:00\nSELECT * FROM t WHERE r = :user.region" },
  { name: "rls_snapshot_roles", text: "-- snapshot: 06:00\n-- roles: a\n-- access: all\nSELECT * FROM t" },
  { name: "rls_snapshot_all", text: "-- snapshot: 06:00\n-- access: all\nSELECT * FROM t" },
  { name: "rls_param_user", text: "-- param: user.region text\nSELECT * FROM t WHERE r = :user.region" },
  { name: "rls_typed", text: "-- param: r text[]\nSELECT * FROM t WHERE r IN (:r) AND o = :user.id AND x IN (:user.id)" },
  { name: "rls_bare", text: "SELECT * FROM t WHERE r = :user AND s = :User" },
  { name: "rls_late", text: "-- 説明\nSELECT * FROM t WHERE r = :user.region\n-- roles: a" },
  { name: "rls_typo", text: "-- role: 経理\nSELECT * FROM t" },
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
  { name: "nonchar", text: "-- 受注\uFFFE\n-- roles: ａ\uFFFE\nSELECT * FROM t WHERE r = :user.region" },
];

// The -- roles: and -- access: lines (accessLines), and the text search for row-level mode (rowLevelSignal).
const accessTexts = [
  "-- roles: 経理, CORP\\Managers\nSELECT 1",
  "-- roles: 経理、経理 , ,b\n-- access: all\nSELECT 1",
  "\uFEFF-- 説明\r\n\r\n  --ROLES:a\r\nSELECT 1",
  "-- roles:\nSELECT 1",
  "-- roles: ,、 \nSELECT 1",
  "-- roles: a\n-- roles: b\nSELECT 1",
  "-- access: all\n-- 説明\n-- access: all\nSELECT 1",
  "-- access: some\nSELECT 1",
  "-- access:\nSELECT 1",
  "-- access: all rows\nSELECT 1",
  "-- Access: All\nSELECT 1",
  "-- ｒｏｌｅｓ： 経理\nSELECT 1",
  "-- roles：経理\nSELECT 1",
  "-- roleſ: 経理\nSELECT 1",
  "\u3000-- access:\u3000all\u3000\nSELECT 1",
  "-- roles 経理\nSELECT 1",
  "-- access all\nSELECT 1",
  "-- x\n-- access\tall\nSELECT 1",
  "-- access all_rows\nSELECT 1",
  "-- accessall\nSELECT 1",
  "-- Access log の SQL\nSELECT 1",
  "-- access\nSELECT 1",
  "-- role: 経理\nSELECT 1",
  "-- rolse: 経理\nSELECT 1",
  "-- Roels : 経理\nSELECT 1",
  "-- acess: all\nSELECT 1",
  "-- accesss: all\nSELECT 1",
  "-- rules: a\nSELECT 1",
  "-- roads: a\nSELECT 1",
  "-- ro: a\nSELECT 1",
  "-- myroles: x\nSELECT 1",
  "--- roles: a\nSELECT 1",
  "-- @roles: a\nSELECT 1",
  "-- ※access: all\nSELECT 1",
  "-- see roles: below\nSELECT 1",
  "-- access::text\nSELECT 1",
  "-- roles:: a\nSELECT 1",
  "-- roles: a\rb\nSELECT 1",
  "-- roles: a\u2028b\nSELECT 1",
  "-- ROLES: Ｃｏｒｐ\\ｘ\nSELECT 1",
  "-- connection: erp\n-- roles: a\n-- snapshot: 06:00\nSELECT 1",
  "-- only comments\n-- roles: a",
  "",
  "SELECT 1\n-- roles: a",
  "SELECT 1 -- access: all",
  "/* roles: a */\nSELECT 1",
  "-- roles: a\n\nSELECT :user.id FROM t /* access: */",
  "SELECT a::text, access::int FROM t",
  "SELECT 'roles: x' FROM t",
  "SELECT access FROM t\nWHERE x = :USER.x",
  "SELECT 1 FROM t -- ｒｏｌｅｓ：",
  "SELECT '--' || 'access:' FROM t",
  "SELECT 1\r-- roles: a",
  "SELECT 1\u2028-- access: all",
  "SELECT 1\n-- Access log",
  // noncharacters, which .NET's normalization refuses (JavaScript keeps them)
  "SELECT 1 -- x\uFFFE",
  "-- 説明\uFFFE\n-- ｒｏｌｅｓ：\uFFFF経理\nSELECT 1",
  "-- \uFDD0access: all\nSELECT 1",
  "-- ａｃｃｅｓｓ：ａｌｌ\uFFFE\nSELECT 1",
];

// The row access/user.sql returns (tableUserOf), as the drivers hand it over: dates and timestamps as text.
const tableUsers: { columns: { name: string; type: ColumnType }[]; row: unknown[] | null }[] = [
  { columns: [{ name: "region", type: "string" }, { name: "roles", type: "string" }], row: ["関東", "営業、 経理 ,営業,, "] },
  { columns: [{ name: "Region", type: "string" }, { name: "ROLES", type: "string" }], row: [null, null] },
  { columns: [{ name: "region", type: "string" }, { name: "roles", type: "string" }], row: null },
  { columns: [{ name: "n", type: "int" }, { name: "f", type: "float" }, { name: "ok", type: "bool" }, { name: "blank", type: "string" }], row: [3, 1.5, false, " \u3000"] },
  { columns: [{ name: "since", type: "date" }, { name: "at", type: "timestamp" }, { name: "before", type: "timestamp" }], row: ["2024-01-02", "2024-01-02 03:04:05.123", "1969-12-31 23:59:59"] },
  { columns: [{ name: "id", type: "string" }], row: ["x"] },
  { columns: [{ name: "region", type: "string" }, { name: "REGION", type: "string" }], row: ["a", "b"] },
  { columns: [{ name: "roles", type: "int" }], row: [1] },
  { columns: [{ name: "地域", type: "string" }], row: ["a"] },
  { columns: [{ name: "a b", type: "string" }], row: ["a"] },
  { columns: [{ name: "user", type: "string" }], row: ["a"] },
  { columns: [{ name: "x", type: "string" }], row: null },
];

type BindCase = { text: string; values: Record<string, unknown>; user?: DevBIUser | null; rowLevel?: boolean };
const binds: BindCase[] = [
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
  // The signed-in user's values (:user.<attribute>): from the user only, never from the values the browser sends
  ...((): BindCase[] => {
    const text = "SELECT * FROM t WHERE r = :user.region AND o = :USER.Id AND d >= :from AND r2 = :User.REGION";
    const values = { from: "2024-04-01" };
    return [
      { text, values, user: { id: " CORP\\yamada ", attrs: { Region: "関東" } } },
      { text, values, user: { id: "u", attrs: { region: " 関東 ", dept: "営業" } } },
      { text, values, user: { id: "u", attrs: { REGION: 0 } } },
      { text, values, user: { id: "u", attrs: { region: false } } },
      { text, values, user: { id: "u", attrs: { region: 1.5 } } },
      { text, values, user: { id: "u", attrs: { region: 2 ** 60 } } },
      { text, values, user: { id: "u", attrs: {} } },
      { text, values, user: { id: "u" } },
      { text, values, user: { id: "u", attrs: { region: "" } } },
      { text, values, user: { id: "u", attrs: { region: " \u3000" } } },
      { text, values, user: { id: "u", attrs: { region: null } } },
      { text, values, user: { id: "" } },
      { text, values, user: { id: " \t" } },
      { text, values, user: null },
      { text, values },
      { text, values: { ...values, "user.region": "近畿" }, user: { id: "u", attrs: { region: "関東" } } },
      { text, values: { "USER.Region": "近畿", ...values }, user: { id: "u", attrs: { region: "関東" } } },
      { text, values: { ...values, "user.": "x" }, user: { id: "u", attrs: { region: "関東" } } },
      { text: "SELECT * FROM t WHERE o = :user.id", values: { "uſer.id": "x" }, user: { id: "u" } },
      { text: "SELECT * FROM t WHERE o = :user.id", values: { user_id: "x" }, user: { id: "u" } },
      { text: "SELECT * FROM t WHERE a = :user", values: { user: "x" }, rowLevel: true },
      { text: "SELECT * FROM t WHERE a = :user", values: { USER: "x" }, rowLevel: false },
      { text: "SELECT * FROM t WHERE a = :User", values: { User: "x" }, user: { id: "u" }, rowLevel: true },
      { text: "SELECT * FROM t WHERE a = :user_id", values: { user_id: "x" }, user: { id: "u" }, rowLevel: true },
      { text: "-- param: r text[]\nSELECT * FROM t WHERE r IN (:r) AND o = :user.id AND x IN (:user.id)", values: { r: ["a", "b"] }, user: { id: "u" } },
      { text: "SELECT * FROM t WHERE r = :user.地域 AND o = :user.id", values: {}, user: { id: "CORP\\鈴木", attrs: { 地域: "近畿" } } },
      { text: "SELECT * FROM t WHERE r = :user.id", values: {}, user: { id: "u", attrs: { region: "x" } }, rowLevel: true },
    ];
  })(),
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
  user: d.user ?? null,
  roles: d.roles ?? null,
  access: d.access ?? null,
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
      access: accessTexts.map((text) => {
        let lines;
        try {
          const l = accessLines(text, "api/x.sql");
          lines = { roles: l.roles ?? null, access: l.access ?? null };
        } catch (e) {
          lines = errorOf(e);
        }
        return { text, lines, signal: rowLevelSignal(text) ?? null };
      }),
      tableUsers: tableUsers.map(({ columns, row }) => {
        try {
          const t = tableUserOf(
            columns.map((c) => c.name),
            row ?? undefined,
          );
          return { columns, row, user: { attrs: Object.fromEntries(t.attrs), roles: t.roles } };
        } catch (e) {
          return { columns, row, user: errorOf(e) };
        }
      }),
      // the user as the host hands it over (viewerOf: the id trimmed, empty attributes as none)
      binds: binds.map(({ text, values, user, rowLevel }) => {
        const asked = { text, values, ...(user !== undefined ? { user } : {}), ...(rowLevel !== undefined ? { rowLevel } : {}) };
        try {
          const viewer = viewerOf(user);
          const { sql, params } = bindParameters(parseDataset("x", text, "mssql"), "mssql", values, { ...(viewer ? { user: viewer } : {}), rowLevel: rowLevel ?? false });
          return { ...asked, bound: { sql, values: params } };
        } catch (e) {
          return { ...asked, bound: errorOf(e) };
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
