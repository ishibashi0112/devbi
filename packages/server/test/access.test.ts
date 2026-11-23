// Row-level security (docs/design/row-level-security.md): :user.<attr>, -- roles:, -- access: all, row-level mode,
// access/user.sql, and the snapshots that must not leave everyone's rows behind.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableFromIPC } from "apache-arrow";
import { snapshotFile } from "devbi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessLines, bindParameters, createApiHandler, parameters, parseDataset, rowLevelSignal, serve, snapshotJobs, viewerOf, type ApiHandler, type DevBIUser, type RunningServer } from "../src/index.js";

const yamada: DevBIUser = { id: "CORP\\yamada", roles: ["営業"], attrs: { region: "関東" } };
const suzuki: DevBIUser = { id: "CORP\\suzuki", roles: ["営業", "経理"], attrs: { region: "近畿" } };

describe(":user. in the SQL", () => {
  it("reads :user.<name> as one name, user in ASCII letters only", () => {
    const names = (sql: string) => parameters(sql, "postgres").map((p) => p.name);
    expect(names("SELECT * FROM t WHERE r = :user.region AND s = :USER.Id AND d >= :from")).toEqual(["user.region", "USER.Id", "from"]);
    expect(names("SELECT :user.地域, :a.b, :user, :user. x, ':user.no' -- :user.no")).toEqual(["user.地域", "a", "user", "user"]);
    expect(names("SELECT :users.x, x:user.y FROM t")).toEqual(["users"]);
  });
  it("keeps the user's names apart from the parameters", () => {
    const d = parseDataset("orders", "-- 受注\nSELECT * FROM t WHERE r = :user.Region AND s = :user.id AND d >= :from AND r2 = :USER.region");
    expect(d).toMatchObject({ params: ["from"], user: ["region", "id"], parameters: [{ name: "from" }] });
    expect(parseDataset("plain", "SELECT 1").user).toBeUndefined();
  });
});

