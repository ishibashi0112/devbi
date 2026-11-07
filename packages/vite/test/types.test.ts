import { defineQuery, type RowOf, type Scalar } from "devbi";
import { describe, expectTypeOf, it } from "vitest";

// What `.devbi/env.d.ts` adds after `pnpm gen` (type-level checks, run by `pnpm typecheck`).
declare module "devbi" {
  interface MetricsRegistry {
    sales: { measures: "revenue" | "orders"; dimensions: "customer"; time: "受注日" };
  }
}

describe("defineQuery / RowOf with generated names", () => {
  it("types the rows, with the time column when the query has a grain", () => {
    const monthly = defineQuery({ measures: ["revenue"], dimensions: ["customer"], time: "month" });
    expectTypeOf<RowOf<typeof monthly>>().toEqualTypeOf<{ revenue: number | null } & { customer: Scalar } & { 受注日: Date | null }>();
    const top = defineQuery({ measures: ["revenue", "orders"], dimensions: ["customer"], limit: 10 });
    expectTypeOf<keyof RowOf<typeof top>>().toEqualTypeOf<"revenue" | "orders" | "customer">();
  });

  it("rejects names that are not in the metrics files", () => {
    // @ts-expect-error -- "revenu" is not a measure
    defineQuery({ measures: ["revenu"] });
    // @ts-expect-error -- "region" is not a dimension
    defineQuery({ dimensions: ["region"] });
    // @ts-expect-error -- "stock" is not a metrics file
    defineQuery({ metrics: "stock", measures: ["revenue"] });
  });
});
