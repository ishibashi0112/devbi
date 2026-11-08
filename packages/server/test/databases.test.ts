// SQL Server, MySQL and Oracle, each against a real database when its URL is set (CI's service containers):
//   DEVBI_TEST_MSSQL=mssql://sa:<password>@127.0.0.1:1433/master
//   DEVBI_TEST_MYSQL=mysql://root:<password>@127.0.0.1:3306/devbi
//   DEVBI_TEST_ORACLE=oracle://<user>:<password>@127.0.0.1:1521/FREEPDB1
// The tests create and drop tables there (orders, order_lines, customers, products, devbi_types): use a database
// kept for tests.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, createApiHandler, type ApiHandler, type Connection } from "../src/index.js";

const SAMPLE = path.resolve(import.meta.dirname, "../../../examples/sales");

/** Runs one statement as the test's administrator (not through DevBI's read-only connection). */
type Admin = { exec(sql: string): Promise<void>; insert(table: string, columns: string[], rows: unknown[][]): Promise<void>; close(): Promise<void> };

const literal = (v: unknown) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `N'${String(v).replace(/'/g, "''")}'`);

interface Case {
  name: string;
  url: string | undefined;
  admin(url: string): Promise<Admin>;
  /** Table devbi_types: id, d (a date), ts (a date and time), amount (a decimal), rate (a double), region (text), big (a bigint). */
  types: string[];
  /** Arrow types of devbi_types' columns, as DevBI sends them. */
  arrow: string[];
  /** Something that takes a few seconds. */
  slow: string;
  /** Column names as the database gives them for unquoted names. */
  upper?: boolean;
}

const drop = (exists: string) => [`DROP TABLE IF EXISTS order_lines`, `DROP TABLE IF EXISTS orders`, `DROP TABLE IF EXISTS customers`, `DROP TABLE IF EXISTS products`, `DROP TABLE IF EXISTS devbi_types`].map((s) => s.replace("IF EXISTS", exists));

