import { createRoot, type Root } from "react-dom/client";
import { Dashboard, type Theme } from "./Dashboard.js";
import type { Project } from "./project.js";

export interface MountOptions {
  /** The dashboard's name (`dashboards/<name>.dash.json`). May be left out when the project has only one. */
  dashboard?: string;
  /** Light or dark. Default `auto` (the OS setting); `light` keeps it light inside a light page. */
  theme?: Theme;
  /** Where the read-only API is (for `read_api`), when it is not `api/` next to the dashboards. */
  apiUrl?: string;
  /** Used for the API requests instead of the global `fetch`: to add a header, for example. */
  fetch?: typeof fetch;
}

export interface MountedDashboard {
  /** Remove the dashboard from the element (only if it is still the one this call showed). */
  unmount(): void;
}

const roots = new WeakMap<Element, { root: Root; mount: object }>();

// The same project object for the same API and fetch, so mounting again with only another theme keeps the
// dashboard as it is (selections too).
const derived = new WeakMap<Project, Map<string, Map<typeof fetch | undefined, Project>>>();
const fetchIds = new WeakMap<typeof fetch, number>();
let nextFetchId = 1;

function projectFor(project: Project, apiUrl: string | undefined, f: typeof fetch | undefined): Project {
  if (!apiUrl && !f) return project;
  let byApi = derived.get(project);
  if (!byApi) derived.set(project, (byApi = new Map()));
  let byFetch = byApi.get(apiUrl ?? "");
  if (!byFetch) byApi.set(apiUrl ?? "", (byFetch = new Map()));
  let p = byFetch.get(f);
  if (!p) byFetch.set(f, (p = { ...project, ...(apiUrl ? { apiUrl } : {}), ...(f ? { fetch: f } : {}) }));
  return p;
}

function fetchId(f: typeof fetch | undefined): number {
  if (!f) return 0;
  let id = fetchIds.get(f);
  if (id === undefined) fetchIds.set(f, (id = nextFetchId++));
  return id;
}

/**
 * Show one dashboard inside an element of any page (a React root of its own). Mounting into the same element
 * again replaces what it shows: another dashboard, API or fetch starts fresh, another theme only changes the colors.
 * `project` is what `loadProject()` returns.
 */
export function mountDashboard(element: Element, project: Project, options: MountOptions = {}): MountedDashboard {
  const names = Object.keys(project.dashboards);
  const name = options.dashboard ?? (names.length === 1 ? names[0]! : "");
  const p = projectFor(project, options.apiUrl, options.fetch);
  let entry = roots.get(element);
  if (!entry) roots.set(element, (entry = { root: createRoot(element), mount: {} }));
  const mount = {};
  entry.mount = mount;
  const key = `${name}\n${options.apiUrl ?? ""}\n${fetchId(options.fetch)}`;
  entry.root.render(<Dashboard key={key} project={p} name={name} {...(options.theme ? { theme: options.theme } : {})} />);
  return {
    unmount: () => {
      if (roots.get(element)?.mount === mount) unmountDashboard(element);
    },
  };
}

/** Remove a dashboard that `mountDashboard` put in the element. Does nothing when there is none. */
export function unmountDashboard(element: Element): void {
  const entry = roots.get(element);
  if (!entry) return;
  roots.delete(element);
  entry.root.unmount();
}
