import { describe, expectTypeOf, it } from "vitest";
import { defineQuery, type RowOf, type Scalar, type TileProps } from "../src/index.js";

// Type-level checks (run by `pnpm typecheck`). Here no names are generated, so any name is allowed.
describe("defineQuery / RowOf without .devbi/env.d.ts", () => {
  it("accepts any names and types the declared columns", () => {
    const q = defineQuery({ measures: ["revenue"], dimensions: ["customer"], time: "month", limit: 10 });
    type R = RowOf<typeof q>;
    expectTypeOf<R["revenue"]>().toEqualTypeOf<number | null>();
    expectTypeOf<R["customer"]>().toEqualTypeOf<Scalar>();
    expectTypeOf<TileProps<R>["rows"]>().toEqualTypeOf<R[]>();
  });
});
