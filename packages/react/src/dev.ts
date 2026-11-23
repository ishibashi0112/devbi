import type { ComponentType } from "react";
import type { Theme } from "./Dashboard.js";
import type { Project, TileModule } from "./project.js";

/** A project file the dev server saw change. */
export interface FileChange {
  /**
   * From the project folder: `dashboards/sales.dash.json`, `models/sales.metrics.yaml`, `data/…`, `api/…`, or a
   * promoted tile's file added or removed (`dashboards/sales/TopCustomers.tsx`; a change to one is React's own update).
   */
  file: string;
  type: "create" | "update" | "delete";
  /** The page that wrote it (a save from the GUI editor). */
  by?: string;
}

/** A dash.json as it is in the file (not filled in with defaults), and where it is. */
export interface SavedDashboard {
  /** `/dashboards/<name>.dash.json` */
  path: string;
  spec: unknown;
}

/** What `DevbiApp` gives the GUI editor for one dashboard. */
export interface DashboardEditorProps {
  project: Project;
  name: string;
  dev: DevServer;
  theme?: Theme;
  /** After each save, with the file as written: the page shows it without reloading. */
  onSaved(name: string, saved: SavedDashboard): void;
  onClose(): void;
}

/** What `DevbiApp` gives the GUI editor's form for a new dashboard. */
export interface NewDashboardProps {
  project: Project;
  dev: DevServer;
  theme?: Theme;
  onCreated(name: string, saved: SavedDashboard): void;
  onCancel(): void;
}

/** The GUI editor (`@devbi/editor`). */
export interface EditorModule {
  DashboardEditor: ComponentType<DashboardEditorProps>;
  NewDashboard: ComponentType<NewDashboardProps>;
}

/**
 * What `@devbi/vite` adds to the project on its dev server, never in a build: the GUI editor and notices of
 * changed files.
 */
export interface DevServer {
  /** This page's id: the editor sends it with a save, and the page that saved does not reload for its own file. */
  client: string;
  /** Where the editor reads and writes dash.json files. */
  endpoint: string;
  /** The GUI editor, when the project has `@devbi/editor` installed. */
  editor?: () => Promise<EditorModule>;
  /**
   * Load a promoted tile's file written after the page loaded (the editor's "コードにする"), which the project's
   * `components` do not have yet. `path` is from the project folder: `/dashboards/sales/Monthly.tsx`.
   */
  importTile(path: string): Promise<TileModule>;
  /**
   * Hear about changed project files. A listener that returns `true` takes care of the change; otherwise the page
   * reloads. Returns the function that stops listening.
   */
  onChange(listener: (change: FileChange) => boolean | void): () => void;
  /**
   * `devUsers` of `@devbi/vite` (row-level security): the page's 「表示する利用者」 picks one, and the dev server's
   * API answers as that user.
   */
  users?: DevUserInfo[];
}

/** One of `devUsers`, as the page lists it. */
export interface DevUserInfo {
  name: string;
  /** What the user is: `営業・region 関東`. */
  note?: string;
}

/** The cookie that tells the dev server who the page views as (`@devbi/vite` reads it from this computer only). */
export const DEV_USER_COOKIE = "devbi-dev-user";

/** The user of devUsers the page views as: its cookie, or "" for nobody. */
export function readDevUser(): string {
  if (typeof document === "undefined") return "";
  for (const part of document.cookie.split(";")) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== DEV_USER_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

/** View the page as this user of devUsers ("" for nobody): for the dev server's requests from now on. */
export function writeDevUser(name: string): void {
  document.cookie = name
    ? `${DEV_USER_COOKIE}=${encodeURIComponent(name)}; path=/; SameSite=Strict`
    : `${DEV_USER_COOKIE}=; path=/; max-age=0; SameSite=Strict`;
}
