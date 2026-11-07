// Generate data/sales.xlsx: two and a half fiscal years of sample orders (deterministic).
// Run: pnpm gen:data   (needs `pnpm build` once for the devbi package)
import { writeFile } from "node:fs/promises";
import { writeXlsx } from "devbi";

let seed = 20261107;
function rand() {
  // mulberry32
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const regions = ["北海道・東北", "関東", "中部", "近畿", "中国・四国", "九州・沖縄"];
const regionWeight = [0.08, 0.38, 0.16, 0.2, 0.08, 0.1];
const customers = Array.from({ length: 40 }, (_, i) => ({
  name: `${["青葉", "朝日", "東和", "富士", "大和", "北斗", "三河", "浪速", "瀬戸", "南海"][i % 10]}${["商事", "工業", "製作所", "物産"][Math.floor(i / 10)]}`,
  region: (() => {
    let r = rand();
    for (let k = 0; k < regions.length; k++) {
      r -= regionWeight[k];
      if (r <= 0) return regions[k];
    }
    return regions[1];
  })(),
  size: 0.3 + rand() * 2.5,
}));
const products = [
  { category: "部品", name: "ベアリング A", price: 1200 },
  { category: "部品", name: "ベアリング B", price: 1800 },
  { category: "部品", name: "シャフト", price: 3500 },
  { category: "部品", name: "ギア", price: 2600 },
  { category: "工具", name: "トルクレンチ", price: 18000 },
  { category: "工具", name: "ノギス", price: 9800 },
  { category: "消耗品", name: "グリス", price: 900 },
  { category: "消耗品", name: "ウエス", price: 400 },
  { category: "保守", name: "定期点検", price: 45000 },
  { category: "保守", name: "修理対応", price: 72000 },
];

const rows = [["受注日", "受注番号", "顧客", "地域", "商品分類", "商品", "数量", "単価", "金額"]];
let orderNo = 10000;
const start = Date.UTC(2024, 3, 1);
const end = Date.UTC(2026, 9, 31);
for (let t = start; t <= end; t += 86_400_000) {
  const d = new Date(t);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const month = d.getUTCMonth();
  const season = 1 + 0.25 * Math.sin(((month - 2) / 12) * 2 * Math.PI) + (month === 2 ? 0.35 : 0); // March is busy
  const growth = 1 + (t - start) / (end - start) * 0.18;
  const orders = Math.round((4 + rand() * 5) * season * growth);
  for (let o = 0; o < orders; o++) {
    const c = pick(customers);
    if (rand() > c.size / 2.8) continue;
    orderNo++;
    const lines = 1 + Math.floor(rand() * 3);
    for (let l = 0; l < lines; l++) {
      const p = pick(products);
      const qty = p.category === "保守" ? 1 : Math.ceil(rand() * (p.price < 2000 ? 40 : 6));
      const price = Math.round(p.price * (0.9 + rand() * 0.2) / 10) * 10;
      rows.push([d, `J${orderNo}`, c.name, c.region, p.category, p.name, qty, price, qty * price]);
    }
  }
}

const buf = await writeXlsx([
  { name: "明細", rows },
  { name: "メモ", rows: [["このファイルは DevBI のサンプル用に自動生成したものです"]] },
]);
await writeFile(new URL("../data/sales.xlsx", import.meta.url), buf);
console.log(`data/sales.xlsx: ${rows.length - 1} rows, ${(buf.length / 1024).toFixed(0)} KB`);
