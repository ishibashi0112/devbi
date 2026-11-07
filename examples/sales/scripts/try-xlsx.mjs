// 自分の Excel でダッシュボードを試すための下書きを作る。
//
//   pnpm try-xlsx ~/Desktop/売上.xlsx [--sheet 明細] [--name local_uriage] [--force]
//
// 1. Excel を data/local/ にコピーする（data/local/ は git に入らない）
// 2. 列の型を見て models/<name>.metrics.yaml と dashboards/<name>.dash.json を書く
// 3. シート・行数・列名と型を表示する（値は表示しないので、この出力はそのまま共有できる）
//
// ファイルは PC の外に出ません。ブラウザもこの PC の dev server から読むだけです。
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSheets, readXlsx } from "devbi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error("\n使い方: pnpm try-xlsx <Excel のパス> [--sheet シート名] [--name local_名前] [--force]\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = { force: false };
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--sheet") opts.sheet = args[++i];
  else if (a === "--name") opts.name = args[++i];
  else if (a === "--force") opts.force = true;
  else if (a === "-h" || a === "--help") usage();
  else files.push(a);
}
if (files.length !== 1) usage("Excel のファイルを一つ指定してください");
const src = path.resolve(process.env.INIT_CWD ?? process.cwd(), files[0]);
if (!existsSync(src)) usage(`ファイルがありません: ${src}`);
if (!/\.xlsx$/i.test(src)) usage("読めるのは .xlsx だけです（.xls や .xlsm は Excel で .xlsx に保存し直してください）");

const NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const name = opts.name ?? `local_${path.basename(src, path.extname(src)).replace(/[^\p{L}\p{N}_]+/gu, "_")}`;
if (!NAME_RE.test(name) || !name.startsWith("local_")) {
  usage(`--name は local_ で始まる、文字・数字・_ だけの名前にしてください（git に入らないように）: ${name}`);
}

const bytes = await readFile(src);
const sheets = await listSheets(bytes);
const sheet = opts.sheet ?? sheets[0];
if (!sheets.includes(sheet)) usage(`シート「${opts.sheet}」がありません。あるのは: ${sheets.join("、")}`);
const table = await readXlsx(bytes, { sheet });

// ---- 列の形 ----------------------------------------------------------------
const cols = table.columns.map((c) => {
  const filled = c.values.filter((v) => v !== null);
  const distinct = new Set(filled.map((v) => (v instanceof Date ? v.getTime() : v))).size;
  const sum = filled.reduce((a, v) => a + (typeof v === "number" ? Math.abs(v) : 0), 0);
  return { name: c.name, type: c.type, filled: filled.length, distinct, sum };
});

const TYPE_JA = { VARCHAR: "文字", BIGINT: "整数", DOUBLE: "数値", BOOLEAN: "真偽", DATE: "日付", TIMESTAMP: "日時" };
console.log(`\nファイル: ${path.basename(src)}`);
console.log(`シート: ${sheets.map((s) => (s === sheet ? `[${s}]` : s)).join("、")}`);
console.log(`行数: ${table.rowCount.toLocaleString()}（見出しの行を除く）\n`);
console.log("列名\t型\t入っている行\t種類");
for (const c of cols) console.log(`${c.name}\t${TYPE_JA[c.type] ?? c.type}\t${c.filled.toLocaleString()}\t${c.distinct.toLocaleString()}`);

// ---- 指標と軸の下書き --------------------------------------------------------
const used = new Set();
const key = (base, prefix) => {
  let k = base.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "") || prefix;
  if (!NAME_RE.test(k)) k = `${prefix}_${k}`;
  let n = k;
  for (let i = 2; used.has(n); i++) n = `${k}_${i}`;
  used.add(n);
  return n;
};
const q = (s) => JSON.stringify(s); // JSON の文字列は YAML の二重引用符の文字列としてそのまま読める
const sqlIdent = (s) => `"${s.replaceAll('"', '""')}"`;

const timeCol = cols.find((c) => (c.type === "DATE" || c.type === "TIMESTAMP") && c.filled > 0);
const looksLikeId = (c) => /(番号|コード|ID|Id|id|No\.?|NO)$/.test(c.name) || (c.type === "BIGINT" && c.distinct === c.filled && c.filled > 20);
const dims = cols
  .filter((c) => c !== timeCol && (c.type === "VARCHAR" || c.type === "BOOLEAN") && c.distinct > 1 && c.distinct <= 300)
  .slice(0, 8)
  .map((c) => ({ key: key(c.name, "d"), col: c }));
// 単価や率は足しても意味がないので平均にする。いちばん大事そうな列（金額・売上など、なければ合計の大きい列）を先頭に。
const isAverage = (c) => /(単価|率|比|割合|%|％|price|rate|ratio)/i.test(c.name);
const isMoney = (c) => /(金額|売上|額|合計|amount|sales|revenue|total)/i.test(c.name);
const nums = cols
  .filter((c) => (c.type === "DOUBLE" || c.type === "BIGINT") && !looksLikeId(c))
  .sort((a, b) => Number(isAverage(a)) - Number(isAverage(b)) || Number(isMoney(b)) - Number(isMoney(a)) || b.sum - a.sum)
  .slice(0, 6)
  .map((c) => ({ key: key(c.name, "m"), col: c, avg: isAverage(c) }));
