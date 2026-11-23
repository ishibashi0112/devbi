/**
 * The `-- param:` and `-- key:` lines at the top of an `api/<name>.sql` file, and the checks the values sent for a
 * typed parameter go through (docs/design/sql-datasets.md, 4 章). The C# reference (dotnet/src/DevBI.Server/
 * Dataset.cs) reads them the same way, with the same messages.
 */

/** The types a `-- param:` line can give. */
export type ParamType = "text" | "integer" | "number" | "date" | "datetime" | "boolean";

export const PARAM_TYPES: readonly ParamType[] = ["text", "integer", "number", "date", "datetime", "boolean"];

/** One parameter of a dataset, as `GET api/schema` lists it. */
export interface DatasetParameter {
  /** As the `-- param:` line writes it (or, without one, as the SQL first writes it). */
  name: string;
  /** Undefined: no `-- param:` line, and the value goes to the database as it comes (text, number, boolean, null). */
  type?: ParamType;
  /** `text[]`: several values, for `IN (:name)`. */
  multiple?: true;
  /** The input's name. Undefined: the parameter's name. */
  label?: string;
  /** As written (`month_start`, `today-30`, `all`, `関東,近畿`, `2024-04-01`): the browser reads it, not the server. */
  default?: string;
  /** The dataset whose rows are the choices (1st column the value, 2nd the label). */
  values?: string;
  /** May be empty: NULL goes to the database. */
  optional?: true;
  /** No input (the value comes from the URL, the embedding page or a click). */
  hidden?: true;
}

/** The parameter names the browser and the SQL files may not use: `user.<attr>` is the signed-in user's (row-level security). */
export const RESERVED = /^user\./i;

/** A parameter's name, the way `parameters()` reads it after the `:` in SQL. */
const NAME = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*$/;

const PARAM_LINE = /^\s*--\s*param\s*:(.*)$/i;
const KEY_LINE = /^\s*--\s*key\s*:(.*)$/i;
const COMMENT_LINE = /^\s*--/;

const TYPES_HINT = "text・integer・number・date・datetime・boolean のどれかを書いてください（複数の値は text[] のように）";
const OPTIONS = ["label", "default", "values", "optional", "hidden"] as const;
const FLAGS = new Set(["optional", "hidden"]);

/** Words for the day a default counts from (the viewer's today), with an optional `+N` / `-N` days. */
const DAY_WORDS = /^(today|tomorrow|yesterday|month_start|next_month_start|previous_month_start|year_start|fiscal_year_start)([+-][0-9]{1,5})?$/;

export class ParamLineError extends Error {}

interface Word {
  key: string;
  /** Undefined: no `=` (a name, a type or a flag). */
  value?: string;
}

