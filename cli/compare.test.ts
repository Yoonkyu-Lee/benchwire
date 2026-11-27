// 비교 명령이 바뀐 작업만 출력하고 전후 수치·병목·출처를 보여 주는지 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const path = "fixtures/compare";
const before = path + "/before.json";
const after = path + "/after.json";
function run(...args: string[]) {
  return spawnSync(process.execPath, ["fixtures/demo.ts","compare", ...args], { encoding: "utf8" });
}

test("T9 CLI는 바뀐 세 작업의 전후 값과 영향을 준 매체의 출처를 보여 준다", () => {
  const product = spawnSync(process.execPath,["cli/compare.ts",before,after],{encoding:"utf8"});
  assert.equal(product.status,1);
  assert.match(product.stderr,/trial/);
  const result = run(before, after, "--models", path, "--connectors", path + "/connectors.json");
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout;
  const first = text.split("작업 first")[1]!.split("작업 peer-b")[0]!;
  assert.match(first, /변경 판정, 값/u);
  assert.match(first, /전 ⚠️.*동시 100 회\/s/u);
  assert.match(first, /후 ✅.*동시 200 회\/s/u);
  assert.match(first, /동시 병목 first\/medium/u);
  for (const id of ["peer-b", "peer-c"]) {
    const peer = text.split("작업 " + id)[1]!.split("시나리오 ")[0]!;
    assert.match(peer, /변경 값/u);
    assert.match(peer, /전 ⚠️.*동시 400 회\/s/u);
    assert.match(peer, /후 ⚠️.*동시 350 회\/s/u);
    assert.match(peer, /동시 병목 host\/trunk/u);
    assert.match(peer, /근거 first\/medium · capacity/u);
    assert.match(peer, /출처 .+\(fixture:compare\/medium-100\)/u);
    assert.match(peer, /출처 .+\(fixture:compare\/medium-200\)/u);
    assert.match(peer, /가격 차이 미산정/u);
  }
  assert.doesNotMatch(text, /작업 alone|시나리오 peer-alone|^연결 /mu);
});

test("차이가 없을 때 해석할 행 없이 종료한다", () => {
  const result = run(before, before);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /달라진 판정 없음/u);
  assert.doesNotMatch(result.stdout, /변경 |^연결 |^시나리오 /mu);
});

test("비교 명령은 장면 경로 두 개를 요구하고 읽을 수 없는 장면의 위치를 알린다", () => {
  const usage = run(before);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /사용법 .*<장면 A> <장면 B>/u);
  const missing = run(before, path + "/missing.json");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing\.json/u);
  assert.equal(missing.stdout, "");
});
