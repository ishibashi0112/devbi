import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, createApiHandler, type ApiHandler, type Connection } from "../src/index.js";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { SAMPLE_DB, typedParameterTests, userFilterTests, writeTypedDatasets } from "./typed-cases.js";

// A PostgreSQL to write test tables into, e.g. postgres://postgres@127.0.0.1:5432/postgres (CI's service container).
const url = process.env.DEVBI_TEST_PG;

describe.skipIf(!url)("PostgreSQL", () => {
  let admin: Connection;
  let server: Server;
  let api: ApiHandler;
  let base = "";
  const pg = async () => (await import("pg")).default;

  beforeAll(async () => {
    const { Client } = await pg();
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS devbi_test CASCADE; CREATE SCHEMA devbi_test;
      CREATE TABLE devbi_test.orders (id bigint, order_date date, created timestamp, created_tz timestamptz, amount numeric(12,2),
        rate double precision, ok boolean, region text, extra jsonb, big bigint);
      INSERT INTO devbi_test.orders VALUES
        (1, '2026-04-01', '2026-04-01 09:30:00.25', '2026-04-01 09:30:00+09', 1200.50, 0.5, true, '関東', '{"a":1}', 9007199254740993),
        (2, '2026-04-02', NULL, NULL, 800, NULL, false, '近畿', NULL, NULL);`);
    // The sample's customers and orders, for the typed parameters (typed-cases.ts).
    await client.query(`DROP SCHEMA IF EXISTS devbi_sample CASCADE; CREATE SCHEMA devbi_sample;
      CREATE TABLE devbi_sample.customers (id integer, name text, region text);
      CREATE TABLE devbi_sample.orders (order_no text, order_date date, customer_id integer);`);
    const sample = new DatabaseSync(SAMPLE_DB, { readOnly: true });
    try {
      for (const [table, sql] of [["customers", "SELECT id, name, region FROM customers"], ["orders", "SELECT order_no, order_date, customer_id FROM orders"]] as const) {
        const rows = (sample.prepare(sql).all() as Record<string, unknown>[]).map((r) => Object.values(r));
        const width = rows[0]!.length;
        const values = rows.map((_, i) => `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(", ")})`).join(", ");
        await client.query(`INSERT INTO devbi_sample.${table} VALUES ${values}`, rows.flat());
      }
    } finally {
      sample.close();
    }
    await client.end();
    admin = await connect(url!);

    const dir = mkdtempSync(path.join(tmpdir(), "devbi-pg-"));
    mkdirSync(path.join(dir, "api"));
    writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT * FROM devbi_test.orders WHERE order_date >= :from::date AND region <> :skip ORDER BY id");
    writeFileSync(path.join(dir, "api", "dollar.sql"), "SELECT $$a;b$$ AS s");
    writeTypedDatasets(dir, "postgres", "devbi_sample.");
    api = createApiHandler({ dir, env: { DEVBI_DB: url }, exposeErrors: true });
    server = createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
  });
  afterAll(async () => {
    server?.close();
    await api?.close();
    await admin?.close();
  });

  it("reads each type as DevBI's: numbers, dates, wall-clock timestamps, text", async () => {
    const res = await fetch(new URL("api/query", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "orders", params: { from: "2026-04-01", skip: "九州" } }),
    });
    expect(res.status).toBe(200);
    const t = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      "id:Int64",
      "order_date:Date32<DAY>",
      "created:Timestamp<MICROSECOND>",
      "created_tz:Timestamp<MICROSECOND>",
      "amount:Float64",
      "rate:Float64",
      "ok:Bool",
      "region:Utf8",
      "extra:Utf8",
      "big:Int64",
    ]);
    const row = t.get(0)!.toJSON();
    expect(row.order_date).toBe(Date.UTC(2026, 3, 1));
    expect(row.created).toBe(Date.UTC(2026, 3, 1, 9, 30, 0, 250));
    expect(row.amount).toBe(1200.5);
    expect(row.ok).toBe(true);
    expect(row.extra).toBe('{"a": 1}');
    expect(row.big).toBe(9007199254740993n);
  });

  typedParameterTests(() => api);
  userFilterTests((d) => createApiHandler({ dir: d, env: { DEVBI_DB: url }, exposeErrors: true }), "devbi_sample.");

  it("reads $$ … $$ text with PostgreSQL's rules", async () => {
    const res = await fetch(new URL("api/query", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "dollar" }) });
    expect(res.status).toBe(200);
    expect(tableFromIPC(new Uint8Array(await res.arrayBuffer())).getChild("s")!.get(0)).toBe("a;b");
  });

  it("reads dates whatever the DateStyle", async () => {
    const c = await connect(`${url}${url!.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c DateStyle=SQL,DMY")}`);
    try {
      const r = await c.query("SELECT DATE '2026-04-01' AS d, TIMESTAMP '2026-04-01 09:30:00' AS t", []);
      expect(r.rows).toEqual([["2026-04-01", "2026-04-01 09:30:00"]]);
    } finally {
      await c.close();
    }
  });

  it("describe: the columns and the types' names, with no rows", async () => {
    // :from::date and :skip have no -- param: lines: null for both, as the dev server sends
    expect((await api.describe("orders")).columns).toEqual([
      { name: "id", type: "int", dbType: "bigint" },
      { name: "order_date", type: "date", dbType: "date" },
      { name: "created", type: "timestamp", dbType: "timestamp without time zone" },
      { name: "created_tz", type: "timestamp", dbType: "timestamp with time zone" },
      { name: "amount", type: "float", dbType: "numeric(12,2)" },
      { name: "rate", type: "float", dbType: "double precision" },
      { name: "ok", type: "bool", dbType: "boolean" },
      { name: "region", type: "string", dbType: "text" },
      { name: "extra", type: "string", dbType: "jsonb" },
      { name: "big", type: "int", dbType: "bigint" },
    ]);
  });

  it("runs every query in a read-only transaction", async () => {
    await expect(admin.query("INSERT INTO devbi_test.orders (id) VALUES (3)", [])).rejects.toThrow(/read-only transaction/);
  });

  it("gives up after the time limit", async () => {
    await expect(admin.query("SELECT pg_sleep(2)", [], { timeoutMs: 200 })).rejects.toThrow(/statement timeout/);
  });
});
