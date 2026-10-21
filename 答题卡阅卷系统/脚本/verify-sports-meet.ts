import assert from "node:assert/strict";
import { parseSportsResult, rankSportsScores, teamPointTotals } from "../源码/shared/sportsMeet";

assert.equal(parseSportsResult("1:23.45"), 83.45);
assert.equal(parseSportsResult("12,34"), 12.34);

const track = rankSportsScores([
  { id: 1, className: "七年级1班", result: 12.2, status: "valid" },
  { id: 2, className: "七年级2班", result: 12.2, status: "valid" },
  { id: 3, className: "七年级3班", result: 12.8, status: "valid" },
  { id: 4, className: "七年级4班", result: null, status: "dns" },
]);
assert.deepEqual(track.map((row) => [row.rank, row.points]), [[1, 8], [1, 8], [3, 6], [null, 0]]);

const field = rankSportsScores([
  { id: 1, className: "七年级1班", result: 6.3, status: "valid" },
  { id: 2, className: "七年级2班", result: 6.8, status: "valid" },
], "distance");
assert.deepEqual(field.map((row) => row.rank), [2, 1]);
assert.deepEqual(teamPointTotals([{ className: "七年级1班", points: 8 }, { className: "七年级1班", points: 6 }, { className: "七年级2班", points: 9 }]), [
  { className: "七年级1班", points: 14 },
  { className: "七年级2班", points: 9 },
]);

console.log("sports meet ranking checks passed");
