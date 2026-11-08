// Oracle Database, through node-oracledb (Thin mode, or Thick mode with Oracle Instant Client). Connecting and
// Thick mode come from ashiato's adapter (src/adapters/oracle.ts, MIT, same author).
import { base64, checkColumnNames, decimalNumber, loadDriver, localText, timeoutMessage, typeOfValues, wholeNumber, type ColumnType, type Connection, type ResultColumn } from "./result.js";

type OracleDb = typeof import("oracledb");
type Metadata = import("oracledb").Metadata<unknown>;

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/**
 * client=thick: node-oracledb Thick mode, through Oracle Instant Client (libDir=its folder, otherwise it is looked
 * for on PATH). Needed for what Thin mode can't do: passwords of the old 10G kind, Native Network Encryption
 * required by the server, Oracle Database 11g.
 */
function useThickMode(oracledb: OracleDb, url: URL): boolean {
  const client = url.searchParams.get("client")?.toLowerCase();
  if (!client || client === "thin") return false;
  if (client !== "thick") throw new Error(`client=${client} は使えません。Oracle Instant Client を使うときは client=thick、使わないときは書きません`);
  const libDir = url.searchParams.get("libDir") ?? undefined;
  try {
    // can be called again with the same folder; Thin mode can't be switched to Thick once it has connected
    oracledb.initOracleClient(libDir ? { libDir } : {});
  } catch (e) {
    throw new Error(`client=thick には Oracle Instant Client が要ります（${libDir ? `${libDir} の中` : "PATH の上、または URL の libDir=<フォルダ>"}）: ${(e as Error).message}`);
  }
  return true;
}

/**
 * A full connect descriptor. Thick mode reads host:port/service through the Instant Client's naming methods, and
 * ORA-12154 follows where sqlnet.ora leaves EZCONNECT out; a descriptor needs none.
 */
