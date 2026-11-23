// Asking a dataset's database for its columns (api/describe), for devbi-check and pnpm gen: with a time limit, and
// telling "no database to ask" from a database that answered with an error.
import type { ApiHandler, DescribedColumn } from "@devbi/server";

/** A dataset's columns as its database describes them, or why not (`offline`: no database to ask). */
export interface Described {
  columns?: DescribedColumn[];
  why?: string;
  offline?: boolean;
}

/** How long to wait for a database to describe a dataset (one that does not answer is left as not asked). */
export const DESCRIBE_SECONDS = 20;

// No database to ask: none written (接続先がありません), a driver that cannot connect, no answer in time, or the
// network refusing (pools connect on the first query, so a refused connection comes back as the query's error:
// Node's ECONNREFUSED…, SQL Server's "Failed to connect", Oracle's NJS-5xx and TNS ORA-125xx).
const OFFLINE =
  /^(接続先がありません|データベースにつなげません)|秒たっても答えがありません$|\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b|Failed to connect to |\bNJS-5\d\d\b|\bORA-12(5\d\d|170)\b/;

/** Ask `api` for the columns of dataset `name`: never throws. */
export async function askColumns(api: Pick<ApiHandler, "describe">, name: string, seconds = DESCRIBE_SECONDS): Promise<Described> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${seconds} 秒たっても答えがありません`)), seconds * 1000);
    });
    return { columns: (await Promise.race([api.describe(name), late])).columns };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // No connection (none written, or it does not connect, or no answer): as without a database.
    return { why, offline: OFFLINE.test(why) };
  } finally {
    clearTimeout(timer);
  }
}
