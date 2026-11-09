// Tile queries written in Malloy or SQL (`query.malloy`, `query.sql`): for what the metrics' names cannot say. The
// metrics files they name are their tables (Malloy sources): each one's model rows, filtered by the period and the
// other tiles' selections. Malloy is compiled to SQL here (in the browser, or in Node for devbi-check), against the
// columns DuckDB describes; DuckDB runs the SQL with the rows in front as CTEs.
import { plainColumn, QueryError } from "./compile.js";
import type { MetricsView } from "./metrics.js";
import { ident } from "./sql.js";
import { GRAINS, type FieldInfo, type Grain, type Query } from "./types.js";

export type CustomLang = "malloy" | "sql";

/** A tile query written in Malloy or SQL: which, and its text. */
export function customQuery(query: Query | null | undefined): { lang: CustomLang; text: string } | undefined {
  if (!query) return undefined;
  if (typeof query.malloy === "string") return { lang: "malloy", text: query.malloy };
  if (typeof query.sql === "string") return { lang: "sql", text: query.sql };
  return undefined;
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;

/** A token of Malloy or SQL text: a word, a quoted name ("…" in SQL, `…` in Malloy), or a sign (`(`, `,`, `->`). */
interface Token {
  kind: "word" | "quoted" | "sign";
  text: string;
}

/** Malloy or SQL text as tokens, without strings and comments; `end` is where the last of them (not `;`) ends. */
function tokenize(lang: CustomLang, text: string): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  const quote = lang === "sql" ? '"' : "`";
  let i = 0;
  let end = 0;
  const skipTo = (close: string, from: number) => {
    const at = text.indexOf(close, from);
    return at < 0 ? text.length : at + close.length;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if ((ch === "-" && text[i + 1] === "-") || (lang === "malloy" && ch === "/" && text[i + 1] === "/")) {
      i = skipTo("\n", i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = skipTo("*/", i + 2);
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (lang === "malloy" && text.startsWith('"""', i)) {
      i = skipTo('"""', i + 3);
    } else if (ch === "'" || (lang === "malloy" && ch === '"')) {
      i++;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" && lang === "malloy" ? 2 : 1;
      i++; // SQL's '' is two strings in a row: the same tokens
    } else if (ch === quote) {
      let name = "";
      i++;
      while (i < text.length) {
        if (text[i] === quote) {
          if (lang === "sql" && text[i + 1] === quote) {
            name += quote;
            i += 2;
            continue;
          }
          break;
        }
        name += text[i++];
      }
      i++;
      tokens.push({ kind: "quoted", text: name });
    } else if (IDENT_START.test(ch)) {
      const start = i;
      while (i < text.length && IDENT_PART.test(text[i]!)) i++;
      tokens.push({ kind: "word", text: text.slice(start, i) });
    } else if (ch === "-" && text[i + 1] === ">") {
      tokens.push({ kind: "sign", text: "->" });
      i += 2;
    } else {
      tokens.push({ kind: "sign", text: ch });
      i++;
    }
    if (ch !== ";") end = Math.min(i, text.length);
  }
  return { tokens, end };
}

/** The names in Malloy or SQL text, outside strings and comments: words, and quoted names ("…" in SQL, `…` in Malloy). */
export function customWords(lang: CustomLang, text: string): string[] {
  return tokenize(lang, text)
    .tokens.filter((t) => t.kind !== "sign")
    .map((t) => t.text);
}

const isSign = (t: Token | undefined, sign: string) => t?.kind === "sign" && t.text === sign;
const isWord = (t: Token | undefined, words: ReadonlySet<string>) => t?.kind === "word" && words.has(t.text.toLowerCase());

const SQL_FROM = new Set(["from", "join", "pivot", "unpivot"]);
const SQL_QUERY = new Set(["select", "from", "with", "values", "table", "pivot", "unpivot"]);
const AS = new Set(["as"]);

/**
 * The tables SQL reads: the names after FROM and JOIN (and after a comma in a FROM list), not those of table functions
 * (`read_csv(…)`), qualified names, or FROM inside a function's parentheses (`EXTRACT(year FROM d)`).
 */
function sqlTables(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  const query: boolean[] = [true]; // for each parenthesis, whether a query is inside (where FROM names tables)
  let expect = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isSign(t, "(")) {
      const next = tokens[i + 1];
      query.push(isSign(next, "(") || isWord(next, SQL_QUERY));
      expect = false;
    } else if (isSign(t, ")")) {
      if (query.length > 1) query.pop();
      expect = false;
    } else if (isWord(t, SQL_FROM)) {
      expect = query.at(-1)!;
    } else if (expect) {
      expect = false;
      if (t.kind === "sign" || isSign(tokens[i + 1], "(") || isSign(tokens[i + 1], ".")) continue;
      out.push(t.text);
      // FROM a [AS] [x], b
      let j = i + 1;
      if (isWord(tokens[j], AS)) j++;
      if (tokens[j] && tokens[j]!.kind !== "sign") j++;
      if (isSign(tokens[j], ",")) {
        expect = true;
        i = j;
      }
    }
  }
  return out;
}