const rowsKey = key("行数", "rows");

const rel = `data/local/${name}.xlsx`;
const yaml = [
  `# pnpm try-xlsx が ${path.basename(src)} の「${sheet}」シートから作った下書き。自由に直してください。`,
  `label: ${q(path.basename(src, path.extname(src)))}`,
  `model: ${q(`SELECT * FROM read_xlsx('${rel}', sheet = '${sheet.replaceAll("'", "''")}')`)}`,
  ...(timeCol ? [`time: { column: ${q(timeCol.name)}, label: ${q(timeCol.name)}, fiscal_year_start: 4 }   # 年度の始まりの月`] : ["# time: 日付の列が見つかりませんでした"]),
  "dimensions:",
  ...(dims.length ? dims.map((d) => `  ${d.key}: { column: ${q(d.col.name)}, label: ${q(d.col.name)} }`) : ["  {}"]),
  "measures:",
  `  ${rowsKey}: { sql: COUNT(*), label: 行数, format: "#,##0" }`,
  ...nums.map((m) =>
    m.avg
      ? `  ${m.key}: { sql: ${q(`AVG(${sqlIdent(m.col.name)})`)}, label: ${q(`${m.col.name}の平均`)}, format: "#,##0.##" }`
      : `  ${m.key}: { sql: ${q(`SUM(${sqlIdent(m.col.name)})`)}, label: ${q(`${m.col.name}の合計`)}, format: "#,##0" }`,
  ),
  ...(timeCol && nums[0]
    ? [
        `  ${nums[0].key}_yoy: { of: ${nums[0].key}, compare: previous_year, as: ratio }`,
        `  ${nums[0].key}_ly: { of: ${nums[0].key}, compare: previous_year, as: value }`,
      ]
    : []),
  "",
].join("\n");

const main = nums[0]?.key ?? rowsKey;
const tiles = [];
let y = 0;
const add = (t) => tiles.push(t);
if (timeCol) {
  add({ id: "period", x: 0, y, w: 12, h: 1, type: "date-range", options: { default: "all" } });
  y += 1;
}
const kpiList = [
  timeCol && nums[0] ? [main, `${main}_ly`, `${main}_yoy`] : [main],
  ...(main !== rowsKey ? [[rowsKey]] : []),
  ...nums.slice(1, 3).map((m) => [m.key]),
].slice(0, 4);
kpiList.forEach((ms, i) => {
  const w = 12 / kpiList.length;
  add({ id: `kpi-${i + 1}`, x: i * w, y, w, h: 2, type: "kpi", query: { measures: ms } });
});
y += 2;
if (timeCol) {
  add({ id: "by-month", x: 0, y, w: dims[0] ? 8 : 12, h: 4, type: "bar", title: "月別", query: { measures: [main], time: "month" } });
}
if (dims[0]) {
  add({ id: `by-${dims[0].key}`, x: timeCol ? 8 : 0, y, w: timeCol ? 4 : 12, h: 4, type: "barlist", title: `${dims[0].col.name}別`, query: { measures: [main], dimensions: [dims[0].key] } });
}
y += 4;
if (timeCol && nums[0]) {
  add({ id: "vs-last-year", x: 0, y, w: dims[1] ? 6 : 12, h: 4, type: "line", title: "前年同月との比較", query: { measures: [main, `${main}_ly`], time: "month" } });
}
if (dims[1]) {
  add({ id: `by-${dims[1].key}`, x: timeCol && nums[0] ? 6 : 0, y, w: timeCol && nums[0] ? 6 : 12, h: 4, type: "barlist", title: `${dims[1].col.name}別`, query: { measures: [main], dimensions: [dims[1].key] } });
}
y += 4;
if (dims.length) {
  add({
    id: "detail",
    x: 0,
    y,
    w: 12,
    h: 5,
    type: "table",
    title: "明細の集計",
    query: { measures: [...new Set([main, rowsKey, ...nums.slice(1, 3).map((m) => m.key)])], dimensions: dims.slice(0, 2).map((d) => d.key), limit: 200 },
  });
}
const dash = { title: `${path.basename(src, path.extname(src))}（試し）`, description: `${path.basename(src)} の「${sheet}」シート`, metrics: name, tiles };

// ---- 書き出し --------------------------------------------------------------
const out = {
  data: path.join(root, rel),
  metrics: path.join(root, "models", `${name}.metrics.yaml`),
  dash: path.join(root, "dashboards", `${name}.dash.json`),
};
for (const f of [out.metrics, out.dash]) {
  if (existsSync(f) && !opts.force) usage(`${path.relative(root, f)} がもうあります。上書きするときは --force を付けてください`);
}
await mkdir(path.dirname(out.data), { recursive: true });
await copyFile(src, out.data);
await writeFile(out.metrics, yaml);
await writeFile(out.dash, `${JSON.stringify(dash, null, 2)}\n`);

console.log("\n書いたファイル（どれも git に入りません）:");
for (const f of Object.values(out)) console.log(`  examples/sales/${path.relative(root, f)}`);
console.log(`\npnpm example:dev を動かして、ブラウザで http://localhost:5173/#/${name} を開いてください。`);
console.log("models/ と dashboards/ のファイルを直して保存すると、画面がすぐ変わります。\n");
