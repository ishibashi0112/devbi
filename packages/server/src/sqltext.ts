/**
 * Reading SQL text without running it: where quotes and comments are, whether a statement only reads, and its
 * `:name` parameters. Taken from ashiato (src/chat/sql.ts, MIT, same author); `parameters` below is DevBI's.
 */

export interface Statement {
  /** The statement as it is sent: without the comments above it and without its terminator. */
  sql: string;
  /** The comment lines right above it, without `--` / `/* *\/`: what it checks, as its writer put it. */
  title: string;
  /** Line in the file where the statement starts (1-based). */
  line: number;
}

/** How a database quotes and comments: what may hide a `;` or a keyword. */
interface Syntax {
  /** MySQL: `\'` inside '...' and "..." is an escaped quote. */
  backslash: boolean;
  /**
   * MySQL: `#` starts a comment, `--` only when a space or a control character follows (`1--1` is
   * 1 - -1), and the server runs what is inside `/*! ... *\/`.
   */
  mysqlComments: boolean;
  /** SQL Server, SQLite: [name]. Elsewhere `[` is an array subscript or an error, not a quote. */
  brackets: boolean;
  /** PostgreSQL: $$...$$ and $tag$...$tag$. */
  dollar: boolean;
  /** Oracle: q'[...]', q'{...}', q'!...!'. */
  qQuote: boolean;
}

const PLAIN: Syntax = { backslash: false, mysqlComments: false, brackets: false, dollar: false, qQuote: false };

/**
 * The ways the dialect's statements are read: the first splits the file, all of them are checked.
 * PostgreSQL's E'...' strings and MySQL's NO_BACKSLASH_ESCAPES mode read backslashes the other way,
 * so both readings must find nothing that writes. Unknown dialects are checked every way.
 */
function syntaxes(dialect?: string): Syntax[] {
  switch (dialect) {
    case "mssql":
      return [{ ...PLAIN, brackets: true }];
    case "sqlite":
      return [{ ...PLAIN, brackets: true }];
    case "oracle":
      return [{ ...PLAIN, qQuote: true }];
    case "postgres":
      return [{ ...PLAIN, dollar: true }, { ...PLAIN, dollar: true, backslash: true }];
    case "mysql":
      return [{ ...PLAIN, backslash: true, mysqlComments: true }, { ...PLAIN, mysqlComments: true }];
    default:
      return [PLAIN, { ...PLAIN, backslash: true, mysqlComments: true }, { ...PLAIN, mysqlComments: true }, { ...PLAIN, brackets: true }, { ...PLAIN, dollar: true }, { ...PLAIN, qQuote: true }];
  }
}

/**
 * Statements end at a `;`, at a line holding only `GO` (SQL Server's tools) or only `/` (SQL*Plus),
 * outside quotes and comments.
 */
export function splitStatements(text: string, dialect?: string): Statement[] {
  const syntax = syntaxes(dialect)[0]!;
  const out: Statement[] = [];
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let comments: string[] = [];
  let start = -1;
  let line = 1;
  let startLine = 1;
  let lineHasContent = false;

  const finish = (end: number) => {
    if (start >= 0) {
      const sql = src.slice(start, end).trim();
      if (sql) out.push({ sql, title: comments.join("\n").trim(), line: startLine });
    }
    comments = [];
    start = -1;
  };
  /** The end of the line starting at i when it holds only GO (optionally a count) or only "/", otherwise -1. */
  const separatorEnd = (i: number) => {
    const nl = src.indexOf("\n", i);
    const end = nl < 0 ? src.length : nl;
    return /^\s*(go(\s+\d+)?|\/)\s*$/i.test(src.slice(i, end)) ? end : -1;
  };

  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const c = src[i]!;
    if (atLineStart) {
      atLineStart = false;
      const end = separatorEnd(i);
      if (end >= 0) {
        finish(i);
        i = end;
        continue;
      }
    }
    if (c === "\n") {
      // a blank line between comments and a statement: those comments are not its title
      if (!lineHasContent && start < 0) comments = [];
      line++;
      atLineStart = true;
      lineHasContent = false;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    lineHasContent = true;
    const comment = commentEnd(src, i, syntax);
    if (comment > i) {
      const body = src.slice(c === "#" ? i + 1 : i + 2, src[i + 1] === "*" && src.startsWith("*/", comment - 2) ? comment - 2 : comment);
      // comments before the statement's first word are its title; inside it, they stay part of it
      if (start < 0) comments.push(...body.split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trim()));
      line += body.split("\n").length - 1;
      i = comment;
      continue;
    }
    if (c === ";") {
      finish(i);
      i++;
      continue;
    }
    if (start < 0) {
      start = i;
      startLine = line;
    }
    const close = quoteEnd(src, i, syntax);
    if (close > i) {
      line += src.slice(i, close).split("\n").length - 1;
      i = close;
      continue;
    }
    i++;
  }
  finish(src.length);
  return out;
}