const CASES: Case[] = [
  {
    name: "SQL Server",
    url: process.env.DEVBI_TEST_MSSQL,
    async admin(url) {
      const mssql = (await import("mssql")).default;
      const u = new URL(url);
      const pool = await new mssql.ConnectionPool({
        server: u.hostname,
        port: Number(u.port || 1433),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1) || undefined,
        options: { encrypt: false, trustServerCertificate: true },
      }).connect();
      return {
        exec: async (sql) => void (await pool.request().batch(sql)),
        async insert(table, columns, rows) {
          for (let i = 0; i < rows.length; i += 500) {
            const values = rows.slice(i, i + 500).map((r) => `(${r.map(literal).join(", ")})`);
            await pool.request().batch(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`);
          }
        },
        close: () => pool.close(),
      };
    },
    types: [
      ...drop("IF EXISTS"),
      `CREATE TABLE devbi_types (id BIGINT, d DATE, ts DATETIME2(3), amount DECIMAL(12,2), rate FLOAT, region NVARCHAR(20), big BIGINT,
         ok BIT, dto DATETIMEOFFSET, t TIME(0), g UNIQUEIDENTIFIER, bin VARBINARY(4))`,
      `INSERT INTO devbi_types VALUES
         (1, '2026-04-01', '2026-04-01 09:30:00.250', 1200.50, 0.5, N'関東', 9007199254740993, 1, '2026-04-01 09:30:00 +09:00', '09:30:00', 'C5B1AB40-2D3E-4F4E-9C5B-1B2B3C4D5E6F', 0x01020304),
         (2, '2026-04-02', NULL, 800, NULL, N'近畿', NULL, 0, NULL, NULL, NULL, NULL),
         (3, '2026-03-31', NULL, 1, NULL, N'九州', NULL, NULL, NULL, NULL, NULL, NULL)`,
    ],
    arrow: ["id:Int64", "d:Date32<DAY>", "ts:Timestamp<MICROSECOND>", "amount:Float64", "rate:Float64", "region:Utf8", "big:Int64", "ok:Bool", "dto:Timestamp<MICROSECOND>", "t:Utf8", "g:Utf8", "bin:Utf8"],
    slow: "WAITFOR DELAY '00:00:05'; SELECT 1 AS one",
  },
  {
    name: "MySQL",
    url: process.env.DEVBI_TEST_MYSQL,
    async admin(url) {
      const mysql = (await import("mysql2/promise")).default;
      const conn = await mysql.createConnection({ uri: url, multipleStatements: true, charset: "utf8mb4" });
      return {
        exec: async (sql) => void (await conn.query(sql)),
        async insert(table, columns, rows) {
          for (let i = 0; i < rows.length; i += 500) {
            await conn.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ?`, [rows.slice(i, i + 500)]);
          }
        },
        close: () => conn.end(),
      };
    },
    types: [
      ...drop("IF EXISTS"),
      `CREATE TABLE devbi_types (id BIGINT, d DATE, ts DATETIME(3), amount DECIMAL(12,2), rate DOUBLE, region VARCHAR(20), big BIGINT,
         ok BIT(1), flag BOOLEAN, j JSON, bin VARBINARY(4)) DEFAULT CHARSET = utf8mb4`,
      `INSERT INTO devbi_types VALUES
         (1, '2026-04-01', '2026-04-01 09:30:00.250', 1200.50, 0.5, '関東', 9007199254740993, b'1', TRUE, '{"a": 1}', 0x01020304),
         (2, '2026-04-02', NULL, 800, NULL, '近畿', NULL, b'0', FALSE, NULL, NULL),
         (3, '2026-03-31', NULL, 1, NULL, '九州', NULL, NULL, NULL, NULL, NULL)`,
    ],
    arrow: ["id:Int64", "d:Date32<DAY>", "ts:Timestamp<MICROSECOND>", "amount:Float64", "rate:Float64", "region:Utf8", "big:Int64", "ok:Bool", "flag:Int64", "j:Utf8", "bin:Utf8"],
    slow: "SELECT COUNT(*) AS n FROM information_schema.columns a, information_schema.columns b, information_schema.columns c",
  },
  {
    name: "Oracle",
    url: process.env.DEVBI_TEST_ORACLE,
    upper: true,
    async admin(url) {
      const oracledb = (await import("oracledb")).default;
      const u = new URL(url);
      const conn = await oracledb.getConnection({
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        connectString: `${u.hostname}:${u.port || 1521}${u.pathname}`,
      });
      return {
        async exec(sql) {
          try {
            await conn.execute(sql);
          } catch (e) {
            // ORA-00942: no such table (DROP TABLE before the first run)
            if (!/^DROP /.test(sql) || !/ORA-00942/.test((e as Error).message)) throw e;
          }
        },
        async insert(table, columns, rows) {
          await conn.executeMany(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `:${i + 1}`).join(", ")})`, rows as never);
          await conn.commit();
        },
        close: () => conn.close(),
      };
    },
    types: [
      ...drop(""),
      `CREATE TABLE devbi_types (id NUMBER(19), d DATE, ts TIMESTAMP(3), amount NUMBER(12,2), rate BINARY_DOUBLE, region NVARCHAR2(20), big NUMBER(19),
         cl CLOB, rw RAW(4))`,
      `INSERT INTO devbi_types VALUES (1, DATE '2026-04-01', TIMESTAMP '2026-04-01 09:30:00.250', 1200.50, 0.5, N'関東', 9007199254740993, 'long text', HEXTORAW('01020304'))`,
      `INSERT INTO devbi_types VALUES (2, DATE '2026-04-02', NULL, 800, NULL, N'近畿', NULL, NULL, NULL)`,
      `INSERT INTO devbi_types VALUES (3, DATE '2026-03-31', NULL, 1, NULL, N'九州', NULL, NULL, NULL)`,
      `COMMIT`,
    ],
    arrow: ["ID:Int64", "D:Date32<DAY>", "TS:Timestamp<MICROSECOND>", "AMOUNT:Float64", "RATE:Float64", "REGION:Utf8", "BIG:Int64", "CL:Utf8", "RW:Utf8"],
    slow: "SELECT COUNT(*) AS n FROM all_objects a, all_objects b, all_objects c",
  },
];

/** The sample's tables (db/sales.sqlite), the way examples/sales/api/*.sql read them. */
function sampleTables(): { table: string; ddl: string; columns: string[]; rows: unknown[][] }[] {
  const db = new DatabaseSync(path.join(SAMPLE, "db", "sales.sqlite"), { readOnly: true });
  try {
    const all = (sql: string) => (db.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r));
    return [
      { table: "customers", ddl: "id INTEGER PRIMARY KEY, name NVARCHAR(100) NOT NULL, region NVARCHAR(20) NOT NULL", columns: ["id", "name", "region"], rows: all("SELECT id, name, region FROM customers") },
      { table: "products", ddl: "id INTEGER PRIMARY KEY, category NVARCHAR(50) NOT NULL, name NVARCHAR(100) NOT NULL", columns: ["id", "category", "name"], rows: all("SELECT id, category, name FROM products") },
      { table: "orders", ddl: "order_no VARCHAR(20) PRIMARY KEY, order_date DATE NOT NULL, customer_id INTEGER NOT NULL", columns: ["order_no", "order_date", "customer_id"], rows: all("SELECT order_no, order_date, customer_id FROM orders") },
      {
        table: "order_lines",
        ddl: "order_no VARCHAR(20) NOT NULL, line_no INTEGER NOT NULL, product_id INTEGER NOT NULL, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL",
        columns: ["order_no", "line_no", "product_id", "qty", "unit_price"],
        rows: all("SELECT order_no, line_no, product_id, qty, unit_price FROM order_lines"),
      },
    ];
  } finally {
    db.close();
  }
}

for (const c of CASES) {
  describe.skipIf(!c.url)(c.name, () => {
    let admin: Admin;
    let conn: Connection;
    let api: ApiHandler;
    const name = (n: string) => (c.upper ? n.toUpperCase() : n);

    beforeAll(async () => {
      admin = await c.admin(c.url!);
      for (const sql of c.types) await admin.exec(sql);
      for (const t of sampleTables()) {
        const ddl = c.name === "Oracle" ? t.ddl.replace(/NVARCHAR\((\d+)\)/g, "NVARCHAR2($1)").replace(/VARCHAR\((\d+)\)/g, "VARCHAR2($1)") : t.ddl;
        await admin.exec(`CREATE TABLE ${t.table} (${ddl})`);
        // Oracle's DATE from text needs its format: as a Date at local midnight, the way the driver binds dates
        const rows = c.name === "Oracle" && t.table === "orders" ? t.rows.map((r) => [r[0], new Date(`${String(r[1])}T00:00:00`), r[2]]) : t.rows;
        await admin.insert(t.table, t.columns, rows);
      }
      conn = await connect(c.url!);
      const dir = mkdtempSync(path.join(tmpdir(), "devbi-db-"));
      mkdirSync(path.join(dir, "api"));
      for (const f of ["orders.sql", "sales_daily.sql"]) copyFileSync(path.join(SAMPLE, "api", f), path.join(dir, "api", f));
      writeFileSync(path.join(dir, "api", "types.sql"), "-- 型の確認\nSELECT * FROM devbi_types WHERE d >= :from AND region <> :skip AND (:from IS NOT NULL) ORDER BY id");
      writeFileSync(path.join(dir, "api", "text.sql"), "SELECT region, 'a:b ? @p1 ;' AS s FROM devbi_types WHERE id = :id");
      api = createApiHandler({ dir, env: { DEVBI_DB: c.url }, exposeErrors: true, maxRows: 2 });
    }, 120_000);
    afterAll(async () => {
      await api?.close();
      await conn?.close();
      await admin?.close();
    });

    it("reads each type as DevBI's: numbers, dates, wall-clock times, text", async () => {
      const { bytes } = await api.run("types", { from: "2026-04-01", skip: "九州" });
      const t = tableFromIPC(bytes);
      expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(c.arrow);
      const row = t.get(0)!.toJSON();
      expect(row[name("d")]).toBe(Date.UTC(2026, 3, 1));
      expect(row[name("ts")]).toBe(Date.UTC(2026, 3, 1, 9, 30, 0, 250));
      expect(row[name("amount")]).toBe(1200.5);
      expect(row[name("region")]).toBe("関東");
      expect(row[name("big")]).toBe(9007199254740993n);
      expect(t.numRows).toBe(2);
      expect(t.get(1)!.toJSON()[name("amount")]).toBe(800);
    });

    it("sends parameters as values, and leaves quoted text alone", async () => {
      const t = tableFromIPC((await api.run("text", { id: 2 })).bytes);
      expect(t.get(0)!.toJSON()).toEqual({ [name("region")]: "近畿", [name("s")]: "a:b ? @p1 ;" });
    });

    it("reads the sample's orders: the same total as the Excel", async () => {
      const big = createApiHandler({ dir: path.join(SAMPLE), env: { DEVBI_DB: c.url } });
      try {
        const lines = tableFromIPC((await big.run("orders", { from: "2024-04-01" })).bytes);
        expect(lines.numRows).toBe(6044);
        const amounts = lines.getChild("金額")!.toArray() as ArrayLike<number | bigint>;
        expect(Array.from(amounts, Number).reduce((a, b) => a + b, 0)).toBe(193161410);
        const daily = tableFromIPC((await big.run("sales_daily", { from: "2024-04-01" })).bytes);
        expect(daily.numRows).toBe(4014);
        expect(Array.from(daily.getChild("金額")!.toArray() as ArrayLike<number | bigint>, Number).reduce((a, b) => a + b, 0)).toBe(193161410);
        expect(String(lines.schema.fields.find((f) => f.name === "受注日")!.type)).toBe("Date32<DAY>");
      } finally {
        await big.close();
      }
    }, 60_000);

    it("stops at the row limit", async () => {
      await expect(api.run("types", { from: "2000-01-01", skip: "-" })).rejects.toMatchObject({ status: 422 });
      const r = await conn.query("SELECT id FROM devbi_types ORDER BY id", [], { maxRows: 2 });
      expect(r.rows).toEqual([[1], [2]]);
    });

    it("gives up after the time limit", async () => {
      const started = Date.now();
      await expect(conn.query(c.slow, [], { timeoutMs: 500 })).rejects.toThrow(/秒を過ぎたので止めました/);
      expect(Date.now() - started).toBeLessThan(4000);
      // and the connection still works
      expect((await conn.query("SELECT 1 AS one" + (c.name === "Oracle" ? " FROM dual" : ""), [])).rows).toEqual([[1]]);
    }, 20_000);

    it("cannot change anything, even when asked to directly", async () => {
      const before = (await conn.query("SELECT COUNT(*) AS n FROM devbi_types", [])).rows[0]![0];
      await conn.query("INSERT INTO devbi_types (id) VALUES (99)", []).catch(() => undefined);
      await conn.query("DELETE FROM devbi_types", []).catch(() => undefined);
      expect((await conn.query("SELECT COUNT(*) AS n FROM devbi_types", [])).rows[0]![0]).toBe(before);
    });

    it("refuses duplicate column names (node-oracledb names Oracle's second ID_1)", async () => {
      const twice = conn.query("SELECT id, id FROM devbi_types", []);
      if (c.name === "Oracle") expect((await twice).columns.map((col) => col.name)).toEqual(["ID", "ID_1"]);
      else await expect(twice).rejects.toThrow(/列名が重なっています/);
    });
  });
}