describe("-- roles: and -- access:", () => {
  const lines = (text: string) => accessLines(text, "api/x.sql");
  it("reads them among the comments at the top, and leaves them out of the description", () => {
    expect(lines("-- 給与\n-- roles: 経理, CORP\\Managers、 管理\n\n-- Access : ALL\nSELECT 1")).toEqual({ roles: ["経理", "CORP\\Managers", "管理"], access: "all" });
    expect(parseDataset("pay", "-- 給与の明細\n-- roles: 経理\n-- access: all\nSELECT 1")).toMatchObject({ description: "給与の明細", roles: ["経理"], access: "all" });
    expect(lines("-- 受注\nSELECT 1")).toEqual({});
  });
  it("refuses what would silently not protect", () => {
    const error = (text: string) => {
      try {
        lines(text);
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    expect(error("-- role: 経理\nSELECT 1")).toBe("api/x.sql（1 行目）: -- role: は -- roles: の書き間違いではありませんか（このままでは読みません。説明の文なら、言い回しを変えてください）");
    expect(error("-- acess: all\nSELECT 1")).toMatch(/acess: は -- access: の書き間違い/);
    expect(error("-- Rolse: 経理\nSELECT 1")).toMatch(/Rolse: は -- roles:/);
    expect(error("-- roles 経理\nSELECT 1")).toBe("api/x.sql（1 行目）: -- roles の行は -- roles: 経理 のように : を付けて書きます（説明の文なら、言い回しを変えてください）");
    expect(error("-- access all\nSELECT 1")).toMatch(/-- access: all のように : を付けて/);
    expect(error("-- roles:\nSELECT 1")).toMatch(/（1 行目）: -- roles: のあとに、読んでよい役割を/);
    expect(error("-- roles: , 、\nSELECT 1")).toMatch(/読んでよい役割を/);
    expect(error("-- access: everyone\nSELECT 1")).toBe("api/x.sql（1 行目）: -- access: に書けるのは all だけです（everyone が書いてあります）");
    expect(error("-- roles: a\n-- roles: b\nSELECT 1")).toMatch(/（2 行目）: -- roles: が 2 つあります（1 行目にも）/);
    expect(error("SELECT 1\n-- roles: 経理")).toMatch(/^api\/x\.sql（2 行目）: roles: の行は、ファイルの先頭から続く -- のコメントの中に/);
    expect(error("/* roles: 経理 */\nSELECT 1")).toMatch(/（1 行目）: roles:/);
    expect(error("-- 説明\n/*\n  access: all\n*/\nSELECT 1")).toMatch(/（3 行目）: access:/);
    // not right after the "--", or full-width: not read, so not left as it is
    for (const line of ["--- roles: 経理", "-- @roles: 経理", "-- - roles: 経理", "-- ※roles: 経理", "-- 経理だけ。roles: 経理"]) {
      expect(error(`${line}\n-- access: all\nSELECT 1`)).toMatch(/^api\/x\.sql（1 行目）: roles: の行は、-- roles: 経理 のように -- のすぐあとに書いてください/);
    }
    expect(error("-- ｒｏｌｅｓ: 経理\nSELECT 1")).toBe("api/x.sql（1 行目）: -- roles: は半角の英字と : で書いてください（このままでは読みません）");
    expect(error("-- roles： 経理\nSELECT 1")).toMatch(/-- roles: は半角の英字と : で/);
    expect(error("-- access：all\nSELECT 1")).toMatch(/-- access: は半角の英字と : で/);
    expect(error("-- role： 経理\nSELECT 1")).toMatch(/-- role: は -- roles: の書き間違い/);
    // a full-width space after the "--" is a space: read
    expect(lines("--\u3000roles: 経理\nSELECT 1")).toEqual({ roles: ["経理"] });
    // not near: a description, a connection line, a cast, "access" without ":" (a missing access: all only refuses more)
    expect(error("-- rules: 税抜き\n-- connection: erp\n-- 権限のある人だけ\nSELECT access::text, roles_count FROM t")).toBe("no error");
    expect(error("-- Access log per day\n-- access-log の件数\nSELECT 1 -- access from intranet only")).toBe("no error");
  });
  it("cannot be both, and filtered SQL cannot be a snapshot", () => {
    expect(() => parseDataset("x", "-- access: all\nSELECT * FROM t WHERE r = :user.region")).toThrow(/-- access: all（全員に全部の行）と :user.region（人で絞る）が両方あります/);
    expect(() => parseDataset("x", "-- snapshot: 06:00\nSELECT * FROM t WHERE r = :user.region")).toThrow(/:user.region で人ごとに行が変わるので、-- snapshot: は書けません/);
    expect(() => parseDataset("x", "-- snapshot: 06:00\n-- roles: 経理\n-- access: all\nSELECT 1")).toThrow(/-- roles: の役割を、静的なファイルでは確かめられないので/);
    expect(parseDataset("x", "-- snapshot: 06:00\n-- access: all\nSELECT 1")).toMatchObject({ snapshot: ["06:00"], access: "all" });
  });
  it("the text that puts a project in row-level mode: plain search, any doubt is yes", () => {
    expect(rowLevelSignal("SELECT * FROM t WHERE r = :User.region")).toBe(":user.");
    expect(rowLevelSignal("SELECT ':user.x' AS s")).toBe(":user.");
    expect(rowLevelSignal("--roles: a\nSELECT 1")).toBe("-- roles:");
    expect(rowLevelSignal("SELECT 1 -- Access: all")).toBe("-- access:");
    // as accessLines reads or refuses them: a full-width space or colon, not right after the "--"
    for (const text of ["--\u3000roles: 経理", "--\u00a0roles: 経理", "-- roles：経理", "--- roles: 経理", "-- @roles: 経理", "-- ｒｏｌｅｓ: 経理"]) {
      expect(rowLevelSignal(`${text}\n-- access: all\nSELECT 1`.replace("\n-- access: all", ""))).toBe("-- roles:");
    }
    // a comment that only mentions the word: not the mode (a project without logins keeps working)
    expect(rowLevelSignal("-- access_log の件数\n-- Access log per day\nSELECT :user_id, :user -- access from intranet only")).toBeUndefined();
    expect(rowLevelSignal("SELECT access::text FROM t -- roles 経理")).toBeUndefined();
  });
});

describe("binding the user's values", () => {
  const d = parseDataset("orders", "SELECT * FROM t WHERE r = :user.region AND d >= :from AND (r = :user.region OR s = :user.id)");
  const user = { id: "CORP\\yamada", attrs: new Map([["region", "関東"]]) };
  it("from the user only, as the database's parameters", () => {
    expect(bindParameters(d, "postgres", { from: "2026-04-01" }, { user })).toEqual({
      sql: "SELECT * FROM t WHERE r = $1 AND d >= $2 AND (r = $1 OR s = $3)",
      params: ["関東", "2026-04-01", "CORP\\yamada"],
    });
    expect(bindParameters(d, "sqlite", { from: "x" }, { user }).params).toEqual(["関東", "x", "関東", "CORP\\yamada"]);
    expect(bindParameters(d, "mssql", { from: "x" }, { user }).sql).toBe("SELECT * FROM t WHERE r = @p1 AND d >= @p2 AND (r = @p1 OR s = @p3)");
    // a quote in a value stays a value
    expect(bindParameters(d, "postgres", { from: "x" }, { user: { id: "a", attrs: new Map([["region", "' OR 1=1 --"]]) } }).params).toEqual(["' OR 1=1 --", "x", "a"]);
    // an attribute's name lower-cased on its own (`user.Σ` as a whole would end in ς), never bound as nothing
    const sigma = parseDataset("s", "SELECT * FROM t WHERE (:user.Σ IS NULL OR r = :user.Σ)");
    const v = viewerOf({ id: "a", attrs: { Σ: "関東" } })!;
    expect(bindParameters(sigma, "postgres", {}, { user: v }).params).toEqual(["関東"]);
  });
  it("no user: 401; no such attribute, or an empty one: 403, nothing runs", () => {
    expect(() => bindParameters(d, "postgres", { from: "x" })).toThrow(expect.objectContaining({ status: 401, message: "ログインしていません（api/orders.sql は、ログインした人の :user.region で行を絞ります）" }));
    for (const region of [undefined, null, "", "  "]) {
      const attrs = new Map<string, string | null>(region === undefined ? [] : [["region", region]]);
      expect(() => bindParameters(d, "postgres", { from: "x" }, { user: { id: "u1", attrs } })).toThrow(expect.objectContaining({ status: 403, message: "利用者 u1 に属性 region がありません（api/orders.sql の :user.region）" }));
    }
  });
  it("the browser cannot send them; user itself is refused in row-level mode", () => {
    expect(() => bindParameters(d, "postgres", { from: "x", "user.region": "近畿" }, { user })).toThrow(/パラメーター user.region は渡せません/);
    expect(() => bindParameters(d, "postgres", { from: "x", "User.Id": "admin" }, { user })).toThrow(/User.Id は渡せません/);
    expect(() => bindParameters(d, "postgres", { from: "x", user: "admin" }, { user, rowLevel: true })).toThrow(/パラメーター user は渡せません（行レベルのモードでは/);
    // not in row-level mode: a parameter like any other (and user_id always)
    const plain = parseDataset("p", "SELECT * FROM t WHERE a = :user AND b = :user_id");
    expect(bindParameters(plain, "postgres", { user: "x", user_id: 1 }).params).toEqual(["x", 1]);
  });
});

describe("the user the host hands over", () => {
  it("is checked: an empty id is nobody, the attributes' names without regard to case", () => {
    expect(viewerOf(undefined)).toBeUndefined();
    expect(viewerOf(null)).toBeUndefined();
    expect(viewerOf({ id: "  " })).toBeUndefined();
    const v = viewerOf({ id: " CORP\\yamada ", roles: ["営業", ""], attrs: { Region: "関東", dept: 10, admin: false, none: null, blank: " ", notGiven: undefined } })!;
    expect(v.id).toBe("CORP\\yamada");
    expect([...v.roles]).toEqual(["営業"]);
    expect([...v.attrs]).toEqual([
      ["region", "関東"],
      ["dept", 10],
      ["admin", false],
      ["none", null],
      ["blank", null],
    ]);
  });
  it("a wrong shape is the host's mistake: an error, not a guess", () => {
    expect(() => viewerOf({ id: 1 } as never)).toThrow(/user.id は文字で/);
    expect(() => viewerOf({ id: "a", roles: "経理" } as never)).toThrow(/roles は文字の配列/);
    expect(() => viewerOf({ id: "a", attrs: { id: "b" } })).toThrow(/id は属性の名前に使えません/);
    expect(() => viewerOf({ id: "a", attrs: { "a b": "x" } })).toThrow(/:user.a b と書けない名前/);
    expect(() => viewerOf({ id: "a", attrs: { r: "x", R: "y" } })).toThrow(/R が 2 つ/);
    expect(() => viewerOf({ id: "a", attrs: { r: ["x"] } as never })).toThrow(/r の値は文字・数値・真偽/);
  });
});

/** A project with users' regions on SQLite. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "devbi-rls-"));
  mkdirSync(path.join(dir, "db"));
  const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
  db.exec(`CREATE TABLE orders (id INTEGER, region TEXT, rep TEXT, amount INTEGER);
    INSERT INTO orders VALUES (1, '関東', 'CORP\\yamada', 100), (2, '関東', 'CORP\\tanaka', 200), (3, '近畿', 'CORP\\suzuki', 300);
    CREATE TABLE devbi_users (login TEXT, region TEXT, dept TEXT, roles TEXT);
    INSERT INTO devbi_users VALUES ('CORP\\yamada', '関東', '営業1', '営業'), ('CORP\\sato', '近畿', NULL, '営業, 経理'), ('CORP\\twice', 'a', NULL, NULL), ('CORP\\twice', 'b', NULL, NULL);`);
  db.close();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const env = { DEVBI_DB: "sqlite:db/shop.sqlite" };
const rowsOf = (bytes: Uint8Array) => tableFromIPC(bytes).toArray().map((r) => r.toJSON());

describe("row-level security on SQLite", () => {
  const files = {
    "api/mine.sql": "-- 自分の地域の受注\nSELECT id, region, amount FROM orders WHERE region = :user.region ORDER BY id",
    "api/my_orders.sql": "-- 自分の受注\nSELECT id FROM orders WHERE rep = :user.id",
    "api/regions.sql": "-- 地域の一覧（全員に）\n-- access: all\nSELECT DISTINCT region FROM orders ORDER BY region",
    "api/payroll.sql": "-- 経理だけ\n-- roles: 経理\n-- access: all\nSELECT SUM(amount) AS total FROM orders",
    "api/forgot.sql": "-- 絞り忘れ\nSELECT * FROM orders",
    "api/bare.sql": "-- access: all\nSELECT * FROM orders WHERE rep = :user",
  };
  let dir: string;
  let api: ApiHandler;
  const logs: string[] = [];
  const post = (body: unknown, user?: DevBIUser | null) =>
    api.fetch(new Request("http://x/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { user });
  const error = async (res: Response | undefined) => [res?.status, ((await res?.json()) as { error: string }).error] as const;

  beforeAll(() => {
    dir = project(files);
    api = createApiHandler({ dir, env, log: (l) => logs.push(l) });
  });
  afterAll(async () => {
    await api?.close();
  });

  it("the files put the project in row-level mode: nobody signed in is 401 everywhere", async () => {
    for (const path of ["api/schema", "snapshots/regions.arrows"]) {
      expect(await error(await api.fetch(new Request(`http://x/${path}`)))).toEqual([401, "ログインしていません"]);
    }
    expect(await error(await post({ name: "regions" }))).toEqual([401, "ログインしていません"]);
    expect(await error(await post({ name: "nope" }, null))).toEqual([401, "ログインしていません"]);
    await expect(api.run("regions")).rejects.toMatchObject({ status: 401 });
  });

  it("each user gets their own rows", async () => {
    const res = await post({ name: "mine" }, yamada);
    expect(res?.status).toBe(200);
    expect(rowsOf(new Uint8Array(await res!.arrayBuffer()))).toEqual([
      { id: 1n, region: "関東", amount: 100n },
      { id: 2n, region: "関東", amount: 200n },
    ]);
    expect(rowsOf((await api.run("mine", {}, { user: suzuki })).bytes)).toEqual([{ id: 3n, region: "近畿", amount: 300n }]);
    expect(rowsOf((await api.run("my_orders", {}, { user: { id: "CORP\\tanaka" } })).bytes)).toEqual([{ id: 2n }]);
    // the browser cannot be someone else
    expect(await error(await post({ name: "mine", params: { "user.region": "近畿" } }, yamada))).toEqual([
      400,
      "api/mine.sql: パラメーター user.region は渡せません（user. で始まる名前は、ログインした人の値のために取ってあります）",
    ]);
    expect((await error(await post({ name: "regions", params: { user: "CORP\\suzuki" } }, yamada)))[1]).toMatch(/パラメーター user は渡せません（行レベルのモードでは/);
    expect(logs).toContainEqual(expect.stringMatching(/^CORP\\yamada api\/mine\.sql: 2 行、\d+ ms$/));
  });

  it("403 without the attribute or the role, 400 for a file that does not say who sees what", async () => {
    expect(await error(await post({ name: "mine" }, { id: "CORP\\guest" }))).toEqual([403, "利用者 CORP\\guest に属性 region がありません（api/mine.sql の :user.region）"]);
    expect(await error(await post({ name: "mine" }, { id: "CORP\\guest", attrs: { region: "" } }))).toEqual([403, "利用者 CORP\\guest に属性 region がありません（api/mine.sql の :user.region）"]);
    expect(await error(await post({ name: "payroll" }, yamada))).toEqual([403, "api/payroll.sql を読む役割がありません（利用者 CORP\\yamada）"]);
    expect(rowsOf((await api.run("payroll", {}, { user: suzuki })).bytes)).toEqual([{ total: 600n }]);
    expect(await error(await post({ name: "forgot" }, yamada))).toEqual([
      400,
      "api/forgot.sql は、だれにどの行を見せるかが書いてありません。:user.… で絞るか、全員に全部の行を見せるなら -- access: all を書いてください（行レベルのモード: api/bare.sql に -- access: があるため）",
    ]);
    expect((await error(await post({ name: "bare" }, yamada)))[1]).toMatch(/^api\/bare\.sql: 行レベルのモードでは :user は使えません。ログインした人の ID なら :user\.id と書きます/);
  });

  it("the schema lists what the user may read, without the user's names, and says who it is for", async () => {
    const schema = async (user: DevBIUser) => (await (await api.fetch(new Request("http://x/api/schema"), { user }))!.json()) as Record<string, unknown> & { datasets: { name: string; params?: string[]; error?: string }[] };
    const forYamada = await schema(yamada);
    expect(forYamada).toMatchObject({ access: 1, user: { id: "CORP\\yamada" } });
    expect(forYamada.datasets.map((d) => d.name)).toEqual(["bare", "forgot", "mine", "my_orders", "regions"]);
    expect(forYamada.datasets.find((d) => d.name === "mine")).toMatchObject({ params: [], parameters: [] });
    expect(forYamada.datasets.find((d) => d.name === "forgot")?.error).toMatch(/だれにどの行を見せるかが書いてありません/);
    expect((await schema(suzuki)).datasets.map((d) => d.name)).toContain("payroll");
    expect(JSON.stringify(forYamada)).not.toContain("経理");
  });

  it("a wrong user from the host is a 500 that says so", async () => {
    expect(await error(await post({ name: "regions" }, { id: "a", attrs: { id: "b" } }))).toEqual([500, "user.attrs の id: id は属性の名前に使えません（:user.id はログインした人の ID です）"]);
  });
});

describe("row-level mode from the host, and projects that do not use it", () => {
  it("requireUser: on whatever the files say", async () => {
    const dir = project({ "api/all.sql": "SELECT region FROM orders" });
    const api = createApiHandler({ dir, env, requireUser: true });
    try {
      expect((await api.fetch(new Request("http://x/api/schema")))?.status).toBe(401);
      await expect(api.run("all", {}, { user: yamada })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/（行レベルのモード: ホストの設定 requireUser）$/) });
    } finally {
      await api.close();
    }
  });
  it("an access/ folder turns it on too", async () => {
    const dir = project({ "api/all.sql": "-- access: all\nSELECT region FROM orders", "access/readme.txt": "" });
    const api = createApiHandler({ dir, env });
    try {
      await expect(api.run("all")).rejects.toMatchObject({ status: 401 });
      expect((await api.run("all", {}, { user: yamada })).rows).toBe(3);
    } finally {
      await api.close();
    }
  });
  it("without it, nothing changes (a user given is logged, once a warning)", async () => {
    const dir = project({ "api/all.sql": "SELECT region FROM orders WHERE rep <> :user" });
    const lines: string[] = [];
    const api = createApiHandler({ dir, env, log: (l) => lines.push(l) });
    try {
      expect((await api.run("all", { user: "x" })).rows).toBe(3);
      const schema = (await (await api.fetch(new Request("http://x/api/schema")))!.json()) as Record<string, unknown>;
      expect(schema).toMatchObject({ access: 1 });
      expect(schema).not.toHaveProperty("user");
      await api.run("all", { user: "x" }, { user: yamada });
      await api.run("all", { user: "x" }, { user: yamada });
      expect(lines.filter((l) => l.startsWith("利用者を受け取っていますが、行レベルのモードになっていません"))).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
});

describe("access/user.sql: the user's attributes and roles from a table", () => {
  const files = {
    "api/mine.sql": "SELECT id FROM orders WHERE region = :user.region ORDER BY id",
    "api/payroll.sql": "-- roles: 経理\n-- access: all\nSELECT SUM(amount) AS total FROM orders",
    "access/user.sql": "-- 利用者の属性\nSELECT region, dept, roles FROM devbi_users WHERE login = :user.id",
  };

  it("fills what the host does not give; the host's values win, its null means none", async () => {
    const dir = project(files);
    const api = createApiHandler({ dir, env });
    try {
      expect(rowsOf((await api.run("mine", {}, { user: { id: "CORP\\yamada" } })).bytes)).toEqual([{ id: 1n }, { id: 2n }]);
      expect(rowsOf((await api.run("mine", {}, { user: { id: "CORP\\yamada", attrs: { region: "近畿" } } })).bytes)).toEqual([{ id: 3n }]);
      await expect(api.run("mine", {}, { user: { id: "CORP\\yamada", attrs: { region: null } } })).rejects.toMatchObject({ status: 403 });
      // undefined is not given (`{ region: claims.region }` without the claim): the table's value
      expect((await api.run("mine", {}, { user: { id: "CORP\\yamada", attrs: { region: undefined } } })).rows).toBe(2);
      // roles from the table and the host both count
      expect((await api.run("payroll", {}, { user: { id: "CORP\\sato" } })).rows).toBe(1);
      expect((await api.run("payroll", {}, { user: { id: "CORP\\yamada", roles: ["経理"] } })).rows).toBe(1);
      await expect(api.run("payroll", {}, { user: { id: "CORP\\yamada" } })).rejects.toMatchObject({ status: 403 });
      // not in the table: only what the host gives
      await expect(api.run("mine", {}, { user: { id: "CORP\\nobody" } })).rejects.toMatchObject({ status: 403, message: "利用者 CORP\\nobody に属性 region がありません（api/mine.sql の :user.region）" });
      await expect(api.run("mine", {}, { user: { id: "CORP\\twice" } })).rejects.toMatchObject({ status: 500, message: "access/user.sql が利用者 CORP\\twice の行を 2 行以上返しました。1 人につき 1 行（いなければ 0 行）にしてください" });
    } finally {
      await api.close();
    }
  });

  it("writes one line to the log for each, whatever the id holds", async () => {
    const dir = project(files);
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.prepare("INSERT INTO devbi_users VALUES (?, 'a', NULL, NULL), (?, 'b', NULL, NULL)").run("CORP\\twice\n2026-11-23 ok", "CORP\\twice\n2026-11-23 ok");
    db.close();
    const lines: string[] = [];
    const api = createApiHandler({ dir, env, log: (l) => lines.push(l) });
    try {
      const res = await api.fetch(new Request("http://x/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "mine" }) }), { user: { id: "CORP\\twice\n2026-11-23 ok" } });
      expect(res?.status).toBe(500);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).not.toMatch(/[\n\r]/);
      expect(lines.join("|")).toContain("CORP\\twice?2026-11-23 ok");
    } finally {
      await api.close();
    }
  });

  it("is kept for userCacheMs", async () => {
    const dir = project(files);
    const kept = createApiHandler({ dir, env });
    const fresh = createApiHandler({ dir, env, userCacheMs: 0 });
    const user = { user: { id: "CORP\\yamada" } };
    try {
      expect((await kept.run("mine", {}, user)).rows).toBe(2);
      expect((await fresh.run("mine", {}, user)).rows).toBe(2);
      const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
      db.exec("UPDATE devbi_users SET region = '近畿' WHERE login = 'CORP\\yamada'");
      db.close();
      expect((await kept.run("mine", {}, user)).rows).toBe(2);
      expect((await fresh.run("mine", {}, user)).rows).toBe(1);
    } finally {
      await kept.close();
      await fresh.close();
    }
  });

  it("only :user.id, one statement that reads; its mistakes are 500s that name the file", async () => {
    const run = async (text: string) => {
      const dir = project({ ...files, "access/user.sql": text });
      const api = createApiHandler({ dir, env });
      try {
        await api.run("mine", {}, { user: { id: "CORP\\yamada" } });
        return "no error";
      } catch (e) {
        return `${(e as { status: number }).status} ${(e as Error).message}`;
      } finally {
        await api.close();
      }
    };
    expect(await run("SELECT region FROM devbi_users")).toBe("500 access/user.sql: :user.id で、ログインした人の行を選んでください（WHERE u.login = :user.id）");
    expect(await run("SELECT region FROM devbi_users WHERE login = :user.id AND dept = :dept")).toBe("500 access/user.sql: 使えるパラメーターは :user.id だけです（:dept があります）");
    expect(await run("SELECT region FROM devbi_users WHERE login = :user.id AND dept = :user.dept")).toMatch(/（:user.dept があります）/);
    expect(await run("UPDATE devbi_users SET region = 'x'")).toMatch(/^500 access\/user\.sql: SELECT か WITH で始まる文だけ/);
    expect(await run("SELECT login AS id, region FROM devbi_users WHERE login = :user.id")).toBe("500 access/user.sql の列 id: id は属性の名前に使えません（:user.id はログインした人の ID です）");
    expect(await run("SELECT region FROM devbi_users WHERE login = :user.id")).toBe("no error");
  });
});

describe("snapshots in row-level mode", () => {
  const files = {
    "api/regions.sql": "-- snapshot: 06:00\n-- access: all\nSELECT DISTINCT region FROM orders ORDER BY region",
    "api/totals.sql": "-- snapshot: 06:00\nSELECT region, SUM(amount) AS amount FROM orders GROUP BY region",
    "api/mine.sql": "SELECT id FROM orders WHERE region = :user.region",
    "models/m.metrics.yaml": "measures:\n  n: COUNT(*)\nmodel: SELECT * FROM read_api('regions') JOIN read_api('totals') USING (region)\n",
  };

  it("only -- access: all SQL is made, after the login is checked", async () => {
    const dir = project(files);
    const { jobs, problems, snapshotting } = await snapshotJobs(dir, env, { rowLevel: true });
    expect(jobs.map((j) => j.file)).toEqual(["regions.arrows"]);
    expect(snapshotting).toEqual(["regions"]);
    expect(problems).toEqual(["api/totals.sql: 行レベルのモードなので、-- access: all のない SQL のスナップショットは作りません"]);
    expect((await snapshotJobs(dir, env, { rowLevel: true })).leftOut).toBe(1);
    const out = path.join(dir, "site", "snapshots");
    const api = createApiHandler({ dir, env, snapshotDir: out });
    try {
      expect((await api.fetch(new Request("http://x/snapshots/regions.arrows")))?.status).toBe(401);
      expect(existsSync(path.join(out, "regions.arrows"))).toBe(false);
      const res = await api.fetch(new Request("http://x/snapshots/regions.arrows"), { user: yamada });
      expect(res?.status).toBe(200);
      expect(rowsOf(new Uint8Array(await res!.arrayBuffer()))).toEqual([{ region: "近畿" }, { region: "関東" }]);
      expect((await api.fetch(new Request("http://x/snapshots/totals.arrows"), { user: yamada }))?.status).toBe(404);
    } finally {
      await api.close();
    }
  });

  it("removes the files no job makes any more: none of everyone's rows is left behind", async () => {
    // models/bad.metrics.yaml cannot be read: its read_api calls may be jobs, so the files of SQL still made stay
    const dir = project({ ...files, "models/bad.metrics.yaml": "measures: [" });
    const out = path.join(dir, "site", "snapshots");
    mkdirSync(out, { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    const put = (f: string, at?: Date) => {
      writeFileSync(path.join(out, f), "old");
      if (at) utimesSync(path.join(out, f), at, at);
    };
    // made before the SQL filtered by user, by an older build, half written long ago, and not DevBI's
    put("totals.arrows");
    put("mine.arrows");
    put(snapshotFile("regions", { from: "2020-01-01" }));
    put("regions.arrows.123-456.tmp", old);
    put("regions.arrows.124-457.tmp");
    put("notes.txt");
    const lines: string[] = [];
    const api = createApiHandler({ dir, env, snapshotDir: out, log: (l) => lines.push(l) });
    try {
      const made = await api.snapshots.make();
      expect(made.map((r) => [r.file, r.ok])).toEqual([["regions.arrows", true]]);
      // a file that cannot be read keeps the files of SQL that is still made (regions' old parameters)
      expect(readFileSync(path.join(out, snapshotFile("regions", { from: "2020-01-01" })), "utf8")).toBe("old");
      for (const f of ["totals.arrows", "mine.arrows", "regions.arrows.123-456.tmp"]) expect(existsSync(path.join(out, f))).toBe(false);
      for (const f of ["regions.arrows.124-457.tmp", "notes.txt", "regions.arrows"]) expect(existsSync(path.join(out, f))).toBe(true);
      expect(lines).toContainEqual("スナップショット: 今は作らない totals.arrows を消しました");
    } finally {
      await api.close();
    }
    // SQL left out in row-level mode (totals.sql) leaves no doubt: every file no job makes goes, at the first look
    // at the jobs (devbi-serve without a schedule, or a host that only answers snapshots/<file>)
    rmSync(path.join(dir, "models", "bad.metrics.yaml"));
    const again = createApiHandler({ dir, env, snapshotDir: out });
    try {
      expect((await again.snapshots.jobs()).map((j) => j.file)).toEqual(["regions.arrows"]);
      expect(existsSync(path.join(out, snapshotFile("regions", { from: "2020-01-01" })))).toBe(false);
      expect(existsSync(path.join(out, "regions.arrows"))).toBe(true);
    } finally {
      await again.close();
    }
  });

  it("a -- snapshot: line with :user. makes no job, and its old file is not sent", async () => {
    const dir = project({ ...files, "api/regions.sql": "-- snapshot: 06:00\nSELECT DISTINCT region FROM orders WHERE region = :user.region" });
    const out = path.join(dir, "site", "snapshots");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "regions.arrows"), "everyone's rows");
    const api = createApiHandler({ dir, env, snapshotDir: out });
    try {
      expect((await api.snapshots.jobs()).map((j) => j.file)).toEqual([]);
      expect((await api.fetch(new Request("http://x/snapshots/regions.arrows"), { user: yamada }))?.status).toBe(404);
      await api.snapshots.catchUp();
      expect(existsSync(path.join(out, "regions.arrows"))).toBe(false);
    } finally {
      await api.close();
    }
  });
});

describe("devbi-serve sends snapshots through the API only", () => {
  let running: RunningServer;
  let dir: string;
  beforeAll(async () => {
    dir = project({
      "api/regions.sql": "-- snapshot: 06:00\n-- access: all\nSELECT DISTINCT region FROM orders ORDER BY region",
      "api/mine.sql": "SELECT id FROM orders WHERE region = :user.region",
      "models/m.metrics.yaml": "measures:\n  n: COUNT(*)\nmodel: SELECT * FROM read_api('regions')\n",
      "dist/index.html": "<!doctype html><title>t</title>",
      "dist/snapshots/regions.arrows": "made yesterday",
      "dist/snapshots/regions.arrows.1-2.tmp": "half",
    });
    running = await serve({ dir, port: 0, env, schedule: false });
  });
  afterAll(async () => {
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  /** The status for a path as written (fetch would tidy `//` and `%2E`). */
  const status = (p: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(running.url);
      request({ host: u.hostname, port: u.port, path: p }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });

  it("never as plain files, whatever the path looks like", async () => {
    expect(await status("/snapshots/regions.arrows")).toBe(401);
    for (const p of ["/snapshots//regions.arrows", "/snapshots/regions.arrows/", "/snapshots/regions%2Earrows", "/x/../snapshots//regions.arrows", "/snapshots/regions.arrows.1-2.tmp", "/./snapshots/regions.arrows%3F"]) {
      expect([p, await status(p)]).toEqual([p, 404]);
    }
    expect(await status("/index.html")).toBe(200);
  });
});

