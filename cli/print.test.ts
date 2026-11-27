// CLI가 장면의 판정·근거를 보여 주고 로드 실패의 위치를 전달하는지 확인한다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { power } from "../domains/power/power.ts";
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

test("T2 CLI는 선택한 연결 설정과 근거를 보이고 --variants에서 다른 설정의 판정과 성능을 보인다", () => {
  const setup = `
    import { trial } from ${JSON.stringify(new URL("./domains.ts", import.meta.url).href)};
    const negotiate = trial.negotiate;
    trial.negotiate = link => {
      const options = negotiate(link);
      const wire = link.scene.connections[link.connection];
      if (wire.id !== "wire-a") return options;
      return options.flatMap(o => ["C", "D"].map(profile => ({ ...o, profile,
        limit: profile === "C" ? 100 : 50, rule: "시험 핀 " + profile, inputs: [...o.inputs, wire.evidence] })));
    };
  `;
  const args = ["--import", "data:text/javascript," + encodeURIComponent(setup), "cli/evaluate.ts", sceneFile];
  const base = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(base.status, 0, base.stderr);
  const [summary, evidence] = base.stdout.split(/\r?\n근거\r?\n/u);
  assert.match(summary!, /시나리오 all\s+연결 설정 wire-a · C/u);
  const choice = evidence!.split(/연결 설정 wire-a · C/u)[1]!.split(/(?:✅|⚠️|❌|❓)/u)[0]!;
  assert.match(choice, /시험 핀 C/u);
  assert.match(choice, /주장 wire-a · connection = true/u);
  assert.match(choice, /출처 scene 합성 시험 정의 \(fixture:scene\)/u);
  assert.match(choice, /규격 합성 펄스 규격 \(fixture:pulse-spec\)/u);
  assert.doesNotMatch(base.stdout, /대안 1/u);

  const expanded = spawnSync(process.execPath, [...args, "--variants"], { encoding: "utf8" });
  assert.equal(expanded.status, 0, expanded.stderr);
  const [primary, alternative] = expanded.stdout.split("대안 1 · 시나리오 all");
  assert.match(primary!, /시나리오 all\s+연결 설정 wire-a · C/u);
  assert.match(primary!, /\n근거\n/u);
  assert.match(alternative!, /연결 설정 wire-a · C → D/u);
  const workload = alternative!.split(/⚠️ 워크로드 a\b/u)[1]!.split(/(?:✅|⚠️|❌|❓) 워크로드/u)[0]!;
  assert.match(workload, /동시 성능 50 회\/s/u);
});

test("T2 CLI는 시나리오별로 조합 탐색이 잘린 사실과 확인한 조합 수를 보인다", () => {
  const plugin = trialDomain();
  const scene = loadScene(sceneFile, files, [plugin]);
  const negotiate = plugin.negotiate;
  plugin.negotiate = link => negotiate(link).flatMap(o => link.connection === 0
    ? Array.from({ length: 140 }, (_, index) => ({ ...o, profile: `시험-${index}` })) : [o]);
  const result = evaluate(scene, [plugin]);
  const output = printResults(scene, result);
  assert.equal(result.searches[0]?.truncated, true);
  assert.match(output.split("시나리오 all\n")[1]!, new RegExp(`조합 탐색이 잘림 · 확인한 조합 ${result.searches[0]!.examined}개`, "u"));
});

test("CLI 출력에 모르는 정책의 범위와 가정값, 가능한 판정, 확인할 것이 보인다", () => {
  const plugins = [trialDomain()];
  const scene = loadScene(sceneFile, files, plugins);
  const trunk = scene.resources.findIndex(r => r.id === "trunk");
  const policy = effectiveClaim(scene, "resource", trunk, "trial", "policy")!;
  scene.claims[policy]!.value = null;
  scene.claims[policy]!.confidence = "unknown";
  const output = printResults(scene, evaluate(scene, plugins)).split("\n근거\n")[0]!;
  const b = output.split(/❓ 워크로드 b\b/u)[1]!.split(/❓ 워크로드 c\b/u)[0]!;
  assert.match(b, /동시 성능 범위 0 회\/s ~ 800 회\/s/u);
  assert.match(b, /동시 성능 400 회\/s \(가정\)/u);
  assert.match(b, /가능한 판정 .*✅.*/u);
  assert.match(b, /확인할 것 · .+ \(host\/trunk · policy\) · 판정을 가름/u);
});

test("T8 CLI는 판정이 같고 전달량만 달라지는 퀘스트의 영향을 보인다", () => {
  const dir = "fixtures/power";
  const scene = loadScene(dir + "/single-port.json", { modelsDir: dir, connectorsFile: dir + "/connectors.json" }, [power]);
  scene.interfaces.forEach((port, row) => {
    if (port.role !== "cable") return;
    scene.claims[effectiveClaim(scene, "interface", row, "power", "eMarked")!]!.value = true;
    Object.assign(scene.claims[effectiveClaim(scene, "interface", row, "power", "currentA")!]!, { value: null, confidence: "unknown" });
  });
  const output = printResults(scene, evaluate(scene, [power]));
  assert.match(output, /✅ 워크로드 idle[^]*?확인할 것 · [^\n]*currentA\) · 범위만 좁힘/u);
});

test("T8 CLI 출력에 단독·동시 전달량과 순충전 전력 및 가능한 판정이 보인다", () => {
  const dir = "fixtures/power";
  const plugins = [power];
  const scene = loadScene(dir + "/three-ports.json", { modelsDir: dir, connectorsFile: dir + "/connectors.json" }, plugins);
  const idle = scene.workloads.findIndex(w => w.id === "idle");
  const load = effectiveClaim(scene, "workload", idle, "power", "loadW")!;
  Object.assign(scene.claims[load]!, { value: null, confidence: "unknown" });
  const [summary, evidence] = printResults(scene, evaluate(scene, plugins)).split("\n근거\n");
  const maximum = summary!.split("시나리오 max\n")[1]!.split("시나리오 only-a")[0]!;
  const discharge = maximum.split(/❌ 워크로드 max\b/u)[1]!;
  assert.match(discharge, /단독 전달량 50 W/u);
  assert.match(discharge, /동시 전달량 50 W/u);
  assert.match(discharge, /단독 순충전 -20 W/u);
  assert.match(discharge, /동시 순충전 -20 W/u);
  assert.match(discharge, /단독 판정 ❌/u);
  assert.match(discharge, /동시 판정 ❌/u);
  const unknown = summary!.split(/❓ 워크로드 idle\b/u)[1]!.split("시나리오 normal")[0]!;
  assert.match(unknown, /동시 순충전 범위 미확인 ~ 50 W/u);
  assert.match(unknown, /동시 가능한 판정 ✅ ⚠️ ❌/u);
  assert.match(evidence!, /\[판정\] 동시 순충전.* · max/u);
});
