import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tableFromIPC } from "apache-arrow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, createApiHandler, type ApiHandler, type Connection } from "../src/index.js";
import { createServer, type Server } from "node:http";

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
    await client.end();
    admin = await connect(url!);

    const dir = mkdtempSync(path.join(tmpdir(), "devbi-pg-"));
    mkdirSync(path.join(dir, "api"));
    writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT * FROM devbi_test.orders WHERE order_date >= :from::date AND region <> :skip ORDER BY id");
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
      "created:Timestamp<MILLISECOND>",
      "created_tz:Timestamp<MILLISECOND>",
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

  it("runs every query in a read-only transaction", async () => {
    await expect(admin.query("INSERT INTO devbi_test.orders (id) VALUES (3)", [])).rejects.toThrow(/read-only transaction/);
  });

  it("gives up after the time limit", async () => {
    await expect(admin.query("SELECT pg_sleep(2)", [], { timeoutMs: 200 })).rejects.toThrow(/statement timeout/);
  });
});
