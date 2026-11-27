// 실제 영상 장면에서 선호 모드, 배선 열거 범위와 단절의 출처를 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { display } from "../domains/display/display.ts";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
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
    assert.ok(r.reasons.some(v => v.outcome === unresolved && v.rule === "배선 조합 상한"));
    for (const [id, verdict] of [["native","ok"], ["too-large","impossible"]]) {
      const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === id);
      assert.equal(r.outcomes[row]!.verdict, verdict);
      assert.deepEqual(r.quests.filter(q => q.outcome === row), []);
    }
  }
});

test("T3 끊긴 GPU 경로의 근거에 실제 출력 포트 부착점과 모델 출처가 남는다", () => {
  const scene = fixture(), wire = scene.connections.find(c => c.id === "unresolved")!, claim = portFacts(scene, wire.from).attachment;
  scene.claims[claim]!.attachmentNode = scene.nodes.findIndex(n => n.id === "gpu-b");
  scene.claims[claim]!.value = "gpu-b";
  const r = evaluate(scene, [display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && scene.workloads[o.subjectRow]!.id === "unresolved");
  assert.equal(r.outcomes[row]!.verdict, "impossible");
  assert.ok(r.reasonInputs.some(i => i.claim === claim && r.reasons[i.reason]!.outcome === row && r.reasons[i.reason]!.stage === "path"));
  assert.ok(scene.claimSources.some(s => s.claim === claim && scene.sources[s.source]!.id === "video-source"));
});

test("T3 작업 양 끝의 노드가 모두 고립되어도 그 장비의 포트 배선을 근거로 보인다", () => {
  const scene = fixture(), work = scene.workloads.findIndex(w => w.id === "native"), request = scene.workloads[work]!;
  const unattached = scene.connections.find(c => c.id === "unresolved")!.from;
  Object.assign(scene.claims[portFacts(scene,unattached).attachment]!, { value: "gpu-b", attachmentNode: scene.nodes.findIndex(n => n.id === "gpu-b") });
  for (const side of ["from","to"] as const) {
    const node = scene.nodes[request[side]]!;
    request[side] = scene.nodes.push({ ...node, id: "isolated-" + side }) - 1;
  }
  const r = evaluate(scene, [display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === work);
  const wire = scene.connections.find(c => c.id === "native")!;
  assert.equal(r.outcomes[row]!.verdict, "impossible");
  for (const p of [wire.from, wire.to]) assert.ok(r.reasonInputs.some(i => r.reasons[i.reason]!.outcome === row && i.claim === portFacts(scene,p).attachment));
});

test("T3 외부 연결 없는 장비에서 역방향 내부 간선의 방향과 모델 출처가 불가 근거에 남는다", () => {
  const trial = trialDomain();
  const scene = loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [trial]);
  scene.connections = [];
  scene.members = scene.members.slice(0, 1);
  const work = scene.workloads[0]!, row = scene.edges.findIndex(e => e.from === work.from);
  const edge = scene.edges[row]!;
  work.from = edge.to;
  work.to = edge.from;
  for (const verdict of ["impossible", "ok"] as const) {
    if (verdict === "ok") [edge.from, edge.to] = [edge.to, edge.from];
    const result = evaluate(scene, [trial]), outcome = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0);
    assert.equal(result.outcomes[outcome]!.verdict, verdict);
    const proof = result.reasons.flatMap((r, i) => r.outcome === outcome && r.stage === "path" && r.targetKind === "edge" ? [i] : []);
    assert.deepEqual(proof.map(i => result.reasons[i]!.targetRow), [row]);
    const reason = proof[0]!;
    assert.ok(result.reasonParents.some(p => p.prior === reason && result.reasons[p.reason]!.outcome === outcome));
    if (verdict === "impossible") assert.ok(result.reasons[reason]!.rule.includes(scene.nodes[edge.from]!.id + " → " + scene.nodes[edge.to]!.id));
    assert.ok(result.reasonInputs.some(i => i.reason === reason && i.claim === edge.evidence));
    assert.ok(scene.claimSources.some(s => s.claim === edge.evidence && scene.sources[s.source]!.locator === "fixture:source"));
  }
});

test("T2 레인 수와 압축 능력이 미확인이어도 4K144 DSC로 가능한 판정에는 무조건 성립이 없다", () => {
  const scene = fixture(), workload = scene.workloads.findIndex(w => w.id === "dsc");
  const claims = [["host","lanes"],["native","dscBpp"]].map(([id,field]) => {
    const port = scene.ports.findIndex(p => scene.items[p.item]!.id === id && p.id === "dp");
    const iface = scene.interfaces.findIndex(i => i.port === port && i.domain === display.id);
    const row = effectiveClaim(scene,"interface",iface,display.id,field!)!;
    Object.assign(scene.claims[row]!,{ value: null, confidence: "unknown" });
    return row;
  });
  const r = evaluate(scene,[display]), row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === workload);
  assert.equal(r.outcomes[row]!.verdict,"unknown");
  assert.deepEqual(r.possibleVerdicts.filter(p => p.outcome === row).map(p => p.verdict).sort(),["conditional","impossible"]);
  const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.equal(m.low,0);
  assert.ok(Math.abs(m.high! - 15.674472) < 1e-9);
  for (const claim of claims) assert.ok(r.quests.some(q => q.outcome === row && q.claim === claim));
});
