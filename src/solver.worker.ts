import { type Grid, type SolveResult, type Strategy, solve } from "./sudoku.ts";

export type WorkerMessage =
  | { type: "progress"; steps: number; ms: number }
  | ({ type: "done"; ms: number } & SolveResult);

// Runs the search off the main thread so a long brute-force solve doesn't freeze the page.
self.onmessage = (e: MessageEvent<{ grid: Grid; strategy: Strategy }>) => {
  const t0 = performance.now();
  const post = (msg: WorkerMessage) => self.postMessage(msg);
  const result = solve(e.data.grid, e.data.strategy, undefined, (steps) =>
    post({ type: "progress", steps, ms: performance.now() - t0 }),
  );
  post({ type: "done", ...result, ms: performance.now() - t0 });
};
