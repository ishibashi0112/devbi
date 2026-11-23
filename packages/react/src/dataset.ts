// The rows of a dataset (api/<name>.sql) for a tile, straight from the API: no DuckDB. Loaded as its own chunk with
// the first dataset tile (it brings Apache Arrow).
import * as arrow from "apache-arrow";
import type { FieldInfo, ParamValue, Row } from "devbi";
import { readApi, type ApiReadOptions } from "./api-read.js";
import { tableToRows } from "./arrow-rows.js";

export interface DatasetResult {
  rows: Row[];
  fields: FieldInfo[];
  /** The snapshot it read, when it did. */
  snapshot?: { file: string; at: Date };
}

/**
 * How a column shows: numbers are measures (right-aligned, 3-digit groups), dates and times are time (no grain:
 * `2026/4/1`, with the time when it has one), the rest dimensions. The `-- key:` columns are dimensions even when they
 * are numbers (no groups in an order number).
 */
export function datasetFields(schema: arrow.Schema, key: readonly string[] = []): FieldInfo[] {
  return schema.fields.map((f) => {
    const t = f.type;
    const number = arrow.DataType.isInt(t) || arrow.DataType.isFloat(t) || arrow.DataType.isDecimal(t);
    const time = arrow.DataType.isDate(t) || arrow.DataType.isTimestamp(t);
    const kind: FieldInfo["kind"] = key.includes(f.name) ? "dimension" : number ? "measure" : time ? "time" : "dimension";
    return { name: f.name, label: f.name, kind };
  });
}

/** Read a dataset with these parameter values. */
export async function readDataset(
  options: Omit<ApiReadOptions, "params"> & { params: Record<string, ParamValue>; key?: readonly string[] },
): Promise<DatasetResult> {
  const read = await readApi(options);
  return {
    rows: tableToRows(read.table),
    fields: datasetFields(read.table.schema, options.key),
    ...(read.snapshot ? { snapshot: read.snapshot } : {}),
  };
}