describe("devbi-serve --user-header: the user from the server in front", () => {
  const files = {
    "api/mine.sql": "SELECT id FROM orders WHERE region = :user.region ORDER BY id",
    "access/user.sql": "SELECT region, roles FROM devbi_users WHERE login = :user.id",
    "dist/index.html": "<!doctype html><title>t</title>",
  };
  /** A raw request: headers as given (two of one, bytes Node reads as Latin-1). */
  const ask = (running: RunningServer, p: string, headers: Record<string, string | string[]> = {}, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const u = new URL(running.url);
      const req = request(
        { host: u.hostname, port: u.port, path: p, method: body ? "POST" : "GET", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      // A Buffer: a string body would send the headers in its encoding (UTF-8), not byte for byte.
      req.end(body ? Buffer.from(JSON.stringify(body)) : undefined);
    });
  const errorOf = (r: { status: number; text: string }) => `${r.status} ${(JSON.parse(r.text) as { error: string }).error}`;
  const query = { name: "mine" };
  const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");

  it("believes the header from this computer; two of it, or bytes that are not UTF-8, are refused", async () => {
    const dir = project(files);
    const db = new DatabaseSync(path.join(dir, "db", "shop.sqlite"));
    db.prepare("INSERT INTO devbi_users VALUES (?, '近畿', NULL, NULL)").run("山田");
    db.close();
    const logs: string[] = [];
    const running = await serve({ dir, port: 0, env, schedule: false, userHeader: "X-DevBI-User", log: (l) => logs.push(l) });
    try {
      expect(errorOf(await ask(running, "/api/query", {}, query))).toBe("401 ログインしていません（前のサーバーから X-DevBI-User が届いていません）");
      const yamada = await ask(running, "/api/query", { "X-DevBI-User": "CORP\\yamada" }, query);
      expect(yamada.status).toBe(200);
      expect(JSON.parse((await ask(running, "/api/schema", { "x-devbi-user": " CORP\\yamada " })).text).user).toEqual({ id: "CORP\\yamada" });
      // a name in Japanese, as nginx or IIS sends it (UTF-8)
      expect(JSON.parse((await ask(running, "/api/schema", { "X-DevBI-User": latin1("山田") })).text).user).toEqual({ id: "山田" });
      expect((await ask(running, "/api/query", { "X-DevBI-User": latin1("山田") }, query)).status).toBe(200);
      expect(errorOf(await ask(running, "/api/query", { "X-DevBI-User": "  " }, query))).toBe("401 ログインしていません（前のサーバーから届いた X-DevBI-User が空です）");
      // the server in front added its own instead of replacing the browser's
      expect(errorOf(await ask(running, "/api/query", { "X-DevBI-User": ["CORP\\yamada", "CORP\\suzuki"] }, query))).toBe(
        "400 X-DevBI-User が 2 つあります。前のサーバーは、ブラウザから来た X-DevBI-User を上書きします（足しません）",
      );
      expect(errorOf(await ask(running, "/api/schema", { "X-DevBI-User": "\xff\xfe" }))).toBe("400 X-DevBI-User の値が UTF-8 ではありません");
      expect(logs).toContain("リクエストを断りました: X-DevBI-User の値が UTF-8 ではありません");
      // the site's files are the same for everyone
      expect((await ask(running, "/index.html", { "X-DevBI-User": ["a", "b"] })).status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it("is row-level mode, whatever the files say (requireUser)", async () => {
    const dir = project({ "api/all.sql": "SELECT COUNT(*) AS n FROM orders", "dist/index.html": "<!doctype html>" });
    const running = await serve({ dir, port: 0, env, schedule: false, userHeader: "X-DevBI-User" });
    try {
      expect((await ask(running, "/api/query", {}, { name: "all" })).status).toBe(401);
      const r = await ask(running, "/api/query", { "X-DevBI-User": "CORP\\yamada" }, { name: "all" });
      expect(errorOf(r)).toMatch(/-- access: all を書いてください/);
    } finally {
      await running.close();
    }
  });

  it("not from a trusted server, or without the secret: nobody, and a line in the log once a minute", async () => {
    const dir = project(files);
    const logs: string[] = [];
    const far = await serve({ dir, port: 0, env, schedule: false, userHeader: "X-DevBI-User", trustedProxies: ["10.0.0.1"], log: (l) => logs.push(l) });
    try {
      for (let i = 0; i < 2; i++) {
        expect(errorOf(await ask(far, "/api/query", { "X-DevBI-User": "CORP\\yamada" }, query))).toBe("401 ログインしていません（このサーバーは、前に置いたサーバーを通して開きます）");
      }
      expect(logs.filter((l) => l.includes("を使いませんでした"))).toEqual([
        "X-DevBI-User を使いませんでした（127.0.0.1 は --trusted-proxy にありません）。ログインしていない人として答えます（同じ相手は 1 分に 1 回だけ書きます）",
      ]);
    } finally {
      await far.close();
    }
    const near = await serve({ dir, port: 0, env, schedule: false, userHeader: "X-DevBI-User", trustedProxies: ["127.0.0.0/8"], proxySecret: "s3cret", userLowercase: true });
    try {
      expect((await ask(near, "/api/query", { "X-DevBI-User": "CORP\\yamada" }, query)).status).toBe(401);
      expect((await ask(near, "/api/query", { "X-DevBI-User": "CORP\\yamada", "X-DevBI-Proxy-Secret": "wrong" }, query)).status).toBe(401);
      expect((await ask(near, "/api/query", { "X-DevBI-User": "CORP\\yamada", "X-DevBI-Proxy-Secret": ["s3cret", "s3cret"] }, query)).status).toBe(401);
      expect(JSON.parse((await ask(near, "/api/schema", { "X-DevBI-User": "CORP\\Yamada", "X-DevBI-Proxy-Secret": "s3cret" })).text).user).toEqual({ id: "corp\\yamada" });
    } finally {
      await near.close();
    }
  });

  it("checks the options when it starts", async () => {
    const { proxyUser } = await import("../src/proxy-user.js");
    expect(() => proxyUser({ header: "X DevBI" })).toThrow("--user-header の X DevBI はヘッダーの名前になりません");
    expect(() => proxyUser({ header: "X-DevBI-Proxy-Secret" })).toThrow(/合言葉のヘッダー/);
    for (const bad of ["localhost", "10.0.0.0/33", "10.0.0.1/8/1", "::1/129", "10.0.0.0/x"]) {
      expect(() => proxyUser({ header: "X-DevBI-User", trustedProxies: [bad] })).toThrow(`--trusted-proxy の ${bad} は IP アドレス`);
    }
    const from = (remoteAddress: string, user = "CORP\\yamada") =>
      proxyUser({ header: "X-DevBI-User", trustedProxies: ["192.168.10.0/24", "fd00::/8"] })({ socket: { remoteAddress }, headersDistinct: { "x-devbi-user": [user] } } as never);
    expect(from("192.168.10.7")).toEqual({ options: { user: { id: "CORP\\yamada" } } });
    expect(from("::ffff:192.168.10.7")).toEqual({ options: { user: { id: "CORP\\yamada" } } });
    expect(from("fd12::1")).toEqual({ options: { user: { id: "CORP\\yamada" } } });
    expect(from("192.168.11.7")).toMatchObject({ ignored: "192.168.11.7 は --trusted-proxy にありません" });
    expect(from("127.0.0.1")).toMatchObject({ ignored: "127.0.0.1 は --trusted-proxy にありません" });
    await expect(serve({ dir: project(files), port: 0, env, schedule: false, userHeader: "X-DevBI-User", proxySecret: " " })).rejects.toThrow("合言葉（proxySecret）が空です");
    // the options of the header without it
    await expect(serve({ dir: project(files), port: 0, env, schedule: false, trustedProxies: ["10.0.0.1"], userLowercase: true })).rejects.toThrow(
      "trustedProxies・userLowercase は userHeader と一緒に使います",
    );
    expect(() => proxyUser({ header: "X-DevBI-User", trustedProxies: [] })).toThrow("--trusted-proxy に IP アドレスがありません");
  });

  it("reads IPv4 as IPv4: ::ffff: ranges, and IPv6 ranges that would hold every IPv4 address are refused", async () => {
    const { proxyUser, trustedList } = await import("../src/proxy-user.js");
    const from = (trustedProxies: string[], remoteAddress: string) => {
      const got = proxyUser({ header: "X-DevBI-User", trustedProxies })({ socket: { remoteAddress }, headersDistinct: { "x-devbi-user": ["a"] } } as never);
      return "options" in got && got.options.user !== undefined;
    };
    expect(from(["::ffff:10.0.0.0/104"], "10.1.2.3")).toBe(true);
    expect(from(["::ffff:10.0.0.0/104"], "::ffff:10.1.2.3")).toBe(true);
    expect(from(["::ffff:10.0.0.0/104"], "11.0.0.1")).toBe(false);
    expect(from(["::ffff:10.0.0.5"], "10.0.0.5")).toBe(true);
    expect(from(["::ffff:10.0.0.5"], "10.0.0.6")).toBe(false);
    for (const bad of ["::ffff:10.0.0.0/8", "::/8", "::/0", "::ffff:0:0/95"]) {
      expect(() => trustedList([bad])).toThrow(`--trusted-proxy の ${bad} は、IPv4 のアドレスもすべて含んでしまいます`);
    }
    // a zone (fe80::1%eth0) is left out by the check: it would be fe80::1 on every network
    expect(() => trustedList(["fe80::1%eth0"])).toThrow("--trusted-proxy の fe80::1%eth0 は IP アドレス");
    expect(from(["fd00::/8"], "127.0.0.1")).toBe(false);
  });

  it("takes the value as it came: one with , (two joined), and with --user-lowercase a letter of another shape, are refused", async () => {
    const { proxyUser } = await import("../src/proxy-user.js");
    const got = (user: string, lowercase = false) =>
      proxyUser({ header: "X-DevBI-User", lowercase })({ socket: { remoteAddress: "127.0.0.1" }, headersDistinct: { "x-devbi-user": [Buffer.from(user, "utf8").toString("latin1")] } } as never);
    expect(got("mallory, alice")).toEqual({
      refuse: "X-DevBI-User の値に , があります（2 つの値を 1 行にしたもののようです）。前のサーバーは、ブラウザから来た X-DevBI-User を上書きします（足しません）",
    });
    // only spaces and tabs around it are dropped: not U+3000, NBSP or a BOM
    expect(got(" \talice\t ")).toEqual({ options: { user: { id: "alice" } } });
    expect(got("alice\u3000")).toEqual({ options: { user: { id: "alice\u3000" } } });
    expect(got("\u00a0alice")).toEqual({ options: { user: { id: "\u00a0alice" } } });
    expect(got("\ufeffalice")).toEqual({ options: { user: { id: "\ufeffalice" } } });
    expect(got("CORP\\Yamada", true)).toEqual({ options: { user: { id: "corp\\yamada" } } });
    expect(got("\u212Aimura", true)).toMatchObject({ refuse: expect.stringMatching(/^X-DevBI-User の値に、全角の英字や記号のような、ふつうと違う形の文字があります/) });
    expect(got("ｋimura", true)).toMatchObject({ refuse: expect.stringMatching(/ふつうと違う形の文字/) });
    expect(got("\u212Aimura")).toEqual({ options: { user: { id: "\u212Aimura" } } });
  });

  it("takes a secret of visible ASCII only, and compares it byte for byte", async () => {
    const { proxyUser } = await import("../src/proxy-user.js");
    for (const bad of ["合言葉", "pässwörd", " s3cret", "s3\ncret", "\u0000s\u00003"]) {
      expect(() => proxyUser({ header: "X-DevBI-User", secret: bad })).toThrow(/^合言葉は、半角の英数字と記号で書いてください/);
    }
    const check = proxyUser({ header: "X-DevBI-User", secret: "s3 cr#t" });
    const ask = (secret: string) => check({ socket: { remoteAddress: "127.0.0.1" }, headersDistinct: { "x-devbi-user": ["a"], "x-devbi-proxy-secret": [secret] } } as never);
    expect(ask("s3 cr#t")).toEqual({ options: { user: { id: "a" } } });
    expect(ask("s3 cr#T")).toMatchObject({ ignored: "127.0.0.1 からの x-devbi-proxy-secret が合いません" });
  });

  it("writes the log line of a header not believed once a minute for each address, 10 lines a minute in all", async () => {
    const { logGate } = await import("../src/proxy-user.js");
    let now = 0;
    const gate = logGate(10, () => now);
    expect(gate("10.0.0.1")).toBe(true);
    expect(gate("10.0.0.1")).toBe(false);
    const written = Array.from({ length: 20 }, (_, i) => gate(`10.0.1.${i}`));
    expect(written.filter((w) => w === true)).toHaveLength(8);
    expect(written[8]).toBe("last");
    expect(written.slice(9).every((w) => w === false)).toBe(true);
    now += 60_000;
    expect(gate("10.0.0.1")).toBe(true);
    expect(gate("10.0.1.15")).toBe(true);
  });
});
