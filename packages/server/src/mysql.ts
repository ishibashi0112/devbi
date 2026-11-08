// MySQL and MariaDB, through mysql2. Read-only statements and sql_select_limit come from ashiato's adapter
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

/** Dates with a zero month or day ('0000-00-00', and '2026-04-00' where sql_mode allows it) are no dates. */
const realDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(?!00)\d{2}-(?!00)\d{2}/.test(v) && !v.startsWith("0000");

interface Command {
  on(event: string, f: (...args: never[]) => void): Command;
}
interface CoreConnection {
  execute(options: { sql: string; rowsAsArray: boolean }, values: unknown[]): Command;
  stream?: { destroy(): void };
}

/**
 * The first result's rows, as they come. A LIMIT in the SQL wins over sql_select_limit: past maxRows, reading stops
 * (`over`) and the connection must be closed.
 */
function readRows(conn: PoolConnection, sql: string, params: unknown[], maxRows: number | undefined): Promise<{ fields?: Field[]; rows: unknown[][]; over: boolean }> {
  const core = (conn as unknown as { connection: CoreConnection }).connection;
  return new Promise((resolve, reject) => {
    let fields: Field[] | undefined;
    const rows: unknown[][] = [];
    let over = false;
    // A prepared statement: the server reads the ? placeholders (a ? inside a string stays text).
    core
      .execute({ sql, rowsAsArray: true }, params)
      .on("fields", (f: Field[] | undefined, index: number | undefined) => {
        if ((index ?? 0) === 0) fields ??= f;
      })
      .on("result", (row: unknown, index: number | undefined) => {
        // other results (a statement's OK, more result sets) are not rows of the first
        if (over || (index ?? 0) !== 0 || !Array.isArray(row)) return;
        if (maxRows !== undefined && rows.length >= maxRows) {
          over = true;
          // the server is still sending: closing the socket stops it
          core.stream?.destroy();
          resolve({ fields, rows, over });
          return;
        }
        rows.push(row);
      })
      .on("error", (e: Error) => {
        if (!over) reject(e);
      })
      .on("end", () => {
        if (!over) resolve({ fields, rows, over });
      });
  });
}

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
  const limitTime = (ms: number) => (mariadb ? `max_statement_time = ${ms / 1000}` : `max_execution_time = ${Math.max(1, Math.round(ms))}`);

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
        return realDate(v) && DATE.test(v) ? v : null;
      case "timestamp":
        return realDate(v) && TIMESTAMP.test(v) ? v : null;
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
      let reusable = true;
      try {
        // Every statement read-only (the server refuses writes and DDL alike), at most maxRows rows sent, and the
        // time limit. The connection is reset before it returns to the pool.
        await conn.query("SET SESSION TRANSACTION READ ONLY");
        const settings = [
          ...(options.maxRows !== undefined ? [`sql_select_limit = ${Math.max(0, Math.floor(options.maxRows))}`] : []),
          ...(options.timeoutMs ? [limitTime(options.timeoutMs)] : []),
        ];
        if (settings.length) await conn.query(`SET SESSION ${settings.join(", ")}`);
        let result;
        try {
          result = await readRows(conn, sql, params, options.maxRows);
        } catch (e) {
          const code = (e as { code?: string; errno?: number }).code;
          // ER_QUERY_TIMEOUT (MySQL), ER_STATEMENT_TIMEOUT (MariaDB)
          if (options.timeoutMs && (code === "ER_QUERY_TIMEOUT" || code === "ER_STATEMENT_TIMEOUT" || (e as { errno?: number }).errno === 3024 || (e as { errno?: number }).errno === 1969)) {
            throw new Error(timeoutMessage(options.timeoutMs));
          }
          throw e;
        }
        const { rows, fields, over } = result;
        if (over) reusable = false;
        if (!fields) throw new Error("結果の表がありません（SELECT か WITH で始まる文だけ使えます）");
        checkColumnNames(fields.map((f) => f.name));
        const columns = fields.map((f): ResultColumn => ({ name: f.name, type: typeOf(f) }));
        return { columns, rows: rows.map((r) => r.map((v, i) => valueOf(v, columns[i]!.type, fields[i]!))) };
      } finally {
        try {
          if (!reusable) throw new Error("closed mid-result");
          // back to the server's settings: the transaction mode, the limits, user variables, GET_LOCK() locks
          await conn.reset();
          await conn.query("SET NAMES utf8mb4");
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
