// Core Sudoku logic, generic over the grid size n = b², where b is the box size
// (4×4 with 2×2 boxes, 9×9 with 3×3 boxes, 16×16 with 4×4 boxes, ...).
// A grid is a flat array of n² cells; 0 means empty.

export type Grid = number[];

export function sideOf(grid: Grid): number {
  const n = Math.sqrt(grid.length);
  const b = Math.sqrt(n);
  if (!Number.isInteger(n) || !Number.isInteger(b)) {
    throw new Error(`Grid of ${grid.length} cells is not a valid Sudoku size`);
  }
  return n;
}

/** Parse a puzzle string like "53..7....6..195..." ('.' or '0' = empty). */
export function parse(text: string): Grid {
  const cells = text.replace(/\s+/g, "").split("").map((ch) => (ch === "." ? 0 : Number(ch)));
  sideOf(cells);
  return cells;
}

/** Every row, column and box, each as a list of cell indices. */
export function groups(n: number): number[][] {
  const b = Math.sqrt(n);
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    const col: number[] = [];
    const box: number[] = [];
    const br = Math.floor(i / b) * b;
    const bc = (i % b) * b;
    for (let j = 0; j < n; j++) {
      row.push(i * n + j);
      col.push(j * n + i);
      box.push((br + Math.floor(j / b)) * n + bc + (j % b));
    }
    result.push(row, col, box);
  }
  return result;
}

/** Indices of all cells whose value repeats within a row, column or box. */
export function findConflicts(grid: Grid): Set<number> {
  const n = sideOf(grid);
  const conflicts = new Set<number>();
  for (const group of groups(n)) {
    const seen = new Map<number, number[]>();
    for (const idx of group) {
      const v = grid[idx];
      if (v === 0) continue;
      const cells = seen.get(v) ?? [];
      cells.push(idx);
      seen.set(v, cells);
    }
    for (const cells of seen.values()) {
      if (cells.length > 1) cells.forEach((c) => conflicts.add(c));
    }
  }
  return conflicts;
}

export type Verdict =
  | { kind: "solved"; checks: number }
  | { kind: "incomplete"; empty: number; checks: number }
  | { kind: "invalid"; conflicts: Set<number>; checks: number };

/**
 * The NP "verifier": checks a candidate solution in polynomial time.
 * It visits each of the 3n groups once, touching n cells each — O(n²) work.
 */
export function verify(grid: Grid): Verdict {
  const n = sideOf(grid);
  const checks = 3 * n * n;
  const conflicts = findConflicts(grid);
  if (conflicts.size > 0) return { kind: "invalid", conflicts, checks };
  const empty = grid.filter((v) => v === 0).length;
  if (empty > 0) return { kind: "incomplete", empty, checks };
  return { kind: "solved", checks };
}

export interface SolveResult {
  solution: Grid | null;
  /** Number of values tried — a rough measure of search effort. */
  steps: number;
}

/**
 * How the solver picks the next cell to fill:
 * - "smart": the empty cell with the fewest candidates (MRV heuristic).
 * - "brute": the first empty cell, left to right, top to bottom.
 */
export type Strategy = "smart" | "brute";

/**
 * The "search": backtracking over candidate values. Each cell's candidates are
 * tracked as bitmasks per row/column/box. Exponential in the worst case either
 * way; the heuristic only changes which puzzles hit that worst case.
 */
export function solve(
  puzzle: Grid,
  strategy: Strategy = "smart",
  maxSteps = 200_000_000,
  onProgress?: (steps: number) => void,
): SolveResult {
  const n = sideOf(puzzle);
  const b = Math.sqrt(n);
  const grid = puzzle.slice();
  const rows = new Array<number>(n).fill(0);
  const cols = new Array<number>(n).fill(0);
  const boxes = new Array<number>(n).fill(0);
  const boxOf = (idx: number) => Math.floor(Math.floor(idx / n) / b) * b + Math.floor((idx % n) / b);
  const full = (1 << (n + 1)) - 2; // bits 1..n

  /** Toggle value v's bit in the cell's row, column and box masks. */
  const flip = (idx: number, v: number) => {
    const bit = 1 << v;
    rows[Math.floor(idx / n)] ^= bit;
    cols[idx % n] ^= bit;
    boxes[boxOf(idx)] ^= bit;
  };

  /** Values not yet used in the cell's row, column or box, as a bitmask. */
  const candidates = (idx: number) => full & ~(rows[Math.floor(idx / n)] | cols[idx % n] | boxes[boxOf(idx)]);

  if (findConflicts(grid).size > 0) return { solution: null, steps: 0 };
  for (let idx = 0; idx < grid.length; idx++) {
    if (grid[idx] !== 0) flip(idx, grid[idx]);
  }

  // The regions below are shown on the web page, so keep them readable.

  // #region brute
  /** Brute force: the first empty cell, in reading order. */
  const pickFirstEmpty = (): number => {
    for (let idx = 0; idx < grid.length; idx++) {
      if (grid[idx] === 0) return idx;
    }
    return -1; // no empty cells
  };
  // #endregion

  // #region smart
  /** Smart: the empty cell with the fewest candidates (MRV). */
  const pickFewestCandidates = (): number => {
    let best = -1;
    let bestCount = Infinity;
    for (let idx = 0; idx < grid.length; idx++) {
      if (grid[idx] !== 0) continue;
      const count = popcount(candidates(idx));
      if (count < bestCount) {
        best = idx;
        bestCount = count;
        if (count <= 1) break; // can't do better
      }
    }
    return best; // -1 if no empty cells
  };
  // #endregion

  const pickCell = strategy === "brute" ? pickFirstEmpty : pickFewestCandidates;

  /** Count one guess and report progress; false once over the step budget. */
  let steps = 0;
  const tick = (): boolean => {
    steps++;
    if (onProgress && steps % 250_000 === 0) onProgress(steps);
    return steps <= maxSteps;
  };

  // #region search
  const search = (): boolean => {
    const idx = pickCell();
    if (idx === -1) return true; // board full: solved

    const mask = candidates(idx);
    for (let v = 1; v <= n; v++) {
      if (!(mask & (1 << v))) continue; // v breaks a rule
      if (!tick()) return false; // out of step budget

      grid[idx] = v; // guess
      flip(idx, v);
      if (search()) return true;
      grid[idx] = 0; // undo the guess
      flip(idx, v);
    }
    return false; // no value fits: backtrack
  };
  // #endregion

  return { solution: search() ? grid : null, steps };
}

function popcount(x: number): number {
  let count = 0;
  while (x) {
    x &= x - 1;
    count++;
  }
  return count;
}

/** The example puzzle from Wikipedia's Sudoku article. */
export const EXAMPLE = parse(`
  53..7....
  6..195...
  .98....6.
  8...6...3
  4..8.3..1
  7...2...6
  .6....28.
  ...419..5
  ....8..79
`);

/**
 * Worst case for the brute-force solver. From Wikipedia's "Sudoku solving
 * algorithms": the top row of its solution is 987654321, so left-to-right
 * search tries nearly every wrong digit first. Brute force needs ~69 million
 * guesses on it; the fewest-candidates heuristic needs ~58 thousand.
 */
export const WORST_CASE = parse(`
  .........
  .....3.85
  ..1.2....
  ...5.7...
  ..4...1..
  .9.......
  5......73
  ..2.1....
  ....4...9
`);
