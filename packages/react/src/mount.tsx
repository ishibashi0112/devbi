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
  /** Remove the dashboard from the element. */
  unmount(): void;
}

const roots = new WeakMap<Element, Root>();

/**
 * Show one dashboard inside an element of any page (a React root of its own). Mounting into the same element
 * again replaces what it shows. `project` is what `loadProject()` returns.
 */
export function mountDashboard(element: Element, project: Project, options: MountOptions = {}): MountedDashboard {
  const names = Object.keys(project.dashboards);
  const name = options.dashboard ?? (names.length === 1 ? names[0]! : "");
  const p: Project = {
    ...project,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  let root = roots.get(element);
  if (!root) {
    root = createRoot(element);
    roots.set(element, root);
  }
  // A new dashboard starts fresh (its own selections), not as an update of the one before.
  root.render(<Dashboard key={name} project={p} name={name} {...(options.theme ? { theme: options.theme } : {})} />);
  return { unmount: () => unmountDashboard(element) };
}

/** Remove a dashboard that `mountDashboard` put in the element. Does nothing when there is none. */
export function unmountDashboard(element: Element): void {
  const root = roots.get(element);
  if (!root) return;
  roots.delete(element);
  root.unmount();
}
