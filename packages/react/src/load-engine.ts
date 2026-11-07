import { loadChunk } from "./chunk.js";
import type { Engine, EngineOptions } from "./engine.js";

/**
 * Start DuckDB-wasm. The engine's code (DuckDB-wasm's JS and Apache Arrow) is loaded on the first call,
 * as its own chunk, so the page can draw before it arrives.
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const { createEngine: create } = await loadChunk(() => import("./engine.js"));
  return create(options);
}
