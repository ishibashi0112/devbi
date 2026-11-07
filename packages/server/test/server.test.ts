import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindParameters, connectionOf, isHostAllowed, parameters, parseDataset, readOnlyProblem, serve, toArrowTable, type RunningServer } from "../src/index.js";

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
