import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiCalls, parseMetricsYaml, snapshotFile, type ApiParamValue } from "devbi";
import { DatasetError, listDatasets, readDatasetText, snapshotOf } from "./datasets.js";

/** One snapshot to make: a `read_api(name, params)` call in models/ whose SQL file has a `-- snapshot:` line. */
export interface SnapshotJob {
  /** The SQL file: `api/<name>.sql`. */
  name: string;
  params: Record<string, ApiParamValue>;
  /** The file in the snapshots folder: `snapshotFile(name, params)`. */
  file: string;
  /** The times of day it is made (server time, `HH:MM`), from the `-- snapshot:` line. */
  times: string[];
  /** The metrics files that read it (`models/<name>.metrics.yaml`). */
  models: string[];
}

export interface SnapshotResult {
  file: string;
  name: string;
  ok: boolean;
  rows?: number;
  ms?: number;
  /** Why it failed, as the browser may see it (details of file system errors only go to the log). */
  error?: string;
  /** The HTTP status of the failure, when the SQL failed (422: too many rows; 400: the SQL breaks a rule). */
  status?: number;
}

export interface SnapshotStatus {
  file: string;
  name: string;
  params: Record<string, ApiParamValue>;
  times: string[];
  models: string[];
  /** When the saved file was made; null when there is none yet (or no folder to save in). */
  updatedAt: string | null;
  /** Why the last try failed, when it did. */
  error?: string;
}

/** A saved file (open it before reading its time and size: it may be replaced meanwhile), or the rows as they are now. */
export type SnapshotFound = { path: string; rows?: number } | { at: Date; rows: number; bytes: Uint8Array };

export interface Snapshots {
  /** The snapshots to make, read again from models/ and api/ each time (a git pull takes effect without a restart). */
  jobs(): Promise<SnapshotJob[]>;
  /**
   * For `GET …/snapshots/<file>`: the saved file, made first when it is not there yet; without a folder to save
   * in (the dev server), the rows as they are now. Throws a DatasetError (404) when no job makes that file.
   */
  get(file: string): Promise<SnapshotFound>;
  /** Make and save snapshots now: all of them, or those of the given SQL files. */
  make(names?: string[]): Promise<SnapshotResult[]>;
  /** Make those that are missing or older than their last time of day (when the server starts). */
  catchUp(now?: Date): Promise<SnapshotResult[]>;
  /** From now on, make each at its times of day, until `stop()`. */
  schedule(): void;
  stop(): void;
  /** Resolves when none is being made. */
  idle(): Promise<void>;
  status(): Promise<SnapshotStatus[]>;
}

function at(day: Date, time: string, addDays = 0): Date {
  const [h, m] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, h, m, 0, 0);
}

/** The last of the times of day at or before `now` (today's, or else yesterday's). */
export function lastDue(times: string[], now: Date): Date | undefined {
  let best: Date | undefined;
  for (const t of times) {
    for (const d of [0, -1]) {
      const when = at(now, t, d);
      if (when <= now && (!best || when > best)) best = when;
    }
  }
  return best;
}

/** The first of the times of day after `now` (today's, or else tomorrow's). */
export function nextDue(times: string[], now: Date): Date | undefined {
  let best: Date | undefined;
  for (const t of times) {
    for (const d of [0, 1]) {
      const when = at(now, t, d);
      if (when > now && (!best || when < best)) best = when;
    }
  }
  return best;
}

/**
 * The snapshots of a project: each `read_api(...)` call in `models/*.metrics.yaml` whose SQL file has a
 * `-- snapshot: 06:00` line, with the parameters written there. Files that cannot be read are listed in `problems`.
 */
