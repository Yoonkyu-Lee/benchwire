// 판정과 자원에서 시작하는 근거 순회가 같은 선행 주장을 재참조하는지 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceRows } from "./evidence.ts";
import type { Results } from "./results.ts";

test("T10 두 갈래가 공유하는 근거는 처음 한 번만 펼치고 자원에서도 같은 순서로 읽는다", () => {
  const reasons: Results["reasons"] = ["공통 출처","경로","배분","판정"].map(rule => ({
    outcome: 0, stage: "judge", rule, targetKind:"workload", targetRow:0,
  }));
  const graph = {reasons,reasonParents:[{reason:3,prior:1},{reason:3,prior:2},{reason:1,prior:0},{reason:2,prior:0}]};
  assert.deepEqual(evidenceRows(graph,{outcome:0}),[
    {reason:3,depth:0,reference:false},{reason:1,depth:1,reference:false},{reason:0,depth:2,reference:false},
    {reason:2,depth:1,reference:false},{reason:0,depth:2,reference:true},
  ]);
  assert.deepEqual(evidenceRows(graph,{reasons:[2]}).map(s => s.reason),[2,0]);
});
