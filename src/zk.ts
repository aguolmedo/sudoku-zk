// Zero-knowledge proof that you know a Sudoku solution, without revealing it.
// One round, repeated many times:
//   1. The prover relabels the digits with a fresh random permutation σ.
//   2. The prover commits to every cell: hash(value ‖ random nonce).
//   3. The verifier challenges one row, column, box, or the starting numbers.
//   4. The prover opens only those cells; the verifier checks hashes and rules.
// A grid with any mistake fails at least 1 of the 3n + 1 challenges, so a
// cheater survives k rounds with probability at most (1 − 1/(3n + 1))^k.

import { type Grid, groups, sideOf } from "./sudoku.ts";

export type Challenge = { kind: "row" | "col" | "box"; index: number } | { kind: "givens" };

export interface Opening {
  cells: number[];
  values: number[];
  nonces: string[];
  /** The relabelling σ (relabel[d] = σ(d)), revealed only for a starting-numbers challenge. */
  relabel?: number[];
}

export type Check = { ok: true } | { ok: false; reason: string; cells: number[] };

/** All 3n + 1 possible challenges: every row, column and box, plus the starting numbers. */
export function allChallenges(n: number): Challenge[] {
  const result: Challenge[] = [];
  for (const kind of ["row", "col", "box"] as const) {
    for (let index = 0; index < n; index++) result.push({ kind, index });
  }
  result.push({ kind: "givens" });
  return result;
}

export function challengeLabel(challenge: Challenge): string {
  if (challenge.kind === "givens") return "Starting numbers";
  const name = { row: "Row", col: "Column", box: "Box" }[challenge.kind];
  return `${name} ${challenge.index + 1}`;
}

/** The cells a challenge asks the prover to open. */
export function challengeCells(challenge: Challenge, givens: Grid): number[] {
  if (challenge.kind === "givens") return givens.flatMap((v, idx) => (v !== 0 ? [idx] : []));
  const offset = { row: 0, col: 1, box: 2 }[challenge.kind];
  return groups(sideOf(givens))[3 * challenge.index + offset]; // groups() interleaves row, col, box
}

export async function hashCell(value: number, nonce: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${value}:${nonce}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random permutation of 1..n as a lookup table; index 0 (empty) maps to 0. */
function randomRelabel(n: number): number[] {
  const digits = Array.from({ length: n }, (_, i) => i + 1);
  const random = crypto.getRandomValues(new Uint32Array(n));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor((random[i] / 2 ** 32) * (i + 1));
    [digits[i], digits[j]] = [digits[j], digits[i]];
  }
  return [0, ...digits];
}

function isPermutation(relabel: number[]): boolean {
  const n = relabel.length - 1;
  const digits = relabel.slice(1).sort((a, b) => a - b);
  return relabel[0] === 0 && digits.every((d, i) => d === i + 1) && n > 0;
}

export class Prover {
  private readonly grid: Grid;
  private values: number[] = [];
  private nonces: string[] = [];
  private relabel: number[] = [];

  /** `grid` is the solution the prover claims to know (a cheater passes a wrong one). */
  constructor(grid: Grid) {
    this.grid = grid;
  }

  // The regions below are shown on the web page, so keep them readable.

  // #region commit
  /** Start a round: relabel the digits at random, then lock in every cell. */
  async commit(): Promise<string[]> {
    this.relabel = randomRelabel(sideOf(this.grid)); // e.g. 1→7, 2→3, …
    this.values = this.grid.map((v) => this.relabel[v]);
    this.nonces = this.values.map(() => randomNonce()); // so 1–9 can't be guessed
    return Promise.all(this.values.map((v, i) => hashCell(v, this.nonces[i])));
  }
  // #endregion

  // #region open
  /** Reveal only the challenged cells (and σ for the starting numbers). */
  open(challenge: Challenge, givens: Grid): Opening {
    const cells = challengeCells(challenge, givens);
    return {
      cells,
      values: cells.map((c) => this.values[c]),
      nonces: cells.map((c) => this.nonces[c]),
      relabel: challenge.kind === "givens" ? this.relabel : undefined,
    };
  }
  // #endregion
}

const fail = (reason: string, cells: number[]): Check => ({ ok: false, reason, cells });

// #region verify
/** The verifier's check of one round. It never sees the unopened cells. */
export async function checkOpening(
  givens: Grid,
  hashes: string[],
  challenge: Challenge,
  opening: Opening,
): Promise<Check> {
  const { cells, values, nonces, relabel } = opening;
  if (cells.join() !== challengeCells(challenge, givens).join()) {
    return fail("opened the wrong cells", cells);
  }

  // 1. Each opened value must match the hash committed before the challenge.
  for (let i = 0; i < cells.length; i++) {
    if ((await hashCell(values[i], nonces[i])) !== hashes[cells[i]]) {
      return fail("a value doesn't match its commitment", [cells[i]]);
    }
  }

  // 2a. Starting numbers: σ applied to the public puzzle must match.
  if (challenge.kind === "givens") {
    if (!relabel || !isPermutation(relabel)) return fail("σ isn't a relabelling", []);
    const bad = cells.filter((c, i) => values[i] !== relabel[givens[c]]);
    return bad.length ? fail("doesn't match the puzzle", bad) : { ok: true };
  }

  // 2b. Row, column or box: each value 1..n exactly once.
  const seen = new Map<number, number>();
  for (let i = 0; i < cells.length; i++) {
    const v = values[i];
    if (v < 1 || v > cells.length) return fail(`${v} isn't a digit`, [cells[i]]);
    if (seen.has(v)) return fail(`${v} appears twice`, [seen.get(v)!, cells[i]]);
    seen.set(v, cells[i]);
  }
  return { ok: true };
}
// #endregion

/**
 * A cheating prover's grid: the real solution with two cells in the same row
 * and box swapped. Every row, every box and the starting numbers still check
 * out — only the two affected columns expose it, 2 of the 28 challenges.
 */
export function makeCheatingGrid(solution: Grid, givens: Grid): Grid | null {
  const n = sideOf(solution);
  const b = Math.sqrt(n);
  for (let a = 0; a < solution.length; a++) {
    if (givens[a] !== 0) continue;
    const row = Math.floor(a / n);
    for (let col = (a % n) + 1; col < n; col++) {
      const other = row * n + col;
      if (givens[other] !== 0 || Math.floor(col / b) !== Math.floor((a % n) / b)) continue;
      const grid = solution.slice();
      [grid[a], grid[other]] = [grid[other], grid[a]];
      return grid;
    }
  }
  return null;
}
