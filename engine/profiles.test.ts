// 단일 연결의 설정·동시 모드·상시 부하를 시험 영역의 손계산과 대조한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { trialDomain } from "../fixtures/trial.ts";
import * as engine from "./evaluate.ts";
import { effectiveClaim, type Demand, type Option } from "./contract.ts";
import type { Results } from "./results.ts";

function setup(amounts: number[]) {
  const plugin = trialDomain();
  const scene = loadScene("fixtures/three-flows.json", { modelsDir: "fixtures", connectorsFile: "fixtures/connectors.json" }, [plugin]);
  scene.connections = scene.connections.slice(0,1);
  const c = scene.connections[0]!;
  const node = (port: number) => scene.claims[effectiveClaim(scene,"port",port,"","attachment")!]!.reference!;
  scene.workloads = amounts.map((_, i) => ({ id: "작업-" + i, domain: plugin.id, kind: "시험", from: node(c.from), to: node(c.to) }));
  scene.members = amounts.map((_,workload) => ({ scenario: 0, workload }));
  const inputs = [c.evidence], specs = ["pulse"];
  plugin.consume = () => [];
  function option(mode: string, limit: number, profile?: string): Option {
    return { mode, limit, unit: "회/s", verdict: "ok", condition: "", rule: "시험 링크", inputs, specs, ...(profile ? { profile } : {}) };
  }
  function demand(mode: string, requested: number, elastic: boolean, preference = 0): Demand {
    return { mode, requested, elastic, preference, via: [], unit: "회/s", rule: "작업 요청", inputs, specs };
  }
  return { scene, plugin, option, demand, inputs, specs };
}
function work(r: Results, w: number, scenario = 0) {
  const row = r.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === w && o.scenario === scenario);
  const value = (kind: "solo" | "together") => r.metrics.find(m => m.outcome === row && m.kind === kind)!.value;
  return { mode: r.outcomes[row]!.mode, solo: value("solo"), value: value("together"), verdict: r.outcomes[row]!.verdict };
}

test("T2 한 연결의 양방향·두 데이터 작업은 영상 목표가 고른 같은 핀 배정을 쓴다", () => {
  const { scene, plugin, option, demand } = setup([16,100,100]);
  scene.members[0]!.priority = 0;
  const w = scene.workloads[1]!;
  [w.from,w.to] = [w.to,w.from];
  plugin.negotiate = () => ["C","D"].flatMap(p => [
    { ...option("video",p === "C" ? 26 : 13,p), unit: "Gbps" },
    option("bulk",p === "C" ? 40 : 400,p),
  ]);
  let requested = 16;
  plugin.demand = (_s,w) => w ? [demand("bulk",100,true)] : [demand("video",requested,false),demand("video",12,false,1)]
    .map(d => ({ ...d, unit: "Gbps" }));
  const variants = engine.evaluateVariants(scene,[plugin],0);
  assert.deepEqual(variants.map(v => v.choices.map(c => c.profile)), [["C"],["D"]]);
  assert.deepEqual(variants.map(v => [0,1,2].map(w => work(v.result,w).value)), [[16,40,40],[12,100,100]]);
  assert.deepEqual(engine.evaluate(scene,[plugin]), variants[0]!.result);
  assert.ok(variants[0]!.choices[0]!.inputs.includes(scene.connections[0]!.evidence));
  requested = 12;
  assert.equal(engine.evaluateVariants(scene,[plugin],0)[0]!.choices[0]!.profile,"D");
});

test("T4 두 고정 스트림 중 하나를 압축하면 둘 다 서고, 동점인 두 해를 보인다", () => {
  const { scene, plugin, option, demand } = setup([16,16]);
  plugin.negotiate = () => [option("raw",24),option("compressed",24)];
  plugin.demand = () => [demand("raw",16,false), demand("compressed",8,false,1)];
  const check = () => {
    const variants = engine.evaluateVariants(scene,[plugin],0);
    assert.deepEqual(variants.map(v => [0,1].map(w => work(v.result,w).value)).sort(), [[16,8],[8,16]]);
    for (const v of variants) assert.deepEqual([0,1].map(w => work(v.result,w).solo),[16,16]);
    return variants.map(v => [0,1].map(w => work(v.result,w).mode));
  };
  const prior = check();
  scene.members.reverse();
  assert.deepEqual(check(), prior);
});

