// 추천한 단일 편집을 실제로 적용한 장면의 목표, 동시 부하, 순위를 검증한다.
import assert from "node:assert/strict";
import {test} from "node:test";
import {resolve} from "node:path";
import {openLibrary} from "../server/library.ts";
import {plugins} from "../domains/registry.ts";
import {loadSceneDocuments} from "../scene/load.ts";
import {loadScene} from "../cli/load.ts";
import {trialDomain} from "../fixtures/trial.ts";
import {readClaim} from "../engine/scene.ts";
import {evaluate} from "../engine/evaluate.ts";
import {modelKey,type SceneDocument,type Model} from "./document.ts";
import {recommendationEdits,reviewRecommendation,rankRecommendations} from "./recommend.ts";

const library=openLibrary(resolve(),resolve("work","추천-시험"));
const {models,connectors}=library.describe();
const model=(id:string)=>models.find(m=>m.modelId===id)!;
function setup(additional:Model[]) {
  const doc=JSON.parse(library.readScene("network")!.text) as SceneDocument;
  const documents={models:new Map([...models,...additional].map(m=>[modelKey(m),m])),connectors};
  const scenario=doc.scenarios.find(s=>s.members.includes("lan-a") && s.members.includes("lan-b"))!;
  scenario.goals=[{id:"전송 A",kind:"metric",metric:"delivery",unit:"Mbps",minimum:800,run:"together",workloads:["lan-a"]},
    {id:"전송 B 유지",kind:"metric",metric:"delivery",unit:"Mbps",minimum:500,run:"together",workloads:["lan-b"]}];
  function snapshot(d:SceneDocument) {
    const scene=loadSceneDocuments(d,documents,plugins);
    return {scene,result:evaluate(scene,plugins)};
  }
  const owned={instanceId:"spare",state:"owned" as const,modelId:additional[0]!.modelId,revision:additional[0]!.revision};
  const stock={models:additional,inventory:[owned],connectors};
  const edits=()=>recommendationEdits(doc,documents,stock,snapshot(doc),scenario.id);
  return {doc,documents,stock,scenario,snapshot,edits};
}
test("T5 병목 교체 사본에서 수치 목표를 달성하고 기존 목표를 깨는 후보는 뒤로 간다",()=>{
  const fast=structuredClone(model("network-router"));fast.revision="fast";
  fast.resources.forEach(r=>r.capacity.value=3000);
  const slow=structuredClone(fast);slow.revision="one-port";
  slow.ports.find(p=>p.id==="lan-b")!.interfaces[0]!.params.baseTModes!.value="100BASE-TX";
  const f=setup([fast,slow]), before=f.snapshot(f.doc), plan=f.edits();
  const cards=plan.edits.flatMap(edit=>{
    const after=f.snapshot(edit.document);
    const card=reviewRecommendation(before,after,edit,f.scenario.id);
    if (!card) return [];
    assert.deepEqual(after.result,f.snapshot(structuredClone(edit.document)).result);
    assert.deepEqual(card.achieved,["전송 A"]);
    return [card];
  }).sort(rankRecommendations);
  assert.deepEqual(cards.map(c=>[c.edit.model.revision,c.goalRegressions.map(r=>r.goal)]),[["fast",[]],["one-port",["전송 B 유지"]]]);
  assert.equal(cards[0]!.edit.item.state,"owned");
  const bad=structuredClone(cards[0]!.edit.document);
  bad.scenarios.find(s=>s.id===f.scenario.id)!.members=["lan-a"];
  bad.scenarios.find(s=>s.id===f.scenario.id)!.goals!.pop();
  assert.equal(reviewRecommendation(before,f.snapshot(bad),cards[0]!.edit,f.scenario.id),null);
});

