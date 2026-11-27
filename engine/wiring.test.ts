// 실제 영상 장면에서 선호 모드, 배선 열거 범위와 단절의 출처를 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { display } from "../domains/display/display.ts";
import { loadScene } from "../cli/load.ts";
import { effectiveClaim } from "./contract.ts";
import { evaluate } from "./evaluate.ts";
import { portFacts } from "./scene.ts";

function fixture() {
  return loadScene("fixtures/display/scene.json", { modelsDir: "fixtures/display", connectorsFile: "fixtures/display/connectors.json" }, [display]);
}

test("T1 요청 주사율이 미확인이면 알려진 60 Hz 폴백으로 확정하지 않는다", () => {
  const scene = fixture(), work = scene.workloads.findIndex(w => w.id === "with-fallback");
  const refresh = effectiveClaim(scene, "workload", work, display.id, "refresh")!;
  scene.claims[refresh]!.value = null;
  const r = evaluate(scene, [display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === work);
  assert.equal(r.outcomes[row]!.verdict, "unknown");
  assert.deepEqual(r.possibleVerdicts.filter(p => p.outcome === row).map(p => p.verdict).sort(), ["conditional", "ok"]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === refresh && q.instruction === display.quest("refresh")));
  assert.equal(r.metrics.find(m => m.outcome === row && m.kind === "together")!.value, null);
});

test("T3 다른 배선의 후보가 많아도 독립 시나리오의 판정과 퀘스트는 유지한다", () => {
  const scene = fixture();
  for (const connected of [false,true]) {
    for (let i = 0; i < 65; i++) {
      const n = scene.nodes.push({ item: 0, id: String(scene.nodes.length), label: "", kind: "junction" }) - 1;
      if (connected) scene.edges.push({ ...scene.edges[0]!, item: 0, from: 0, to: n });
    }
    const r = evaluate(scene, [display]);
    const unresolved = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === "unresolved");
    assert.equal(r.reasons.some(v => v.outcome === unresolved && v.rule === "배선 조합 상한"), connected);
    for (const [id, verdict] of [["native","ok"], ["too-large","impossible"]]) {
      const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === id);
      assert.equal(r.outcomes[row]!.verdict, verdict);
      assert.deepEqual(r.quests.filter(q => q.outcome === row), []);
    }
  }
});

test("T3 끊긴 GPU 경로의 근거에 실제 출력 포트 부착점과 모델 출처가 남는다", () => {
  const scene = fixture(), wire = scene.connections.find(c => c.id === "unresolved")!, claim = portFacts(scene, wire.from).attachment;
  scene.claims[claim]!.reference = scene.nodes.findIndex(n => n.id === "gpu-b");
  scene.claims[claim]!.value = "gpu-b";
  const r = evaluate(scene, [display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === "unresolved");
  assert.equal(r.outcomes[row]!.verdict, "impossible");
  assert.ok(r.reasonInputs.some(i => i.claim === claim && r.reasons[i.reason]!.outcome === row && r.reasons[i.reason]!.stage === "path"));
  assert.ok(scene.claimSources.some(s => s.claim === claim && scene.sources[s.source]!.id === "video-source"));
});

test("T3 작업 양 끝의 노드가 모두 고립되어도 그 장비의 포트 배선을 근거로 보인다", () => {
  const scene = fixture(), work = scene.workloads.findIndex(w => w.id === "native"), request = scene.workloads[work]!;
  const unattached = scene.connections.find(c => c.id === "unresolved")!.from;
  Object.assign(scene.claims[portFacts(scene,unattached).attachment]!, { value: "gpu-b", reference: scene.nodes.findIndex(n => n.id === "gpu-b") });
  for (const side of ["from","to"] as const) {
    const node = scene.nodes[request[side]]!;
    request[side] = scene.nodes.push({ ...node, id: "isolated-" + side }) - 1;
  }
  const r = evaluate(scene, [display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === work);
  const wire = scene.connections.find(c => c.id === "native")!;
  assert.equal(r.outcomes[row]!.verdict, "impossible");
  for (const p of [wire.from, wire.to]) assert.ok(r.reasonInputs.some(i => r.reasons[i.reason]!.outcome === row && i.claim === portFacts(scene,p).attachment));
});
