import path from "node:path";

/**
 * The kind of values in a result column, as DevBI hands them on in Arrow. `null`: nothing tells the type (a SQLite
 * expression with no rows, or only NULLs); it becomes DuckDB's NULL type, which every function and comparison takes.
 */
export type ColumnType = "string" | "int" | "float" | "bool" | "date" | "timestamp" | "null";

export interface ResultColumn {
  name: string;
  type: ColumnType;
}

export interface ResultSet {
  columns: ResultColumn[];
  /**
   * Values per row, in column order: string, number, bigint, boolean or null. Dates are `YYYY-MM-DD` text and
   * timestamps `YYYY-MM-DD HH:MM:SS[.fff]` text (the database's own wall-clock time).
   */
  rows: unknown[][];
}

export type Dialect = "sqlite" | "postgres";

/** A read-only connection to one database. */
export interface Connection {
  dialect: Dialect;
  /**
   * Run one SELECT with its parameters already in the database's placeholder style. Gives up after
   * `timeoutMs` where the database supports it (PostgreSQL).
   */
  query(sql: string, params: unknown[], options?: { timeoutMs?: number }): Promise<ResultSet>;
  close(): Promise<void>;
}

/** Drivers are optional peer dependencies: install only the one for your database. (From ashiato.) */
export async function loadDriver<T>(pkg: string, label: string): Promise<T> {
  try {
    const mod = (await import(pkg)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch (e) {
    const base = pkg.split("/")[0];
    throw new Error(`${label} につなぐには ${base} が要ります。npm install ${base} で入れてください（${(e as Error).message}）`);
  }
}

/** The dialect of a connection URL, without connecting. Undefined when DevBI cannot read it yet. */
export function dialectOf(connection: string): Dialect | undefined {
  if (connection.startsWith("sqlite:")) return "sqlite";
  const scheme = /^([a-z]+):/i.exec(connection)?.[1]?.toLowerCase();
  return scheme === "postgres" || scheme === "postgresql" ? "postgres" : undefined;
}

/**
 * Open a read-only connection from a URL:
 *   sqlite:db/sales.sqlite                 (a relative path is read from `baseDir`)
 *   postgres://user:pass@host:5432/database
 */
export async function connect(connection: string, baseDir = process.cwd()): Promise<Connection> {
  if (connection.startsWith("sqlite:")) {
    const file = connection.slice("sqlite:".length).replace(/^\/\//, "");
    return connectSqlite(path.resolve(baseDir, file));
  }
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new Error("接続先の URL を読めません（例: postgres://user:pass@host:5432/db、sqlite:db/sales.sqlite）");
  }
  switch (url.protocol) {
    case "postgres:":
    case "postgresql:":
      return connectPostgres(url);
    case "mssql:":
    case "sqlserver:":
    case "oracle:":
    case "mysql:":
    case "mariadb:":
      throw new Error(`${url.protocol.slice(0, -1)} にはまだつなげません（今は sqlite: と postgres: だけ）`);
    default:
      throw new Error(`この接続先は使えません: ${url.protocol}（sqlite: か postgres: で書いてください）`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A date and time, with an optional time zone (`Z`, `+09:00`) that DevBI drops: the wall-clock time stays as written. */
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:\s*(?:Z|[+-]\d{2}(?::?\d{2})?))?$/i;

/** A column's type from its values, when they say: numbers, booleans, otherwise text. Undefined when all are NULL. */
function typeOfValues(values: unknown[]): ColumnType | undefined {
  let type: ColumnType | undefined;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    let t: ColumnType;
    if (typeof v === "bigint") t = "int";
    else if (typeof v === "number") t = Number.isInteger(v) ? "int" : "float";
    else if (typeof v === "boolean") t = "bool";
    else return "string";
    if (type === undefined || type === t) type = t;
    else if ((type === "int" && t === "float") || (type === "float" && t === "int")) type = "float";
    else return "string";
  }
  return type;
}

/**
 * The type a SQLite table column was declared with (CREATE TABLE … amount REAL), in DevBI's terms, following
 * SQLite's own rules for reading type names. Undefined for expressions (SUM(…), CAST(…)) and untyped columns.
 */
export function sqliteDeclaredType(declared: string | null | undefined): ColumnType | undefined {
  const d = (declared ?? "").toUpperCase();
  if (!d) return undefined;
  if (/BOOL/.test(d)) return "bool";
  if (/DATETIME|TIMESTAMP/.test(d)) return "timestamp";
  if (/DATE/.test(d)) return "date";
  if (/INT/.test(d)) return "int";
  if (/CHAR|CLOB|TEXT/.test(d)) return "string";
  if (/BLOB/.test(d)) return undefined;
  if (/REAL|FLOA|DOUB|NUM|DEC/.test(d)) return "float";
  return undefined;
}

/** One SQLite result column's type: from the values, with the declared type deciding what they cannot. */
function sqliteColumnType(declared: ColumnType | undefined, values: unknown[]): ColumnType {
  const byValues = typeOfValues(values);
  // SQLite keeps dates as text: a column declared DATE / DATETIME reads its text as dates when it is all dates.
  if ((declared === "date" || declared === "timestamp") && (byValues === undefined || byValues === "string")) {
    const strings = values.filter((v): v is string => typeof v === "string");
    if (strings.length === values.filter((v) => v !== null && v !== undefined).length) {
      if (declared === "date" && strings.every((v) => DATE.test(v))) return "date";
      if (strings.every((v) => DATE.test(v) || TIMESTAMP.test(v))) return "timestamp";
    }
  }
  // No values to go by (no rows, or all NULL): the declared type, so the column keeps its type in DuckDB.
  if (byValues === undefined) return declared ?? "null";
  // A declared REAL / NUMERIC column stays a decimal even when this result's values happen to be whole.
  if (byValues === "int" && declared === "float") return "float";
  if (byValues === "int" && declared === "bool" && values.every((v) => v === null || v === 0 || v === 1 || v === 0n || v === 1n)) return "bool";
  return byValues;
}

async function connectSqlite(file: string): Promise<Connection> {
  const { DatabaseSync } = await import("node:sqlite");
  // Read-only, and wait a little for an app's write lock instead of failing at once.
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  return {
    dialect: "sqlite",
    async query(sql, params) {
      const stmt = db.prepare(sql);
      // Integers beyond 2^53 would otherwise throw.
      stmt.setReadBigInts(true);
      const info = stmt.columns();
      const names = info.map((c) => c.name);
      // From a subquery (the row limit around the SQL), SQLite names a second `id` "id:1".
      const dup = names.find((n, i) => names.indexOf(n) !== i || names.includes(/^(.*):\d+$/.exec(n)?.[1] ?? "\0"));
      if (dup !== undefined) throw new Error(`列名が重なっています: ${dup.replace(/:\d+$/, "")}（AS で別の名前を付けてください）`);
      const objects = stmt.all(...(params as never[])) as Record<string, unknown>[];
      const rows = objects.map((o) => names.map((n) => o[n]));
      const columns = info.map((c, i): ResultColumn => ({ name: c.name, type: sqliteColumnType(sqliteDeclaredType(c.type), rows.map((r) => r[i])) }));
      for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
          const v = row[i];
          const type = columns[i]!.type;
          if (v === null || v === undefined) continue;
          if (type === "bool") row[i] = v === 1 || v === 1n;
          else if (type === "timestamp" && typeof v === "string") row[i] = TIMESTAMP.exec(v)?.[1] ?? v;
          else if (typeof v === "bigint" && Number.isSafeInteger(Number(v))) row[i] = Number(v);
          else if (v instanceof Uint8Array) row[i] = Buffer.from(v).toString("base64");
        }
      }
      return { columns, rows };
    },
    async close() {
      db.close();
    },
  };
}

/** PostgreSQL type ids → DevBI's column types. Everything else is text (as psql shows it). */
const PG_TYPES: Record<number, ColumnType> = {
  16: "bool",
  20: "int",
  21: "int",
  23: "int",
  26: "int",
  700: "float",
  701: "float",
  1700: "float",
  1082: "date",
  1114: "timestamp",
  1184: "timestamp",
};

function pgValue(text: string, type: ColumnType): unknown {
  switch (type) {
    case "bool":
      return text === "t";
    case "int": {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : BigInt(text);
    }
    case "float":
      return text === "NaN" || text === "Infinity" || text === "-Infinity" ? null : Number(text);
    case "date":
      return DATE.test(text) ? text : null; // infinity, BC dates
    case "timestamp": {
      // timestamptz comes in the session's time zone with its offset: keep the wall-clock time, as psql shows it.
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?)/.exec(text);
      return m ? m[1] : null;
    }
    default:
      return text;
  }
}

