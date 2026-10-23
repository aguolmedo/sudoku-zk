import { region } from "./code.ts";
import { type Grid, solve } from "./sudoku.ts";
import {
  allChallenges,
  type Challenge,
  challengeLabel,
  type Check,
  checkOpening,
  makeCheatingGrid,
  type Opening,
  Prover,
} from "./zk.ts";
import zkSource from "./zk.ts?raw";

const N = 9;
const B = 3;
const CHALLENGES = allChallenges(N);
const RUN_ROUNDS = 100;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

const board = $<HTMLDivElement>("#zk-board");
const proverSelect = $<HTMLSelectElement>("#zk-prover");
const challengeSelect = $<HTMLSelectElement>("#zk-challenge");
const openButton = $<HTMLButtonElement>("#zk-open");
const randomButton = $<HTMLButtonElement>("#zk-random");
const runButton = $<HTMLButtonElement>("#zk-run");
const restartButton = $<HTMLButtonElement>("#zk-restart");

let givens: Grid = new Array(N * N).fill(0);
let prover: Prover | null = null;
// The commitment for the next round. It's made before the verifier picks a challenge.
let pending: Promise<string[]> | null = null;
let passed = 0;
let caught = false;
let running = false;
// Bumped on every restart so async work from an old proof is ignored.
let epoch = 0;

// --- Board ---

const cells = Array.from({ length: N * N }, (_, idx) => {
  const cell = document.createElement("div");
  cell.className = "zcell";
  const r = Math.floor(idx / N);
  const c = idx % N;
  if (c % B === B - 1 && c !== N - 1) cell.classList.add("box-right");
  if (r % B === B - 1 && r !== N - 1) cell.classList.add("box-bottom");
  const given = document.createElement("span");
  given.className = "zgiven";
  const value = document.createElement("span");
  value.className = "zvalue";
  cell.append(given, value);
  board.append(cell);
  return { cell, given, value };
});

interface RoundView {
  hashes: string[];
  opening?: Opening;
  check?: Check;
}

function renderBoard(view: RoundView | null) {
  const opened = new Map<number, number>();
  view?.opening?.cells.forEach((c, i) => opened.set(c, view.opening!.values[i]));
  const bad = new Set(view?.check && !view.check.ok ? view.check.cells : []);
  cells.forEach(({ cell, given, value }, idx) => {
    const v = opened.get(idx);
    given.textContent = givens[idx] ? String(givens[idx]) : "";
    value.textContent = v !== undefined ? String(v) : (view?.hashes[idx].slice(0, 2) ?? "");
    cell.classList.toggle("opened", v !== undefined);
    cell.classList.toggle("bad", bad.has(idx));
    cell.title = view ? `Commitment ${view.hashes[idx].slice(0, 16)}…` : "";
  });
}

// --- Round, transcript and confidence ---

const cellName = (idx: number) => `r${Math.floor(idx / N) + 1}c${(idx % N) + 1}`;

function setRound(label: string, detail: string, tone: "ok" | "bad" | "" = "") {
  $("#zk-round").className = `card ${tone}`;
  $("#zk-round-label").textContent = label;
  $("#zk-round-detail").textContent = detail;
  $("#zk-relabel").hidden = true;
  $("#zk-transcript-wrap").hidden = true;
}

function renderRound(round: number, challenge: Challenge, hashes: string[], opening: Opening, check: Check) {
  const label = `Round ${round} · ${challengeLabel(challenge)}`;
  const count = opening.cells.length;
  if (!check.ok) {
    setRound(label, `✗ Caught: ${check.reason} (${check.cells.map(cellName).join(", ")}).`, "bad");
  } else if (challenge.kind === "givens") {
    setRound(label, `✓ All ${count} hashes match, and σ turns every starting number into its opened value.`, "ok");
  } else {
    setRound(label, `✓ All ${count} hashes match, and the values are 1–${N} with no repeats.`, "ok");
  }

  if (opening.relabel) {
    const pairs = opening.relabel.slice(1).map((to, i) => `${i + 1}→${to}`);
    $("#zk-relabel").textContent = `σ: ${pairs.join("  ")}`;
    $("#zk-relabel").hidden = false;
  }

  const bad = new Set(check.ok ? [] : check.cells);
  $("#zk-transcript").innerHTML = opening.cells
    .map((c, i) => {
      const shown = challenge.kind === "givens" ? `${givens[c]}→${opening.values[i]}` : opening.values[i];
      return `<tr class="${bad.has(c) ? "bad" : ""}">
        <td>${cellName(c)}</td><td>${shown}</td>
        <td>${opening.nonces[i].slice(0, 8)}…</td><td>${hashes[c].slice(0, 10)}…</td>
        <td>${bad.has(c) ? "✗" : "✓"}</td>
      </tr>`;
    })
    .join("");
  $("#zk-transcript-wrap").hidden = false;
}

function formatChance(p: number): string {
  const pct = p * 100;
  if (pct >= 0.01) return `${pct.toPrecision(2)}%`;
  const exp = Math.floor(Math.log10(pct));
  return `${(pct / 10 ** exp).toFixed(1)} × 10<sup>${exp}</sup>%`;
}

