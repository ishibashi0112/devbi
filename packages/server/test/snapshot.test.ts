import { existsSync, mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { snapshotFile } from "devbi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHandler, lastDue, nextDue, parseDataset, serve, snapshotJobs, snapshotOf, type RunningServer } from "../src/index.js";

describe("the -- snapshot: line", () => {
  it("reads the times of day among the comments at the top", () => {
    expect(snapshotOf("-- 日次\n-- snapshot: 12:00, 6:00\nSELECT 1")).toEqual(["06:00", "12:00"]);
    expect(snapshotOf("-- Snapshot: 06:00、18:30\n\nSELECT 1")).toEqual(["06:00", "18:30"]);
    expect(snapshotOf("SELECT 1\n-- snapshot: 06:00")).toBeUndefined();
    expect(snapshotOf("-- 日次\nSELECT 1")).toBeUndefined();
    expect(() => snapshotOf("-- snapshot: 6時\nSELECT 1", "daily")).toThrow("api/daily.sql: snapshot の時刻は 06:00 のように書きます（6時）");
    expect(() => snapshotOf("-- snapshot: 24:00\nSELECT 1")).toThrow(/06:00 のように/);
    expect(() => snapshotOf("-- snapshot:\nSELECT 1")).toThrow(/時刻を書いてください/);
  });
  it("is not part of the description", () => {
    expect(parseDataset("d", "-- 日次の売上\n-- snapshot: 06:00\nSELECT 1")).toMatchObject({ description: "日次の売上", snapshot: ["06:00"] });
  });
});

describe("times of day", () => {
  const now = new Date(2026, 10, 8, 7, 30);
  it("the last one at or before now, today's or yesterday's", () => {
    expect(lastDue(["06:00", "12:00"], now)).toEqual(new Date(2026, 10, 8, 6, 0));
    expect(lastDue(["08:00"], now)).toEqual(new Date(2026, 10, 7, 8, 0));
    expect(lastDue(["07:30"], now)).toEqual(now);
  });
  it("the next one after now, today's or tomorrow's", () => {
    expect(nextDue(["06:00", "12:00"], now)).toEqual(new Date(2026, 10, 8, 12, 0));
    expect(nextDue(["06:00"], now)).toEqual(new Date(2026, 10, 9, 6, 0));
    expect(nextDue(["07:30"], now)).toEqual(new Date(2026, 10, 9, 7, 30));
  });
});

describe("snapshots (SQLite)", () => {
  let dir: string;
  let running: RunningServer;
  const logs: string[] = [];
  const env = { DEVBI_DB: "sqlite:db/shop.sqlite" };
  const daily = snapshotFile("daily", { from: "2026-04-01" });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "devbi-snapshot-"));
    for (const d of ["api", "models", "db", "dist"]) mkdirSync(path.join(dir, d));
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.exec(`CREATE TABLE orders (order_date DATE, region TEXT, amount REAL);
      INSERT INTO orders VALUES ('2026-03-31', '関東', 1), ('2026-04-01', '関東', 1200), ('2026-04-02', '近畿', 800);`);
    db.close();
    writeFileSync(path.join(dir, "api", "daily.sql"), "-- 地域ごとの合計\n-- snapshot: 06:00\nSELECT region, SUM(amount) AS amount FROM orders WHERE order_date >= :from GROUP BY region\n");
    writeFileSync(path.join(dir, "api", "unused.sql"), "-- snapshot: 06:00\nSELECT 1 AS one\n");
    writeFileSync(path.join(dir, "api", "live.sql"), "SELECT region, amount FROM orders\n");
    const model = (sql: string) => `measures:\n  revenue: SUM(amount)\nmodel: ${sql}\n`;
    writeFileSync(path.join(dir, "models", "a.metrics.yaml"), model("SELECT * FROM read_api('daily', from = '2026-04-01')"));
    writeFileSync(path.join(dir, "models", "b.metrics.yaml"), model("SELECT * FROM read_api('daily', from = '2026-04-01') JOIN read_api('live') USING (region)"));
    writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html><title>t</title>");
    running = await serve({ dir, port: 0, env, log: (l) => logs.push(l) });
  });
  afterAll(async () => {
    await running?.close();
  });

  it("are the read_api calls in models/ whose SQL has a snapshot line, each once", async () => {
    const { jobs, problems } = await snapshotJobs(dir);
    expect(problems).toEqual([]);
    expect(jobs).toEqual([{ name: "daily", params: { from: "2026-04-01" }, file: daily, times: ["06:00"], models: ["a", "b"] }]);
  });

  it("devbi-serve makes a missing one when asked for it, and sends it with its time", async () => {
    const res = await fetch(new URL(`reports/snapshots/${encodeURIComponent(daily)}`, running.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apache.arrow.stream");
    const modified = res.headers.get("last-modified")!;
    expect(Date.now() - Date.parse(modified)).toBeLessThan(60_000);
    const t = tableFromIPC(new Uint8Array(await res.arrayBuffer()));
    expect(t.toArray().map((r) => r.toJSON())).toEqual(
      expect.arrayContaining([
        { region: "関東", amount: 1200n },
        { region: "近畿", amount: 800n },
      ]),
    );
    expect(existsSync(path.join(dir, "dist", "snapshots", daily))).toBe(true);
    // Not changed since: 304, no body.
    const again = await fetch(new URL(`snapshots/${encodeURIComponent(daily)}`, running.url), { headers: { "If-Modified-Since": modified } });
    expect(again.status).toBe(304);
  });

  it("refuses files no read_api in models/ makes, and other methods", async () => {
    const other = await fetch(new URL(`snapshots/${snapshotFile("daily", { from: "2000-01-01" })}`, running.url));
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: string }).error).toMatch(/models\/ の read_api で使っているものだけ/);
    expect((await fetch(new URL("snapshots/unused.arrows", running.url))).status).toBe(404);
    expect((await fetch(new URL("snapshots/live.arrows", running.url))).status).toBe(404);
    expect((await fetch(new URL(`snapshots/${daily}`, running.url), { method: "POST" })).status).toBe(405);
  });

  it("the schema shows the snapshot times and when each was made", async () => {
    const body = (await (await fetch(new URL("api/schema", running.url))).json()) as {
      datasets: { name: string; snapshot?: string[] }[];
      snapshots: { file: string; updatedAt: string | null; models: string[] }[];
    };
    expect(body.datasets.find((d) => d.name === "daily")?.snapshot).toEqual(["06:00"]);
    expect(body.datasets.find((d) => d.name === "live")?.snapshot).toBeUndefined();
    expect(body.snapshots).toEqual([expect.objectContaining({ file: daily, models: ["a", "b"], updatedAt: expect.any(String) })]);
  });

  it("devbi-snapshot's work: make them all now; catch up makes those older than their last time", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "devbi-site-"));
    const api = createApiHandler({ dir, env, snapshotDir: path.join(out, "snapshots") });
    try {
      expect(await api.snapshots.make(["nope"])).toEqual([]);
      const [made] = await api.snapshots.make();
      expect(made).toMatchObject({ file: daily, ok: true, rows: 2 });
      const file = path.join(out, "snapshots", daily);
      const today6 = new Date();
      today6.setHours(6, 0, 0, 0);
      const after = new Date(today6.getTime() + 60 * 60_000);
      // Made after today's 06:00: nothing to do.
      utimesSync(file, after, after);
      expect(await api.snapshots.catchUp(new Date(today6.getTime() + 2 * 60 * 60_000))).toEqual([]);
      // Made before it: made again.
      const before = new Date(today6.getTime() - 60 * 60_000);
      utimesSync(file, before, before);
      expect(await api.snapshots.catchUp(new Date(today6.getTime() + 2 * 60 * 60_000))).toEqual([expect.objectContaining({ file: daily, ok: true })]);
      expect(statSync(file).mtime.getTime()).toBeGreaterThan(before.getTime());
    } finally {
      await api.close();
    }
  });

  it("without a folder (the dev server), each request runs the SQL and saves nothing", async () => {
    const api = createApiHandler({ dir, env });
    try {
      const found = await api.snapshots.get(daily);
      expect("bytes" in found && tableFromIPC(found.bytes).numRows).toBe(2);
      expect(await api.snapshots.catchUp()).toEqual([]);
    } finally {
      await api.close();
    }
  });

  it("a failure is logged and shown, and the old file stays", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "devbi-site-"));
    const api = createApiHandler({ dir, env: { DEVBI_DB: "sqlite:db/missing.sqlite" }, snapshotDir: path.join(out, "snapshots") });
    try {
      const [r] = await api.snapshots.make();
      expect(r).toMatchObject({ file: daily, ok: false });
      expect(existsSync(path.join(out, "snapshots", daily))).toBe(false);
      expect((await api.snapshots.status())[0]).toMatchObject({ file: daily, updatedAt: null, error: expect.stringMatching(/つなげません/) });
    } finally {
      await api.close();
    }
  });
});
