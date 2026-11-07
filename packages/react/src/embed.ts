import type { Theme } from "./Dashboard.js";
import { mountDashboard, unmountDashboard, type MountOptions, type MountedDashboard } from "./mount.js";
import { loadProject, type Project, type ProjectInput } from "./project.js";

/** What the embed script (`devbi-embed.js`) exports, and puts on `window.DevBI`. */
export interface DevbiEmbed {
  /** The dashboards in the project: for a menu in the page. */
  dashboards: { name: string; title: string; description?: string }[];
  /**
   * Show a dashboard in an element (or the first element a CSS selector finds). Options left out come from the
   * element's `data-devbi*` attributes.
   */
  mount(element: Element | string, options?: MountOptions): MountedDashboard;
  /**
   * Show a dashboard in every `[data-devbi]` element under `root` (default: the page) that has none yet, and
   * remove those whose element has left the page. Call it after the page replaces part of itself (an
   * ASP.NET UpdatePanel, for example). Skips the elements `unmount` emptied. Asks every DevBI script on the page
   * (other projects' too), so `window.DevBI.mountAll()` is enough. Returns how many it added.
   */
  mountAll(root?: ParentNode): number;
  /** Remove the dashboard from an element (whichever DevBI script on the page showed it). */
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
 * Shared by every DevBI embed script on the page (two projects' builds, or one loaded twice under two URLs), so
 * they don't take each other's elements. Each has its own copy of this code, so the shape stays as it is (v1).
 */
interface Instance {
  /** Whether the project has the dashboard ("" = the project's only one). */
  knows(name: string): boolean;
  /** Remove its dashboard from the element. */
  release(el: Element): void;
  /** Its part of `mountAll`: show its dashboards in new elements, let go of those that left the page. */
  scan(root: ParentNode): number;
}
interface Claim {
  instance: Instance;
  /** The instance has the dashboard (not just showing "ダッシュボード … がありません"). */
  known: boolean;
}
interface Registry {
  instances: Set<Instance>;
  claims: WeakMap<Element, Claim>;
  /** Emptied with `unmount`: `mountAll` leaves them empty. */
  released: WeakSet<Element>;
}

const REGISTRY = Symbol.for("devbi.embed.v1");

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (g[REGISTRY] ??= { instances: new Set(), claims: new WeakMap(), released: new WeakSet() });
}

/**
 * The embed script's work: show the project's dashboards in `[data-devbi]` elements of the page it is loaded
 * into, and give the page `mount` / `mountAll` / `unmount` (also as `window.DevBI`, with a `devbi:ready`
 * event on `window`).
 */
export function startEmbed(input: ProjectInput, { auto = true, global = true }: { auto?: boolean; global?: boolean } = {}): DevbiEmbed {
  const project: Project = loadProject(input);
  const names = Object.keys(project.dashboards);
  const reg = registry();
  const mounted = new Set<Element>();

  const self: Instance = {
    knows: (name) => (name ? Object.hasOwn(project.dashboards, name) : names.length === 1),
    release(el) {
      mounted.delete(el);
      if (reg.claims.get(el)?.instance === self) reg.claims.delete(el);
      unmountDashboard(el);
    },
    scan(root) {
      for (const el of mounted) if (!el.isConnected) self.release(el);
      let added = 0;
      const selector = "[data-devbi]:not(style, script, link, meta, template)";
      const found = [...(root instanceof Element && root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
      for (const el of found) {
        if (reg.released.has(el)) continue;
        const name = el.getAttribute("data-devbi") ?? "";
        const claim = reg.claims.get(el);
        // Shown already, by this script or by one that has the dashboard. One that only shows "… がありません"
        // gives way to a script that has it.
        if (claim && (claim.instance === self || claim.known || !self.knows(name))) continue;
        // Another DevBI script on the page has it (its scan shows it).
        if (!claim && !self.knows(name) && [...reg.instances].some((i) => i !== self && i.knows(name))) continue;
        try {
          api.mount(el);
          added++;
        } catch (e) {
          console.error(e);
          el.textContent = (e as Error).message;
        }
      }
      return added;
    },
  };
  reg.instances.add(self);

  // data-devbi-api in the page's HTML: only the page's own server or DevBI's (JavaScript can pass any apiUrl).
  const checkApiAttribute = (api: string) => {
    if (typeof location === "undefined") return;
    const base = new URL(project.baseUrl, document.baseURI);
    const url = new URL(api, base);
    if (url.origin !== location.origin && url.origin !== base.origin) {
      throw new Error(
        `DevBI: data-devbi-api="${api}" は別のサーバー（${url.origin}）なので使いません。` +
          `ページか DevBI と同じサーバーの API にするか、JavaScript の mount() に apiUrl で渡してください`,
      );
    }
  };

  const api: DevbiEmbed = {
    dashboards: Object.entries(project.dashboards)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, d]) => ({ name, title: d.title, ...(d.description ? { description: d.description } : {}) })),
    mount(target, options = {}) {
      const el = elementOf(target);
      const attrs = optionsFromAttributes(el);
      if (options.apiUrl === undefined && attrs.apiUrl) checkApiAttribute(attrs.apiUrl);
      const opts: MountOptions = { ...attrs, ...options };
      const prev = reg.claims.get(el);
      if (prev && prev.instance !== self) prev.instance.release(el);
      reg.released.delete(el);
      const m = mountDashboard(el, project, opts);
      const claim: Claim = { instance: self, known: self.knows(opts.dashboard ?? "") };
      reg.claims.set(el, claim);
      mounted.add(el);
      return {
        unmount() {
          if (reg.claims.get(el) !== claim) return; // mounted again since: that one stays
          m.unmount();
          reg.claims.delete(el);
          mounted.delete(el);
        },
      };
    },
    mountAll(root = document) {
      // Every DevBI script on the page, whichever one's mountAll the page calls (window.DevBI is the last loaded).
      let added = self.scan(root);
      for (const other of reg.instances) if (other !== self) added += other.scan(root);
      return added;
    },
    unmount(target) {
      const el = elementOf(target);
      reg.claims.get(el)?.instance.release(el);
      reg.released.add(el);
    },
  };

  if (typeof window !== "undefined") {
    if (global) (window as unknown as { DevBI?: DevbiEmbed }).DevBI = api;
    if (auto) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => self.scan(document), { once: true });
      else self.scan(document);
    }
    if (global) window.dispatchEvent(new CustomEvent("devbi:ready", { detail: api }));
  }
  return api;
}
