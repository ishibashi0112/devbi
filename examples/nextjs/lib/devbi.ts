// The DevBI read-only API for this app: one for the whole server. app/devbi/[...path]/route.ts answers with it,
// and instrumentation.ts starts its morning snapshots.
import path from "node:path";
import { createApiHandler, loadEnv, type ApiHandler } from "@devbi/server";

// The DevBI project: api/*.sql, models/, and its .env with DEVBI_DB (here the sales example next door). This
// app's own variables (.env.local, the server's environment) win over the project's .env.
// turbopackIgnore: folders read when the server runs, not files of the build.
const dir = path.resolve(/* turbopackIgnore: true */ process.env.DEVBI_DIR ?? "../sales");

function create(): ApiHandler {
  return createApiHandler({
    dir,
    env: loadEnv(dir),
    // On the server, sent by the route (next start does not serve files put in public/ after it started).
    snapshotDir: path.resolve(/* turbopackIgnore: true */ process.env.DEVBI_SNAPSHOTS ?? "snapshots"),
    log: (line) => console.log(`[devbi] ${line}`),
  });
}

// 「担当の売上」: a project whose api/orders.sql filters by who signed in (:user.region). requireUser: every request
// needs a user (401 without), and every api/*.sql must use :user. or say -- access: all, even if a file is removed
// or mistyped. app/devbi-rls/[...path]/route.ts hands it the user of the app's session.
const rlsDir = path.resolve(/* turbopackIgnore: true */ process.env.DEVBI_RLS_DIR ?? "../sales/e2e/rls");

function createRls(): ApiHandler {
  return createApiHandler({
    dir: rlsDir,
    env: loadEnv(rlsDir),
    requireUser: true,
    log: (line) => console.log(`[devbi-rls] ${line}`),
  });
}

// globalThis: `next dev` loads this file again after each change, and the route and instrumentation.ts are
// built apart; all of them share the one handler and its database connections.
const shared = globalThis as typeof globalThis & { devbi?: ApiHandler; devbiRls?: ApiHandler };
export const devbi = (shared.devbi ??= create());
export const devbiRls = (shared.devbiRls ??= createRls());
