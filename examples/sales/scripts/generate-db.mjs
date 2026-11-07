// Generate db/sales.sqlite from data/sales.xlsx: the same orders, kept the way an order system's database keeps them
// (orders, order lines, customers, products), for the read_api sample (api/orders.sql joins them back).
// Run: pnpm gen:db   (needs `pnpm build` once for the devbi package, and Node 22.16 or later)
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readXlsx } from "devbi";

const xlsx = await readXlsx(readFileSync(new URL("../data/sales.xlsx", import.meta.url)), { sheet: "明細" });
const col = (name) => xlsx.columns.find((c) => c.name === name).values;
const [dates, orderNos, customers, regions, categories, products, qtys, prices] = ["受注日", "受注番号", "顧客", "地域", "商品分類", "商品", "数量", "単価"].map(col);

const file = new URL("../db/sales.sqlite", import.meta.url);
mkdirSync(new URL("../db/", import.meta.url), { recursive: true });
rmSync(file, { force: true });
const db = new DatabaseSync(file.pathname);
db.exec(`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
  CREATE TABLE products (id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL);
  CREATE TABLE orders (order_no TEXT PRIMARY KEY, order_date DATE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id));
  CREATE TABLE order_lines (order_no TEXT NOT NULL REFERENCES orders(order_no), line_no INTEGER NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, unit_price INTEGER NOT NULL, PRIMARY KEY (order_no, line_no));
`);
const ids = (values, key) => {
  const map = new Map();
  values.forEach((_, i) => {
    const k = key(i);
    if (!map.has(k)) map.set(k, map.size + 1);
  });
  return map;
};
const customerIds = ids(customers, (i) => `${customers[i]}\t${regions[i]}`);
const productIds = ids(products, (i) => `${categories[i]}\t${products[i]}`);
db.exec("BEGIN");
const insert = (sql) => db.prepare(sql);
const c = insert("INSERT INTO customers VALUES (?, ?, ?)");
for (const [k, id] of customerIds) c.run(id, ...k.split("\t"));
const p = insert("INSERT INTO products VALUES (?, ?, ?)");
for (const [k, id] of productIds) p.run(id, ...k.split("\t"));
const o = insert("INSERT OR IGNORE INTO orders VALUES (?, ?, ?)");
const l = insert("INSERT INTO order_lines VALUES (?, ?, ?, ?, ?)");
const lineNo = new Map();
for (let i = 0; i < orderNos.length; i++) {
  const day = dates[i].toISOString().slice(0, 10);
  o.run(orderNos[i], day, customerIds.get(`${customers[i]}\t${regions[i]}`));
  const n = (lineNo.get(orderNos[i]) ?? 0) + 1;
  lineNo.set(orderNos[i], n);
  l.run(orderNos[i], n, productIds.get(`${categories[i]}\t${products[i]}`), qtys[i], prices[i]);
}
db.exec("COMMIT");
db.exec("VACUUM");
db.close();
console.log(`db/sales.sqlite: ${lineNo.size} orders, ${orderNos.length} lines`);
