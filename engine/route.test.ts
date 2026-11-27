// 긴 직렬 배선도 실행기의 호출 스택 크기와 무관하게 끝점까지 이어진다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { routes } from "./route.ts";

test("경로: 엣지 12000개의 직렬 배선을 끝까지 이어 붙인다", () => {
  const arcs = Array.from({ length: 12000 }, (_, from) => ({ from, to: from + 1, key: String(from) }));
  const { found, truncated } = routes(arcs, 0, arcs.length);
  assert.equal(truncated, false);
  assert.deepEqual(found, [arcs]);
});