test("T5 충돌 후보 중 하나에서만 목표가 성립하면 같은 세계의 확인 조건을 붙인다",()=>{
  const change=structuredClone(model("network-router"));change.revision="conflicted";
  change.resources.forEach(r=>r.capacity.value=3000);
  change.resources.find(r=>r.id==="uplink")!.capacity.conflicts=[{value:1000,confidence:"review",sources:[change.sources[0]!.id]}];
  const f=setup([change]), edit=f.edits().edits.find(e=>e.target==="router")!;
  const after=f.snapshot(edit.document);
  const card=reviewRecommendation(f.snapshot(f.doc),after,edit,f.scenario.id);
  assert.deepEqual(card?.achieved,[]);
  assert.equal(card.conditional[0]?.goal,"전송 A");
  assert.ok(card.conditional[0]!.assignments.some(a=>a.value===3000));
  const row=after.result.goals.findIndex(goal=>goal.id==="전송 A" && after.scene.scenarios[goal.scenario]!.id===f.scenario.id);
  const proof=after.result.goalSuccesses?.find(success=>success.goal===row);
  assert.ok(proof);
  const budget=proof.assignments.find(a=>after.scene.claims[a.claim]!.field==="capacity");
  assert.equal(budget?.value,3000);
  const capacity=change.resources.find(r=>r.id==="uplink")!.capacity;
  capacity.value=budget.value;
  delete capacity.conflicts;
  assert.equal(f.snapshot(edit.document).result.goals[row]!.verdict,"ok");
  capacity.value=1000;
  assert.equal(f.snapshot(edit.document).result.goals[row]!.verdict,"impossible");
});
test("T5 결합 실패에 어댑터 하나를 끼우며 중복을 빼고 여덟 편집만 평가한다",()=>{
  const adapters=Array.from({length:12},(_,i)=>({...model("network-copper"),kind:"adapter" as const,revision:"adapter-"+i}));
  const f=setup(adapters);
  f.scenario.goals![0]={id:"연결 회복",kind:"metric",metric:"delivery",unit:"Mbps",minimum:500,run:"together",workloads:["lan-a"]};
  const link=f.doc.connections.find(c=>c.id==="lan-a")!;
  link.parts=[];
  const plan=f.edits();
  assert.ok(plan.total>=12);assert.equal(plan.edits.length,8);
  const inserted=plan.edits.find(e=>e.kind==="insert" && e.item.state==="owned")!;
  assert.ok(inserted);
  const parts=inserted.document.connections.find(c=>c.id===link.id)!.parts;
  assert.equal(parts.length,1);assert.equal(parts[0]!.instanceId,inserted.item.instanceId);
  assert.deepEqual(reviewRecommendation(f.snapshot(f.doc),f.snapshot(inserted.document),inserted,f.scenario.id)?.achieved,["연결 회복"]);
});


test("T5 검산을 끝내지 못한 추천은 해당 목표와 사유를 남긴다", () => {
  const change = structuredClone(model("network-router"));
  change.revision = "open-modes";
  change.resources.forEach(r => r.capacity.value = 3000);
  for (const port of change.ports.filter(p=>p.id==="lan-a" || p.id==="lan-b"))
    Object.assign(port.interfaces[0]!.params.baseTModes!, {value:null, confidence:"unknown"});
  const f = setup([change]), edit = f.edits().edits.find(e => e.target === "router")!;
  const before = f.snapshot(f.doc), after = f.snapshot(edit.document);
  const goal = after.result.goals.find(g => g.id === "전송 A")!;
  assert.equal(goal.verdict, "unknown");
  assert.ok(goal.truncated);
  assert.ok(goal.limitClaims?.some(row => after.scene.claims[row]!.field === "baseTModes"));
  const card = reviewRecommendation(before, after, edit, f.scenario.id);
  assert.ok(card);
  assert.deepEqual(card.achieved, []);
  assert.deepEqual(card.conditional, []);
  assert.deepEqual(card.incomplete, ["전송 A"]);
});



