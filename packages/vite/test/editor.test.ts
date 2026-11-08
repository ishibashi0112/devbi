import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatDashboardJson } from "devbi";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("gives the page the dev server's hooks, without the editor when @devbi/editor is not installed", async () => {
    const res = await fetch(new URL("/@id/__x00__virtual:devbi", base));
    const code = await res.text();
    expect(code).toContain("devbi:change");
    expect(code).toContain("dev: {");
    expect(code).not.toContain("@devbi/editor");
  });
});
