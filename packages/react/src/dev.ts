import type { ComponentType } from "react";
import type { Theme } from "./Dashboard.js";
import type { Project } from "./project.js";

/** A project file the dev server saw change. */
export interface FileChange {
  /** From the project folder: `dashboards/sales.dash.json`, `models/sales.metrics.yaml`, `data/…`, `api/…`. */
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
   * Hear about changed project files. A listener that returns `true` takes care of the change; otherwise the page
   * reloads. Returns the function that stops listening.
   */
  onChange(listener: (change: FileChange) => boolean | void): () => void;
}