/** The words of a `-- param:` line: `name type key=value "a b"` (a value in "…", `""` for a " inside). */
function words(body: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < body.length) {
    if (/\s/.test(body[i]!)) {
      i++;
      continue;
    }
    let cur = "";
    let key: string | undefined;
    while (i < body.length && !/\s/.test(body[i]!)) {
      const c = body[i]!;
      if (c === '"') {
        let j = i + 1;
        for (;;) {
          if (j >= body.length) throw new ParamLineError(`" が閉じていません`);
          if (body[j] === '"') {
            if (body[j + 1] === '"') {
              cur += '"';
              j += 2;
              continue;
            }
            break;
          }
          cur += body[j];
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === "=" && key === undefined) {
        key = cur;
        cur = "";
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    out.push(key === undefined ? { key: cur } : { key, value: cur });
  }
  return out;
}

/** A written value (`2024-04-01`, `10`, `true`) for the type: whether it reads as one. */
function literalFits(text: string, type: ParamType): boolean {
  switch (type) {
    case "text":
      return true;
    case "integer":
      return /^[+-]?[0-9]+$/.test(text) && Number.isSafeInteger(Number(text));
    case "number":
      return /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text) && Number.isFinite(Number(text));
    case "date":
      return DAY_WORDS.test(text) || dateText(text) !== undefined;
    case "datetime":
      return DAY_WORDS.test(text) || datetimeText(text) !== undefined;
    case "boolean":
      return text === "true" || text === "false";
  }
}

const EXAMPLES: Record<ParamType, string> = {
  text: "受付",
  integer: "10",
  number: "1.5",
  date: "2024-04-01 か month_start、today-30",
  datetime: "2024-04-01T09:00 か today",
  boolean: "true か false",
};

/** Throws ParamLineError when the default does not read as the type. */
function checkDefault(def: DatasetParameter & { type: ParamType }, text: string): void {
  const type = def.multiple ? `${def.type}[]` : def.type;
  if (def.multiple) {
    // `all`: every choice. Without choices, or for text, it is the text "all" itself (or, for others, an error below).
    if (text === "all" && def.values !== undefined) return;
    const items = text.split(",").map((s) => s.trim());
    if (items.some((s) => s === "")) throw new ParamLineError(`default=${text} に空の値があります（, で区切って書きます）`);
    const bad = items.find((s) => !literalFits(s, def.type));
    if (bad !== undefined) throw new ParamLineError(`default の ${bad} は ${type} の値として読めません（例: ${EXAMPLES[def.type]}）`);
    return;
  }
  if (text === "" && def.type !== "text") throw new ParamLineError(`default に値を書いてください（例: default=${EXAMPLES[def.type].split(" ")[0]}）`);
  if (!literalFits(text, def.type)) throw new ParamLineError(`default=${text} は ${type} の値として読めません（例: ${EXAMPLES[def.type]}）`);
}

/** One `-- param:` line's text after `param:`. Throws ParamLineError. */
function parseParamLine(body: string): DatasetParameter & { type: ParamType } {
  const ws = words(body);
  const [first, second, ...rest] = ws;
  if (!first || first.value !== undefined) throw new ParamLineError("-- param: のあとにパラメーターの名前と型を書いてください（例: -- param: from date）");
  const name = first.key;
  if (RESERVED.test(name)) throw new ParamLineError(`${name}: user. で始まる名前は、ログインした人の値のために取ってあるので使えません`);
  if (!NAME.test(name)) throw new ParamLineError(`${name} はパラメーターの名前として読めません（SQL の :名前 の名前を書きます）`);
  if (!second) throw new ParamLineError(`パラメーター ${name} の型がありません。${TYPES_HINT}`);
  if (second.value !== undefined) throw new ParamLineError(`パラメーター ${name} の型がありません（名前と型のあとに label=… などを書きます）。${TYPES_HINT}`);
  const multiple = second.key.endsWith("[]");
  const typeName = multiple ? second.key.slice(0, -2) : second.key;
  if (!(PARAM_TYPES as readonly string[]).includes(typeName)) throw new ParamLineError(`型 ${second.key} は使えません。${TYPES_HINT}`);
  const def: DatasetParameter & { type: ParamType } = { name, type: typeName as ParamType, ...(multiple ? { multiple: true as const } : {}) };
  const seen = new Set<string>();
  let defaultText: string | undefined;
  for (const w of rest) {
    const key = w.key;
    if (!(OPTIONS as readonly string[]).includes(key)) throw new ParamLineError(`${key} は知らない指定です。${OPTIONS.join("・")} を書けます`);
    if (seen.has(key)) throw new ParamLineError(`${key} が 2 回あります`);
    seen.add(key);
    if (FLAGS.has(key)) {
      if (w.value !== undefined) throw new ParamLineError(`${key} は値を付けずに書きます`);
      if (key === "optional") {
        if (multiple) throw new ParamLineError(`複数の値（${second.key}）には optional を付けられません（1 つも選ばないことはできません）`);
        def.optional = true;
      } else def.hidden = true;
      continue;
    }
    if (w.value === undefined) throw new ParamLineError(`${key} には値を書いてください（${key}=…）`);
    if (key === "label") {
      if (w.value === "") throw new ParamLineError("label に名前を書いてください");
      def.label = w.value;
    } else if (key === "values") {
      if (w.value === "" || /[/\\]/.test(w.value)) throw new ParamLineError(`values には候補を出すデータセットの名前（api/ の SQL ファイルの名前）を書きます（${w.value}）`);
      def.values = w.value;
    } else defaultText = w.value;
  }
  if (defaultText !== undefined) {
    checkDefault(def, defaultText);
    def.default = defaultText;
  }
  // The keys in one order (api/schema and the C# reference write them so).
  return {
    name: def.name,
    type: def.type,
    ...(def.multiple ? { multiple: true } : {}),
    ...(def.label !== undefined ? { label: def.label } : {}),
    ...(def.default !== undefined ? { default: def.default } : {}),
    ...(def.values !== undefined ? { values: def.values } : {}),
    ...(def.optional ? { optional: true } : {}),
    ...(def.hidden ? { hidden: true } : {}),
  };
}

/** The columns of a `-- key:` line (`受注番号, 行番号`; a name in "…" may hold a comma). Throws ParamLineError. */
function parseKeyLine(body: string): string[] {
  const columns: string[] = [];
  let i = 0;
  let cur = "";
  let quoted = false;
  const finish = () => {
    const name = quoted ? cur : cur.trim();
    if (name === "") throw new ParamLineError("-- key: のあとに、行を見分ける列の名前を , で区切って書いてください（例: -- key: 受注番号, 行番号）");
    if (columns.includes(name)) throw new ParamLineError(`列 ${name} が 2 回あります`);
    columns.push(name);
    cur = "";
    quoted = false;
  };
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"' && cur.trim() === "" && !quoted) {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= body.length) throw new ParamLineError(`" が閉じていません`);
        if (body[j] === '"') {
          if (body[j + 1] === '"') {
            name += '"';
            j += 2;
            continue;
          }
          break;
        }
        name += body[j];
        j++;
      }
      cur = name;
      quoted = true;
      i = j + 1;
      while (i < body.length && /\s/.test(body[i]!)) i++;
      if (i < body.length && body[i] !== "," && body[i] !== "、") throw new ParamLineError(`"${name}" のあとは , で区切ります`);
      continue;
    }
    if (c === "," || c === "、") {
      finish();
      i++;
      continue;
    }
    if (quoted) throw new ParamLineError(`"${cur}" のあとは , で区切ります`);
    cur += c;
    i++;
  }
  finish();
  return columns;
}

/**
 * The `-- param:` and `-- key:` lines among the comment lines at the top of the file (blank lines between them are
 * fine, as for `-- connection:`), checked against the SQL's parameter names. `sqlParams`: the names in the SQL, each
 * once. Throws Error with `api/<name>.sql（N 行目）: …`.
 */
export function headerDirectives(
  text: string,
  name: string,
  sqlParams: string[],
): { parameters: (DatasetParameter & { type: ParamType })[]; key?: string[] } {
  const rel = `api/${name}.sql`;
  const parameters: (DatasetParameter & { type: ParamType; line: number })[] = [];
  let key: { columns: string[]; line: number } | undefined;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = `${rel}（${i + 1} 行目）`;
    if (line.trim() && !COMMENT_LINE.test(line)) {
      // a -- param: or -- key: past the header (after a /* */ or in the SQL) would do nothing: say so
      for (let j = i; j < lines.length; j++) {
        const late = PARAM_LINE.test(lines[j]!) ? "-- param:" : KEY_LINE.test(lines[j]!) ? "-- key:" : undefined;
        if (late) {
          throw new ParamLineError(
            `${rel}（${j + 1} 行目）: ${late} は、ファイルの先頭から続く -- のコメントの中に書いてください（SQL や /* */ よりあとの行は読みません）`,
          );
        }
      }
      break;
    }
    try {
      const p = PARAM_LINE.exec(line);
      if (p) {
        const def = parseParamLine(p[1]!);
        const lower = def.name.toLowerCase();
        const twice = parameters.find((q) => q.name.toLowerCase() === lower);
        if (twice) throw new ParamLineError(`パラメーター ${def.name} の -- param: が 2 つあります（${twice.line} 行目にも）`);
        if (!sqlParams.some((s) => s.toLowerCase() === lower)) {
          throw new ParamLineError(`パラメーター ${def.name} は SQL にありません（SQL に :${def.name} と書くか、この行を消してください）`);
        }
        parameters.push({ ...def, line: i + 1 });
        continue;
      }
      const k = KEY_LINE.exec(line);
      if (k) {
        if (key) throw new ParamLineError(`-- key: が 2 つあります（${key.line} 行目にも）`);
        key = { columns: parseKeyLine(k[1]!), line: i + 1 };
      }
    } catch (e) {
      if (e instanceof ParamLineError) throw new ParamLineError(`${at}: ${e.message}`);
      throw e;
    }
  }
  return { parameters: parameters.map(({ line: _, ...p }) => p), ...(key ? { key: key.columns } : {}) };
}

/** `YYYY-MM-DD` when the text is a date on the calendar (years 1 to 9999), otherwise undefined. */
export function dateText(text: string): string | undefined {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(text);
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return undefined;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days ? text : undefined;
}

/**
 * `YYYY-MM-DD HH:MM:SS[.ffffff]` when the text is a date and time without a time zone (`2024-04-01T09:00`,
 * `2024-04-01 09:00:30.5`), or a date (midnight). Otherwise undefined.
 */
export function datetimeText(text: string): string | undefined {
  if (dateText(text)) return `${text} 00:00:00`;
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,6})?)?$/.exec(text);
  if (!m || !dateText(m[1]!)) return undefined;
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return undefined;
  return `${m[1]} ${m[2]}:${m[3]}:${m[4] ?? "00"}${m[5] ?? ""}`;
}

/** Most characters (UTF-16 code units, as JavaScript and C# count) in one text value. */
export const MAX_TEXT = 4000;
/** Most values in one multiple-value parameter (Oracle's limit for one IN list). */
export const MAX_VALUES = 1000;
/** Most placeholders in one statement (SQL Server takes 2,100). */
export const MAX_PLACEHOLDERS = 2000;

const WANTS: Record<ParamType, string> = {
  text: "文字",
  integer: "整数",
  number: "数値",
  date: "日付（'2024-04-01' の形の文字）",
  datetime: "日時（'2024-04-01T09:00' の形の文字）",
  boolean: "真偽（true か false）",
};

function shown(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  if (s.length <= 40) return s;
  // not between the two halves of a surrogate pair (𠮷, emoji)
  const high = s.charCodeAt(39) >= 0xd800 && s.charCodeAt(39) <= 0xdbff;
  return `${s.slice(0, high ? 39 : 40)}…`;
}

/**
 * The value for a typed parameter, checked and in the form it goes to the database in: text, a safe integer, a
 * finite number, `YYYY-MM-DD`, `YYYY-MM-DD HH:MM:SS[.ffffff]`, a boolean, or null (only when `optional`); an array
 * of them for a multiple-value parameter (one value is taken as a list of one). Throws Error.
 */
export function checkValue(rel: string, def: DatasetParameter & { type: ParamType }, v: unknown): string | number | boolean | null | (string | number | boolean)[] {
  const one = (x: unknown, inList: boolean): string | number | boolean | null => {
    if (x === null) {
      if (inList) throw new Error(`${rel}: パラメーター ${def.name} の値に null は入れられません`);
      if (!def.optional) throw new Error(`${rel}: パラメーター ${def.name} の値がありません（null にできるのは -- param: に optional を付けたパラメーターだけです）`);
      return null;
    }
    const wrong = () => new Error(`${rel}: パラメーター ${def.name} には${WANTS[def.type]}を渡してください（${shown(x)} が来ました）`);
    switch (def.type) {
      case "text":
        if (typeof x !== "string") throw wrong();
        if (x.length > MAX_TEXT) throw new Error(`${rel}: パラメーター ${def.name} の文字が長すぎます（${MAX_TEXT.toLocaleString("en-US")} 文字まで）`);
        return x;
      case "integer":
        if (typeof x !== "number" || !Number.isSafeInteger(x)) throw wrong();
        return x;
      case "number":
        if (typeof x !== "number" || !Number.isFinite(x)) throw wrong();
        return x;
      case "date": {
        const d = typeof x === "string" ? dateText(x) : undefined;
        if (d === undefined) throw wrong();
        return d;
      }
      case "datetime": {
        const d = typeof x === "string" ? datetimeText(x) : undefined;
        if (d === undefined) throw wrong();
        return d;
      }
      case "boolean":
        if (typeof x !== "boolean") throw wrong();
        return x;
    }
  };
  if (!def.multiple) {
    if (Array.isArray(v)) throw new Error(`${rel}: パラメーター ${def.name} は 1 つの値です（複数の値にするには -- param: の型を ${def.type}[] にします）`);
    return one(v, false);
  }
  const list = Array.isArray(v) ? v : v === null ? [] : [v];
  if (list.length === 0) throw new Error(`${rel}: パラメーター ${def.name} に 1 つ以上の値を渡してください`);
  if (list.length > MAX_VALUES) {
    throw new Error(`${rel}: パラメーター ${def.name} の値が ${list.length.toLocaleString("en-US")} 個あります。1 つのパラメーターに渡せるのは ${MAX_VALUES.toLocaleString("en-US")} 個までです。候補を絞るか、すべてのときはこのパラメーターを使わない SQL にしてください`);
  }
  return list.map((x) => one(x, true) as string | number | boolean);
}
