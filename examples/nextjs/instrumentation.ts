// When the server starts: make the snapshots that are missing or older than their time, then each at its time
// of day, as devbi-serve does. (Without a long-running server, run devbi-snapshot from cron or Task Scheduler.)
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { devbi } = await import("./lib/devbi");
  devbi.snapshots.schedule();
  void devbi.snapshots.catchUp().catch((e: Error) => console.error(`[devbi] スナップショット: ${e.message}`));
}
