// CLI가 장면의 판정·근거를 보여 주고 로드 실패의 위치를 전달하는지 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { effectiveClaim } from "../engine/contract.ts";
import { evaluate } from "../engine/evaluate.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { loadScene } from "./load.ts";
import { printResults } from "./print.ts";

const sceneFile = "fixtures/three-flows.json";
const files = { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" };

test("CLI 출력에서 워크로드별 단독·동시 성능과 병목의 주장 및 출처를 읽을 수 있다", () => {
  const plugins = [trialDomain()];
  const scene = loadScene(sceneFile, files, plugins);
  const output = printResults(scene, evaluate(scene, plugins));

  assert.match(output, /✅ 연결 wire-a.*host\/a → a\/in/u);
  const [summary, evidence] = output.split("\n근거\n");
  const scenario = summary!.split("시나리오 all\n")[1]!;
  const [, a, b, c] = scenario.split(/(?:✅ 워크로드 a|⚠️ 워크로드 [bc])\b/u);
  assert.match(a!, /단독 성능 100 회\/s/u);
  assert.match(a!, /동시 성능 100 회\/s/u);
  for (const work of [b!, c!]) {
    assert.match(work, /단독 성능 800 회\/s/u);
    assert.match(work, /동시 성능 400 회\/s/u);
    assert.match(work, /하락량 400 회\/s/u);
    assert.match(work, /하락률 50%/u);
    assert.match(work, /동시 병목 host\/trunk/u);
  }
  assert.match(evidence!, /판정.*요청과 단독·동시 성능 비교/u);
  assert.match(evidence!, /host\/trunk.*capacity.*900 회\/s.*inferred/u);
  assert.match(evidence!, /source 합성 시험 정의 \(fixture:source\)/u);
  assert.match(evidence!, /합성 펄스 규격 \(fixture:pulse-spec\)/u);
});

test("CLI 출력에 미사용 성능, 연결 불가와 미확인, 필요한 결합 형태, 계약 오류가 보인다", () => {
  const plugin = trialDomain();
  const negotiate = plugin.negotiate;
  plugin.negotiate = link => negotiate(link).map(o => ({ ...o, unused: 20, specs: [...o.specs, "missing-spec"] }));
  const scene = loadScene(sceneFile, files, [plugin]);
  const connection = scene.connections[0]!;
  const from = effectiveClaim(scene, "port", connection.from, "", "connector")!;
  const to = effectiveClaim(scene, "port", connection.to, "", "connector")!;
  const fromClaim = scene.claims[from]!;
  const toClaim = scene.claims[to]!;
  toClaim.value = fromClaim.value;
  toClaim.reference = fromClaim.reference!;
  const sink = scene.interfaces.findIndex(i => i.port === scene.connections[2]!.to);
  const rate = effectiveClaim(scene, "interface", sink, "trial", "rate")!;
  scene.claims[rate]!.value = null;
  scene.claims[rate]!.confidence = "unknown";

  const result = evaluate(scene, [plugin]);
  const need = result.needs[0]!;
  const output = printResults(scene, result);
  assert.match(output, /❌ 연결 wire-a/u);
  assert.match(output, /❓ 연결 wire-c/u);
  assert.ok(output.includes(`필요한 결합 형태 ${need.requiredCapability}`));
  const workloadB = output.split(/워크로드 b\b/u)[1]!;
  assert.match(workloadB.split("\n\n")[0]!, /미사용 성능 20 회\/s/u);
  assert.match(output, /영역 플러그인 계약 오류\n[^]*?trial[^\n]*missing-spec/u);
});

test("CLI 명령은 파일·필드가 있는 로드 오류를 한 줄로 쓰고 종료 코드 1을 돌려준다", () => {
  const processResult = spawnSync(process.execPath, ["cli/evaluate.ts", files.connectorsFile], { encoding: "utf8" });
  assert.equal(processResult.status, 1);
  assert.equal(processResult.stdout, "");
  const error = processResult.stderr.trimEnd();
  assert.match(error, /fixtures\/connectors\.json#sceneId/u);
  assert.doesNotMatch(error, /[\r\n]/u);
});

test("CLI 명령은 경로 옵션으로 장면을 열고 시험 전용 영역을 표시한다", () => {
  const args = ["cli/evaluate.ts", sceneFile, "--models", files.modelsDir, "--connectors", files.connectorsFile];
  const processResult = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.match(processResult.stdout, /시험 전용 영역 trial/u);
  assert.match(processResult.stdout, /시나리오 all/u);
});
