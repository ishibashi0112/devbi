import { describe, expect, it } from "vitest";
import { askColumns } from "../src/describe.js";

const failing = (message: string) => ({ describe: () => Promise.reject(new Error(message)) });

describe("askColumns", () => {
  it("gives the columns, or why not: no database to ask (offline) or a database that answered with an error", async () => {
    const columns = [{ name: "id", type: "int" as const }];
    expect(await askColumns({ describe: async (name) => ({ name, columns }) }, "x")).toEqual({ columns });
    for (const why of [
      "接続先がありません。DEVBI_DB に書いてください",
      "データベースにつなげません: pg がありません",
      "api/x.sql: connect ECONNREFUSED 127.0.0.1:5432",
      "api/x.sql: getaddrinfo ENOTFOUND db.example",
      "api/x.sql: Failed to connect to db:1433 - Could not connect (sequence)",
      "api/x.sql: NJS-503: connection to host db port 1521 could not be established",
      "api/x.sql: ORA-12541: TNS:no listener",
    ]) {
      expect(await askColumns(failing(why), "x"), why).toEqual({ why, offline: true });
    }
    const sqlError = "api/x.sql: no such column: nope";
    expect(await askColumns(failing(sqlError), "x")).toEqual({ why: sqlError, offline: false });
    expect(await askColumns(failing("api/x.sql: password authentication failed for user \"devbi\""), "x")).toMatchObject({ offline: false });
  });

  it("stops waiting after the time limit (as no database)", async () => {
    const never = { describe: () => new Promise<never>(() => undefined) };
    expect(await askColumns(never, "x", 0.05)).toEqual({ why: "0.05 秒たっても答えがありません", offline: true });
  });
});
