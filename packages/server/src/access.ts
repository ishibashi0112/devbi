/**
 * Row-level security (docs/design/row-level-security.md): who is looking, which datasets they may read, and the lines
 * of an `api/*.sql` file that say so. DevBI does not sign anyone in: the host (ASP.NET, Next.js, a proxy in front of
 * devbi-serve) does, and hands the API the signed-in user. The rows are filtered in the server's SQL, by
 * `:user.<attribute>` and `:user.id`, never in the browser.
 */

/** The signed-in user, as the host hands it to the API (`handle(req, res, { user })`, `fetch`, `run`). */
export interface DevBIUser {
  /**
   * The user's id, one that does not change and that nobody else can take: Entra ID's `oid`, OpenID Connect's `sub`,
   * the Windows account (`CORP\yamada`). Not an e-mail address. `:user.id` in SQL. Empty (or only spaces): not signed in.
   */
  id: string;
  /** Roles, for `-- roles:` lines (groups, the app's roles). Matched exactly. */
  roles?: readonly string[];
  /**
   * Attributes, one value each: `:user.<name>` in SQL (names without regard to case). `null`, empty or only spaces:
   * the user has no such attribute (and one of the same name from `access/user.sql` is not used either).
   */
  attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

/** An attribute's value as it goes to the database. */
export type AttrValue = string | number | boolean;

/**
 * A user as the server checks it. `attrs`: lower-case name → value; `null` where the host said the user has none.
 * `roles` and `attrs` are the host's until `access/user.sql` is read (`resolved`).
 */
export interface Viewer {
  id: string;
  roles: ReadonlySet<string>;
  attrs: ReadonlyMap<string, AttrValue | null>;
}

/** An attribute's name: as a parameter's, without dots. */
const ATTR_NAME = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/;

/** Whether a parameter's name is the signed-in user's (`user.region`): `user.` in ASCII letters, without regard to case. */
export function isUserName(name: string): boolean {
  return /^user\./i.test(name);
}

/** The bare name `user` (ASCII letters, without regard to case): refused in row-level mode, where it is likely a mistake for `user.id`. */
export function isBareUser(name: string): boolean {
  return /^user$/i.test(name);
}

/** An attribute's value as it reaches the database, or null when it counts as none (null, empty, only spaces). */
function attrValue(v: unknown, what: () => string): AttrValue | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`${what()} の値が数として読めません（${v}）`);
    return v;
  }
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  throw new TypeError(`${what()} の値は文字・数値・真偽のどれかにしてください`);
}

/**
 * The user the host handed over, checked: undefined when there is none (not signed in: `undefined`, `null`, or an
 * empty `id`). Throws TypeError when the host passes something of the wrong shape (a mistake in the host's code).
 */
export function viewerOf(user: DevBIUser | null | undefined): Viewer | undefined {
  if (user === undefined || user === null) return undefined;
  if (typeof user !== "object") throw new TypeError("user は { id, roles, attrs } のオブジェクトで渡してください");
  if (typeof user.id !== "string") throw new TypeError("user.id は文字で渡してください（ログインした人の、変わらない ID）");
  const id = user.id.trim();
  if (id === "") return undefined;
  const roles = new Set<string>();
  if (user.roles !== undefined && user.roles !== null) {
    if (!Array.isArray(user.roles)) throw new TypeError("user.roles は文字の配列で渡してください");
    for (const r of user.roles) {
      if (typeof r !== "string") throw new TypeError("user.roles は文字の配列で渡してください");
      if (r !== "") roles.add(r);
    }
  }
  const attrs = new Map<string, AttrValue | null>();
  if (user.attrs !== undefined && user.attrs !== null) {
    if (typeof user.attrs !== "object" || Array.isArray(user.attrs)) throw new TypeError("user.attrs は { 名前: 値 } のオブジェクトで渡してください");
    for (const [name, v] of Object.entries(user.attrs)) {
      checkAttrName(name, () => `user.attrs の ${name}`);
      const lower = name.toLowerCase();
      if (attrs.has(lower)) throw new TypeError(`user.attrs に ${name} が 2 つあります（大文字と小文字は区別しません）`);
      attrs.set(lower, attrValue(v, () => `user.attrs の ${name}`));
    }
  }
  return { id, roles, attrs };
}

function checkAttrName(name: string, what: () => string): void {
  if (/^id$/i.test(name)) throw new TypeError(`${what()}: id は属性の名前に使えません（:user.id はログインした人の ID です）`);
  if (!ATTR_NAME.test(name)) throw new TypeError(`${what()}: 属性の名前は文字・数字・_ で書きます（:user.${name} と書けない名前です）`);
}

/** What `access/user.sql` says of a user: its attributes and roles (an empty one when it returns no row). */
export interface TableUser {
  attrs: Map<string, AttrValue | null>;
  roles: string[];
}

/** The row `access/user.sql` returned (columns and values), as attributes and roles. Throws TypeError. */
export function tableUserOf(columns: string[], row: unknown[] | undefined): TableUser {
  const out: TableUser = { attrs: new Map(), roles: [] };
  const seen = new Set<string>();
  columns.forEach((name, i) => {
    const what = () => `access/user.sql の列 ${name}`;
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new TypeError(`${what()} が 2 つあります（大文字と小文字は区別しません）`);
    seen.add(lower);
    if (lower === "roles") {
      const v = row?.[i];
      if (v === null || v === undefined) return;
      if (typeof v !== "string") throw new TypeError(`${what()} は、役割を , で区切った文字にしてください`);
      out.roles = [...new Set(v.split(/[,、]/).map((r) => r.trim()).filter(Boolean))];
      return;
    }
    checkAttrName(name, what);
    if (row) out.attrs.set(lower, attrValue(row[i], what));
  });
  return out;
}