async function connectPostgres(url: URL): Promise<Connection> {
  const pg = await loadDriver<typeof import("pg")>("pg", "PostgreSQL");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 4,
    // Every value as the server's text; DevBI turns it into numbers and dates itself (pg's Date would move
    // DATE and TIMESTAMP by the Node process's time zone).
    types: { getTypeParser: (() => (v: string) => v) as unknown as typeof pg.types.getTypeParser },
  });
  // Without a listener, an idle connection being closed by the server would crash the process.
  pool.on("error", () => undefined);
  return {
    dialect: "postgres",
    async query(sql, params, options) {
      const client = await pool.connect();
      try {
        // A read-only transaction: the server refuses any write, whatever the SQL says.
        // and dates in ISO form whatever the database's or user's DateStyle is (DevBI reads them as text).
        const timeout = options?.timeoutMs ? `; SET LOCAL statement_timeout = ${Math.round(options.timeoutMs)}` : "";
        await client.query(`BEGIN READ ONLY; SET LOCAL DateStyle = ISO; SET LOCAL IntervalStyle = postgres${timeout}`);
        const res = await client.query({ text: sql, values: params, rowMode: "array" });
        await client.query("COMMIT");
        const names = res.fields.map((f) => f.name);
        const dup = names.find((n, i) => names.indexOf(n) !== i);
        if (dup !== undefined) throw new Error(`列名が重なっています: ${dup}（AS で別の名前を付けてください）`);
        const columns = res.fields.map((f): ResultColumn => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? "string" }));
        const rows = (res.rows as (string | null)[][]).map((r) => r.map((v, i) => (v === null ? null : pgValue(v, columns[i]!.type))));
        return { columns, rows };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