const MALLOY_EXTEND = new Set(["extend", "include"]);
const MALLOY_JOIN = new Set(["join_one", "join_many", "join_cross"]);
const MALLOY_DEFINE = new Set([...MALLOY_JOIN, "source"]);

/**
 * The sources Malloy reads: a name before `->`, `extend` or `include`, or the source of `join_one: x` or
 * `join_one: / source: y is x`.
 */
function malloySources(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "sign") return;
    const next = tokens[i + 1];
    if (
      isSign(next, "->") ||
      isWord(next, MALLOY_EXTEND) ||
      (isSign(tokens[i - 1], ":") && isWord(tokens[i - 2], MALLOY_JOIN)) ||
      (tokens[i - 1]?.kind === "word" &&
        tokens[i - 1]!.text === "is" &&
        tokens[i - 2]?.kind !== "sign" &&
        isSign(tokens[i - 3], ":") &&
        isWord(tokens[i - 4], MALLOY_DEFINE))
    )
      out.push(t.text);
  });
  return out;
}

/**
 * The metrics views a Malloy or SQL query reads: its `metrics`, then the ones it reads as tables (SQL: after FROM and
 * JOIN, names in any case; Malloy: as sources, before `->`). Empty for a query written with the metrics' names.
 */
export function customViews(query: Query, names: readonly string[]): string[] {
  const custom = customQuery(query);
  if (!custom) return [];
  const key = (n: string) => (custom.lang === "sql" ? n.toLowerCase() : n);
  const byKey = new Map(names.map((n) => [key(n), n]));
  const out = new Set<string>();
  if (query.metrics && names.includes(query.metrics)) out.add(query.metrics);
  const { tokens } = tokenize(custom.lang, custom.text);
  for (const w of custom.lang === "sql" ? sqlTables(tokens) : malloySources(tokens)) {
    const n = byKey.get(key(w));
    if (n) out.add(n);
  }
  return [...out];
}

/** The view a Malloy or SQL query's `filters` and clicks are on: its `metrics`, else the only view it reads. */
export function customMainView(query: Query, views: readonly string[]): string | undefined {
  return query.metrics ?? (views.length === 1 ? views[0] : undefined);
}

/** The name a view's rows have in the SQL that Malloy writes (and in the SQL query, the view's own name). */
export function customTable(lang: CustomLang, view: string): string {
  return ident(lang === "malloy" ? `__devbi_rows_${view}` : view);
}

/** `sql` with the views' rows in front of it, as CTEs (joined to its own WITH, if it has one). */
export function withSources(sql: string, sources: readonly { table: string; sql: string }[]): string {
  // Without what follows the last statement (`;`, comments): the SQL is put inside DESCRIBE SELECT * FROM (…).
  const body = sql.slice(0, tokenize("sql", sql).end).trim();
  if (!sources.length) return body;
  const ctes = sources
    .map(
      (s) =>
        `${s.table} AS (\n${s.sql
          .split("\n")
          .map((l) => (l ? `  ${l}` : l))
          .join("\n")}\n)`,
    )
    .join(",\n");
  const lead = /^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))*\s*/.exec(body)![0];
  const rest = body.slice(lead.length);
  const own = /^with(\s+recursive)?\s/i.exec(rest);
  if (own) return `${lead}WITH${own[1] ? " RECURSIVE" : ""} ${ctes},\n${rest.slice(own[0].length)}`;
  return `${lead}WITH ${ctes}\n${rest}`;
}

/** A column of a Malloy or SQL query's result. */
export interface ResultColumn {
  name: string;
  type: "number" | "string" | "date" | "timestamp" | "boolean" | "other";
  /** Malloy: grouped by, or aggregated. */
  kind?: "dimension" | "measure";
  /** Malloy: the source's column it is, and the unit it was truncated to (`month`). */
  source?: { column: string; truncation?: string };
}

/** A view's rows for {@link compileMalloy}: its name, the table the SQL reads them from, and their columns' DuckDB types. */
export interface MalloySource {
  name: string;
  table: string;
  schema: Readonly<Record<string, string>>;
}

