import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatDashboardJson } from "devbi";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { versionOf } from "../src/editor.js";

const SALES = `{\n  "metrics": "s",\n  "tiles": [\n    {\n      "id": "k",\n      "x": 0, "y": 0, "w": 3, "h": 2,\n      "type": "kpi",\n      "query": { "measures": ["n"] }\n    }\n  ]\n}\n`;

/** A request with any headers (fetch would not send Origin or Host as given). */
function send(base: string, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(new URL(url, base), { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { text };
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("the GUI editor's endpoint on the dev server", () => {
  let server: ViteDevServer;
  let base: string;
  let dir: string;
  const editor = { "X-DevBI-Editor": "1", "X-DevBI-Client": "page-1" };
  const file = (name: string) => path.join(dir, "dashboards", `${name}.dash.json`);
  const put = (name: string, spec: unknown, version: string | null, headers: Record<string, string> = editor) =>
    send(base, "PUT", `/__devbi/editor/dashboards/${encodeURIComponent(name)}`, headers, { spec, version });
  const promote = (body: unknown, name = "sales", headers: Record<string, string> = editor) =>
    send(base, "POST", `/__devbi/editor/dashboards/${encodeURIComponent(name)}/tiles`, headers, body);
  const tileFile = (name: string) => path.join(dir, "dashboards", "sales", name);

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "devbi-editor-"));
    mkdirSync(path.join(dir, "models"));
    mkdirSync(path.join(dir, "dashboards"));
    writeFileSync(path.join(dir, "models", "s.metrics.yaml"), "model: SELECT 1 AS a\nmeasures:\n  n: COUNT(*)\n");
    writeFileSync(file("sales"), SALES);
    const { createServer } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    server = await createServer({ root: dir, configFile: false, logLevel: "silent", plugins: [devbi()], server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    base = server.resolvedUrls!.local[0]!;
  });
  afterAll(() => server?.close());

  it("reads a dashboard as written, with its version", async () => {
    const res = await send(base, "GET", "/__devbi/editor/dashboards/sales", editor);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "sales", path: "/dashboards/sales.dash.json", spec: JSON.parse(SALES), version: versionOf(SALES) });
    expect((await send(base, "GET", "/__devbi/editor/dashboards/nothing", editor)).status).toBe(404);
  });

  it("writes in the hand-written style when the version is the one read", async () => {
    const spec = JSON.parse(SALES);
    spec.tiles[0].x = 3;
    const res = await put("sales", spec, versionOf(SALES));
    expect(res.status).toBe(200);
    const text = readFileSync(file("sales"), "utf8");
    expect(text).toBe(formatDashboardJson(spec));
    expect(text).toContain(`"x": 3, "y": 0, "w": 3, "h": 2,`);
    expect(res.body.version).toBe(versionOf(text));
    // The file changed since that version: refused, with the version it has now.
    const stale = await put("sales", JSON.parse(SALES), versionOf(SALES));
    expect(stale.status).toBe(409);
    expect(stale.body.version).toBe(versionOf(text));
    writeFileSync(file("sales"), SALES);
  });

  it("creates a new file only with version null, a plain name and no file there yet", async () => {
    const spec = { title: "新しい", metrics: "s", tiles: [] };
    expect((await put("monthly", spec, null)).status).toBe(200);
    expect(readFileSync(file("monthly"), "utf8")).toBe(`{\n  "title": "新しい",\n  "metrics": "s",\n  "tiles": []\n}\n`);
    expect((await put("monthly", spec, null)).status).toBe(409);
    const named = await put("月次", spec, null);
    expect(named.status).toBe(400);
    expect(named.body.error).toMatch(/半角の英数字/);
  });

  it("checks the dashboard like the build does", async () => {
    const overlap = await put("sales", { tiles: [{ id: "a", x: 0, y: 0, w: 13, h: 1, type: "kpi" }] }, versionOf(SALES));
    expect(overlap.status).toBe(422);
    expect(overlap.body.error).toMatch(/列数 12 を超えています/);
    const metrics = await put("sales", { metrics: "nothing", tiles: [] }, versionOf(SALES));
    expect(metrics.status).toBe(422);
    expect(metrics.body.error).toMatch(/models\/nothing\.metrics\.yaml がありません/);
    const component = await put("sales", { tiles: [{ id: "a", x: 0, y: 0, w: 1, h: 1, component: "./x/Gone.tsx" }] }, versionOf(SALES));
    expect(component.body.error).toMatch(/Gone\.tsx がありません/);
    expect(readFileSync(file("sales"), "utf8")).toBe(SALES);
  });

  it("answers only the editor on this computer: its header, this server's origin, a known host, a file name", async () => {
    const spec = JSON.parse(SALES);
    expect((await put("sales", spec, versionOf(SALES), {})).status).toBe(403);
    const other = await put("sales", spec, versionOf(SALES), { ...editor, Origin: "http://localhost:3000" });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/ほかのサイト/);
    expect((await put("sales", spec, versionOf(SALES), { ...editor, Origin: "null" })).status).toBe(403);
    const port = new URL(base).port;
    expect((await put("sales", spec, versionOf(SALES), { ...editor, Origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    // A name pointed at this computer from outside (DNS rebinding).
    const rebind = await put("sales", spec, versionOf(SALES), { ...editor, Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` });
    expect(rebind.status).toBe(403);
    for (const name of ["../models/s", "a\\b", "a\u0000b"]) expect((await put(name, spec, null)).status).toBe(400);
    expect((await put("..", spec, null)).status).toBe(404); // the URL itself goes up a level
    expect((await send(base, "DELETE", "/__devbi/editor/dashboards/sales", editor)).status).toBe(405);
    expect((await send(base, "PUT", "/__devbi/editor/dashboards/sales", editor, "not an object")).status).toBe(400);
  });

  it("writes a built-in tile out as a .tsx file (コードにする), named after the tile, never over another file", async () => {
    const tile = { id: "k", x: 0, y: 0, w: 3, h: 2, type: "kpi", title: "件数", query: { measures: ["n"] } };
    const first = await promote({ tile, metrics: "s" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ path: "/dashboards/sales/K.tsx", component: "./sales/K.tsx", created: true });
    const written = readFileSync(tileFile("K.tsx"), "utf8");
    expect(written).toContain(`export const query = defineQuery({ measures: ["n"] });`);
    expect(written).toContain("models/s.metrics.yaml");
    expect(written).toContain("export default function K(props: TileProps<RowOf<typeof query>>) {");
    // The same tile again (written out, undone in the editor, written out again): the same file.
    expect((await promote({ tile, metrics: "s" })).body).toEqual({ ...first.body, created: false });
    // Another tile with that name: the next one free, and the first file stays as it is.
    const other = await promote({ tile: { ...tile, title: "別の" }, metrics: "s" });
    expect(other.body).toEqual({ path: "/dashboards/sales/K2.tsx", component: "./sales/K2.tsx", created: true });
    expect(readFileSync(tileFile("K.tsx"), "utf8")).toBe(written);
    // The dashboard can then name it, as the editor's save does.
    const spec = JSON.parse(SALES);
    spec.tiles[0] = { id: "k", x: 0, y: 0, w: 3, h: 2, component: "./sales/K.tsx", title: "件数" };
    expect((await put("sales", spec, versionOf(SALES))).status).toBe(200);
    writeFileSync(file("sales"), SALES);
  });

  it("writes out only a built-in tile that dash.json allows, of a dashboard that is there", async () => {
    const tile = { id: "k", type: "kpi", query: { measures: ["n"] } };
    const chart = await promote({ tile: { ...tile, type: "chart" } });
    expect(chart.status).toBe(400);
    expect(chart.body.error).toMatch(/組み込みのタイルだけ/);
    expect((await promote({ tile: { id: "c", component: "./sales/K.tsx" } })).status).toBe(400);
    const query = await promote({ tile: { ...tile, query: { measures: "n" } } });
    expect(query.status).toBe(422);
    expect((await promote({ tile: { ...tile, id: "" } })).status).toBe(422);
    expect((await promote({ tile }, "nothing")).status).toBe(404);
    expect((await promote({ tile }, "../models")).status).toBe(400);
    expect((await promote({ tile }, "sales", {})).status).toBe(403);
    expect((await send(base, "GET", "/__devbi/editor/dashboards/sales/tiles", editor)).status).toBe(405);
    expect(existsSync(path.join(dir, "dashboards", "nothing"))).toBe(false);
  });

  it("tells the page of a tile file added or removed, instead of reloading it (the editor may have unsaved changes)", async () => {
    // The page has loaded virtual:devbi (its import.meta.glob lists the tile files).
    await (await fetch(new URL("/@id/__x00__virtual:devbi", base))).text();
    mkdirSync(path.join(dir, "dashboards", "sales"), { recursive: true });
    const hot = server.environments.client.hot;
    const sent: { type?: string; event?: string; data?: unknown }[] = [];
    const original = hot.send;
    hot.send = ((payload: unknown) => void sent.push(payload as never)) as typeof hot.send;
    const change = (data: unknown) => ({ type: "custom", event: "devbi:change", data });
    try {
      writeFileSync(tileFile("Added.tsx"), "export default function Added() { return null; }\n");
      await vi.waitFor(() => expect(sent).toContainEqual(change({ file: "dashboards/sales/Added.tsx", type: "create" })), { timeout: 10_000 });
      rmSync(tileFile("Added.tsx"));
      await vi.waitFor(() => expect(sent).toContainEqual(change({ file: "dashboards/sales/Added.tsx", type: "delete" })), { timeout: 10_000 });
      // The editor's own file: the page that wrote it is named, and does not reload for it.
      const res = await promote({ tile: { id: "own", type: "kpi", query: { measures: ["n"] } } });
      expect(res.body.created).toBe(true);
      await vi.waitFor(() => expect(sent).toContainEqual(change({ file: "dashboards/sales/Own.tsx", type: "create", by: "page-1" })), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 300));
      expect(sent.filter((p) => p.type === "full-reload")).toEqual([]);
    } finally {
      hot.send = original;
    }
  });

  it("gives the page the dev server's hooks, without the editor when @devbi/editor is not installed", async () => {
    const res = await fetch(new URL("/@id/__x00__virtual:devbi", base));
    const code = await res.text();
    expect(code).toContain("devbi:change");
    expect(code).toContain("dev: {");
    expect(code).toContain("importTile: (path) => import(");
    expect(code).not.toContain("@devbi/editor");
  });
});

describe("the read-only API on the dev and preview servers, and the Host header", () => {
  const project = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "devbi-hosts-"));
    mkdirSync(path.join(dir, "api"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "api", "orders.sql"), "SELECT 1 AS one");
    writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html>");
    return dir;
  };

  it("leaves a name the dev server does not know to Vite, which refuses it (DNS rebinding)", async () => {
    const { createServer } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    const server = await createServer({ root: project(), configFile: false, logLevel: "silent", plugins: [devbi()], server: { port: 0, host: "127.0.0.1" } });
    await server.listen();
    try {
      const base = server.resolvedUrls!.local[0]!;
      const port = new URL(base).port;
      expect((await send(base, "GET", "/api/schema", {})).status).toBe(200);
      expect((await send(base, "GET", "/api/schema", { Host: `evil.example:${port}` })).status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("uses preview.allowedHosts on the preview server", async () => {
    const { preview } = await import("vite");
    const devbi = (await import("../src/index.js")).default;
    const server = await preview({
      root: project(),
      configFile: false,
      logLevel: "silent",
      plugins: [devbi()],
      preview: { port: 0, host: "127.0.0.1", allowedHosts: ["staging.example.com"] },
    });
    try {
      const base = server.resolvedUrls!.local[0]!;
      const port = new URL(base).port;
      const allowed = await send(base, "GET", "/api/schema", { Host: `staging.example.com:${port}` });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toHaveProperty("datasets");
      expect((await send(base, "GET", "/api/schema", { Host: `evil.example:${port}` })).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