function connectDescriptor(host: string, port: string, service: string): string {
  for (const [label, value] of [
    ["ホスト", host],
    ["サービス名", service],
  ] as const) {
    // these would start another part of the descriptor
    if (!value || /[()=\s]/.test(value)) throw new Error(`Oracle の${label}「${value}」が空か、括弧・=・空白を含んでいます`);
  }
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SERVICE_NAME=${service})))`;
}

/** Errors Thin mode gives where Thick mode connects: they say what to add to the URL. */
function thinModeHint(e: unknown): unknown {
  if (!(e instanceof Error) || !/^NJS-(116|138|533)\b/.test(e.message)) return e;
  return new Error(`${e.message}\nこのデータベースには Thin モードでつなげません。URL に client=thick を足してください（Oracle Instant Client が要ります）`);
}

/**
 * oracle://user:password@host:1521/serviceName — `?schema=OWNER` reads names without an owner as OWNER's tables;
 * `?client=thick` (and `libDir=`) uses Oracle Instant Client.
 */
export async function connectOracle(url: URL): Promise<Connection> {
  const oracledb = await loadDriver<OracleDb>("oracledb", "Oracle");
  const thick = useThickMode(oracledb, url);
  const service = decodeURIComponent(url.pathname).replace(/^\//, "");
  const schema = url.searchParams.get("schema")?.toUpperCase();
  const pool = await oracledb.createPool({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectString: thick ? connectDescriptor(url.hostname, url.port || "1521", service) : `${url.hostname}:${url.port || 1521}/${service}`,
    poolMin: 0,
    poolMax: 4,
    // checks a connection before use when it was idle, and reconnects after a restart or an idle timeout
    poolPingInterval: 10,
    // Once per new connection: text like '2024-04-01' (a read_api parameter) compared with a DATE reads in ISO form,
    // whatever the server's or client's NLS settings; and names without an owner are ?schema='s tables.
    sessionCallback: (conn: import("oracledb").Connection, _tag: string, done: (e?: Error) => void) => {
      const nls =
        "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'" +
        " NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'";
      conn
        .execute(nls)
        .then(() => (schema ? conn.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${q(schema)}`) : undefined))
        .then(
          () => done(),
          (e: Error) => done(e),
        );
    },
  });
  try {
    // connect now, so that a wrong password or a mode that can't connect shows up here
    await (await pool.getConnection()).close();
  } catch (e) {
    await pool.close(0).catch(() => undefined);
    throw thinModeHint(e);
  }

  // NUMBER as text (the driver's double would round large IDs and long decimals); DATE and TIMESTAMP are Dates the
  // driver builds from the stored wall-clock time in the process's time zone, so their local fields are that time.
  const fetchTypeHandler = (meta: Metadata) => {
    switch (meta.dbType) {
      case oracledb.DB_TYPE_NUMBER:
        return { type: oracledb.STRING };
      case oracledb.DB_TYPE_DATE:
      case oracledb.DB_TYPE_TIMESTAMP:
      case oracledb.DB_TYPE_TIMESTAMP_TZ:
      case oracledb.DB_TYPE_TIMESTAMP_LTZ:
        return { converter: (d: unknown) => (d instanceof Date ? localText(d) : d) };
      case oracledb.DB_TYPE_CLOB:
      case oracledb.DB_TYPE_NCLOB:
        return { type: oracledb.STRING };
      case oracledb.DB_TYPE_BLOB:
        return { type: oracledb.BUFFER };
      default:
        return undefined;
    }
  };

  const typeOf = (m: Metadata, values: unknown[]): ColumnType => {
    switch (m.dbType) {
      case oracledb.DB_TYPE_NUMBER: {
        // NUMBER(10) and NUMBER(10,0) hold whole numbers; NUMBER and expressions (SUM(…)) go by their values
        if (m.scale === 0 && (m.precision ?? 0) > 0) return "int";
        if ((m.scale ?? 0) > 0) return "float";
        return typeOfValues(values.map((v) => (typeof v === "string" ? decimalNumber(v) : v))) ?? "float";
      }
      case oracledb.DB_TYPE_BINARY_FLOAT:
      case oracledb.DB_TYPE_BINARY_DOUBLE:
        return "float";
      case oracledb.DB_TYPE_BOOLEAN:
        return "bool";
      case oracledb.DB_TYPE_DATE:
        // Oracle's DATE has a time: a date when no value has one (so a column of order dates stays dates)
        return values.every((v) => v === null || (typeof v === "string" && v.endsWith(" 00:00:00"))) ? "date" : "timestamp";
      case oracledb.DB_TYPE_TIMESTAMP:
      case oracledb.DB_TYPE_TIMESTAMP_TZ:
      case oracledb.DB_TYPE_TIMESTAMP_LTZ:
        return "timestamp";
      default:
        return "string";
    }
  };
  const valueOf = (v: unknown, type: ColumnType): unknown => {
    if (v === null || v === undefined) return null;
    switch (type) {
      case "int":
        return typeof v === "string" ? wholeNumber(v.replace(/\.0*$/, "")) : v;
      case "float":
        return typeof v === "string" ? Number(v) : v;
      case "date":
        return String(v).slice(0, 10);
      case "string":
        if (v instanceof Uint8Array) return base64(v);
        return typeof v === "object" ? JSON.stringify(v) : String(v);
      default:
        return v;
    }
  };

  const run = async (sql: string, params: unknown[], options: { timeoutMs?: number; maxRows?: number }) => {
    const conn = await pool.getConnection();
    try {
      // Oracle refuses to change anything in a read-only transaction (ORA-01456)
      await conn.execute("SET TRANSACTION READ ONLY");
      if (options.timeoutMs) conn.callTimeout = Math.max(1, Math.round(options.timeoutMs));
      // Oracle's SQL has no booleans before 23ai: 1 and 0
      const binds = Object.fromEntries(params.map((v, i) => [`p${i + 1}`, typeof v === "boolean" ? (v ? 1 : 0) : v])) as import("oracledb").BindParameters;
      let res;
      try {
        res = await conn.execute(sql, binds, {
          outFormat: oracledb.OUT_FORMAT_ARRAY,
          // 0: all rows
          maxRows: options.maxRows ?? 0,
          fetchTypeHandler,
        });
      } catch (e) {
        // DPI-1067 / NJS-123: the call took longer than callTimeout
        if (options.timeoutMs && /^(DPI-1067|NJS-123|ORA-03156)\b/.test((e as Error).message)) throw new Error(timeoutMessage(options.timeoutMs));
        throw e;
      }
      const meta = res.metaData ?? [];
      const rows = (res.rows ?? []) as unknown[][];
      checkColumnNames(meta.map((m) => m.name));
      const columns = meta.map((m, i): ResultColumn => ({ name: m.name, type: typeOf(m, rows.map((r) => r[i])) }));
      return { columns, rows: rows.map((r) => r.map((v, i) => valueOf(v, columns[i]!.type))) };
    } finally {
      await conn.rollback().catch(() => undefined);
      conn.callTimeout = 0;
      // a connection that timed out cannot be used again: drop it from the pool
      await conn.close({ drop: Boolean(options.timeoutMs) && !conn.isHealthy() }).catch(() => undefined);
    }
  };

  return {
    dialect: "oracle",
    async query(sql, params, options = {}) {
      try {
        return await run(sql, params, options);
      } catch (e) {
        // ORA-01466: a read-only transaction can't read a table created or altered within the last second
        if (!(e instanceof Error) || !e.message.startsWith("ORA-01466")) throw e;
        await new Promise((r) => setTimeout(r, 1100));
        return run(sql, params, options);
      }
    },
    async close() {
      await pool.close(0);
    },
  };
}
