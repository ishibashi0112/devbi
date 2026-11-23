import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindParameters, connectionOf, createApiHandler, isHostAllowed, parameters, parseDataset, readOnlyProblem, serve, toArrowTable, type ApiHandler, type RunningServer } from "../src/index.js";
import { SAMPLE_DB, typedParameterTests, writeTypedDatasets } from "./typed-cases.js";

describe("parameters", () => {
  it("finds :name outside quotes and comments, not casts", () => {
    const sql = "SELECT a::date, ':skip', \"col:x\" FROM t -- :nope\nWHERE d >= :from AND d < :to AND x = :from /* :no */";
    expect(parameters(sql, "postgres").map((p) => p.name)).toEqual(["from", "to", "from"]);
  });
  it("reads Japanese names", () => {
    expect(parameters("SELECT * FROM t WHERE 地域 = :地域", "sqlite").map((p) => p.name)).toEqual(["地域"]);
  });
});

describe("parseDataset", () => {
  it("takes the comments above as the description and the connection line", () => {
    const d = parseDataset("orders", "-- 受注の明細\n-- connection: erp\nSELECT * FROM orders WHERE d >= :from;\n");
    expect(d).toMatchObject({ name: "orders", description: "受注の明細", connection: "erp", params: ["from"] });
    expect(d.sql).toBe("SELECT * FROM orders WHERE d >= :from");
  });
  it("finds the connection line among the comments at the top, blank lines or not", () => {
    expect(parseDataset("x", "-- connection: erp\n\nSELECT 1").connection).toBe("erp");
    expect(connectionOf("-- 受注\n\n-- Connection: ERP\nSELECT 1")).toBe("ERP");
    expect(connectionOf("SELECT 1\n-- connection: erp")).toBeUndefined();
  });
  it("checks with the database's quoting rules", () => {
    expect(parseDataset("x", "SELECT id AS [update] FROM t", "sqlite").sql).toBe("SELECT id AS [update] FROM t");
    expect(parseDataset("x", "SELECT $$a;b$$ AS s", "postgres").params).toEqual([]);
  });
  it("refuses writes and several statements", () => {
    expect(() => parseDataset("x", "DELETE FROM orders")).toThrow(/SELECT か WITH/);
    expect(() => parseDataset("x", "SELECT 1; SELECT 2")).toThrow(/1 つだけ/);
    expect(() => parseDataset("x", "SELECT * INTO copy FROM orders")).toThrow(/INTO は使えません/);
    expect(() => parseDataset("x", "-- nothing")).toThrow(/SELECT 文がありません/);
    expect(readOnlyProblem("WITH a AS (SELECT 1) SELECT * FROM a", "postgres")).toBeUndefined();
  });
});

describe("bindParameters", () => {
  const d = parseDataset("orders", "SELECT * FROM t WHERE d >= :From AND d < :to OR d = :from");
  it("PostgreSQL: $n, the same name the same number, names without regard to case", () => {
    expect(bindParameters(d, "postgres", { from: "2025-04-01", TO: "2026-04-01" })).toEqual({
      sql: "SELECT * FROM t WHERE d >= $1 AND d < $2 OR d = $1",
      params: ["2025-04-01", "2026-04-01"],
    });
  });
  it("SQLite: ? in order, booleans as 1 / 0, whole numbers as integers", () => {
    const b = parseDataset("b", "SELECT * FROM t WHERE a = :x AND b = :y AND c = :x");
    expect(bindParameters(b, "sqlite", { x: true, y: null })).toEqual({ sql: "SELECT * FROM t WHERE a = ? AND b = ? AND c = ?", params: [1n, null, 1n] });
    expect(bindParameters(b, "sqlite", { x: 10, y: 1.5 }).params).toEqual([10n, 1.5, 10n]);
  });
  it("every parameter needs a value, and no others", () => {
    expect(() => bindParameters(d, "postgres", { from: "x" })).toThrow(/:to の値がありません/);
    expect(() => bindParameters(d, "postgres", { from: "x", to: "y", region: "関東" })).toThrow(/region はありません/);
    expect(() => bindParameters(d, "postgres", { from: "x", to: { a: 1 } })).toThrow(/文字・数値・真偽・null/);
  });
  it("names starting with user. are the signed-in user's: never from the request", () => {
    const u = parseDataset("u", "SELECT * FROM t WHERE r = :user");
    expect(() => bindParameters(u, "postgres", { "user.region": "関東", user: "x" })).toThrow(/user.region は渡せません/);
    expect(() => bindParameters(u, "postgres", { "USER.id": 1, user: "x" })).toThrow(/USER.id は渡せません/);
    // a parameter named user itself is fine (until a project uses row-level security)
    expect(bindParameters(u, "postgres", { user: "x" }).params).toEqual(["x"]);
  });
});