/** When a comment starts at i: the index after it ends (or the end of the text). Otherwise i. */
function commentEnd(src: string, i: number, syntax: Syntax): number {
  const lineEnd = () => {
    const end = src.indexOf("\n", i);
    return end < 0 ? src.length : end;
  };
  if (src[i] === "-" && src[i + 1] === "-") {
    const after = src[i + 2];
    if (syntax.mysqlComments && after !== undefined && !/[\s\x00-\x1f]/.test(after)) return i;
    return lineEnd();
  }
  if (src[i] === "#" && syntax.mysqlComments) return lineEnd();
  if (src[i] === "/" && src[i + 1] === "*") {
    // MySQL runs the inside of /*! ... */: it is read as part of the statement
    if (syntax.mysqlComments && src[i + 2] === "!") return i;
    const end = src.indexOf("*/", i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return i;
}

/** Letters, digits and _ $ # @ continue a name, and so do non-ASCII characters other than spaces (受注番号). */
const isNameChar = (c: string | undefined) => c !== undefined && (/[A-Za-z0-9_$#@]/.test(c) || (c > "\x7f" && !/\s/.test(c)));
const Q_CLOSERS: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };

/** When a quote starts at i: the index after it ends (or the end of the text). Otherwise i. */
function quoteEnd(src: string, i: number, syntax: Syntax): number {
  const c = src[i]!;
  const prev = src[i - 1];
  const afterName = isNameChar(prev);
  if (c === "'" || c === '"' || c === "`" || (c === "[" && syntax.brackets)) {
    const end = c === "[" ? "]" : c;
    let j = i + 1;
    while (j < src.length) {
      const d = src[j]!;
      if (syntax.backslash && d === "\\" && c !== "`") {
        j += 2;
        continue;
      }
      if (d === end) {
        // a doubled quote is an escaped quote
        if (src[j + 1] === end) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return src.length;
  }
  if (c === "$" && syntax.dollar && !afterName) {
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))?.[0];
    if (!tag) return i;
    const end = src.indexOf(tag, i + tag.length);
    return end < 0 ? src.length : end + tag.length;
  }
  if ((c === "q" || c === "Q") && syntax.qQuote && src[i + 1] === "'" && (!afterName || ((prev === "n" || prev === "N") && !isNameChar(src[i - 2])))) {
    const open = src[i + 2];
    if (open === undefined || /\s/.test(open)) return i;
    const close = `${Q_CLOSERS[open] ?? open}'`;
    const end = src.indexOf(close, i + 3);
    return end < 0 ? src.length : end + 2;
  }
  return i;
}

/** The statement's words outside quotes and comments, in upper case, in order, and whether a `;` is among them. */
function scan(sql: string, syntax: Syntax): { words: string[]; semicolon: boolean } {
  const words: string[] = [];
  let semicolon = false;
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i, syntax);
    if (comment > i) {
      i = comment;
      continue;
    }
    const close = quoteEnd(sql, i, syntax);
    if (close > i) {
      i = close;
      continue;
    }
    if (sql[i] === ";") semicolon = true;
    const word = /^[A-Za-z_][A-Za-z0-9_$#@]*/.exec(sql.slice(i, i + 256))?.[0];
    if (word && !isNameChar(sql[i - 1])) {
      const upper = word.toUpperCase();
      // a name right after a dot is a column or table name (o.update_date), not a keyword; seq.NEXTVAL still counts
      if (!/\.\s*$/.test(sql.slice(Math.max(0, i - 8), i)) || upper === "NEXTVAL") words.push(upper);
      i += word.length;
      continue;
    }
    i++;
  }
  return { words, semicolon };
}

/** Words that write, lock, run code, or reach outside the database. */
const REFUSED = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "TRUNCATE", "CREATE", "ALTER", "DROP", "RENAME",
  "GRANT", "REVOKE", "DENY", "EXEC", "EXECUTE", "CALL", "INTO", "DECLARE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT",
  "FUNCTION", "PROCEDURE", "PRAGMA", "LOCK", "UNLOCK", "USE", "SET", "SETUSER", "SHUTDOWN", "KILL", "RECONFIGURE",
  "BACKUP", "RESTORE", "DUMP", "DBCC", "VACUUM", "ATTACH", "DETACH", "WRITETEXT", "UPDATETEXT", "SEND", "RECEIVE",
  "CONVERSATION", "NEXTVAL", "SETVAL", "OPENROWSET", "OPENDATASOURCE", "OPENQUERY", "OPENXML",
  // SQL Server's table hints that hold locks until the transaction ends
  "UPDLOCK", "XLOCK", "HOLDLOCK", "TABLOCKX",
]);

