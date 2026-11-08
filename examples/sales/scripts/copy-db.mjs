// Copy the sample's tables (db/sales.sqlite: customers, products, orders, order_lines) into another database, to
// try api/orders.sql and api/sales_daily.sql on SQL Server, Oracle or MySQL.
// Run: pnpm --filter devbi-example-sales copy-db <URL>
//   mssql://sa:<password>@127.0.0.1:1433/master   oracle://<user>:<password>@127.0.0.1:1521/FREEPDB1   mysql://root:<password>@127.0.0.1:3306/devbi
// It drops those four tables in the target first: use a database kept for trying things.
import { DatabaseSync } from "node:sqlite";

const target = process.argv[2];
if (!target) {
  console.error("使い方: pnpm --filter devbi-example-sales copy-db <mssql://… | oracle://… | mysql://…>");
  process.exit(2);
}
const url = new URL(target);
const kind = { "mssql:": "mssql", "sqlserver:": "mssql", "oracle:": "oracle", "mysql:": "mysql", "mariadb:": "mysql" }[url.protocol];
if (!kind) {
  console.error(`この接続先には写せません: ${url.protocol}（mssql:、oracle:、mysql: のどれか）`);
  process.exit(2);
}

const db = new DatabaseSync(new URL("../db/sales.sqlite", import.meta.url).pathname, { readOnly: true });
const rowsOf = (sql) => db.prepare(sql).all().map((r) => Object.values(r));
const text = (n) => (kind === "oracle" ? `NVARCHAR2(${n})` : `NVARCHAR(${n})`);
const code = (n) => (kind === "oracle" ? `VARCHAR2(${n})` : `VARCHAR(${n})`);
const tables = [
  { name: "customers", ddl: `id INTEGER PRIMARY KEY, name ${text(100)} NOT NULL, region ${text(20)} NOT NULL`, rows: rowsOf("SELECT id, name, region FROM customers") },
  { name: "products", ddl: `id INTEGER PRIMARY KEY, category ${text(50)} NOT NULL, name ${text(100)} NOT NULL`, rows: rowsOf("SELECT id, category, name FROM products") },
  { name: "orders", ddl: `order_no ${code(20)} PRIMARY KEY, order_date DATE NOT NULL, customer_id INTEGER NOT NULL`, rows: rowsOf("SELECT order_no, order_date, customer_id FROM orders") },
  {
    name: "order_lines",
    ddl: `order_no ${code(20)} NOT NULL, line_no INTEGER NOT NULL, product_id INTEGER NOT NULL, qty INTEGER NOT NULL, unit_price INTEGER NOT NULL`,
    rows: rowsOf("SELECT order_no, line_no, product_id, qty, unit_price FROM order_lines"),
  },
];
db.close();

const user = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const database = decodeURIComponent(url.pathname.slice(1));
const literal = (v) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `N'${String(v).replace(/'/g, "''")}'`);

if (kind === "mssql") {
  const mssql = (await import("mssql")).default;
  const pool = await new mssql.ConnectionPool({
    server: url.hostname,
    port: Number(url.port || 1433),
    user,
    password,
    database: database || undefined,
    options: { encrypt: url.searchParams.get("encrypt") === "true", trustServerCertificate: true },
  }).connect();
  for (const t of [...tables].reverse()) await pool.request().batch(`DROP TABLE IF EXISTS ${t.name}`);
  for (const t of tables) {
    await pool.request().batch(`CREATE TABLE ${t.name} (${t.ddl})`);
    for (let i = 0; i < t.rows.length; i += 500) {
      await pool.request().batch(`INSERT INTO ${t.name} VALUES ${t.rows.slice(i, i + 500).map((r) => `(${r.map(literal).join(", ")})`).join(", ")}`);
    }
  }
  await pool.close();
} else if (kind === "mysql") {
  const mysql = (await import("mysql2/promise")).default;
  url.protocol = "mysql:";
  const conn = await mysql.createConnection({ uri: url.href, charset: "utf8mb4" });
  for (const t of [...tables].reverse()) await conn.query(`DROP TABLE IF EXISTS ${t.name}`);
  for (const t of tables) {
    await conn.query(`CREATE TABLE ${t.name} (${t.ddl}) DEFAULT CHARSET = utf8mb4`);
    for (let i = 0; i < t.rows.length; i += 500) await conn.query(`INSERT INTO ${t.name} VALUES ?`, [t.rows.slice(i, i + 500)]);
  }
  await conn.end();
} else {
  const oracledb = (await import("oracledb")).default;
  const conn = await oracledb.getConnection({ user, password, connectString: `${url.hostname}:${url.port || 1521}/${database}` });
  for (const t of [...tables].reverse()) {
    await conn.execute(`DROP TABLE ${t.name}`).catch((e) => {
      if (!/ORA-00942/.test(e.message)) throw e; // no such table yet
    });
  }
  for (const t of tables) {
    await conn.execute(`CREATE TABLE ${t.name} (${t.ddl})`);
    const n = t.rows[0].length;
    // order_date: a Date at local midnight, which the driver binds as that day
    const rows = t.name === "orders" ? t.rows.map(([no, day, customer]) => [no, new Date(`${day}T00:00:00`), customer]) : t.rows;
    await conn.executeMany(`INSERT INTO ${t.name} VALUES (${Array.from({ length: n }, (_, i) => `:${i + 1}`).join(", ")})`, rows);
  }
  await conn.commit();
  await conn.close();
}
console.log(`${tables.map((t) => `${t.name} ${t.rows.length} 行`).join("、")} を ${url.protocol}//${url.host}${url.pathname} に写しました`);
