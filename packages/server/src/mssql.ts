// SQL Server, through the mssql package (tedious). The connection options come from ashiato's adapter
// (src/adapters/mssql.ts, MIT, same author).
import { base64, checkColumnNames, loadDriver, timeoutMessage, typeOfValues, utcText, wholeNumber, type ColumnType, type Connection, type ResultColumn } from "./result.js";

type Mssql = typeof import("mssql");

/**
 * mssql://user:password@host:1433/database — SQL Server authentication. In the query string: `instance=` (a named
 * instance, through SQL Browser), `encrypt=true`, `trustServerCertificate=false`, `applicationIntent=ReadOnly`
 * (an Always On readable secondary).
 */
export async function connectMssql(url: URL): Promise<Connection> {
  const mssql = await loadDriver<Mssql>("mssql", "SQL Server");
  const params = url.searchParams;
  const instance = params.get("instance") ?? undefined;
  const pool = new mssql.ConnectionPool({
    server: url.hostname,
    // a named instance's port comes from SQL Browser unless the URL gives one
    ...(url.port || !instance ? { port: url.port ? Number(url.port) : 1433 } : {}),
    user: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined,
    // DevBI stops a query itself after its time limit (query below); none from the driver.
    requestTimeout: 0,
    pool: { max: 4, min: 0, idleTimeoutMillis: 60_000 },
    options: {
      encrypt: params.get("encrypt") === "true",
      trustServerCertificate: params.get("trustServerCertificate") !== "false",
      ...(instance ? { instanceName: instance } : {}),
      readOnlyIntent: params.get("applicationIntent")?.toLowerCase() === "readonly",
      // Date and time columns as Dates holding the stored wall-clock time in UTC: written back as that text.
      useUTC: true,
    },
  });
  // Without a listener, a connection the server closes would crash the process.
  pool.on("error", () => undefined);
  await pool.connect();

  const T = mssql.TYPES;
  const typeOf = (type: unknown, values: unknown[]): ColumnType => {
    if (type === T.Int || type === T.SmallInt || type === T.TinyInt || type === T.BigInt) return "int";
    if (type === T.Bit) return "bool";
    if (type === T.Float || type === T.Real || type === T.Decimal || type === T.Numeric || type === T.Money || type === T.SmallMoney) return "float";
    if (type === T.Date) return "date";
    if (type === T.DateTime || type === T.DateTime2 || type === T.SmallDateTime || type === T.DateTimeOffset) return "timestamp";
    // sql_variant: whatever its values are
    if (type === T.Variant) return typeOfValues(values.map((v) => (v instanceof Date ? "" : v))) ?? "string";
    return "string";
  };
  const valueOf = (v: unknown, type: ColumnType): unknown => {
    if (v === null || v === undefined) return null;
    switch (type) {
      case "int":
        // BIGINT comes as text
        return typeof v === "string" ? wholeNumber(v) : v;
      case "date":
        return v instanceof Date ? utcText(v, false) : String(v);
      case "timestamp":
        // DATETIMEOFFSET is a moment: its UTC time
        return v instanceof Date ? utcText(v) : String(v);
      case "string":
        if (v instanceof Date) return utcText(v).slice(11); // TIME
        if (v instanceof Uint8Array) return base64(v);
        return String(v);
      default:
        return v;
    }
  };

  return {
    dialect: "mssql",
    async query(sql, values, options = {}) {
      // SQL Server has no read-only transaction: the statement was checked to be a SELECT, the user should be
      // granted SELECT only, and it runs in a transaction that is always rolled back.
      const tx = new mssql.Transaction(pool);
      await tx.begin();
      const req = new mssql.Request(tx);
      values.forEach((v, i) => (v === null ? req.input(`p${i + 1}`, mssql.NVarChar, null) : req.input(`p${i + 1}`, v)));
      // Streamed, so that reading stops at the row limit.
      req.stream = true;
      req.arrayRowMode = true;
      let types: unknown[] = [];
      let names: string[] = [];
      let sets = 0;
      let full = false;
      let timedOut = false;
      let error: Error | undefined;
      const rows: unknown[][] = [];
      req.on("recordset", (cols: { name: string; type: unknown }[]) => {
        // only the first result (SELECT 1 SELECT 2 without a semicolon returns two)
        if (++sets > 1) return;
        names = cols.map((c) => c.name);
        types = cols.map((c) => c.type);
      });
      req.on("row", (row: unknown[]) => {
        if (sets !== 1 || full) return;
        rows.push(row);
        if (options.maxRows !== undefined && rows.length >= options.maxRows) {
          full = true;
          req.cancel();
        }
      });
      req.on("error", (e: Error) => {
        if (!full && !timedOut) error ??= e;
      });
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            req.cancel();
          }, options.timeoutMs)
        : undefined;
      try {
        // in stream mode the promise settles after the "done" event, errors having gone to "error"
        await req.query(sql).catch((e: Error) => {
          if (!full && !timedOut) error ??= e;
        });
      } finally {
        if (timer) clearTimeout(timer);
        // fails when the server already ended the transaction (a severe error): nothing is left to undo
        await tx.rollback().catch(() => undefined);
      }
      if (timedOut && !full) throw new Error(timeoutMessage(options.timeoutMs!));
      if (error) throw error;
      checkColumnNames(names);
      const columns = names.map((name, i): ResultColumn => ({ name, type: typeOf(types[i], rows.map((r) => r[i])) }));
      return { columns, rows: rows.map((r) => r.map((v, i) => valueOf(v, columns[i]!.type))) };
    },
    async close() {
      await pool.close();
    },
  };
}
