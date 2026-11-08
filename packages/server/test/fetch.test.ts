// createApiHandler's fetch(): the same API with the web's Request and Response, for Next.js route handlers and
// other servers built on them. The answers must match what devbi-serve sends (server.test.ts, snapshot.test.ts);
// the last tests check handle() (Node's http) on the same files, gzip included.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { snapshotFile } from "devbi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHandler, type ApiHandler } from "../src/index.js";

describe("createApiHandler: fetch (the web's Request / Response) and handle (Node's http)", () => {
  let dir: string;
  let api: ApiHandler;
  let server: Server;
  let nodeUrl: string;
  const logs: string[] = [];
  const base = "http://localhost:3000/reports/devbi/";
  const daily = snapshotFile("daily", { from: "2026-04-01" });
  const ask = async (url: string, init?: RequestInit) => {
    const res = await api.fetch(new Request(new URL(url, base), init));
    if (!res) throw new Error(`${url}: no answer`);
    return res;
  };
  const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    ask("api/query", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error] as const;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "devbi-fetch-"));
    for (const d of ["api", "models", "db", "snapshots"]) mkdirSync(path.join(dir, d));
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.exec("CREATE TABLE orders (order_date DATE, region TEXT, amount REAL)");
    const insert = db.prepare("INSERT INTO orders VALUES (?, ?, ?)");
    // One transaction: row by row, each insert waits for the disk (seconds on a busy CI machine, past the hook's 10 s).
    db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) insert.run(`2026-04-${String((i % 28) + 1).padStart(2, "0")}`, ["関東", "近畿", "九州"][i % 3]!, i);
    db.exec("COMMIT");
    db.close();
    writeFileSync(path.join(dir, "api", "orders.sql"), "-- 受注\nSELECT order_date, region, amount FROM orders WHERE order_date >= :from\n");
    writeFileSync(path.join(dir, "api", "daily.sql"), "-- snapshot: 06:00\nSELECT order_date, region, amount FROM orders WHERE order_date >= :from\n");
    writeFileSync(path.join(dir, "api", "writes.sql"), "DELETE FROM orders");
    writeFileSync(path.join(dir, "models", "a.metrics.yaml"), "measures:\n  revenue: SUM(amount)\nmodel: SELECT * FROM read_api('daily', from = '2026-04-01')\n");
    api = createApiHandler({ dir, env: { DEVBI_DB: "sqlite:db/shop.sqlite" }, snapshotDir: path.join(dir, "snapshots"), log: (l) => logs.push(l) });
    server = createServer((req, res) => {
      void api.handle(req, res).then((done) => {
        if (!done) res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    nodeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reports/`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await api?.close();
  });

  it("answers only the API's paths, under any base path", async () => {
    expect(await api.fetch(new Request(new URL("index.html", base)))).toBeUndefined();
    expect(await api.fetch(new Request(new URL("api/other", base)))).toBeUndefined();
    expect(await api.fetch(new Request("http://localhost/api/schema"))).toBeInstanceOf(Response);
  });

  it("schema: the SQL files, as JSON", async () => {
    const res = await ask("api/schema");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { datasets: { name: string; error?: string }[] };
    expect(body.datasets.find((d) => d.name === "orders")).toMatchObject({ description: "受注", params: ["from"] });
    expect(body.datasets.find((d) => d.name === "writes")?.error).toMatch(/SELECT か WITH/);
    const head = await ask("api/schema", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
  });

  it("query: Arrow, never gzipped (Next.js would drop the Content-Encoding; the server in front compresses)", async () => {
    const small = await post({ name: "orders", params: { from: "2026-04-28" } });
    expect(small.status).toBe(200);
    expect(small.headers.get("content-type")).toBe("application/vnd.apache.arrow.stream");
    const t = tableFromIPC(new Uint8Array(await small.arrayBuffer()));
    expect(t.numRows).toBe(107);
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["order_date:Date32<DAY>", "region:Utf8", "amount:Float64"]);

    const large = await post({ name: "orders", params: { from: "2026-04-01" } }, { "Content-Type": "application/json", "Accept-Encoding": "gzip, br" });
    expect(large.headers.get("content-encoding")).toBeNull();
    expect(large.headers.get("x-devbi-rows")).toBe("3000");
    const bytes = new Uint8Array(await large.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(8192);
    expect(Number(large.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(tableFromIPC(bytes).numRows).toBe(3000);
    expect(logs).toContainEqual(expect.stringMatching(/^api\/orders\.sql: 3,000 行、\d+ ms$/));
  });

  it("errors: the same statuses and Japanese messages as devbi-serve", async () => {
    expect(await error(await post({ name: "nope" }))).toEqual([404, "API の SQL nope はありません（api/nope.sql）"]);
    expect((await error(await post({ name: "orders" })))[1]).toMatch(/:from の値がありません/);
    expect((await error(await post({ name: "writes" })))[0]).toBe(400);
    expect((await error(await post("{", { "Content-Type": "application/json" })))[0]).toBe(400);
    expect((await error(await post({ name: "orders", params: { from: "x" } }, { "Content-Type": "text/plain" })))[0]).toBe(415);
    expect(await error(await post({ name: "orders", params: { from: "x".repeat(70_000) } }))).toEqual([413, "リクエストが大きすぎます"]);
    expect(await error(await ask("api/query"))).toEqual([405, "POST で呼んでください"]);
    expect(await error(await ask("api/schema", { method: "POST" }))).toEqual([405, "GET で呼んでください"]);
    expect(await error(await ask(`snapshots/${daily}`, { method: "DELETE" }))).toEqual([405, "GET で呼んでください"]);
    expect(await error(await ask("snapshots/%E3%81.arrows"))).toEqual([404, "スナップショットの名前を読めません"]);
  });

  it("a body over 64 KB: 413, and the rest is not read (the browser's stream is cancelled)", async () => {
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(16384).fill(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: endless, duplex: "half" } as RequestInit;
    expect(await error(await ask("api/query", init))).toEqual([413, "リクエストが大きすぎます"]);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("snapshots: made when missing, then streamed from the file, with 304 and HEAD", async () => {
    const first = await ask(`snapshots/${encodeURIComponent(daily)}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/vnd.apache.arrow.stream");
    expect(first.headers.get("x-devbi-rows")).toBe("3000");
    const modified = first.headers.get("last-modified")!;
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(Number(first.headers.get("content-length"))).toBe(bytes.byteLength);
    expect(tableFromIPC(bytes).numRows).toBe(3000);

    const again2 = await ask(`snapshots/${daily}`, { headers: { "Accept-Encoding": "gzip" } });
    expect(again2.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await again2.arrayBuffer())).toEqual(bytes);

    const again = await ask(`snapshots/${daily}`, { headers: { "If-Modified-Since": modified } });
    expect([again.status, await again.text()]).toEqual([304, ""]);
    const head = await ask(`snapshots/${daily}`, { method: "HEAD" });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, String(bytes.byteLength), ""]);

    const other = await ask(`snapshots/${snapshotFile("daily", { from: "2000-01-01" })}`);
    expect(other.status).toBe(404);
  });

  // Where the system lists a process's open files (Linux): the snapshot file must not stay open.
  it.runIf(existsSync("/proc/self/fd"))("closes the file when the browser goes away, before or while it is sent", async () => {
    const open = () =>
      readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`).endsWith(daily);
        } catch {
          return false;
        }
      }).length;
    const closed = async () => {
      for (let i = 0; i < 50 && open() > 0; i++) await new Promise((r) => setTimeout(r, 20));
      return open();
    };
    await (await ask(`snapshots/${daily}`)).arrayBuffer(); // read to the end
    expect(await closed()).toBe(0);
    // Gone before the answer (Next.js then never reads nor cancels the body).
    const gone = new AbortController();
    gone.abort();
    await ask(`snapshots/${daily}`, { signal: gone.signal });
    expect(await closed()).toBe(0);
    // Gone after the answer, before its body is read.
    const later = new AbortController();
    const res = await ask(`snapshots/${daily}`, { signal: later.signal });
    expect(res.status).toBe(200);
    later.abort();
    expect(await closed()).toBe(0);
  });

  it("handle (Node's http): the same, gzipped when large and asked for, the file streamed through gzip", async () => {
    const query = (encoding: string) =>
      fetch(new URL("api/query", nodeUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept-Encoding": encoding },
        body: JSON.stringify({ name: "orders", params: { from: "2026-04-01" } }),
      });
    const zipped = await query("gzip");
    expect([zipped.status, zipped.headers.get("content-encoding"), zipped.headers.get("x-devbi-rows")]).toEqual([200, "gzip", "3000"]);
    expect(tableFromIPC(new Uint8Array(await zipped.arrayBuffer())).numRows).toBe(3000); // fetch unzips it
    const plain = await query("identity");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(Number(plain.headers.get("content-length"))).toBe((await plain.arrayBuffer()).byteLength);

    const file = new Uint8Array(readFileSync(path.join(dir, "snapshots", daily)));
    const snap = await fetch(new URL(`snapshots/${daily}`, nodeUrl), { headers: { "Accept-Encoding": "gzip" } });
    expect([snap.status, snap.headers.get("content-encoding"), snap.headers.get("content-length")]).toEqual([200, "gzip", null]);
    expect(new Uint8Array(await snap.arrayBuffer())).toEqual(file);
    const head = await fetch(new URL(`snapshots/${daily}`, nodeUrl), { method: "HEAD", headers: { "Accept-Encoding": "identity" } });
    expect([head.status, head.headers.get("content-length"), await head.text()]).toEqual([200, String(file.byteLength), ""]);
    const modified = head.headers.get("last-modified")!;
    expect((await fetch(new URL(`snapshots/${daily}`, nodeUrl), { headers: { "If-Modified-Since": modified } })).status).toBe(304);
    const schemaHead = await fetch(new URL("api/schema", nodeUrl), { method: "HEAD" });
    expect([schemaHead.status, schemaHead.headers.get("content-type"), await schemaHead.text()]).toEqual([200, "application/json; charset=utf-8", ""]);
    expect((await fetch(new URL("index.html", nodeUrl))).status).toBe(404);
  });
});