test("T4 시나리오마다 우선순위의 작은 값이 먼저 고정 예약을 얻는다", () => {
  const { scene, plugin, option, demand } = setup([16,16]);
  plugin.negotiate = () => [option("raw",24)];
  plugin.demand = () => [demand("raw",16,false)];
  scene.scenarios.push({ id: "역순" });
  scene.members = [0,1].flatMap(scenario => [0,1].map(workload => ({ scenario, workload, priority: scenario === workload ? 0 : 1 })));
  const r = engine.evaluate(scene,[plugin]);
  assert.deepEqual([0,1].map(s => [0,1].map(w => work(r,w,s).value)), [[16,0],[0,16]]);
});

test("T8 패스스루의 10은 입력과 소스 총예산에서 단독·동시 모두 실물당 한 번 빠진다", () => {
  const { scene, plugin, option, demand, inputs, specs } = setup([60,60]);
  const capacity = effectiveClaim(scene,"resource",0,plugin.id,"capacity")!;
  scene.claims[capacity]!.value = 45;
  plugin.negotiate = () => [option("input",60)];
  plugin.demand = () => [demand("input",60,true)];
  plugin.consume = () => [{ resource: 0, coefficient: 1, fixed: 0, rule: "상위 소스", inputs, specs }];
  plugin.standingLoads = () => [{ item: 1, id: "자체 소비", amount: 10, unit: "회/s", rule: "항상 쓰는 10", inputs, specs,
    targets: [{ resource: 0 },{ connection: 0, direction: "forward", domain: plugin.id, mode: "input" }] }];
  const r = engine.evaluate(scene,[plugin]);
  assert.deepEqual([0,1].map(w => [work(r,w).solo,work(r,w).value]), [[35,17.5],[35,17.5]]);
  for (const [row,o] of r.outcomes.entries()) if (o.subjectKind === "workload")
    assert.ok(r.reasons.some(reason => reason.outcome === row && reason.rule === "항상 쓰는 10"));
  scene.claims[capacity]!.value = 90;
  assert.equal(work(engine.evaluate(scene,[plugin]),0).solo,50);
});

test("T2 설정 탐색이 잘리면 지원을 확인한 결과에 탐색 상한을 표시한다", () => {
  const { scene, plugin, option, demand } = setup([10]);
  plugin.negotiate = () => Array.from({ length: 300 }, (_,i) => option("mode",20,"p"+i));
  plugin.demand = () => [demand("mode",10,false)];
  const r = engine.evaluate(scene,[plugin]);
  assert.equal(r.searches[0]?.truncated, true);
});

test("T2 경계가 있는 운반 링크에 미확인 match가 겹치면 폴백 스트림은 조건부 또는 불가다", () => {
  const { scene,plugin,option,demand,inputs,specs } = setup([16]);
  plugin.negotiate = () => [{ ...option("stream",24), limit: null, bounds: { low: 6, high: 24 }, verdict: "unknown" }];
  plugin.demand = () => [demand("stream",32,false),demand("stream",16,false,1)];
  plugin.match = () => ({ verdict: "unknown", rule: "압축 지원 미확인", inputs,specs });
  const r = engine.evaluate(scene,[plugin]), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  assert.deepEqual(r.possibleVerdicts.filter(p => p.outcome === row).map(p => p.verdict).sort(),["conditional","impossible"]);
  const metric = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([metric.low,metric.high],[0,16]);
});

test("T4 낮은 등급끼리만 예약이 넘치면 먼저 들어간 높은 예약은 확정이다", () => {
  const { scene,plugin,option,demand } = setup([12,8,8]);
  scene.members.forEach((m,i) => m.priority = i ? 1 : 0);
  plugin.negotiate = () => [option("raw",24)];
  plugin.demand = (_s,w) => [demand("raw",w ? 8 : 12,false)];
  const r = engine.evaluate(scene,[plugin]);
  assert.deepEqual([0,1,2].map(w => work(r,w).value),[12,null,null]);
});

test("T4 같은 등급의 두 고정 예약이 다 들어가지 않으면 실제 정책은 미확인이고 한 작업씩 우선하는 대안이 있다", () => {
  const { scene,plugin,option,demand } = setup([16,16]);
  plugin.negotiate = () => [option("raw",24)];
  plugin.demand = () => [demand("raw",16,false)];
  const variants = engine.evaluateVariants(scene,[plugin],0);
  assert.deepEqual([0,1].map(w => work(variants[0]!.result,w).value),[null,null]);
  assert.deepEqual(variants.slice(1).map(v => [0,1].map(w => work(v.result,w).value)).sort(),[[0,16],[16,0]]);
});

