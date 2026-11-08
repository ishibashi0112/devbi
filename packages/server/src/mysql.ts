// MySQL and MariaDB, through mysql2. The read-only transaction and sql_select_limit come from ashiato's adapter
// (src/adapters/mysql.ts, MIT, same author).
import { DATE, TIMESTAMP, base64, checkColumnNames, decimalNumber, loadDriver, timeoutMessage, wholeNumber, type ColumnType, type Connection, type ResultColumn } from "./result.js";

type Mysql = typeof import("mysql2/promise");
type PoolConnection = import("mysql2/promise").PoolConnection;

interface Field {
  name: string;
  columnType: number;
  columnLength?: number;
  characterSet?: number;
}

/** MySQL's column types in result metadata. */
const INTS = new Set([1, 2, 3, 8, 9, 13]); // TINY, SHORT, LONG, LONGLONG, INT24, YEAR
const FLOATS = new Set([4, 5]); // FLOAT, DOUBLE
const DECIMALS = new Set([0, 246]); // DECIMAL, NEWDECIMAL
const DATES = new Set([10, 14]); // DATE, NEWDATE
const TIMESTAMPS = new Set([7, 12]); // TIMESTAMP, DATETIME
const BIT = 16;
const BLOBS = new Set([249, 250, 251, 252, 253, 254]); // BLOB kinds, VAR_STRING, STRING: binary when the character set is
const BINARY_CHARSET = 63;

/** mysql://user:password@host:3306/database — MariaDB too (mariadb://). */
export async function connectMysql(url: URL): Promise<Connection> {
  const mysql = await loadDriver<Mysql>("mysql2/promise", "MySQL");
  const uri = new URL(url.href);
  uri.protocol = "mysql:";
  const pool = mysql.createPool({
    uri: uri.href,
    connectionLimit: 4,
    enableKeepAlive: true,
    // dates and times as the server's text: the stored wall-clock time
    dateStrings: true,
    // BIGINT and DECIMAL as text: DevBI decides what stays exact
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    charset: "utf8mb4",
  });
  // Without a listener, a connection the server closes would crash the process.
  pool.on("connection", (c) => (c as unknown as { on(e: string, f: () => void): void }).on("error", () => undefined));

  const take = async (): Promise<PoolConnection> => {
    const conn = await pool.getConnection();
    try {
      await conn.query("SELECT 1");
      return conn;
    } catch (e) {
      // the server closed the idle connection (wait_timeout, restart): a new one
      conn.destroy();
      if (!(e as { fatal?: boolean }).fatal) throw e;
      return pool.getConnection();
    }
  };
  // MariaDB's time limit is max_statement_time (seconds); MySQL's is max_execution_time (milliseconds, SELECT only).
  const first = await take();
  let mariadb: boolean;
  try {
    const [rows] = (await first.query("SELECT VERSION() AS v")) as unknown as [{ v: string }[]];
    mariadb = /mariadb/i.test(String(rows[0]?.v));
  } finally {
    first.release();
  }
  const limitTime = (ms: number | undefined) =>
    mariadb ? `SET SESSION max_statement_time = ${ms ? ms / 1000 : 0}` : `SET SESSION max_execution_time = ${ms ? Math.max(1, Math.round(ms)) : 0}`;

  const typeOf = (f: Field): ColumnType => {
    if (INTS.has(f.columnType)) return "int";
    if (FLOATS.has(f.columnType) || DECIMALS.has(f.columnType)) return "float";
    if (DATES.has(f.columnType)) return "date";
    if (TIMESTAMPS.has(f.columnType)) return "timestamp";
    if (f.columnType === BIT && f.columnLength === 1) return "bool";
    return "string";
  };
  const valueOf = (v: unknown, type: ColumnType, f: Field): unknown => {
    if (v === null || v === undefined) return null;
    switch (type) {
      case "int":
        return typeof v === "string" ? wholeNumber(v) : v;
      case "float":
        return typeof v === "string" ? Number(decimalNumber(v)) : v;
      case "date":
        // zero dates ('0000-00-00') are no dates
        return typeof v === "string" && DATE.test(v) && !v.startsWith("0000") ? v : null;
      case "timestamp":
        return typeof v === "string" && TIMESTAMP.test(v) && !v.startsWith("0000") ? v : null;
      case "bool":
        return v instanceof Uint8Array ? v[0] === 1 : Boolean(v);
      default:
        if (v instanceof Uint8Array) return f.columnType === BIT || (BLOBS.has(f.columnType) && f.characterSet === BINARY_CHARSET) ? base64(v) : Buffer.from(v).toString("utf8");
        return typeof v === "object" ? JSON.stringify(v) : String(v);
    }
  };

  return {
    dialect: "mysql",
    async query(sql, params, options = {}) {
      const conn = await take();
      try {
        // A read-only transaction (the server refuses any write), at most maxRows rows sent, and the time limit.
        // All put back before the connection returns to the pool.
        await conn.query("START TRANSACTION READ ONLY");
        if (options.maxRows !== undefined) await conn.query(`SET SESSION sql_select_limit = ${Math.max(0, Math.floor(options.maxRows))}`);
        if (options.timeoutMs) await conn.query(limitTime(options.timeoutMs));
        let result;
        try {
          // A prepared statement: the server reads the ? placeholders (a ? inside a string stays text).
          result = (await conn.execute({ sql, rowsAsArray: true }, params as never[])) as unknown as [unknown[][], Field[]];
        } catch (e) {
          const code = (e as { code?: string; errno?: number }).code;
          // ER_QUERY_TIMEOUT (MySQL), ER_STATEMENT_TIMEOUT (MariaDB)
          if (options.timeoutMs && (code === "ER_QUERY_TIMEOUT" || code === "ER_STATEMENT_TIMEOUT" || (e as { errno?: number }).errno === 3024 || (e as { errno?: number }).errno === 1969)) {
            throw new Error(timeoutMessage(options.timeoutMs));
          }
          throw e;
        }
        const [rows, fields] = result;
        checkColumnNames(fields.map((f) => f.name));
        const columns = fields.map((f): ResultColumn => ({ name: f.name, type: typeOf(f) }));
        return { columns, rows: rows.map((r) => r.map((v, i) => valueOf(v, columns[i]!.type, fields[i]!))) };
      } finally {
        try {
          await conn.query("ROLLBACK");
          if (options.maxRows !== undefined) await conn.query("SET SESSION sql_select_limit = DEFAULT");
          if (options.timeoutMs) await conn.query(limitTime(undefined));
          conn.release();
        } catch {
          conn.destroy();
        }
      }
    },
    async close() {
      await pool.end();
    },
  };
}