function renderConfidence() {
  const stats = $("#zk-stats");
  const detail = $("#zk-confidence");
  const bound = ((3 * N) / (3 * N + 1)) ** passed;
  $("#zk-passed").textContent = String(passed);
  stats.className = `card ${caught ? "bad" : ""}`;
  $("#zk-meter").style.width = `${caught ? 100 : (1 - bound) * 100}%`;

  const cheaterNote =
    proverSelect.value === "cheat" && !caught
      ? " This prover is cheating: two cells in one row are swapped, so only 2 of the 28 challenges can expose it."
      : "";
  if (caught) {
    detail.textContent = `✗ The prover was caught in round ${passed + 1}. An honest prover never fails a check, so their grid is wrong.`;
  } else if (passed === 0) {
    detail.textContent = `No rounds yet. Each round passed shrinks a cheater's chance of getting through by 27/28.${cheaterNote}`;
  } else {
    detail.innerHTML = `A cheater would get through ${passed} rounds with probability at most (27/28)<sup>${passed}</sup> = ${formatChance(bound)}.${cheaterNote}`;
  }
}

function setControls() {
  const canPlay = prover !== null && !caught && !running;
  for (const el of [challengeSelect, openButton, randomButton, runButton]) el.disabled = !canPlay;
  restartButton.disabled = running;
  // Keep the proof's setup fixed while a batch of rounds runs.
  document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("#puzzle, #zk-prover, #mode-tabs button").forEach((el) => {
    el.disabled = running;
  });
}

// --- Protocol ---

/** Start a fresh proof for `puzzle`. The prover solves it privately first. */
export function startZk(puzzle: Grid) {
  epoch++;
  givens = puzzle.slice();
  passed = 0;
  caught = false;
  running = false;
  prover = null;
  pending = null;

  const solution = solve(givens, "smart", 2_000_000).solution;
  const grid = solution && proverSelect.value === "cheat" ? makeCheatingGrid(solution, givens) : solution;
  if (!grid) {
    renderBoard(null);
    setRound(
      "No proof",
      solution
        ? "There are no two empty cells in the same row and box to swap, so the cheating prover can't play this puzzle."
        : "This puzzle has no solution, so there's nothing to prove. Pick another puzzle.",
      "bad",
    );
  } else {
    prover = new Prover(grid);
    pending = prover.commit();
    const current = epoch;
    pending.then((hashes) => {
      if (current !== epoch) return;
      renderBoard({ hashes });
      setRound("Round 1", "The prover has committed to all 81 cells. Pick a challenge.");
    });
  }
  renderConfidence();
  setControls();
}

async function runRound(challenge: Challenge): Promise<void> {
  if (!prover || !pending || caught) return;
  const current = epoch;
  const hashes = await pending;
  const opening = prover.open(challenge, givens);
  const check = await checkOpening(givens, hashes, challenge, opening);
  if (current !== epoch) return;

  const round = passed + 1;
  if (check.ok) {
    passed++;
    pending = prover.commit(); // commit to the next round before the next challenge
  } else {
    caught = true;
  }
  renderBoard({ hashes, opening, check });
  renderRound(round, challenge, hashes, opening, check);
  renderConfidence();
  setControls();
}

function randomChallenge(): Challenge {
  const [r] = crypto.getRandomValues(new Uint32Array(1));
  return CHALLENGES[Math.floor((r / 2 ** 32) * CHALLENGES.length)];
}

// --- Controls ---

for (const kind of ["row", "col", "box", "givens"] as const) {
  const group = document.createElement("optgroup");
  group.label = { row: "Rows", col: "Columns", box: "Boxes", givens: "Other" }[kind];
  CHALLENGES.forEach((challenge, i) => {
    if (challenge.kind === kind) group.append(new Option(challengeLabel(challenge), String(i)));
  });
  challengeSelect.append(group);
}

openButton.addEventListener("click", () => runRound(CHALLENGES[Number(challengeSelect.value)]));
randomButton.addEventListener("click", () => runRound(randomChallenge()));
restartButton.addEventListener("click", () => startZk(givens));
proverSelect.addEventListener("change", () => startZk(givens));

runButton.addEventListener("click", async () => {
  const current = epoch;
  running = true;
  setControls();
  for (let i = 0; i < RUN_ROUNDS && !caught && current === epoch; i++) {
    await runRound(randomChallenge());
    await new Promise(requestAnimationFrame); // let each round paint
  }
  if (current !== epoch) return;
  running = false;
  setControls();
});

// --- Implementation panel ---

const codeTabs = document.querySelectorAll<HTMLButtonElement>("#zk-code-tabs button");
const CODE = Object.fromEntries([...codeTabs].map((tab) => [tab.dataset.region!, region(zkSource, tab.dataset.region!)]));

function showCode(name: string) {
  $("#zk-code").innerHTML = CODE[name];
  codeTabs.forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.region === name)));
}

codeTabs.forEach((tab) => tab.addEventListener("click", () => showCode(tab.dataset.region!)));
showCode("commit");
