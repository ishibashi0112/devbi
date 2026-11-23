// Typed parameters (`-- param:`) on a real database: the same cases on SQLite (server.test.ts), PostgreSQL
// (postgres.test.ts), and SQL Server, MySQL, MariaDB and Oracle (databases.test.ts). They read the sample's tables
// (customers, orders); the answers come from the sample's SQLite file (examples/sales/db/sales.sqlite).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { afterAll, expect, it } from "vitest";
import type { ApiHandler, DevBIUser, Dialect } from "../src/index.js";

export const SAMPLE_DB = path.resolve(import.meta.dirname, "../../../examples/sales/db/sales.sqlite");

/** Write the cases' SQL files into `<dir>/api`. `schema`: what comes before a table name (`devbi_test.` in PostgreSQL). */
export function writeTypedDatasets(dir: string, dialect: Dialect, schema = ""): void {
  mkdirSync(path.join(dir, "api"), { recursive: true });
  const files: Record<string, string> = {
    typed_orders:
      "-- 受注の件数\n-- param: from date label=受注日（から）\n-- param: customer integer optional\n\n" +
      `SELECT COUNT(*) AS n FROM ${schema}orders o WHERE o.order_date >= :from AND (:customer IS NULL OR o.customer_id = :customer)`,
    typed_regions: `-- param: regions text[] label=地域\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE c.region IN (:regions)`,
    typed_not_regions: `-- param: regions text[]\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE c.region NOT IN ( :regions )`,
    typed_at: `-- param: at datetime\nSELECT COUNT(*) AS n FROM ${schema}orders o WHERE o.order_date < :at`,
    typed_many: `-- param: ids integer[]\n-- param: more integer[]\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE c.id IN (:ids) OR c.id IN (:more)`,
    typed_text: `-- param: region text optional\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE (:region IS NULL OR c.region = :region)`,
    // PostgreSQL has booleans; the others take 1 and 0
    typed_flag: `-- param: ok boolean\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE ${dialect === "postgres" ? ":ok" : ":ok = 1"}`,
    typed_number: `-- param: rate number\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE c.id * :rate < 10`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, "api", `${name}.sql`), text);
}

function sample<T>(sql: string): T {
  const db = new DatabaseSync(SAMPLE_DB, { readOnly: true });
  try {
    return Object.values(db.prepare(sql).get() as Record<string, unknown>)[0] as T;
  } finally {
    db.close();
  }
}

/** The tests, for the API `get()` gives once the files above are in its folder. */
export function typedParameterTests(get: () => ApiHandler, dialect?: Dialect): void {
  const count = async (name: string, params: Record<string, unknown>) => {
    const t = tableFromIPC((await get().run(name, params)).bytes);
    // Oracle answers N for n
    return Number(t.get(0)!.toArray()[0]);
  };

  it("typed parameters: a date, and an optional integer that may be NULL (:x IS NULL OR …)", async () => {
    expect(await count("typed_orders", { from: "2026-01-01", customer: null })).toBe(sample<number>("SELECT COUNT(*) FROM orders WHERE order_date >= '2026-01-01'"));
    expect(await count("typed_orders", { from: "2026-01-01", customer: 3 })).toBe(sample<number>("SELECT COUNT(*) FROM orders WHERE order_date >= '2026-01-01' AND customer_id = 3"));
    await expect(get().run("typed_orders", { from: "2026-13-01", customer: null })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/from には日付/) });
    await expect(get().run("typed_orders", { from: "2026-01-01" })).rejects.toMatchObject({ status: 400 });
  });

  it("typed parameters: several values in IN (…) and NOT IN (…)", async () => {
    const both = sample<number>("SELECT COUNT(*) FROM customers WHERE region IN ('関東', '近畿')");
    expect(await count("typed_regions", { regions: ["関東", "近畿"] })).toBe(both);
    expect(await count("typed_regions", { regions: "関東" })).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE region = '関東'"));
    expect(await count("typed_not_regions", { regions: ["関東", "近畿"] })).toBe(sample<number>("SELECT COUNT(*) FROM customers") - both);
    await expect(get().run("typed_regions", { regions: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("typed parameters: 1,000 values in one IN, 2,000 in the statement", async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
    const more = Array.from({ length: 1000 }, (_, i) => -i);
    expect(await count("typed_many", { ids, more })).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE id BETWEEN 1 AND 1000"));
    await expect(get().run("typed_many", { ids: [...ids, 1001], more: [0] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/1,000 個まで/) });
  }, 30_000);

  it("typed parameters: a date and time compared with a date, with and without a fraction of a second", async () => {
    const until = sample<number>("SELECT COUNT(*) FROM orders WHERE order_date <= '2024-04-02'");
    expect(await count("typed_at", { at: "2024-04-02T12:00" })).toBe(until);
    expect(await count("typed_at", { at: "2024-04-02 12:00:00.5" })).toBe(until);
    // SQLite compares its dates as text: '2024-04-03' < '2024-04-03 00:00:00'
    if (dialect !== "sqlite") expect(await count("typed_at", { at: "2024-04-03" })).toBe(until);
  });

  it("typed parameters: optional text, a boolean, a number", async () => {
    expect(await count("typed_text", { region: null })).toBe(sample<number>("SELECT COUNT(*) FROM customers"));
    expect(await count("typed_text", { region: "関東" })).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE region = '関東'"));
    expect(await count("typed_flag", { ok: true })).toBe(sample<number>("SELECT COUNT(*) FROM customers"));
    expect(await count("typed_flag", { ok: false })).toBe(0);
    expect(await count("typed_number", { rate: 2.5 })).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE id * 2.5 < 10"));
  });
}

/**
 * Row-level security on a real database (docs/design/row-level-security.md): `:user.region` bound as the database's
 * parameter. In a project of its own (its files put it in row-level mode); `open` makes the API for that folder.
 */
export function userFilterTests(open: (dir: string) => ApiHandler, schema = ""): void {
  let api: ApiHandler | undefined;
  const get = () => {
    if (!api) {
      const dir = mkdtempSync(path.join(tmpdir(), "devbi-rls-db-"));
      mkdirSync(path.join(dir, "api"));
      writeFileSync(path.join(dir, "api", "user_region.sql"), `-- 自分の地域の顧客\nSELECT COUNT(*) AS n FROM ${schema}customers c WHERE c.region = :user.region`);
      writeFileSync(path.join(dir, "api", "user_all.sql"), `-- access: all\nSELECT COUNT(*) AS n FROM ${schema}customers c`);
      api = open(dir);
    }
    return api;
  };
  afterAll(async () => {
    await api?.close();
  });
  const count = async (name: string, user?: DevBIUser) => Number(tableFromIPC((await get().run(name, {}, { user })).bytes).get(0)!.toArray()[0]);

  it("row-level security: :user.region from the user, a quote in it stays a value, nobody is 401", async () => {
    const region = (r: string) => ({ id: "CORP\\yamada", attrs: { region: r } });
    expect(await count("user_region", region("関東"))).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE region = '関東'"));
    expect(await count("user_region", region("近畿"))).toBe(sample<number>("SELECT COUNT(*) FROM customers WHERE region = '近畿'"));
    expect(await count("user_region", region("' OR 1=1 --"))).toBe(0);
    expect(await count("user_all", { id: "CORP\\yamada" })).toBe(sample<number>("SELECT COUNT(*) FROM customers"));
    await expect(get().run("user_all")).rejects.toMatchObject({ status: 401 });
    await expect(get().run("user_region", {}, { user: { id: "CORP\\yamada" } })).rejects.toMatchObject({ status: 403 });
  });
}