/** Why a statement is not run. `message` says it in English; `code` and `word` let a report say it in another language. */
export interface Problem {
  code: "not-select" | "several" | "writes" | "locks" | "sequence";
  /** The word that was found: the statement's first word (not-select), or the word that writes or locks. */
  word?: string;
  message: string;
}

/**
 * Why the statement may not run, or undefined when it only reads: it must start with SELECT or WITH
 * and contain none of the words that write (INSERT, UPDATE, SELECT ... INTO, FOR UPDATE, WITH FUNCTION ...).
 * Strict on purpose: a column named like one of those words must be quoted. The database user should
 * still be granted SELECT only: this check is the first guard, not the last.
 */
export function readOnlyProblem(sql: string, dialect?: string): Problem | undefined {
  for (const syntax of syntaxes(dialect)) {
    const { words: w, semicolon } = scan(sql, syntax);
    const first = w[0];
    if (first !== "SELECT" && first !== "WITH") return { code: "not-select", word: first, message: `only SELECT and WITH statements are run, not ${first ?? "this"}` };
    // a ; left after splitting means the database may read a second statement where the split saw a quote
    if (semicolon) return { code: "several", message: "it may hold more than one statement: check the quotes" };
    for (let i = 0; i < w.length; i++) {
      const word = w[i]!;
      if (REFUSED.has(word)) return { code: "writes", word, message: `${word} is not allowed: only statements that read are run` };
      // FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE lock rows (FOR UPDATE is refused above)
      if (word === "FOR" && (w[i + 1] === "SHARE" || w[i + 1] === "KEY" || w[i + 1] === "NO")) {
        return { code: "locks", word: `FOR ${w[i + 1]}`, message: `FOR ${w[i + 1]} locks rows: only statements that read are run` };
      }
      if (word === "NEXT" && w[i + 1] === "VALUE") return { code: "sequence", word: "NEXT VALUE FOR", message: "NEXT VALUE FOR moves a sequence on: only statements that read are run" };
    }
  }
  return undefined;
}

/** A `:name` parameter in the SQL text. */
export interface Parameter {
  name: string;
  start: number;
  end: number;
}

/**
 * The `:name` parameters outside quotes and comments, in order (a name may appear more than once).
 * Not PostgreSQL's casts (`x::date`), not `:=`, and not a colon right after a name (`arr[a:b]` reads as a
 * parameter `b` only when a space or `[` comes before the colon).
 */
export function parameters(sql: string, dialect?: string): Parameter[] {
  const syntax = syntaxes(dialect)[0]!;
  const out: Parameter[] = [];
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i, syntax);
    if (comment > i) {
      i = comment;
      continue;
    }
    const close = quoteEnd(sql, i, syntax);
    if (close > i) {
      i = close;
      continue;
    }
    if (sql[i] === ":") {
      if (sql[i + 1] === ":" || sql[i - 1] === ":") {
        i += 2;
        continue;
      }
      const name = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*/.exec(sql.slice(i + 1, i + 129))?.[0];
      if (name && !isNameChar(sql[i - 1])) {
        out.push({ name, start: i, end: i + 1 + name.length });
        i += 1 + name.length;
        continue;
      }
    }
    i++;
  }
  return out;
}