describe("-- param: and -- key:", () => {
  const text = [
    "-- 受注の明細",
    "-- param: from date label=受注日（から） default=month_start",
    "-- param: regions text[] label=\"地域 （複数）\" values=regions default=all",
    "--param:customer integer optional hidden",
    "-- key: 受注番号, \"行, 番号\"",
    "",
    "-- 説明の 2 行目",
    "-- param: status text default=\"受付 \"\"中\"\"\"",
    "SELECT * FROM t WHERE d >= :from AND r IN (:Regions) AND (:customer IS NULL OR c = :customer) AND s = :status AND x = :plain",
  ].join("\n");
  it("reads the lines at the top: types, labels, defaults, choices, flags, and the key", () => {
    const d = parseDataset("lines", text, "postgres");
    expect(d.description).toBe("説明の 2 行目");
    expect(d.params).toEqual(["from", "Regions", "customer", "status", "plain"]);
    expect(d.parameters).toEqual([
      { name: "from", type: "date", label: "受注日（から）", default: "month_start" },
      { name: "regions", type: "text", multiple: true, label: "地域 （複数）", default: "all", values: "regions" },
      { name: "customer", type: "integer", optional: true, hidden: true },
      { name: "status", type: "text", default: '受付 "中"' },
      { name: "plain" },
    ]);
    expect(d.key).toEqual(["受注番号", "行, 番号"]);
  });
  it("says which line is wrong, and what", () => {
    const err = (head: string, sql = "SELECT * FROM t WHERE d = :d AND r IN (:r)") => {
      try {
        parseDataset("x", `-- 説明\n${head}\n${sql}`);
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    expect(err("-- param: d")).toBe("api/x.sql（2 行目）: パラメーター d の型がありません。text・integer・number・date・datetime・boolean のどれかを書いてください（複数の値は text[] のように）");
    expect(err("-- param:")).toMatch(/2 行目）: -- param: のあとにパラメーターの名前と型/);
    expect(err("-- param: d day")).toMatch(/型 day は使えません/);
    expect(err("-- param: nope date")).toBe("api/x.sql（2 行目）: パラメーター nope は SQL にありません（SQL に :nope と書くか、この行を消してください）");
    expect(err("-- param: d date\n-- param: D date")).toBe("api/x.sql（3 行目）: パラメーター D の -- param: が 2 つあります（2 行目にも）");
    expect(err("-- param: d date colour=red")).toMatch(/colour は知らない指定です。label・default・values・optional・hidden を書けます/);
    expect(err("-- param: d date label")).toMatch(/label には値を書いてください/);
    expect(err("-- param: d date optional=yes")).toMatch(/optional は値を付けずに書きます/);
    expect(err("-- param: d date label=a label=b")).toMatch(/label が 2 回あります/);
    expect(err('-- param: d date label="a')).toMatch(/" が閉じていません/);
    expect(err("-- param: r text[] optional")).toMatch(/複数の値（text\[\]）には optional を付けられません/);
    expect(err("-- param: user.region text")).toMatch(/user. で始まる名前は、ログインした人の値のために取ってあるので使えません/);
    expect(err("-- param: d integer default=1.5")).toMatch(/default=1.5 は integer の値として読めません/);
    expect(err("-- param: d date default=2024-02-30")).toMatch(/default=2024-02-30 は date の値として読めません/);
    expect(err("-- param: d date default=today+")).toMatch(/default=today\+ は date の値として読めません/);
    expect(err("-- param: r integer[] default=1,,2")).toMatch(/空の値があります/);
    expect(err("-- param: r integer[] default=all")).toMatch(/default の all は integer\[\] の値として読めません/);
    expect(err("-- param: d boolean default=yes")).toMatch(/default=yes は boolean の値として読めません/);
    expect(err("-- param: d date values=../x")).toMatch(/values には候補を出すデータセットの名前/);
    expect(err("-- key:")).toMatch(/-- key: のあとに、行を見分ける列の名前/);
    expect(err("-- key: a, a")).toMatch(/列 a が 2 回あります/);
    expect(err("-- key: a\n-- key: b")).toMatch(/3 行目）: -- key: が 2 つあります（2 行目にも）/);
    expect(err('-- key: "a" b')).toMatch(/"a" のあとは , で区切ります/);
    // a multiple-value parameter only as IN (:x)
    expect(err("-- param: r text[]", "SELECT * FROM t\nWHERE d = :d\n  AND r = :r")).toBe("api/x.sql（5 行目）: :r は複数の値（text[]）なので、IN (:r) の形でだけ使えます");
    expect(err("-- param: r text[]", "SELECT * FROM t WHERE d = :d AND r IN (:r, 'x')")).toMatch(/IN \(:r\) の形でだけ/);
    expect(err("-- param: r text[]", "SELECT * FROM t WHERE d = :d AND rIN (:r)")).toMatch(/IN \(:r\) の形でだけ/);
    expect(err("-- param: r text[]", "SELECT * FROM t WHERE d = :d AND r NOT IN(\n  :r\n)")).toBe("no error");
  });
  it("accepts the defaults the browser reads", () => {
    const ok = (head: string) => parseDataset("x", `${head}\nSELECT * FROM t WHERE a = :a`).parameters[0];
    expect(ok("-- param: a date default=today-30")).toMatchObject({ default: "today-30" });
    expect(ok("-- param: a datetime default=2024-04-01T09:00")).toMatchObject({ default: "2024-04-01T09:00" });
    expect(ok("-- param: a text default=all")).toMatchObject({ default: "all" });
    expect(ok('-- param: a text default=""')).toMatchObject({ default: "" });
    expect(ok("-- param: a number default=-1.5e3")).toMatchObject({ default: "-1.5e3" });
    expect(ok("-- param: a boolean default=false")).toMatchObject({ default: "false" });
    expect(ok("-- param: a  text   label=名前")).toMatchObject({ label: "名前" });
  });
  it("only the comment lines at the top count, as for -- connection:, and one further down is an error", () => {
    expect(parseDataset("x", "-- param: a date\n\n\n-- 説明\nSELECT * FROM t WHERE a = :a").parameters).toEqual([{ name: "a", type: "date" }]);
    const late = "は、ファイルの先頭から続く -- のコメントの中に書いてください（SQL や /* */ よりあとの行は読みません）";
    expect(() => parseDataset("x", "SELECT * FROM t WHERE a = :a\n-- param: a date")).toThrow(`api/x.sql（2 行目）: -- param: ${late}`);
    expect(() => parseDataset("x", "/* 受注 */\n-- param: a date\nSELECT * FROM t WHERE a = :a")).toThrow(`api/x.sql（2 行目）: -- param: ${late}`);
    expect(() => parseDataset("x", "-- 説明\nSELECT * FROM t\n  -- KEY : id\nWHERE a = :a")).toThrow(`api/x.sql（3 行目）: -- key: ${late}`);
    // not a line of its own, or not param / key
    expect(parseDataset("x", "SELECT * FROM t WHERE a = :a -- param: a date\n-- keys: a").parameters).toEqual([{ name: "a" }]);
  });
});

describe("bindParameters with -- param: types", () => {
  const typed = parseDataset(
    "typed",
    [
      "-- param: from date",
      "-- param: at datetime optional",
      "-- param: n integer",
      "-- param: r number",
      "-- param: ok boolean",
      "-- param: s text",
      "-- param: regions text[]",
      "SELECT * FROM t WHERE d >= :from AND t < :at AND n = :n AND r = :r AND ok = :ok AND s = :s AND x IN (:regions) AND d < :from",
    ].join("\n"),
  );
  const values = { from: "2024-04-01", at: "2024-04-01T09:00", n: 10, r: 1.5, ok: true, s: "関東", regions: ["関東", "近畿"] };
  it("PostgreSQL: every typed value cast, several values one placeholder each", () => {
    expect(bindParameters(typed, "postgres", values)).toEqual({
      sql:
        "SELECT * FROM t WHERE d >= CAST($1 AS date) AND t < CAST($2 AS timestamp) AND n = CAST($3 AS bigint) AND r = CAST($4 AS numeric) AND ok = CAST($5 AS boolean)" +
        " AND s = CAST($6 AS text) AND x IN (CAST($7 AS text), CAST($8 AS text)) AND d < CAST($1 AS date)",
      params: ["2024-04-01", "2024-04-01 09:00:00", 10, 1.5, true, "関東", "関東", "近畿"],
    });
  });
  it("SQL Server, Oracle, MySQL: dates and times read in ISO form; SQLite: as text", () => {
    expect(bindParameters(typed, "mssql", values).sql).toBe(
      "SELECT * FROM t WHERE d >= CAST(@p1 AS date) AND t < CAST(@p2 AS datetime2) AND n = @p3 AND r = @p4 AND ok = @p5 AND s = @p6 AND x IN (@p7, @p8) AND d < CAST(@p1 AS date)",
    );
    expect(bindParameters(typed, "oracle", values).sql).toBe(
      "SELECT * FROM t WHERE d >= TO_DATE(:p1, 'YYYY-MM-DD') AND t < TO_DATE(:p2, 'YYYY-MM-DD HH24:MI:SS') AND n = :p3 AND r = :p4 AND ok = :p5 AND s = :p6 AND x IN (:p7, :p8) AND d < TO_DATE(:p1, 'YYYY-MM-DD')",
    );
    expect(bindParameters(typed, "oracle", { ...values, at: "2024-04-01 09:00:00.25" }).sql).toContain("TO_TIMESTAMP(:p2, 'YYYY-MM-DD HH24:MI:SS.FF')");
    const mysql = bindParameters(typed, "mysql", values);
    expect(mysql.sql).toBe("SELECT * FROM t WHERE d >= CAST(? AS DATE) AND t < CAST(? AS DATETIME(6)) AND n = ? AND r = ? AND ok = ? AND s = ? AND x IN (?, ?) AND d < CAST(? AS DATE)");
    expect(mysql.params).toEqual(["2024-04-01", "2024-04-01 09:00:00", 10, 1.5, true, "関東", "関東", "近畿", "2024-04-01"]);
    const sqlite = bindParameters(typed, "sqlite", values);
    expect(sqlite.sql).toBe("SELECT * FROM t WHERE d >= ? AND t < ? AND n = ? AND r = ? AND ok = ? AND s = ? AND x IN (?, ?) AND d < ?");
    expect(sqlite.params).toEqual(["2024-04-01", "2024-04-01 09:00:00", 10n, 1.5, 1n, "関東", "関東", "近畿", "2024-04-01"]);
  });
  it("checks each value against its type", () => {
    const bad = (patch: Record<string, unknown>) => {
      try {
        bindParameters(typed, "postgres", { ...values, ...patch });
      } catch (e) {
        expect((e as { status?: number }).status).toBe(400);
        return (e as Error).message;
      }
      return "no error";
    };
    expect(bad({ from: "2024-02-30" })).toBe(`api/typed.sql: パラメーター from には日付（'2024-04-01' の形の文字）を渡してください（"2024-02-30" が来ました）`);
    expect(bad({ from: 20240401 })).toMatch(/from には日付/);
    expect(bad({ from: null })).toBe("api/typed.sql: パラメーター from の値がありません（null にできるのは -- param: に optional を付けたパラメーターだけです）");
    expect(bad({ at: null })).toBe("no error");
    expect(bad({ at: "2024-04-01T24:00" })).toMatch(/at には日時/);
    expect(bad({ at: "2024-04-01T09:00Z" })).toMatch(/at には日時/);
    expect(bad({ at: "2024-04-01" })).toBe("no error");
    expect(bad({ n: 1.5 })).toMatch(/n には整数を渡してください（1.5 が来ました）/);
    expect(bad({ n: "10" })).toMatch(/n には整数/);
    expect(bad({ n: 2 ** 60 })).toMatch(/n には整数/);
    expect(bad({ r: "1.5" })).toMatch(/r には数値/);
    expect(bad({ ok: 1 })).toMatch(/ok には真偽（true か false）を渡してください/);
    expect(bad({ s: 1 })).toMatch(/s には文字/);
    expect(bad({ s: "x".repeat(4001) })).toBe("api/typed.sql: パラメーター s の文字が長すぎます（4,000 文字まで）");
    expect(bad({ s: ["a"] })).toMatch(/s は 1 つの値です（複数の値にするには -- param: の型を text\[\] にします）/);
    expect(bad({ regions: [] })).toBe("api/typed.sql: パラメーター regions に 1 つ以上の値を渡してください");
    expect(bad({ regions: null })).toMatch(/regions に 1 つ以上の値/);
    expect(bad({ regions: ["a", null] })).toMatch(/regions の値に null は入れられません/);
    expect(bad({ regions: ["a", 1] })).toMatch(/regions には文字/);
    expect(bad({ regions: "関東" })).toBe("no error");
    expect(bad({ regions: Array.from({ length: 1001 }, (_, i) => String(i)) })).toMatch(/regions の値が 1,001 個あります。1 つのパラメーターに渡せるのは 1,000 個までです/);
  });
  it("2,000 placeholders at most in one statement (MySQL and SQLite count each place)", () => {
    const twice = parseDataset("twice", "-- param: ids integer[]\nSELECT * FROM t WHERE a IN (:ids) OR b IN (:ids) OR c IN (:ids)");
    const ids = Array.from({ length: 700 }, (_, i) => i);
    expect(bindParameters(twice, "postgres", { ids }).params).toHaveLength(700);
    expect(() => bindParameters(twice, "mysql", { ids })).toThrow(/全部で 2,100 個になります。1 つの SQL に渡せるのは 2,000 個までです/);
  });
});

describe("typed parameters on SQLite", () => {
  let api: ApiHandler;
  beforeAll(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-typed-"));
    writeTypedDatasets(dir, "sqlite");
    api = createApiHandler({ dir, env: { DEVBI_DB: `sqlite:${SAMPLE_DB}` }, exposeErrors: true });
  });
  afterAll(async () => {
    await api?.close();
  });
  typedParameterTests(() => api, "sqlite");
});

describe("toArrowTable", () => {
  it("keeps types: integers, decimals, booleans, dates, timestamps (as UTC wall-clock), text", () => {
    const t = toArrowTable({
      columns: [
        { name: "i", type: "int" },
        { name: "f", type: "float" },
        { name: "b", type: "bool" },
        { name: "d", type: "date" },
        { name: "ts", type: "timestamp" },
        { name: "s", type: "string" },
      ],
      rows: [
        [1, 1.5, true, "2026-04-01", "2026-04-01 09:30:00", "関東"],
        [9007199254740993n, null, false, null, "2026-04-01 09:30:00.250", null],
      ],
    });
    expect(t.numRows).toBe(2);
    expect(t.getChild("i")!.get(1)).toBe(9007199254740993n);
    expect(t.getChild("d")!.get(0)).toBe(Date.UTC(2026, 3, 1));
    expect(t.getChild("ts")!.get(1)).toBe(Date.UTC(2026, 3, 1, 9, 30, 0, 250));
    expect(t.getChild("s")!.get(0)).toBe("関東");
    expect(t.getChild("f")!.get(1)).toBeNull();
    expect(String(t.schema.fields[4]!.type)).toBe("Timestamp<MICROSECOND>");
  });
  it("reads years 1 to 99 as they are (.NET's DateTime.MinValue is 0001-01-01), and before 1970", () => {
    const t = toArrowTable({
      columns: [
        { name: "d", type: "date" },
        { name: "ts", type: "timestamp" },
      ],
      rows: [
        ["0001-01-01", "0050-03-01 10:00:00.500"],
        ["1969-12-31", "1969-12-31 23:59:59.999"],
      ],
    });
    const at = (y: number, ...rest: number[]) => {
      const d = new Date(0);
      d.setUTCFullYear(y, rest[0] ?? 0, rest[1] ?? 1);
      return d.setUTCHours(rest[2] ?? 0, rest[3] ?? 0, rest[4] ?? 0, rest[5] ?? 0);
    };
    expect(t.getChild("d")!.get(0)).toBe(at(1));
    expect(t.getChild("ts")!.get(0)).toBe(at(50, 2, 1, 10, 0, 0, 500));
    expect(new Date(t.getChild("d")!.get(0) as number).toISOString()).toBe("0001-01-01T00:00:00.000Z");
    expect(t.getChild("d")!.get(1)).toBe(Date.UTC(1969, 11, 31));
    expect(t.getChild("ts")!.get(1)).toBe(Date.UTC(1969, 11, 31, 23, 59, 59, 999));
  });
  it("keeps the SELECT's column order, whatever the names", () => {
    const t = toArrowTable({
      columns: [
        { name: "region", type: "string" },
        { name: "2024", type: "int" },
        { name: "__proto__", type: "string" },
      ],
      rows: [["関東", 1, "x"]],
    });
    expect(t.schema.fields.map((f) => f.name)).toEqual(["region", "2024", "__proto__"]);
    expect(t.numRows).toBe(1);
    expect(t.getChild("__proto__")!.get(0)).toBe("x");
    expect(toArrowTable({ columns: [{ name: "a", type: "int" }], rows: [] }).schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["a:Int64"]);
  });
  it("sends whole numbers past BIGINT as doubles, not wrapped around", () => {
    const t = toArrowTable({ columns: [{ name: "big", type: "int" }, { name: "edge", type: "int" }], rows: [[18446744073709551615n, 9223372036854775807n], [1, -9223372036854775808n]] });
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["big:Float64", "edge:Int64"]);
    expect(t.getChild("big")!.get(0)).toBe(18446744073709551615);
    expect(t.getChild("edge")!.get(1)).toBe(-9223372036854775808n);
  });
});

describe("isHostAllowed", () => {
  it("IP addresses, localhost and the allowed names; others are refused", () => {
    expect(isHostAllowed("127.0.0.1:8080")).toBe(true);
    expect(isHostAllowed("[::1]:8080")).toBe(true);
    expect(isHostAllowed("192.168.1.20")).toBe(true);
    expect(isHostAllowed("localhost:4179")).toBe(true);
    expect(isHostAllowed("attacker.example:8080")).toBe(false);
    expect(isHostAllowed("reports.corp.local", ["reports.corp.local"])).toBe(true);
    expect(isHostAllowed("a.corp.local", [".corp.local"])).toBe(true);
    expect(isHostAllowed("corp.local.evil", [".corp.local"])).toBe(false);
    expect(isHostAllowed("pc-01:8080", [], "pc-01")).toBe(true);
    expect(isHostAllowed("anything", true)).toBe(true);
  });
});

describe("devbi-serve (SQLite)", () => {
  let dir: string;
  let running: RunningServer;
  const logs: string[] = [];
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    fetch(new URL("api/query", running.url), { method: "POST", headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "devbi-serve-"));
    mkdirSync(path.join(dir, "api"));
    mkdirSync(path.join(dir, "dist", "assets"), { recursive: true });
    mkdirSync(path.join(dir, "db"));
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, order_date DATE, region TEXT, amount REAL, qty INTEGER);
      INSERT INTO orders VALUES (1, '2026-04-01', '関東', 1200.5, 3), (2, '2026-04-02', '近畿', 800, 1), (3, '2026-05-01', '関東', 300, 2);
      CREATE TABLE events (id INTEGER, at DATETIME, code TEXT, disc INTEGER, rate REAL, done BOOLEAN);
      INSERT INTO events VALUES (1, '2026-04-01T10:00:00.000Z', '10', NULL, NULL, 1), (2, '2026-04-02 09:30:00+09:00', '20', NULL, NULL, 0);`);
    db.close();
    writeFileSync(path.join(dir, "api", "orders.sql"), "-- 受注\nSELECT order_date, region, amount, qty FROM orders WHERE order_date >= :from\n");
    writeFileSync(path.join(dir, "api", "everything.sql"), "SELECT * FROM orders");
    writeFileSync(path.join(dir, "api", "broken.sql"), "SELECT nope FROM orders");
    writeFileSync(path.join(dir, "api", "writes.sql"), "DELETE FROM orders");
    writeFileSync(path.join(dir, "api", "erp.sql"), "-- connection: erp\n\nSELECT 1 AS one");
    writeFileSync(path.join(dir, "api", "events.sql"), "SELECT id AS [update], at, code, disc, rate, done FROM events WHERE code = :code OR :all = 1");
    writeFileSync(path.join(dir, "api", "computed.sql"), "SELECT region, qty * 2 AS twice, NULL AS blank FROM orders WHERE order_date >= :from");
    writeFileSync(path.join(dir, "api", "twice.sql"), "SELECT o.id, e.id FROM orders o JOIN events e ON e.id = o.id");
    writeFileSync(
      path.join(dir, "api", "typed.sql"),
      "-- 地域で絞る\n-- param: regions text[] label=地域 values=regions_list\n-- param: from date optional\n-- key: id\nSELECT id, region FROM orders WHERE region IN (:regions) AND (:from IS NULL OR order_date >= :from)\n",
    );
    writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(path.join(dir, "dist", "data.csv"), "a,b\n1,2\n3,4\n");
    writeFileSync(path.join(dir, "dist", "assets", "index-AbCdEf12.js"), "console.log(1)");
    running = await serve({ dir, port: 0, env: { DEVBI_DB: "sqlite:db/shop.sqlite" }, maxRows: 2, log: (l) => logs.push(l) });
  });
  afterAll(async () => {
    await running?.close();
  });

  it("schema lists the SQL files with their parameters", async () => {
    const res = await fetch(new URL("api/schema", running.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { datasets: { name: string; params?: string[]; error?: string; connection?: string }[] };
    expect(body.datasets.find((d) => d.name === "orders")).toMatchObject({ description: "受注", params: ["from"], connection: "DEVBI_DB" });
    expect(body.datasets.find((d) => d.name === "erp")).toMatchObject({ connection: "DEVBI_DB_ERP" });
    expect(body.datasets.find((d) => d.name === "writes")?.error).toMatch(/SELECT か WITH/);
    expect(body.datasets.find((d) => d.name === "orders")).toMatchObject({ parameters: [{ name: "from" }] });
    expect(body.datasets.find((d) => d.name === "orders")).not.toHaveProperty("key");
    expect(body.datasets.find((d) => d.name === "typed")).toEqual({
      name: "typed",
      description: "地域で絞る",
      params: ["regions", "from"],
      parameters: [
        { name: "regions", type: "text", multiple: true, label: "地域", values: "regions_list" },
        { name: "from", type: "date", optional: true },
      ],
      key: ["id"],
      connection: "DEVBI_DB",
    });
  });

  it("query takes several values for a text[] parameter, checks types, and refuses user. names", async () => {
    const res = await post({ name: "typed", params: { regions: ["関東", "九州"], from: null } });
    expect(res.status).toBe(200);
    expect(tableFromIPC(new Uint8Array(await res.arrayBuffer())).numRows).toBe(2);
    const bad = await post({ name: "typed", params: { regions: ["関東"], from: "4/1" } });
    expect([bad.status, ((await bad.json()) as { error: string }).error]).toEqual([400, `api/typed.sql: パラメーター from には日付（'2024-04-01' の形の文字）を渡してください（"4/1" が来ました）`]);
    const user = await post({ name: "typed", params: { regions: ["関東"], from: null, "user.region": "関東" } });
    expect([user.status, ((await user.json()) as { error: string }).error]).toEqual([400, "api/typed.sql: パラメーター user.region は渡せません（user. で始まる名前は、ログインした人の値のために取ってあります）"]);
  });

  it("query returns Arrow with dates as dates", async () => {
    const res = await post({ name: "orders", params: { from: "2026-04-02" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apache.arrow.stream");
    const t = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(t.numRows).toBe(2);
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["order_date:Date32<DAY>", "region:Utf8", "amount:Float64", "qty:Int64"]);
    expect(t.getChild("order_date")!.get(0)).toBe(Date.UTC(2026, 3, 2));
  });

  it("an empty result keeps its columns and their declared types", async () => {
    const t = tableFromIPC(new Uint8Array(await (await post({ name: "orders", params: { from: "2099-01-01" } })).arrayBuffer()));
    expect(t.numRows).toBe(0);
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["order_date:Date32<DAY>", "region:Utf8", "amount:Float64", "qty:Int64"]);
  });

  it("describe: the columns from the database without rows, only when asked for (the dev server)", async () => {
    // devbi-serve does not answer it: the path is the site's (files, GET only)
    const off = await fetch(new URL("api/describe", running.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "orders" }) });
    expect(off.status).toBe(405);
    expect(await createApiHandler({ dir }).fetch(new Request("http://x/api/describe", { method: "POST" }))).toBeUndefined();
    // as the dev server makes it: the database's messages as they are
    const api = createApiHandler({ dir, env: { DEVBI_DB: "sqlite:db/shop.sqlite" }, describe: true, exposeErrors: true });
    try {
      // declared types; an expression's only from its values; typed parameters get values that pass their checks
      expect(await api.describe("orders")).toEqual({
        name: "orders",
        columns: [
          { name: "order_date", type: "date", dbType: "DATE" },
          { name: "region", type: "string", dbType: "TEXT" },
          { name: "amount", type: "float", dbType: "REAL" },
          { name: "qty", type: "int", dbType: "INTEGER" },
        ],
      });
      expect((await api.describe("computed")).columns).toEqual([{ name: "region", type: "string", dbType: "TEXT" }, { name: "twice" }, { name: "blank" }]);
      expect((await api.describe("typed")).columns.map((c) => c.name)).toEqual(["id", "region"]);
      await expect(api.describe("twice")).rejects.toThrow(/列名が重なっています: id/);
      await expect(api.describe("nope")).rejects.toMatchObject({ status: 404 });
      const asked = await api.fetch(new Request("http://x/api/describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "broken" }) }));
      expect(asked?.status).toBe(500);
      const missing = await api.fetch(new Request("http://x/api/describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
      expect([missing?.status, await missing?.json()]).toEqual([400, { error: "name（api/ の SQL ファイルの名前）がありません" }]);
      expect((await api.fetch(new Request("http://x/api/describe")))?.status).toBe(405);
    } finally {
      await api.close();
    }
  });

  it("SQLite: an expression with no values to go by is DuckDB's NULL type", async () => {
    const types = async (from: string) => {
      const res = await post({ name: "computed", params: { from } });
      expect(res.status).toBe(200);
      return tableFromIPC(new Uint8Array(await res.arrayBuffer())).schema.fields.map((f) => `${f.name}:${f.type}`);
    };
    expect(await types("2099-01-01")).toEqual(["region:Utf8", "twice:Null", "blank:Null"]);
    expect(await types("2026-05-01")).toEqual(["region:Utf8", "twice:Int64", "blank:Null"]);
  });

  it("SQLite: date-times with a time zone, all-NULL columns, BOOLEAN, [quoted] names, whole-number parameters", async () => {
    const res = await post({ name: "events", params: { code: 10, all: 1 } });
    expect(res.status).toBe(200);
    const t = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      "update:Int64",
      "at:Timestamp<MICROSECOND>",
      "code:Utf8",
      "disc:Int64",
      "rate:Float64",
      "done:Bool",
    ]);
    // The time as written, without moving it by the time zone (like PostgreSQL's timestamptz in the session's zone).
    expect([0, 1].map((i) => t.getChild("at")!.get(i))).toEqual([Date.UTC(2026, 3, 1, 10), Date.UTC(2026, 3, 2, 9, 30)]);
    expect(t.getChild("done")!.toJSON()).toEqual([true, false]);
    // code is TEXT: the number 10 finds '10', as `code = 10` in the SQL would.
    const one = tableFromIPC(new Uint8Array(await (await post({ name: "events", params: { code: 10, all: 0 } })).arrayBuffer()));
    expect(one.numRows).toBe(1);
  });

  it("explains what is wrong, in Japanese, with a status", async () => {
    const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error] as const;
    expect(await error(await post({ name: "nope" }))).toEqual([404, "API の SQL nope はありません（api/nope.sql）"]);
    expect((await error(await post({ name: "orders" })))[1]).toMatch(/:from の値がありません/);
    expect((await error(await post({ name: "writes" })))[0]).toBe(400);
    expect(await error(await post({ name: "everything" }))).toEqual([422, "api/everything.sql の結果が 2 行を超えました。SQL の WHERE で絞ってください"]);
    expect(await error(await post({ name: "erp" }))).toEqual([500, "接続先がありません。環境変数 DEVBI_DB_ERP に接続先の URL を書いてください"]);
    // Database errors stay in the log unless exposeErrors is on.
    expect((await error(await post({ name: "broken" })))[1]).toBe("api/broken.sql を実行できませんでした（くわしくはサーバーのログにあります）");
    expect(logs.some((l) => l.includes("列名が重なっています: id"))).toBe(false);
    await post({ name: "twice" });
    expect(logs.some((l) => l.includes("列名が重なっています: id"))).toBe(true);
    expect((await error(await post({ name: "orders", params: { from: "x" } }, { "Content-Type": "text/plain" })))[0]).toBe(415);
    expect((await fetch(new URL("api/query", running.url))).status).toBe(405);
  });

  it("serves the built site, with byte ranges and long caching for hashed assets", async () => {
    const index = await fetch(running.url);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(new URL("assets/index-AbCdEf12.js", running.url));
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const part = await fetch(new URL("data.csv", running.url), { headers: { Range: "bytes=4-6" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 4-6/12");
    expect(await part.text()).toBe("1,2");
    // A range that ends before it starts is ignored: the whole file.
    expect((await fetch(new URL("data.csv", running.url), { headers: { Range: "bytes=5-2" } })).status).toBe(200);
    expect((await fetch(new URL("missing.js", running.url))).status).toBe(404);
    // The API under a base path (behind a reverse proxy at /reports/).
    expect((await fetch(new URL("reports/api/schema", running.url))).status).toBe(200);
  });

  it("refuses host names it does not know (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL("api/schema", running.url);
        request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on("error", reject)
          .end();
      });
    expect(await status("attacker.example:8080")).toBe(403);
    expect(await status(`localhost:${new URL(running.url).port}`)).toBe(200);
  });

  it("does not serve files outside the site", async () => {
    const res = await fetch(new URL("/..%2f..%2fdb%2fshop.sqlite", running.url));
    expect(res.status).toBe(404);
  });
});
