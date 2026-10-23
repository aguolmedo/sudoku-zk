import assert from "node:assert/strict";
import { EXAMPLE, parse, solve, verify, WORST_CASE } from "./sudoku.ts";

const expected = parse(`
  534678912
  672195348
  198342567
  859761423
  426853791
  713924856
  961537284
  287419635
  345286179
`);

const { solution, steps } = solve(EXAMPLE);
assert.deepEqual(solution, expected);
assert.equal(verify(expected).kind, "solved");
assert.equal(verify(EXAMPLE).kind, "incomplete");

const broken = expected.slice();
broken[0] = broken[1];
const verdict = verify(broken);
assert.equal(verdict.kind, "invalid");

assert.equal(solve(parse("1234" + "3412" + "2143" + "4321")).solution?.length, 16);
assert.equal(solve(broken).solution, null);

console.log(`ok — solved example in ${steps} steps`);

const worst = solve(WORST_CASE, "smart");
assert.equal(worst.solution && verify(worst.solution).kind, "solved");
assert.deepEqual(worst.solution?.slice(0, 9), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
console.log(`ok — worst case solved smartly in ${worst.steps} steps`);
