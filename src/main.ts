import { region } from "./code.ts";
import type { WorkerMessage } from "./solver.worker.ts";
import { EXAMPLE, findConflicts, type Grid, type Strategy, verify, WORST_CASE } from "./sudoku.ts";
import solverSource from "./sudoku.ts?raw";
import { startZk } from "./zk-ui.ts";

const N = 9;
const B = 3;

// "custom" holds the puzzle being built in "Build your own" mode; it survives switching away and back.
const PUZZLES: Record<string, Grid> = { example: EXAMPLE, worst: WORST_CASE, custom: new Array(N * N).fill(0) };
const STRATEGY_LABELS: Record<Strategy, string> = { smart: "smart search", brute: "brute force" };

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const board = $<HTMLDivElement>("#board");
const puzzleSelect = $<HTMLSelectElement>("#puzzle");
const strategySelect = $<HTMLSelectElement>("#strategy");
const solveButton = $<HTMLButtonElement>("#solve");
const stopButton = $<HTMLButtonElement>("#stop");
const compare = $<HTMLParagraphElement>("#compare");

const isBuilding = () => puzzleSelect.value === "custom";

let givens: Grid = EXAMPLE.slice();
let grid: Grid = givens.slice();
let worker: Worker | null = null;

// Latest work counts, used for the "search vs. check" comparison line.
let verifyChecks: number | null = null;
let solveSteps: number | null = null;

// --- Board ---

const cells: HTMLInputElement[] = [];
for (let idx = 0; idx < N * N; idx++) {
  const input = document.createElement("input");
  input.className = "cell";
  input.inputMode = "numeric";
  input.maxLength = 1;
  input.autocomplete = "off";
  input.setAttribute("aria-label", `Row ${Math.floor(idx / N) + 1}, column ${(idx % N) + 1}`);
  const r = Math.floor(idx / N);
  const c = idx % N;
  if (c % B === B - 1 && c !== N - 1) input.classList.add("box-right");
  if (r % B === B - 1 && r !== N - 1) input.classList.add("box-bottom");
  input.addEventListener("keydown", (e) => onKey(e, idx));
  input.addEventListener("input", () => onInput(idx));
  board.append(input);
  cells.push(input);
}

function render(conflicts: Set<number> = new Set()) {
  cells.forEach((input, idx) => {
    input.value = grid[idx] ? String(grid[idx]) : "";
    input.readOnly = givens[idx] !== 0 && !isBuilding();
    input.classList.toggle("given", givens[idx] !== 0);
    input.classList.toggle("conflict", conflicts.has(idx));
  });
  renderBounds();
}

/** Fill in the Big-O lines on the result cards with this puzzle's numbers. */
function renderBounds() {
  // k counts the puzzle's empty cells, so the bound stays put once the board is solved.
  const empty = givens.filter((v) => v === 0).length;
  $("#verify-bound").textContent = `3 × ${N}² = ${3 * N * N}`;
  $("#solve-bound").innerHTML =
    empty === 0 ? "k = 0, nothing to search" : `${N}<sup>${empty}</sup> ≈ ${scientific(empty * Math.log10(N))}`;
}

/** Format 10^log10 as "a.b × 10<sup>e</sup>" without overflowing a float. */
function scientific(log10: number): string {
  const exp = Math.floor(log10);
  if (exp < 6) return Math.round(10 ** log10).toLocaleString();
  return `${(10 ** (log10 - exp)).toFixed(1)} × 10<sup>${exp}</sup>`;
}

function setCell(idx: number, value: number) {
  if (isBuilding()) {
    // Building a puzzle: typed digits become its starting numbers. Editing the
    // puzzle throws away any old solution and results, which no longer apply.
    givens[idx] = value;
    PUZZLES.custom = givens.slice();
    grid = givens.slice();
    resetResults();
    render(findConflicts(grid));
    return;
  }
  if (givens[idx] !== 0) return;
  grid[idx] = value;
  render();
}

function onInput(idx: number) {
  // Handles mobile keyboards / paste; desktop keys are handled in onKey.
  const digit = Number(cells[idx].value.slice(-1));
  setCell(idx, digit >= 1 && digit <= N ? digit : 0);
}

function onKey(e: KeyboardEvent, idx: number) {
  const r = Math.floor(idx / N);
  const c = idx % N;
  const moves: Record<string, [number, number]> = {
    ArrowUp: [r - 1, c],
    ArrowDown: [r + 1, c],
    ArrowLeft: [r, c - 1],
    ArrowRight: [r, c + 1],
  };
  if (e.key in moves) {
    const [nr, nc] = moves[e.key];
    if (nr >= 0 && nr < N && nc >= 0 && nc < N) cells[nr * N + nc].focus();
    e.preventDefault();
  } else if (/^[1-9]$/.test(e.key)) {
    setCell(idx, Number(e.key));
    e.preventDefault();
  } else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") {
    setCell(idx, 0);
    e.preventDefault();
  }
}

// --- Result cards ---

type Tone = "ok" | "bad" | "running" | "";

function setCard(id: "verify" | "solve", value: number | null, detail: string, tone: Tone = "") {
  const card = $<HTMLElement>(`#${id}-card`);
  card.className = `card ${tone}`;
  card.querySelector(".value")!.textContent = value === null ? "—" : value.toLocaleString();
  card.querySelector(".detail")!.textContent = detail;
}

