import { Selection, type SelectionClause } from "@uwdata/mosaic-core";
import { and, column, gte, isIn, isNull, literal, lt, or, type ExprNode } from "@uwdata/mosaic-sql";
import type { Filter } from "devbi";

const EMPTY: Filter[] = [];

interface Source {
  tileId: string;
  reset(): void;
}

function predicate(filters: Filter[]): ExprNode {
  const parts = filters.map((f) => {
    const col = column(f.field);
    if ("in" in f) {
      const values = f.in.filter((v) => v !== null);
      const hasNull = values.length !== f.in.length;
      const inNode = isIn(col, values.map((v) => literal(v)));
      return hasNull ? or(inNode, isNull(col)) : inNode;
    }
    const [lo, hi] = f.between;
    return and(...[lo !== null ? gte(col, literal(lo)) : null, hi !== null ? lt(col, literal(hi)) : null].filter((x) => x !== null));
  });
  return parts.length === 1 ? parts[0]! : and(...parts);
}

/**
 * Cross-filtering state of one dashboard, kept in a Mosaic crossfilter Selection.
 * Each tile owns one clause; a tile sees every clause except its own.
 * Clause values are DevBI filters, so the compiler can shift time ranges for comparisons.
 */
export class DashboardSelection {
  readonly selection = Selection.crossfilter();
  private sources = new Map<string, Source>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor() {
    this.selection.addEventListener("value", () => {
      this.version++;
      for (const l of this.listeners) l();
    });
  }

  private source(tileId: string): Source {
    let s = this.sources.get(tileId);
    if (!s) {
      s = { tileId, reset: () => {} };
      this.sources.set(tileId, s);
    }
    return s;
  }

  /** Set (or clear with null / []) the filters a tile selects. */
  set(tileId: string, filters: Filter[] | null): void {
    const source = this.source(tileId);
    const value = filters?.length ? filters : null;
    const clause: SelectionClause = {
      source,
      clients: new Set([source as never]),
      fields: (value ?? []).map((f) => column(f.field)),
      value,
      predicate: value ? predicate(value) : null,
      meta: { type: "devbi" },
    };
    this.selection.update(clause);
  }

  /** Clear every tile's selection. */
  clear(): void {
    this.selection.reset();
  }

  /** Filters set by the given tile. */
  own(tileId: string): Filter[] {
    const source = this.sources.get(tileId);
    const c = this.selection.clauses.find((x) => x.source === source);
    return (c?.value as Filter[] | null) ?? EMPTY;
  }

  /** Filters that apply to a tile: every clause except its own. */
  filtersFor(tileId: string | undefined): Filter[] {
    const source = tileId === undefined ? undefined : this.source(tileId);
    return this.selection.clauses
      .filter((c) => !source || !this.selection.skip(source as never, c))
      .flatMap((c) => (c.value as Filter[] | null) ?? []);
  }

  /** All active clauses, with the tile that set each. */
  entries(): { tileId: string; filters: Filter[] }[] {
    return this.selection.clauses.map((c) => ({ tileId: (c.source as Source).tileId, filters: (c.value as Filter[]) ?? [] }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;
}