/**
 * Compile a Malloy query to DuckDB SQL: `source: <view> is duckdb.table(…)` for each view, then the text (`run:` may
 * be left out). Malloy is loaded when first used (its own chunk in the browser).
 */
export async function compileMalloy(text: string, sources: readonly MalloySource[]): Promise<{ sql: string; columns: ResultColumn[] }> {
  const [malloy, connection] = await Promise.all([import("@malloydata/malloy"), import("@malloydata/malloy/connection")]);
  const dialect = new malloy.DuckDBDialect();
  const tables = new Map(sources.map((s) => [s.table, s.schema]));
  // Only the columns: DuckDB runs the SQL (with the rows in front), not Malloy.
  class Columns extends connection.BaseConnection {
    get name() {
      return "duckdb";
    }
    get dialectName() {
      return "duckdb";
    }
    getDigest() {
      return "devbi";
    }
    async runSQL(): Promise<never> {
      throw new Error("DevBI runs the SQL itself");
    }
    async fetchTableSchema(name: string, path: string) {
      const schema = tables.get(path);
      if (!schema) return `${path} はありません`;
      const fields = Object.entries(schema).map(([column, type]) => malloy.mkFieldDef(dialect.parseDuckDBType(type), column));
      return { type: "table" as const, name, dialect: "duckdb", tablePath: path, connection: "duckdb", fields };
    }
    async fetchSelectSchema(): Promise<string> {
      return "duckdb.sql(…) は使えません（指標ファイルの名前で読んでください）";
    }
  }
  const runtime = new malloy.SingleConnectionRuntime({ connection: new Columns() });
  // On one line, so that a problem's line is the line of the text.
  const head = sources.map((s) => `source: \`${s.name}\` is duckdb.table('${s.table.replaceAll("'", "\\'")}')`).join(" ");
  // `run:` when the text (after its comments) does not start with a statement.
  const body = /^(?:\s|\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)*(?:[A-Za-z_]\w*\s*:|import\b|#)/.test(text) ? text : `run: ${text}`;
  let prepared: Awaited<ReturnType<ReturnType<typeof runtime.loadQuery>["getPreparedResult"]>>;
  try {
    prepared = await runtime.loadQuery(`${head}\n${body}`).getPreparedResult();
  } catch (e) {
    throw new QueryError(malloyMessage(e));
  }
  const columns = prepared.resultExplore.structDef.fields.map((f): ResultColumn => {
    const meta = (f as { resultMetadata?: { fieldKind?: string; drillExpression?: Drill } }).resultMetadata;
    const type =
      f.type === "timestamptz"
        ? "timestamp"
        : ["number", "string", "date", "timestamp", "boolean"].includes(f.type)
          ? (f.type as ResultColumn["type"])
          : "other";
    if (type === "other")
      throw new QueryError(
        ["turtle", "array", "record"].includes(f.type)
          ? `Malloy: ${f.name} は表にできません（nest などは使えません。group_by と aggregate で書いてください）`
          : `Malloy: ${f.name} は表にできません（${f.type} の値は出せません）`,
      );
    const drill = meta?.drillExpression;
    const ref = drill?.kind === "time_truncation" ? drill.field_reference : drill?.kind === "field_reference" ? drill : undefined;
    return {
      name: f.name,
      type,
      ...(meta?.fieldKind === "measure"
        ? { kind: "measure" as const }
        : meta?.fieldKind === "dimension"
          ? { kind: "dimension" as const }
          : {}),
      ...(ref?.name && !ref.path?.length
        ? {
            source: {
              column: ref.name,
              ...(drill?.kind === "time_truncation" && drill.truncation ? { truncation: drill.truncation } : {}),
            },
          }
        : {}),
    };
  });
  return { sql: prepared.sql, columns };
}

type Drill =
  | { kind: "field_reference"; name?: string; path?: string[] }
  | { kind: "time_truncation"; field_reference?: { name?: string; path?: string[] }; truncation?: string }
  | { kind: string; name?: string; path?: string[]; field_reference?: undefined; truncation?: undefined };

/** Malloy's problem, with the line of the text it is on. */
function malloyMessage(e: unknown): string {
  const problems = (e as { problems?: { message: string; severity?: string; at?: { range?: { start?: { line?: number } } } }[] }).problems;
  const first = problems?.find((p) => p.severity !== "warn" && p.severity !== "debug") ?? problems?.[0];
  if (!first) return `Malloy: ${e instanceof Error ? e.message : String(e)}`;
  const line = first.at?.range?.start?.line;
  return `Malloy: ${first.message}${line ? `（${line} 行目）` : ""}`;
}

/** The SQL's result columns: their names and types as DuckDB gives them (Arrow's type names, or DuckDB's). */
export function sqlColumns(columns: readonly { name: string; type: string }[]): ResultColumn[] {
  return columns.map((c) => {
    const t = c.type.toLowerCase();
    const type: ResultColumn["type"] = /\[\d*\]$/.test(t) // DuckDB's lists and arrays (INTEGER[]), not Arrow's Decimal[18e2]
      ? "other"
      : /^(u?int(eger|\d+)?|u?(big|small|tiny|huge)int|float\d*|double|decimal|real|numeric)\b/.test(t)
        ? "number"
        : /^date/.test(t)
          ? "date"
          : /^timestamp/.test(t)
            ? "timestamp"
            : /^(utf8|varchar|largeutf8|string|text|char|bpchar)/.test(t) || /utf8>$/.test(t)
              ? "string"
              : /^bool/.test(t)
                ? "boolean"
                : "other";
    return { name: c.name, type };
  });
}

/**
 * How a Malloy or SQL result shows: the output name of each column (`names`, in order) and its field. A column that
 * is a dimension of `view` (its column, or its name) is named as that dimension (so a click on it filters the other
 * tiles) and labelled as it unless renamed; in Malloy, the view's time column (truncated) takes the time's name and
 * the unit as its grain. Measures (Malloy: what is aggregated; SQL: numbers) named like a measure of `view` take its
 * label and format.
 */
export function customFields(
  lang: CustomLang,
  columns: readonly ResultColumn[],
  view: MetricsView | undefined,
): { names: string[]; fields: FieldInfo[] } {
  const taken = new Set(columns.map((c) => c.name));
  const used = new Set<string>();
  const free = (name: string, own: string) => !used.has(name) && (name === own || !taken.has(name));
  const names: string[] = [];
  const fields: FieldInfo[] = [];
  const add = (name: string, field: Omit<FieldInfo, "name">) => {
    used.add(name);
    names.push(name);
    fields.push({ name, ...field });
  };
  for (const c of columns) {
    const measure = lang === "malloy" ? c.kind === "measure" : c.type === "number";
    const time = c.type === "date" || c.type === "timestamp";
    const src = c.source?.column ?? c.name;
    const grain =
      c.source?.truncation && (GRAINS as readonly string[]).includes(c.source.truncation) ? (c.source.truncation as Grain) : undefined;
    // Malloy's weeks start on Sunday, DevBI's on Monday: a week is a date of its own.
    if (
      lang === "malloy" &&
      view?.time &&
      time &&
      src === view.time.column &&
      (grain ? grain !== "week" : !c.source?.truncation) &&
      free(view.time.name, c.name)
    ) {
      add(view.time.name, { label: c.name === src ? view.time.label : c.name, kind: "time", grain: grain ?? "day" });
      continue;
    }
    // In SQL, a number can be a dimension (a year): by its name.
    const dim =
      (lang === "sql" || !measure) && !c.source?.truncation && view
        ? Object.values(view.dimensions).find((d) => d.name === src || plainColumn(d.expr) === src)
        : undefined;
    if (dim && free(dim.name, c.name)) {
      add(dim.name, { label: c.name === src ? dim.label : c.name, kind: "dimension", ...(dim.format ? { format: dim.format } : {}) });
      continue;
    }
    if (measure) {
      const m = view && Object.hasOwn(view.measures, c.name) ? view.measures[c.name] : undefined;
      add(c.name, {
        label: m?.label ?? c.name,
        kind: "measure",
        ...(m?.format ? { format: m.format } : {}),
        ...(m?.better === "lower" ? { better: "lower" as const } : {}),
      });
      continue;
    }
    // A time that is not the view's (SQL's dates, other columns, weeks) has no grain under the time's name: a click on it selects nothing.
    const own = time && grain && c.name !== view?.time?.name;
    add(c.name, { label: c.name, kind: time ? "time" : "dimension", ...(own ? { grain } : {}) });
  }
  return { names, fields };
}

/**
 * The fields of a Malloy or SQL result that a click filters the other tiles by: the view's dimensions, and its time
 * (by a grain). A column of the query's own filters nothing.
 */
export function customSelectable(fields: readonly FieldInfo[], view: MetricsView | undefined): Set<string> {
  const out = new Set<string>();
  for (const f of fields) {
    if (!view) break;
    if (f.kind === "dimension" ? Object.hasOwn(view.dimensions, f.name) : f.kind === "time" && !!f.grain && f.name === view.time?.name)
      out.add(f.name);
  }
  return out;
}
