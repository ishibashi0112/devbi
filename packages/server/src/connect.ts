import path from "node:path";

/** The kind of values in a result column, as DevBI hands them on in Arrow. */
export type ColumnType = "string" | "int" | "float" | "bool" | "date" | "timestamp";

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
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/** A column's type from its values, when the database gives none: numbers, booleans, otherwise text. */
function typeOfValues(values: unknown[]): ColumnType {
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
  return type ?? "string";
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
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup !== undefined) throw new Error(`列名が重なっています: ${dup}（AS で別の名前を付けてください）`);
      const objects = stmt.all(...(params as never[])) as Record<string, unknown>[];
      const rows = objects.map((o) => names.map((n) => o[n]));
      const columns = info.map((c, i): ResultColumn => {
        const values = rows.map((r) => r[i]);
        // SQLite keeps dates as text; the declared type of a table column (DATE, DATETIME) says to read them as dates.
        const declared = (c.type ?? "").toUpperCase();
        if (/DATE|TIME/.test(declared) && values.every((v) => v === null || typeof v === "string")) {
          const strings = values.filter((v): v is string => v !== null);
          if (strings.every((v) => DATE.test(v))) return { name: c.name, type: "date" };
          if (strings.every((v) => DATE.test(v) || TIMESTAMP.test(v))) return { name: c.name, type: "timestamp" };
        }
        const byValues = typeOfValues(values);
        // A declared REAL / NUMERIC column stays a decimal even when this result's values happen to be whole.
        if (byValues === "int" && /REAL|FLOA|DOUB|NUM|DEC/.test(declared)) return { name: c.name, type: "float" };
        if (byValues === "int" && /BOOL/.test(declared) && values.every((v) => v === null || v === 0 || v === 1 || v === 0n || v === 1n)) {
          for (const r of rows) if (r[i] !== null) r[i] = r[i] === 1 || r[i] === 1n;
          return { name: c.name, type: "bool" };
        }
        return { name: c.name, type: byValues };
      });
      for (const row of rows) {
        for (let i = 0; i < row.length; i++) {
          const v = row[i];
          if (typeof v === "bigint" && Number.isSafeInteger(Number(v))) row[i] = Number(v);
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
        await client.query("BEGIN READ ONLY");
        if (options?.timeoutMs) await client.query(`SET LOCAL statement_timeout = ${Math.round(options.timeoutMs)}`);
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
