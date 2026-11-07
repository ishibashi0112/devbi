import type { Theme } from "./Dashboard.js";
import { mountDashboard, unmountDashboard, type MountOptions, type MountedDashboard } from "./mount.js";
import { loadProject, type Project, type ProjectInput } from "./project.js";

/** What the embed script (`devbi-embed.js`) exports, and puts on `window.DevBI`. */
export interface DevbiEmbed {
  /** The dashboards in the project: for a menu in the page. */
  dashboards: { name: string; title: string; description?: string }[];
  /** Show a dashboard in an element (or the first element a CSS selector finds). */
  mount(element: Element | string, options?: MountOptions): MountedDashboard;
  /**
   * Show a dashboard in every `[data-devbi]` element under `root` (default: the page) that has none yet, and
   * remove those whose element has left the page. Call it after the page replaces part of itself (an
   * ASP.NET UpdatePanel, for example). Returns how many it added.
   */
  mountAll(root?: ParentNode): number;
  /** Remove the dashboard from an element. */
  unmount(element: Element | string): void;
}

const THEMES: readonly string[] = ["auto", "light", "dark"];

function elementOf(target: Element | string): Element {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) throw new Error(`DevBI: ${String(target)} がページにありません`);
  return el;
}

/** The options a `[data-devbi]` element gives in its attributes. */
export function optionsFromAttributes(el: Element): MountOptions {
  const theme = el.getAttribute("data-devbi-theme") ?? "";
  const api = el.getAttribute("data-devbi-api");
  const name = el.getAttribute("data-devbi");
  return {
    ...(name ? { dashboard: name } : {}),
    ...(api ? { apiUrl: api } : {}),
    ...(THEMES.includes(theme) ? { theme: theme as Theme } : {}),
  };
}

/**
 * The embed script's work: show the project's dashboards in `[data-devbi]` elements of the page it is loaded
 * into, and give the page `mount` / `mountAll` / `unmount` (also as `window.DevBI`, with a `devbi:ready`
 * event on `window`).
 */
export function startEmbed(input: ProjectInput, { auto = true, global = true }: { auto?: boolean; global?: boolean } = {}): DevbiEmbed {
  const project: Project = loadProject(input);
  const mounted = new Set<Element>();

  const api: DevbiEmbed = {
    dashboards: Object.entries(project.dashboards)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, d]) => ({ name, title: d.title, ...(d.description ? { description: d.description } : {}) })),
    mount(target, options = {}) {
      const el = elementOf(target);
      mounted.add(el);
      const m = mountDashboard(el, project, options);
      return {
        unmount() {
          mounted.delete(el);
          m.unmount();
        },
      };
    },
    mountAll(root = document) {
      for (const el of mounted) {
        if (!el.isConnected) {
          mounted.delete(el);
          unmountDashboard(el);
        }
      }
      let added = 0;
      const selector = "[data-devbi]:not(style, script, link, meta, template)";
      const found = [...(root instanceof Element && root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
      for (const el of found) {
        if (mounted.has(el)) continue;
        api.mount(el, optionsFromAttributes(el));
        added++;
      }
      return added;
    },
    unmount(target) {
      const el = elementOf(target);
      mounted.delete(el);
      unmountDashboard(el);
    },
  };

  if (typeof window !== "undefined") {
    if (global) (window as unknown as { DevBI?: DevbiEmbed }).DevBI = api;
    if (auto) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => api.mountAll(), { once: true });
      else api.mountAll();
    }
    if (global) window.dispatchEvent(new CustomEvent("devbi:ready", { detail: api }));
  }
  return api;
}