test("T8 상시 부하가 같은 입력 예산의 서비스 이름마다 두 번 빠지거나 사라지지 않는다", () => {
  const { scene,plugin,option,demand,inputs,specs } = setup([60]);
  plugin.negotiate = () => [option("input",60),option("alternate",60)];
  plugin.demand = () => [demand("alternate",60,true)];
  plugin.standingLoads = () => [{ item: 1, id: "자체 소비", unit: "회/s", amount: 10, rule: "상시 입력", inputs,specs,
    targets: [{ connection: 0, direction: "forward", domain: plugin.id, mode: "input" }] }];
  assert.equal(work(engine.evaluate(scene,[plugin]),0).value,50);
});

test("T8 설정 비교는 일부 전력을 받는 작업도 목표 판정에 따라 성립 수를 센다", () => {
  const { scene, plugin, option, demand, inputs,specs } = setup([100,100]);
  plugin.negotiate = () => ["C","D"].flatMap(profile => [
    { ...option("pd", profile === "C" ? 50 : 60,profile), unit: "W" },
    option("bulk", profile === "C" ? 100 : 50,profile),
  ]);
  plugin.demand = (_s,w) => w ? [demand("bulk",100,true)] : [{ ...demand("pd",100,true),unit:"W" }];
  plugin.assess = (_s,w,_d,_steps,p) => ({ possible: [w ? (p.low === 100 ? "ok" : "conditional") : (p.low! >= 55 ? "ok" : "impossible")],
    metrics: [], rule: "목표", inputs,specs });
  const variants = engine.evaluateVariants(scene,[plugin],0);
  assert.equal(variants[0]!.choices[0]!.profile,"D");
  assert.deepEqual([0,1].map(w => work(variants[0]!.result,w).verdict),["ok","conditional"]);
});

test("T3 미확인 부착점을 전개할 때도 사용자가 고른 대안의 설정을 고정한다", () => {
  const { scene,plugin,option,demand } = setup([100]);
  const attachment = effectiveClaim(scene,"port",scene.connections[0]!.from,"","attachment")!;
  Object.assign(scene.claims[attachment]!,{value:null,reference:null});
  scene.edges.push({ ...scene.edges[0]!, from: scene.edges[0]!.to, to: scene.edges[0]!.from });
  plugin.negotiate = () => [option("bulk",100,"A"),option("bulk",40,"B")];
  plugin.demand = () => [demand("bulk",100,true)];
  const variants = engine.evaluateVariants(scene,[plugin],0);
  const b = variants.find(v => v.choices[0]?.profile === "B")!;
  const row = b.result.outcomes.findIndex(o => o.subjectKind === "workload");
  const rate = b.result.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([rate.low,rate.high],[40,40]);
});

test("T8 상시 소비값만 모르면 원래 소스 용량이 전달량의 상한이고 같은 소비 주장을 확인한다", () => {
  const { scene,plugin,option,demand,inputs,specs } = setup([60]);
  const capacity = effectiveClaim(scene,"resource",0,plugin.id,"capacity")!;
  scene.claims[capacity]!.value = 45;
  const missing = scene.claims.push({ ...scene.claims[capacity]!, field: "자체 소비",ownerKind:"item",owner:1,value:null,confidence:"unknown" })-1;
  plugin.negotiate = () => [option("input",60)];
  plugin.demand = () => [demand("input",60,true)];
  plugin.consume = () => [{ resource: 0, coefficient: 1, fixed: 0, rule: "소스 총량", inputs,specs }];
  plugin.standingLoads = () => [{item:1,id:"자체 소비",unit:"회/s",amount:null,targets:[{resource:0}],rule:"항상 켜진 부하",inputs:[missing],specs}];
  const r = engine.evaluate(scene,[plugin]), row = r.outcomes.findIndex(o => o.subjectKind === "workload");
  const m = r.metrics.find(m => m.outcome === row && m.kind === "together")!;
  assert.deepEqual([m.low,m.high],[0,45]);
  assert.ok(r.quests.some(q => q.outcome === row && q.claim === missing));
});

test("T4 높은 예약의 다른 자원이 미확인이면 낮은 예약을 확정 탈락시키지 않는다", () => {
  const { scene,plugin,option,demand,inputs,specs } = setup([16,16]);
  scene.members.forEach((m,i) => m.priority = i);
  scene.claims[effectiveClaim(scene,"resource",0,plugin.id,"capacity")!]!.value = null;
  plugin.negotiate = () => [option("raw",24)];
  plugin.demand = () => [demand("raw",16,false)];
  plugin.consume = (_s,w) => w ? [] : [{resource:0,fixed:16,coefficient:0,rule:"높은 예약의 추가 자원",inputs,specs}];
  assert.deepEqual([0,1].map(w => work(engine.evaluate(scene,[plugin]),w).verdict),["unknown","unknown"]);
});