/**
 * The host's user with what `access/user.sql` says (docs/design 5 章): the id is the host's; a role either gives counts;
 * an attribute is the host's when the host names it (even as null, which means none), otherwise the table's.
 */
export function mergeViewer(viewer: Viewer, table: TableUser | undefined): Viewer {
  if (!table) return viewer;
  const roles = new Set([...viewer.roles, ...table.roles]);
  const attrs = new Map(table.attrs);
  for (const [k, v] of viewer.attrs) attrs.set(k, v);
  return { id: viewer.id, roles, attrs };
}

/** The lines of an `api/*.sql` file that say who may read it. */
export interface AccessLines {
  /** `-- roles: 経理, CORP\Managers`: only users with one of these roles may read it. */
  roles?: string[];
  /** `-- access: all`: on purpose, every signed-in user gets every row. */
  access?: "all";
}

/** An error in an `-- roles:` or `-- access:` line (the message has the file and the line). */
export class AccessLineError extends Error {}

const ROLES_LINE = /^\s*--\s*roles\s*:(.*)$/i;
const ACCESS_LINE = /^\s*--\s*access\s*:(.*)$/i;
const COMMENT_LINE = /^\s*--/;
/** The first word of a comment line, and whether a `:` follows it. */
const FIRST_WORD = /^\s*--\s*([A-Za-z_]+)(\s*:)?/;
/** `roles:` / `access:` anywhere in a line (not `access::text`, PostgreSQL's cast). */
const LATE_LINE = /(?:^|[^A-Za-z0-9_])(roles|access)\s*:(?!:)/i;

/** Whether `a` becomes `b` with at most one letter added, removed, changed, or two side by side swapped. */
function oneEditAway(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}

/**
 * The `-- roles:` and `-- access:` lines among the comment lines at the top of the file (blank lines between them are
 * fine). So that a rule meant to protect never silently does nothing, these are errors: a word close to them
 * (`-- role:`, `-- acess:`), `roles` or `access` without `:`, an empty `-- roles:`, `-- access:` with anything but
 * `all`, two of either, and `roles:` / `access:` past the top comments (in the SQL, inside `/* *\/`). Throws
 * AccessLineError with `<rel>（N 行目）: …`.
 */
export function accessLines(text: string, rel: string): AccessLines {
  const out: AccessLines = {};
  let rolesLine = 0;
  let accessLine = 0;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = `${rel}（${i + 1} 行目）`;
    if (line.trim() && !COMMENT_LINE.test(line)) {
      for (let j = i; j < lines.length; j++) {
        const late = LATE_LINE.exec(lines[j]!);
        if (late) {
          throw new AccessLineError(
            `${rel}（${j + 1} 行目）: ${late[1]!.toLowerCase()}: の行は、ファイルの先頭から続く -- のコメントの中に書いてください（SQL や /* */ の中では読みません。文字として使うなら言い回しを変えてください）`,
          );
        }
      }
      break;
    }
    const roles = ROLES_LINE.exec(line);
    if (roles) {
      if (rolesLine) throw new AccessLineError(`${at}: -- roles: が 2 つあります（${rolesLine} 行目にも）。1 行に , で区切って書きます`);
      rolesLine = i + 1;
      const names = [...new Set(roles[1]!.split(/[,、]/).map((r) => r.trim()).filter(Boolean))];
      if (names.length === 0) throw new AccessLineError(`${at}: -- roles: のあとに、読んでよい役割を , で区切って書いてください（例: -- roles: 経理, CORP\\Managers）`);
      out.roles = names;
      continue;
    }
    const access = ACCESS_LINE.exec(line);
    if (access) {
      if (accessLine) throw new AccessLineError(`${at}: -- access: が 2 つあります（${accessLine} 行目にも）`);
      accessLine = i + 1;
      const value = access[1]!.trim();
      if (value.toLowerCase() !== "all") throw new AccessLineError(`${at}: -- access: に書けるのは all だけです（${value || "空"} が書いてあります）`);
      out.access = "all";
      continue;
    }
    const w = FIRST_WORD.exec(line);
    if (!w) continue;
    const word = w[1]!.toLowerCase();
    if (word === "roles" || word === "access") {
      const example = word === "roles" ? "-- roles: 経理" : "-- access: all";
      throw new AccessLineError(`${at}: -- ${word} の行は ${example} のように : を付けて書きます（説明の文なら、言い回しを変えてください）`);
    }
    if (w[2]) {
      for (const [near, right] of [
        ["roles", "-- roles:"],
        ["access", "-- access:"],
      ] as const) {
        if (word.slice(0, 2) === near.slice(0, 2) && oneEditAway(word, near)) {
          throw new AccessLineError(`${at}: -- ${w[1]}: は ${right} の書き間違いではありませんか（このままでは読みません。説明の文なら、言い回しを変えてください）`);
        }
      }
    }
  }
  return out;
}

/** Why the project files put it in row-level mode, or undefined: plain text search, not SQL parsing (any doubt → on). */
export function rowLevelSignal(text: string): string | undefined {
  if (/:user\./i.test(text)) return ":user.";
  const m = /--[ \t]*(roles|access)(?![A-Za-z0-9_])/i.exec(text);
  return m ? `-- ${m[1]!.toLowerCase()}` : undefined;
}

/** A user id (or anything a user sent) as it may go into one log line: control characters as `?`. */
export function logSafe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
}