test("T5 업링크는 그대로인데 동시 작업이 끊긴 교체를 온전한 교체 뒤로 보낸다", () => {
  const broken = structuredClone(model("network-router"));
  broken.revision = "drops-concurrent";
  broken.ports.find(p => p.id === "lan-b")!.interfaces[0]!.params.baseTModes!.value = "100BASE-TX";
  const fast = structuredClone(model("network-router"));
  fast.revision = "keeps-concurrent";
  fast.resources.forEach(r => r.capacity.value = 3000);
  const f = setup([broken, fast]);
  f.scenario.goals!.pop();
  const before = f.snapshot(f.doc);
  const cards = f.edits().edits.map(edit => reviewRecommendation(before, f.snapshot(edit.document), edit, f.scenario.id)!)
    .sort(rankRecommendations);
  assert.deepEqual(cards.map(card => card.edit.model.revision), [fast.revision, broken.revision]);
  const { workloadChanges } = cards[1]!;
  const loss = workloadChanges.find(r => r.scenario === f.scenario.id && r.workload === "lan-b")!;
  const together = loss.runs.find(r => r.run === "together")!;
  assert.equal(together.regression, true);
  assert.deepEqual([together.before.verdict, together.before.delivery?.value, together.after?.verdict, together.after?.delivery?.value],
    ["conditional", 600, "impossible", 0]);
});

test("T5 다른 시나리오에서 같은 목표 ID와 작업의 전달량을 별도로 비교한다", () => {
  const broken = structuredClone(model("network-router"));
  broken.revision = "other-scenario";
  broken.ports.find(p => p.id === "lan-b")!.interfaces[0]!.params.baseTModes!.value = "100BASE-TX";
  const f = setup([broken]);
  const goal = f.scenario.goals!.pop()!;
  const sharedId = f.scenario.goals![0]!.id;
  f.doc.scenarios.push({ id: "b-alone", name: "B 단독", members: ["lan-b"], goals: [{ ...goal, id: sharedId }] });
  const edit = f.edits().edits.find(e => e.target === "router")!;
  const card = reviewRecommendation(f.snapshot(f.doc), f.snapshot(edit.document), edit, f.scenario.id)!;
  assert.deepEqual(card.goalRegressions, [{ scenario: "b-alone", goal: sharedId,
    before: "ok", after: "impossible" }]);
  const loss = card.workloadChanges.find(r => r.scenario === "b-alone" && r.workload === "lan-b")!;
  const together = loss.runs.find(r => r.run === "together")!;
  assert.equal(together.regression, true);
  assert.deepEqual([together.before.delivery?.value, together.after?.delivery?.value], [900, 0]);
});

test("검산이 미완료여도 끝까지 확인한 세계의 달성 조건을 함께 남긴다", () => {
  const plugin = trialDomain();
  const scene = loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [plugin]);
  scene.connections.length = scene.workloads.length = scene.members.length = 1;
  const claim = scene.claims.push({ ...scene.claims[scene.connections[0]!.evidence]!, ownerKind: "item", owner: 0,
    domain: plugin.id, field: "profile-mode", value: null, confidence: "unknown", discrete: [false, true] }) - 1;
  scene.goals = [{ id: "전달 확보", scenario: 0, kind: "metric", workloads: [0], run: "together", metric: "delivery", unit: "회/s", minimum: 90 }];
  const base = plugin.negotiate;
  plugin.negotiate = link => base(link).map(option => ({ ...option, limit: 40 }));
  const before = { scene, result: evaluate(scene, [plugin]) };
  plugin.negotiate = link => {
    const modes = readClaim(link.scene, claim).value === false ? 129 : 1;
    return base(link).flatMap(option => Array.from({ length: modes }, (_, i) => ({ ...option, limit: 100, profile: "p" + i })));
  };
  const after = { scene, result: evaluate(scene, [plugin]) };
  assert.equal(before.result.goals[0]!.verdict, "impossible");
  assert.equal(after.result.goals[0]!.verdict, "unknown");
  assert.ok(after.result.goals[0]!.truncated);
  assert.deepEqual(after.result.goalSuccesses, [{ goal: 0, assignments: [{ claim, value: true }] }]);
  const f = setup([model("network-router")]);
  const spare = f.stock.inventory[0]!;
  const edit = { kind: "insert" as const, target: "link", item: spare, model: f.stock.models[0]!, document: f.doc };
  const card = reviewRecommendation(before, after, edit, scene.scenarios[0]!.id)!;
  assert.deepEqual(card.incomplete, ["전달 확보"]);
  assert.equal(card.conditional[0]?.goal, "전달 확보");
});
