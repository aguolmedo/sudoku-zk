import assert from "node:assert/strict";
import { EXAMPLE, solve, WORST_CASE } from "./sudoku.ts";
import { allChallenges, challengeLabel, checkOpening, makeCheatingGrid, Prover } from "./zk.ts";

for (const puzzle of [EXAMPLE, WORST_CASE]) {
  const solution = solve(puzzle).solution!;
  const challenges = allChallenges(9);
  assert.equal(challenges.length, 28);

  // An honest prover passes every challenge.
  const honest = new Prover(solution);
  for (const challenge of challenges) {
    const hashes = await honest.commit();
    const result = await checkOpening(puzzle, hashes, challenge, honest.open(challenge, puzzle));
    assert.ok(result.ok, `honest prover failed ${challengeLabel(challenge)}`);
  }

  // The cheater is caught by exactly two challenges: the two swapped columns.
  const cheater = new Prover(makeCheatingGrid(solution, puzzle)!);
  const caughtBy: string[] = [];
  for (const challenge of challenges) {
    const hashes = await cheater.commit();
    const result = await checkOpening(puzzle, hashes, challenge, cheater.open(challenge, puzzle));
    if (!result.ok) caughtBy.push(challengeLabel(challenge));
  }
  assert.equal(caughtBy.length, 2, `cheater caught by ${caughtBy.join(", ")}`);
  assert.ok(caughtBy.every((label) => label.startsWith("Column")));

  // Changing a value after committing breaks the hash check.
  const challenge = challenges[0];
  const hashes = await honest.commit();
  const opening = honest.open(challenge, puzzle);
  opening.values[0] = (opening.values[0] % 9) + 1;
  const tampered = await checkOpening(puzzle, hashes, challenge, opening);
  assert.ok(!tampered.ok && tampered.reason.includes("commitment"));
}

console.log("ok — zero-knowledge protocol");
