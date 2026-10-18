/**
 * The grids the backend streams into a file row by row (an `OutputSource` of kind `grid`): one table names the grid,
 * the RPC that pages it and the title of its HTML report, so the window, the backend and the type agree on the ids.
 */
export const GRID_SOURCES = {
  /** A flow's data run: one row per data row (tests.scaleRows pages it). */
  'scale-rows': { rpc: 'tests.scaleRows', title: 'Data run' },
  /** An evaluation matrix: cases × variants (eval.matrix pages it). */
  'eval-matrix': { rpc: 'eval.matrix', title: 'Evaluation matrix' },
} as const;

export type GridSourceId = keyof typeof GRID_SOURCES;