function formatTime(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function updateCompare() {
  if (verifyChecks === null || solveSteps === null) {
    compare.textContent = "";
    return;
  }
  const ratio = solveSteps / verifyChecks;
  compare.textContent =
    ratio >= 1
      ? `Finding the solution took ${Math.round(ratio).toLocaleString()}× more steps than checking it.`
      : `On this puzzle the search was cheap — try the worst case with brute force.`;
}

function resetResults() {
  verifyChecks = null;
  solveSteps = null;
  setCard("verify", null, "Not run yet.");
  setCard("solve", null, "Not run yet.");
  updateCompare();
}

// --- Implementation panel ---

const CODE = {
  brute: region(solverSource, "brute"),
  smart: region(solverSource, "smart"),
  search: region(solverSource, "search"),
};
const codeTabs = document.querySelectorAll<HTMLButtonElement>("#solver-tabs button");

function showCode() {
  const strategy = strategySelect.value as Strategy;
  $("#code-pick").innerHTML = CODE[strategy];
  codeTabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.strategy === strategy)));
}

$("#code-pick").classList.add("hljs");
$("#code-search").classList.add("hljs");
$("#code-search").innerHTML = CODE.search;
strategySelect.addEventListener("change", showCode);
codeTabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    strategySelect.value = tab.dataset.strategy!;
    showCode();
  }),
);

// --- Actions ---

function runVerify() {
  const t0 = performance.now();
  const verdict = verify(grid);
  const time = formatTime(performance.now() - t0);
  verifyChecks = verdict.checks;
  switch (verdict.kind) {
    case "solved":
      render();
      setCard("verify", verdict.checks, `✓ Valid solution · ${time}`, "ok");
      break;
    case "incomplete":
      render();
      setCard("verify", verdict.checks, `No conflicts, ${verdict.empty} cells empty · ${time}`);
      break;
    case "invalid":
      render(verdict.conflicts);
      setCard("verify", verdict.checks, `✗ ${verdict.conflicts.size} cells conflict · ${time}`, "bad");
      break;
  }
  updateCompare();
}

$("#verify").addEventListener("click", runVerify);

function setBusy(busy: boolean) {
  board.classList.toggle("busy", busy);
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select").forEach((el) => {
    el.disabled = busy && el !== stopButton;
  });
  stopButton.hidden = !busy;
  solveButton.hidden = busy;
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  setBusy(false);
}

solveButton.addEventListener("click", () => {
  const conflicts = findConflicts(grid);
  if (conflicts.size > 0) {
    render(conflicts);
    setCard("solve", null, `✗ ${conflicts.size} highlighted cells conflict. Fix them first.`, "bad");
    return;
  }
  const strategy = strategySelect.value as Strategy;
  const label = STRATEGY_LABELS[strategy];
  solveSteps = null;
  updateCompare();
  setCard("solve", 0, `Searching (${label})…`, "running");
  setBusy(true);

  worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (msg.type === "progress") {
      setCard("solve", msg.steps, `Searching (${label})… ${formatTime(msg.ms)}`, "running");
      return;
    }
    stopWorker();
    solveSteps = msg.steps;
    if (msg.solution) {
      grid = msg.solution;
      render();
      setCard("solve", msg.steps, `✓ Solved by ${label} · ${formatTime(msg.ms)}`, "ok");
      runVerify(); // Check the answer the search found, so both costs show side by side.
    } else {
      render();
      setCard("solve", msg.steps, `✗ No solution from this board · ${formatTime(msg.ms)}`, "bad");
    }
    updateCompare();
  };
  worker.postMessage({ grid, strategy });
});

stopButton.addEventListener("click", () => {
  stopWorker();
  const value = $("#solve-card .value").textContent;
  $<HTMLElement>("#solve-card").className = "card";
  $("#solve-card .detail").textContent = `Stopped after ${value} guesses.`;
});

function loadPuzzle(source: Grid) {
  givens = source.slice();
  grid = givens.slice();
  render(isBuilding() ? findConflicts(grid) : undefined);
  resetResults();
  if (isBuilding()) setCard("solve", null, "Type the starting numbers, then Solve.");
  if (mode === "zk") startZk(givens);
}

puzzleSelect.addEventListener("change", () => loadPuzzle(PUZZLES[puzzleSelect.value]));
$("#reset").addEventListener("click", () => loadPuzzle(PUZZLES[puzzleSelect.value]));
$("#clear").addEventListener("click", () => {
  puzzleSelect.value = "custom";
  PUZZLES.custom = new Array(N * N).fill(0);
  loadPuzzle(PUZZLES.custom);
  cells[0].focus();
});

// --- Modes ---

const LEDES = {
  solve: "Checking a solution is fast. Finding one means searching.",
  zk: "Prove you know the solution without revealing any of it.",
};
type Mode = keyof typeof LEDES;
let mode: Mode = "solve";
const modeTabs = document.querySelectorAll<HTMLButtonElement>("#mode-tabs button");

function setMode(next: Mode) {
  mode = next;
  modeTabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.mode === mode)));
  document.querySelectorAll<HTMLElement>("[data-show]").forEach((el) => {
    el.hidden = el.dataset.show !== mode;
  });
  $(".lede").textContent = LEDES[mode];
  if (mode === "zk") startZk(givens);
}

modeTabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode as Mode)));

render();
showCode();
setMode("solve");
