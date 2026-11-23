import { defineQuery, type DatasetName, type Row, type RowOf, type Scalar } from "devbi";
import { describe, expectTypeOf, it } from "vitest";

// What `.devbi/env.d.ts` adds after `pnpm gen` (type-level checks, run by `pnpm typecheck`).
declare module "devbi" {
  interface MetricsRegistry {
    sales: { measures: "revenue" | "orders"; dimensions: "customer"; time: "受注日" };
  }
  interface DatasetRegistry {
    order_lines: { params: "from" | "customer"; row: { 受注日: Date; 顧客: string; 金額: number | null; メモ: Scalar } };
    // Its database did not answer pnpm gen: any columns.
    offline: { params: never };
    // The file does not parse: any parameter name.
    broken: { params: string };
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

describe("defineQuery / RowOf for a dataset (query.dataset)", () => {
  it("types the rows as the database described the columns, or as plain rows", () => {
    const lines = defineQuery({ dataset: "order_lines", params: { from: { param: "from" }, customer: "C001" } });
    expectTypeOf<RowOf<typeof lines>>().toEqualTypeOf<{ 受注日: Date; 顧客: string; 金額: number | null; メモ: Scalar }>();
    const offline = defineQuery({ dataset: "offline" });
    expectTypeOf<RowOf<typeof offline>>().toEqualTypeOf<Row>();
    defineQuery({ dataset: "broken", params: { anything: 1 } });
    expectTypeOf<DatasetName>().toEqualTypeOf<"order_lines" | "offline" | "broken">();
  });

  it("rejects datasets and parameters that are not in api/", () => {
    // @ts-expect-error -- "order_line" is not a dataset
    defineQuery({ dataset: "order_line" });
    // @ts-expect-error -- "to" is not a parameter of order_lines
    defineQuery({ dataset: "order_lines", params: { to: "2026-04-01" } });
  });
});