export async function snapshotJobs(dir: string): Promise<{ jobs: SnapshotJob[]; problems: string[] }> {
  const problems: string[] = [];
  const times = new Map<string, string[]>();
  let names: string[];
  try {
    names = await listDatasets(dir);
  } catch (e) {
    // The folder is away for a moment (a network drive, a deploy): no snapshots this time, not a crash.
    return { jobs: [], problems: [`api/ を読めません: ${(e as Error).message}`] };
  }
  for (const name of names) {
    try {
      const t = snapshotOf(await readDatasetText(dir, name), name);
      if (t) times.set(name, t);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const jobs = new Map<string, SnapshotJob>();
  const modelsDir = path.join(dir, "models");
  if (times.size === 0 || !existsSync(modelsDir)) return { jobs: [], problems };
  let files: string[];
  try {
    files = (await readdir(modelsDir)).filter((f) => f.endsWith(".metrics.yaml")).sort();
  } catch (e) {
    return { jobs: [], problems: [...problems, `models/ を読めません: ${(e as Error).message}`] };
  }
  for (const f of files) {
    const model = f.slice(0, -".metrics.yaml".length);
    try {
      const view = parseMetricsYaml(await readFile(path.join(modelsDir, f), "utf8"), model, `models/${f}`);
      for (const call of apiCalls(view.model)) {
        const t = times.get(call.name);
        if (!t) continue;
        const file = snapshotFile(call.name, call.params);
        const job = jobs.get(file);
        if (job) {
          if (!job.models.includes(model)) job.models.push(model);
        } else {
          jobs.set(file, { name: call.name, params: call.params, file, times: t, models: [model] });
        }
      }
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return { jobs: [...jobs.values()], problems };
}

/** Replace `target` with `tmp`. Windows refuses while another process reads the old file: try again for a while. */
async function replace(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export function createSnapshots(options: {
  dir: string;
  run: (name: string, params: Record<string, unknown>) => Promise<{ bytes: Uint8Array; rows: number }>;
  /** Where the files are saved. Without it, nothing is saved: `get` runs the SQL each time. */
  outDir?: string;
  log?: (line: string) => void;
  /** Show file system errors (which name server paths) in `status()` and to the browser. Default off. */
  exposeErrors?: boolean;
}): Snapshots {
  const { dir, run, outDir } = options;
  const log = options.log ?? (() => undefined);
  const errors = new Map<string, string>();
  const rows = new Map<string, number>();
  const making = new Map<string, Promise<SnapshotResult>>();
  // One at a time: the database gets the snapshots' queries one after another, not all at once.
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let reported = "";

  const jobs = async () => {
    const { jobs, problems } = await snapshotJobs(dir);
    // Each problem once, not on every request.
    const text = problems.join("\n");
    if (text && text !== reported) for (const p of problems) log(`スナップショット: ${p}`);
    reported = text;
    return jobs;
  };

  const save = (job: SnapshotJob): Promise<SnapshotResult> => {
    let p = making.get(job.file);
    if (p) return p;
    p = (queue = queue.then(async (): Promise<SnapshotResult> => {
      const started = Date.now();
      const target = path.join(outDir!, job.file);
      const tmp = `${target}.${process.pid}-${started}.tmp`;
      try {
        const result = await run(job.name, job.params);
        await mkdir(outDir!, { recursive: true });
        await writeFile(tmp, result.bytes);
        await replace(tmp, target);
        const ms = Date.now() - started;
        errors.delete(job.file);
        rows.set(job.file, result.rows);
        log(`スナップショット ${job.file}（api/${job.name}.sql）: ${result.rows.toLocaleString("en-US")} 行、${ms} ms`);
        return { file: job.file, name: job.name, ok: true, rows: result.rows, ms };
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        const detail = (e as Error).message;
        // The API's errors are written for the browser (and keep their status: 422 for too many rows); file
        // system errors name folders on the server, so those go to the log only.
        const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined;
        const error = status !== undefined || options.exposeErrors ? detail : "スナップショットを保存できませんでした（くわしくはサーバーのログにあります）";
        errors.set(job.file, error);
        log(`スナップショット ${job.file}（api/${job.name}.sql）を作れませんでした: ${detail}`);
        return { file: job.file, name: job.name, ok: false, error, ...(status !== undefined ? { status } : {}) };
      }
    })).finally(() => making.delete(job.file)) as Promise<SnapshotResult>;
    making.set(job.file, p);
    return p;
  };

  const mtime = async (file: string) => {
    if (!outDir) return undefined;
    try {
      return (await stat(path.join(outDir, file))).mtime;
    } catch {
      return undefined;
    }
  };

  const catchUp = async (now = new Date()) => {
    if (!outDir) return [];
    const results: SnapshotResult[] = [];
    for (const job of await jobs()) {
      const due = lastDue(job.times, now);
      const made = await mtime(job.file);
      if (!made || (due && made < due)) results.push(await save(job));
    }
    return results;
  };

  const arm = async () => {
    if (stopped) return;
    const now = new Date();
    let next: Date | undefined;
    for (const job of await jobs().catch(() => [])) {
      const n = nextDue(job.times, now);
      if (n && (!next || n < next)) next = n;
    }
    if (stopped) return;
    // At least once an hour: a time added later (a git pull) is picked up without a restart.
    const wait = Math.min(next ? next.getTime() - now.getTime() : Infinity, 3_600_000);
    timer = setTimeout(() => {
      void catchUp()
        .catch((e: Error) => log(`スナップショット: ${e.message}`))
        .finally(() => void arm());
    }, Math.max(wait, 1000));
    timer.unref?.();
  };

  return {
    jobs,
    async get(file) {
      const job = (await jobs()).find((j) => j.file === file);
      if (!job) throw new DatasetError(`スナップショット ${file} はありません（api/ の SQL に -- snapshot: の行があり、models/ の read_api で使っているものだけ）`, 404);
      if (!outDir) {
        const result = await run(job.name, job.params);
        return { at: new Date(), rows: result.rows, bytes: result.bytes };
      }
      if (!(await mtime(file))) {
        const result = await save(job);
        if (!result.ok) throw new DatasetError(`スナップショット ${file} を作れませんでした: ${result.error}`, result.status ?? 500);
      }
      return { path: path.join(outDir, file), ...(rows.has(file) ? { rows: rows.get(file)! } : {}) };
    },
    async make(names) {
      if (!outDir) throw new Error("スナップショットを置くフォルダがありません");
      const all = await jobs();
      const chosen = names?.length ? all.filter((j) => names.includes(j.name)) : all;
      const results: SnapshotResult[] = [];
      for (const job of chosen) results.push(await save(job));
      return results;
    },
    catchUp,
    schedule() {
      if (!outDir || timer) return;
      stopped = false;
      void arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    async idle() {
      await Promise.allSettled([...making.values()]);
    },
    async status() {
      const out: SnapshotStatus[] = [];
      for (const job of await jobs()) {
        const made = await mtime(job.file);
        out.push({
          file: job.file,
          name: job.name,
          params: job.params,
          times: job.times,
          models: job.models,
          updatedAt: made ? made.toISOString() : null,
          ...(errors.has(job.file) ? { error: errors.get(job.file)! } : {}),
        });
      }
      return out;
    },
  };
}
