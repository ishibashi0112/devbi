import { z } from "zod";
import { dashboardSchemas, type SchemaNames } from "./dashboard.js";
import { metricsInput } from "./metrics.js";
import { TILE_TYPES, TILE_TYPE_NAMES, type TileTypeInfo } from "./tiles.js";

type JsonSchema = Record<string, unknown>;

function toJson(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" }) as JsonSchema;
}

/** Drop zod's `maximum: Number.MAX_SAFE_INTEGER` on integers: noise in editors. */
function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (!node || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "maximum" && v === Number.MAX_SAFE_INTEGER) continue;
    if (k === "minimum" && v === Number.MIN_SAFE_INTEGER) continue;
    out[k] = tidy(v);
  }
  return out;
}

function optionSchema(info: TileTypeInfo): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(info.options).map(([k, o]) => [k, { ...o }])),
    additionalProperties: false,
  };
}

/**
 * JSON Schema (draft-07) for `*.dash.json`, for editor completion and checks.
 * With `names`, metrics files, measures, dimensions and filter fields are limited to the project's names.
 */
export function dashboardJsonSchema(names?: SchemaNames): JsonSchema {
  const schema = tidy(toJson(dashboardSchemas(names).dashboard)) as JsonSchema;
  const tiles = (schema.properties as Record<string, JsonSchema>).tiles!;
  const tile = tiles.items as JsonSchema;
  const props = tile.properties as Record<string, JsonSchema>;
  // Hover text for each type in VS Code's completion list.
  props.type = { ...props.type, enumDescriptions: TILE_TYPE_NAMES.map((t) => TILE_TYPES[t].description) };
  // Exactly one of type / component (the zod refinement, which JSON Schema output drops).
  tile.oneOf = [{ required: ["type"] }, { required: ["component"] }];
  // Options per tile type.
  tile.allOf = TILE_TYPE_NAMES.map((t) => ({
    if: { properties: { type: { const: t } }, required: ["type"] },
    then: { properties: { options: optionSchema(TILE_TYPES[t]) } },
  }));
  return schema;
}

/** JSON Schema (draft-07) for `*.metrics.yaml`, for editor completion and checks (YAML extensions read JSON Schema). */
export function metricsJsonSchema(): JsonSchema {
  return tidy(toJson(metricsInput)) as JsonSchema;
}

export type { SchemaNames };
