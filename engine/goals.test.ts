// 같은 시나리오와 후보 안에서 작업·수치·배선 목표가 성립하는지 검산한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { power } from "../domains/power/power.ts";
import { data } from "../domains/data/data.ts";
import { storageDomain } from "../domains/storage/copy.ts";
import { trialDomain } from "../fixtures/trial.ts";
import type { SceneDocument, Model } from "../app/document.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { evaluate } from "./evaluate.ts";
import { judgeGoals } from "./goals.ts";
import { evaluationScene, type ClaimUse } from "./scene.ts";
import { effectiveClaim, readClaim, type DomainPlugin } from "./contract.ts";

type Goal = NonNullable<SceneDocument["scenarios"][number]["goals"]>[number];
function fixture(dir = "fixtures", file = "three-flows") {
  const read = (name: string) => JSON.parse(readFileSync(dir + "/" + name + ".json","utf8"));
  const doc: SceneDocument = read(file);
  const models = new Map<string,Model>(doc.items.map(i => [i.modelId + "@" + i.revision, read(i.modelId + "@" + i.revision)]));
  return {doc, models, connectors: read("connectors")};
}
function metric(id: string, workloads: string[], minimum: number, unit = "회/s", kind = "delivery"): Goal {
  return {id, kind:"metric", workloads, run:"together", metric:kind, unit, minimum};
}
function load(f: ReturnType<typeof fixture>, goals: Goal[], plugin: DomainPlugin) {
  f.doc.scenarios[0]!.goals = goals;
  return loadSceneDocuments(f.doc, f, [plugin]);
}

function supportClaims(host:Model, plugin:DomainPlugin, fields:string[]) {
  const field=z.strictObject({value:z.boolean().nullable(),unit:z.literal("")});
  plugin.attributes=z.strictObject(Object.fromEntries(fields.map(key=>[key,field])));
  const facts=Object.fromEntries(fields.map(key=>[key,{value:null as boolean|null,confidence:"inferred" as const,sources:[host.sources[0]!.id]}]));
  host.attributes={[plugin.id]:facts};
  return host.attributes[plugin.id]!;
}

test("T10 색인의 적중·선형 조회·번호 조회는 실제로 고른 주장만 기록한다",()=>{
  const base=load(fixture(),[],trialDomain());
  const row=base.claims.findIndex(c=>c.ownerKind==="resource" && c.field==="capacity");
  const claim=base.claims[row]!;
  claim.value=null;
  for (const scene of [base,evaluationScene(base)]) {
    const uses:ClaimUse[]=[], view={...scene,claimUses:uses};
    assert.equal(effectiveClaim(view,claim.ownerKind,claim.owner,claim.domain,claim.field,claim.condition,"range"),row);
    assert.equal(uses[row],"range");
    assert.equal(readClaim(view,row),claim);
    assert.equal(uses[row],"selection");
    assert.equal(effectiveClaim(view,claim.ownerKind,claim.owner,claim.domain,"없는 칸"),undefined);
    assert.deepEqual(Object.keys(uses),[String(row)]);
  }
});

test("T5 두 SSD의 동시 값이 (800,600)과 (600,800)이면 둘 다 800 MB/s 목표는 모든 세계에서 미달이다", () => {
  const f = fixture("fixtures/storage","independent-controllers"), plugins = [data,storageDomain];
  f.doc.workloads[0]!.request.throughput!.value = 800;
  f.doc.personal = [];
  const host = f.models.get("host@1")!;
  host.resources.forEach(r=>r.capacity.value=1200);
  const attachment = host.ports.find(p=>p.id==="c")!.attachment;
  const jobs = ["copy-a","copy-b"];
  f.doc.scenarios[0]!.goals = [metric("둘",jobs,800,"MB/s"),metric("하나",[jobs[0]!],800,"MB/s"),metric("낮은 목표",jobs,600,"MB/s")];
  // 세 번째 SSD가 어느 컨트롤러를 공유하는지에 따라 그쪽의 두 복사만 1,200을 나눈다.
  for (const [node,expected] of [["controller-a",[600,800]],["controller-b",[800,600]]] as const) {
    attachment.value=node;
    const fixed = evaluate(loadSceneDocuments(f.doc,f,plugins),plugins);
    assert.deepEqual(fixed.metrics.filter(m=>m.kind==="together").slice(0,2).map(m=>m.value),expected);
  }
  host.sources.push({...host.sources[0]!,id:"other"});
  attachment.conflicts=[{value:"controller-a",confidence:"review",sources:["other"]}];
  const s=loadSceneDocuments(f.doc,f,plugins), result=evaluate(s,plugins);
  assert.deepEqual(result.metrics.filter(m=>m.kind==="together").slice(0,2).map(m=>[m.low,m.high]),[[600,800],[600,800]]);
  assert.deepEqual(result.goals.map(g=>g.verdict),["impossible","unknown","ok"]);
  const witnesses=result.goalWitnesses.filter(w=>w.goal===0);
  assert.deepEqual(witnesses.map(w=>[s.workloads[w.workload]!.id,w.high]).sort(),[["copy-a",600],["copy-b",600]]);
  assert.deepEqual(new Set(witnesses.flatMap(w=>w.assignments.map(a=>a.value))),new Set(["controller-a","controller-b"]));
  assert.deepEqual(result.goalEvidence.filter(e=>e.goal===0).map(e=>s.workloads[e.workload]!.id),jobs);
  assert.ok(result.goalEvidence.every(e=>e.reasons.length && e.reasons.every(i=>result.reasons[i]?.outcome===e.outcome)));
  delete attachment.conflicts;
  host.nodes.push(...["고립 1","고립 2"].map(id=>({...host.nodes[0]!,id})));
  const fixed=host.nodes.map(node=>{
    attachment.value=node.id;
    return evaluate(loadSceneDocuments(f.doc,f,plugins),plugins).goals.map(g=>g.verdict);
  });
  attachment.value=null;
  const allNodes=evaluate(loadSceneDocuments(f.doc,f,plugins),plugins);
  assert.deepEqual(new Set(allNodes.wirings.map(w=>w.node)).size,host.nodes.length);
  assert.deepEqual(allNodes.goals.map(g=>g.verdict),fixed[0]!.map((v,i)=>fixed.every(row=>row[i]===v) ? v : "unknown"));
});

test("T8 들어오는 충전과 순충전 40 W를 선택 경로·전달 60 W와 구별한다", () => {
  const f = fixture("fixtures/power","single-port");
  const s = load(f,[{id:"포트",kind:"port",workloads:["idle"],instanceId:"a",portId:"in"},
    metric("전달",["idle"],60,"W"),metric("순충전",["idle"],50,"W","netCharge")],power);
  const r = evaluate(s,[power]);
  assert.deepEqual(r.goals.map(g=>g.verdict),["ok","ok","impossible"]);
  assert.ok(r.goalEvidence.some(e=>e.goal===0 && e.connections.includes(0) && e.reasons.length));
  assert.ok(r.goalEvidence.some(e=>e.goal===2 && e.low===40 && e.high===40));
});

test("T8 단일 경로의 구간 판정은 포트 한도 0·10·20 W에 가능한 작업과 포트 목표를 모두 담는다", () => {
  const f = fixture("fixtures/power","single-port");
  const request = f.doc.workloads[0]!.request;
  request.requestedW!.value = 20;
  request.loadW!.value = 0;
  const limit = f.models.get("supply@1")!.ports[0]!.interfaces[0]!.params.maxW!;
  const goals: Goal[] = [{id:"작업",kind:"workload",workload:"idle"},
    {id:"포트",kind:"port",workloads:["idle"],instanceId:"supply",portId:"a"},
    ...[0,10,20].map(w => metric(String(w),["idle"],w,"W"))];
  function run(watts: number | null, targets=goals) {
    limit.value = watts;
    const result = evaluate(load(f,targets,power),[power]);
    const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload" && o.subjectRow === 0);
    const bounds = result.metrics.find(m => m.kind === "together" && m.outcome === outcome)!;
    return {verdict:result.outcomes[outcome]!.verdict, goals:result.goals.map(g => g.verdict),
      possible:new Set(result.possibleVerdicts.filter(v => v.outcome === outcome).map(v => v.verdict)),
      bounds:[bounds.low,bounds.high], evidence:result.goalEvidence.filter(e => e.reasons.length)};
  }
  for (const target of [0,20]) {
    request.targetW!.value = target;
    const fixed = [0,10,20].map(w=>run(w)), range = run(null);
    assert.deepEqual(fixed.map(r => r.verdict),["impossible",target ? "conditional" : "ok","ok"]);
    assert.deepEqual(range.goals,goals.map(()=>"unknown"));
    assert.ok(fixed.every(r=>range.possible.has(r.verdict)));
    const delivery=run(null,[]);
    assert.deepEqual(delivery.possible,new Set(fixed.map(r=>r.verdict)));
    assert.deepEqual(delivery.bounds,[0,20]);
    assert.ok(range.evidence.length >= goals.length);
  }
  // 케이블의 양 끝 한도가 모두 양수이고 다른 자원이 전달을 막으면 포트 자체는 살아 있다.
  request.requestedW!.value = 80;
  request.targetW!.value = 0;
  f.models.get("supply@1")!.resources[0]!.capacity.value = 0;
  const cable = f.models.get("cable-3a@1")!.ports.map(p => p.interfaces[0]!.params);
  for (const amps of [3,5,null]) {
    for (const params of cable) {
      params.eMarked!.value = true;
      params.currentA!.value = amps;
    }
    const result = run(100);
    assert.deepEqual(result.bounds,[0,0]);
    assert.deepEqual(result.possible,new Set(["ok"]));
  }
});

test("T10 수요가 0이어도 구간의 한 끝에서만 연결되는 서비스는 작업 성립을 확정하지 않는다", () => {
  const f = fixture(), plugin = trialDomain(), negotiate = plugin.negotiate;
  const limit = f.models.get("source@1")!.ports[0]!.interfaces[0]!.params.rate!;
  plugin.negotiate = link => negotiate(link).map(o => o.limit === null ? {...o,bounds:{low:0,high:100}} : o);
  f.doc.scenarios[0]!.members = ["a"];
  f.doc.workloads[0]!.request.rate!.value = 0;
  function run(value: number | null) {
    limit.value = value;
    const r = evaluate(load(f,[{id:"작업",kind:"workload",workload:"a"}],plugin),[plugin]);
    const row = r.outcomes.findIndex(o => o.subjectKind === "workload");
    return {goal:r.goals[0]!.verdict,possible:r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict)};
  }
  const fixed = [0,100].map(run);
  assert.deepEqual(fixed.map(r => r.goal),["impossible","ok"]);
  const range = run(null);
  assert.equal(range.goal,"unknown");
  assert.ok(fixed.flatMap(r=>r.possible).every(v=>range.possible.includes(v)));
});

test("T8 20 V와 0.57 A의 전달·순충전은 11.4 W 문턱에 닿고 실제로 모자라면 미달이다", () => {
  const f = fixture("fixtures/power","single-port"), request = f.doc.workloads[0]!.request;
  request.requestedW!.value = 20;
  request.loadW!.value = 0;
  request.targetW!.value = 11.4;
  const params = f.models.get("supply@1")!.ports[0]!.interfaces[0]!.params;
  params.maxW!.value = 100;
  const goals = [metric("전달",["idle"],11.4,"W"), metric("순충전",["idle"],11.4,"W","netCharge"),
    metric("더 높은 문턱",["idle"],11.400001,"W"), {id:"작업",kind:"workload",workload:"idle"} as const];
  for (const [amps,expect] of [[0.56,"impossible"],[0.57,"ok"],[0.58,"ok"]] as const) {
    params.pdo20!.value = amps;
    const result = evaluate(load(f,goals,power),[power]);
    assert.deepEqual(result.goals.map(g => g.verdict),[expect,expect,amps === 0.58 ? "ok" : "impossible",expect]);
    assert.ok(result.goalEvidence.every(e => e.reasons.length > 0));
  }
  params.pdo20!.value = 0.57;
  request.loadW!.value = 11.4;
  request.targetW!.value = 0;
  assert.deepEqual(evaluate(load(f,[metric("방전 없음",["idle"],0,"W","netCharge"),goals[3]!],power),[power]).goals.map(g => g.verdict),["ok","ok"]);
  params.maxW!.value = 0;
  const nearZero = [1e-18,1e-10].map(w => metric(String(w),["idle"],w,"W"));
  assert.deepEqual(evaluate(load(f,nearZero,power),[power]).goals.map(g => g.verdict),["ok","impossible"]);
});

test("T8 소비를 뺀 순충전이 0.1 W 문턱에 닿으면 성립하고 0.0999 W이면 미달이다", () => {
  const f = fixture("fixtures/power","single-port"), request = f.doc.workloads[0]!.request;
  request.requestedW!.value = 20;
  request.targetW!.value = 0.1;
  f.models.get("supply@1")!.ports[0]!.interfaces[0]!.params.pdo20!.value = 0.57;
  const goals: Goal[] = [{id:"작업",kind:"workload",workload:"idle"},metric("순충전",["idle"],0.1,"W","netCharge")];
  for (const [loadW,expected] of [[11.3001,"impossible"],[11.3,"ok"],[11.2999,"ok"]] as const) {
    request.loadW!.value = loadW;
    const r = evaluate(load(f,goals,power),[power]);
    assert.deepEqual(r.goals.map(g => g.verdict),[expected,expected]);
    assert.ok(r.goalEvidence.every(e => e.reasons.length));
  }
});

test("T8 패스스루 자체 소비를 차감한 뒤의 전달 목표는 같은 양과 실제 미달을 구분한다", () => {
  const f = fixture("fixtures/power","passthrough");
  const reserve = f.models.get("relay@1")!.ports[0]!.interfaces[0]!.params.reserveW!;
  const capacity = f.models.get("supply@1")!.resources[0]!.capacity;
  for (const [cap,standing,remaining] of [[100,59.7,0.3],[10,9.9,0.1],[12,11.9,0.1],[35,34.8,0.2]] as const) {
    capacity.value = cap;
    reserve.value = standing;
    const goals = [remaining,remaining+0.0001].map(min => metric(String(min),["primary"],min,"W"));
    const r = evaluate(load(f,goals,power),[power]);
    assert.deepEqual(r.goals.map(g => g.verdict),["ok","impossible"]);
    assert.ok(r.goalEvidence.every(e => e.reasons.length));
  }
  capacity.value = 100;
  reserve.value = null;
  const goals = [0,30,61].map(w => metric(String(w),["primary"],w,"W"));
  const open = evaluate(load(f,goals,power),[power]);
  assert.deepEqual(open.goals.map(g => [g.verdict,g.truncated]),[["unknown",true],["unknown",true],["unknown",true]]);
});

test("T8 열린 공급 용량의 0–20 W 범위로 전달량 목표를 판정하고 충전 작업·포트 목표는 미확인으로 둔다", () => {
  const f = fixture("fixtures/power","single-port"), request = f.doc.workloads[0]!.request;
  const capacity = f.models.get("supply@1")!.resources[0]!.capacity;
  request.requestedW!.value = 20;
  request.loadW!.value = request.targetW!.value = 0;
  const goals: Goal[] = [{id:"작업",kind:"workload",workload:"idle"},
    {id:"포트",kind:"port",workloads:["idle"],instanceId:"supply",portId:"a"},
    ...[0,10,20,21].map(w => metric(String(w),["idle"],w,"W"))];
  function run(watts: number | null) {
    capacity.value = watts;
    const scene = load(f,goals,power), result = evaluate(scene,[power]);
    const outcome = result.outcomes.findIndex(o => o.subjectKind === "workload");
    const claim = effectiveClaim(scene,"resource",0,"power","capacity");
    return {result,outcome,claim};
  }
  const fixed = [0,1,10,20,100].map(w => run(w).result);
  const {result,outcome,claim} = run(null);
  const expected = goals.map((_,i) => fixed.every(r => r.goals[i]!.verdict === fixed[0]!.goals[i]!.verdict)
    ? fixed[0]!.goals[i]!.verdict : "unknown");
  assert.deepEqual(expected,["ok","ok","ok","unknown","unknown","impossible"]);
  assert.deepEqual(result.goals.map(g => g.verdict),["unknown","unknown",...expected.slice(2)]);
  assert.deepEqual(result.goals.map(g => g.truncated),[true,true,false,false,false,false]);
  assert.ok(result.goalEvidence.every(e => e.reasons.length && e.claims.includes(claim!)));
  for (const run of ["solo","together"]) {
    const m = result.metrics.find(m => m.kind === run && m.outcome === outcome)!;
    assert.deepEqual([m.low,m.high,m.value],[0,20,null]);
  }
  assert.ok(result.quests.some(q => q.outcome === outcome && q.claim === claim && q.impact === "range"));
});

test("T10 같은 열린 자원 용량이 두 경로의 단독 순위를 가르면 선택을 확정하지 않는다", () => {
  const f = fixture(), plugin = trialDomain(), host = f.models.get("source@1")!, sink = f.models.get("sink@1")!;
  f.doc.scenarios[0]!.members = ["a"];
  const extra = structuredClone(sink.ports[0]!);
  extra.id = "other"; extra.interfaces[0]!.id = "other-if";
  sink.ports.push(extra);
  f.doc.connections.length = 2;
  f.doc.connections[1]!.to = {instanceId:"a",id:extra.id};
  host.ports[1]!.attachment.value = "root";
  host.ports[1]!.interfaces[0]!.params.rate!.value = 80;
  const run = (value: number | null) => {
    host.resources[0]!.capacity.value = value;
    return evaluate(load(f,[{kind:"port",id:"경유",workloads:["a"],instanceId:"host",portId:"a"}],plugin),[plugin]).goals[0]!;
  };
  assert.deepEqual([10,100].map(n => run(n).verdict),["impossible","ok"]);
  const open = run(null);
  assert.deepEqual([open.verdict,open.truncated],["unknown",true]);
});

test("T10 설정별 경로가 하나씩이어도 내부 용량이 설정의 점수를 가르면 열린 수는 선택 입력이다", () => {
  const f = fixture(), plugin = trialDomain(), host = f.models.get("source@1")!;
  f.doc.connections.length = 1;
  f.doc.scenarios[0]!.members = ["a"];
  const negotiate = plugin.negotiate, consume = plugin.consume;
  plugin.negotiate = link => negotiate(link).flatMap(o => [100,80].map(limit => ({...o,profile:String(limit),limit})));
  plugin.consume = (s,w,steps,d,options) => steps.some(step => step.option !== null && options[step.option]!.profile === "100")
    ? consume(s,w,steps,d,options) : [];
  const run = (value: number | null) => {
    host.resources[0]!.capacity.value = value;
    return evaluate(load(f,[metric("90 이상",["a"],90)],plugin),[plugin]).goals[0]!;
  };
  assert.deepEqual([10,100].map(n => run(n).verdict),["impossible","ok"]);
  const open = run(null);
  assert.deepEqual([open.verdict,open.truncated],["unknown",true]);
});

test("T10 같은 양의 환산 오차는 고정 수요의 링크·자원 예약·정책 한도에서 같은 판정을 낸다", () => {
  const f = fixture(), plugin = trialDomain(), source = f.models.get("source@1")!;
  const demand = plugin.demand;
  plugin.demand = (s,w) => demand(s,w).map(d => ({...d,elastic:false}));
  f.doc.scenarios[0]!.members = ["a"];
  const request = f.doc.workloads[0]!.request.rate!, link = source.ports[0]!.interfaces[0]!.params.rate!;
  const resource = source.resources[0]!;
  const rounded = 20 * 0.57;
  for (const bottleneck of ["링크","예약","정책"]) {
    link.value = bottleneck === "링크" ? rounded : 100;
    resource.capacity.value = bottleneck === "예약" ? rounded : 100;
    resource.policy.value = bottleneck === "정책" ? "port-table" : "max-min";
    plugin.policy = ({activeWorkloads}) => activeWorkloads.map(workload => ({workload,limit:rounded,inputs:[],specs:["pulse"],rule:"환산한 예산"}));
    for (const [needed,verdict] of [[11.4,"ok"],[11.400001,"impossible"]] as const) {
      request.value = needed;
      const result = evaluate(load(f,[{kind:"workload",id:"고정 예약",workload:"a"}],plugin),[plugin]);
      assert.equal(result.goals[0]!.verdict,verdict,bottleneck);
      assert.ok(result.goalEvidence[0]!.reasons.length);
    }
  }
  request.value = 1e-14;
  plugin.policy = ({activeWorkloads}) => activeWorkloads.map(workload => ({workload,limit:0,inputs:[],specs:["pulse"],rule:"닫힌 예산"}));
  for (const policy of ["port-table","max-min"]) {
    resource.policy.value = policy;
    resource.capacity.value = policy === "max-min" ? 0 : 100;
    assert.equal(evaluate(load(f,[{kind:"workload",id:"양수 예약",workload:"a"}],plugin),[plugin]).goals[0]!.verdict,"impossible");
  }
});

test("T5 조건부 작업도 수치 목표를 달성하며 정책의 가정값으로는 확정하지 않는다", () => {
  const f = fixture(), p=trialDomain();
  const s=load(f,[metric("동시",["b","c"],400),{kind:"workload",id:"작업",workload:"b"},
    {kind:"scenario",id:"전체"},{kind:"port",id:"연결",instanceId:"host",workloads:["a","b"]}],p);
  assert.deepEqual(evaluate(s,[p]).goals.map(g=>g.verdict),["ok","impossible","impossible","impossible"]);
  s.claims[effectiveClaim(s,"resource",0,p.id,"policy")!]!.value=null;
  assert.equal(evaluate(s,[p]).goals[0]!.verdict,"unknown");
});

test("여러 작업이 한 포트로 들어오고 나가며 허브 뒤에서 갈라져도 달성이다", () => {
  const f = fixture(), p=trialDomain();
  const end = (instanceId:string) => ({instanceId,id:"entry"});
  f.doc.workloads.forEach((w,i)=>{
    w.from=end(i===2 ? "c" : "a"); w.to=end(["b","c","a"][i]!);
    w.request.rate!.value=100;
  });
  const s=load(f,[{kind:"port",id:"단말",workloads:["a","b","c"],instanceId:"a"},
    {kind:"port",id:"허브",workloads:["a","b","c"],instanceId:"host"}],p);
  const r=evaluate(s,[p]);
  assert.deepEqual(r.goals.map(g=>g.verdict),["ok","impossible"]);
  assert.deepEqual(r.goalEvidence.filter(e=>e.goal===0).map(e=>e.connections),[[0],[0],[0]]);
});

test("후보 상한을 넘으면 하한 0 목표에도 기본 세계의 확정값을 남기지 않는다", () => {
  const f=fixture(), p=trialDomain(), rate=f.doc.workloads[0]!.request.rate!;
  f.doc.sources.push({...f.doc.sources[0]!,id:"other"});
  rate.conflicts=Array.from({length:257},(_,i)=>({value:i+1000,confidence:"review",sources:["other"]}));
  const r=evaluate(load(f,[metric("하한",["a"],0)],p),[p]);
  assert.deepEqual([r.goals[0]!.verdict,r.goals[0]!.truncated],["unknown",true]);
  assert.equal(r.goalEvidence[0]!.low,null);
  assert.ok(r.goalEvidence[0]!.reasons.some(i=>r.reasons[i]!.rule.includes("상한")));
});

test("두 작업이 후보마다 함께 다른 포트로 옮겨가면 포트 하나는 달성이고 고정 포트는 미확인이다", () => {
  const f=fixture(), p=trialDomain();
  const sink=f.models.get("sink@1")!, first=sink.ports[0]!;
  sink.ports.push({...first,id:"other",interfaces:first.interfaces.map(i=>({...i,id:i.id+"-other"}))});
  f.doc.connections=f.doc.connections.slice(0,2);
  f.doc.connections[1]!.to={instanceId:"a",id:"other"};
  f.doc.workloads[1]!.to=f.doc.workloads[0]!.to;
  f.doc.scenarios[0]!.members=["a","b"];
  f.doc.sources.push({...f.doc.sources[0]!,id:"other"});
  f.doc.workloads[0]!.request.rate!.conflicts=[{value:200,confidence:"review",sources:["other"]}];
  const negotiate=p.negotiate;
  p.negotiate = link => {
    const claim=effectiveClaim(link.scene,"workload",0,p.id,"rate")!;
    const rate=link.scene.claims[claim]!.value;
    const active=link.connection===(rate===100 ? 0 : 1);
    return negotiate(link).map(o=>({...o,inputs:[...o.inputs,claim],limit:rate===null ? null : active ? 1200 : 0,
      verdict:rate===null ? "unknown" : active ? "ok" : "impossible"}));
  };
  const port={kind:"port" as const,id:"포트 하나",instanceId:"host",workloads:["a","b"]};
  const r=evaluate(load(f,[port,{...port,id:"포트 a",portId:"a"}],p),[p]);
  assert.deepEqual(r.goals.map(g=>g.verdict),["ok","unknown"]);
  assert.deepEqual(r.goalEvidence.filter(e=>e.goal===0).map(e=>e.connections.toSorted()),[[0,1],[0,1]]);
});

test("T10 새 영역이 단위와 지표를 선언하면 수치 목표와 근거에 쓰인다", () => {
  const f = fixture(), p = trialDomain();
  p.goalMeasures = [{kind:"balance", unit:"점", label:"잔여 점수"}];
  p.assess = (_s,_w,d,_steps,delivered) => ({...d,possible:["ok"],metrics:[{...delivered,kind:"balance",unit:"점"}]});
  const s=load(f,[metric("점수",["a"],100,"점","balance")],p), r=evaluate(s,[p]);
  assert.equal(r.goals[0]!.verdict,"ok");
  assert.ok(r.goalEvidence[0]!.reasons.length);
});

test("설정 탐색 상한으로 미확인이 된 목표도 작업 결과의 근거로 이어진다", () => {
  const p=trialDomain(), f=fixture(), negotiate=p.negotiate;
  p.negotiate = link => Array.from({length:257},(_,i)=>({...negotiate(link)[0]!,profile:"설정"+i}));
  f.doc.connections=f.doc.connections.slice(0,1);
  f.doc.scenarios[0]!.members=["a"];
  const r=evaluate(load(f,[metric("동시",["a"],0)],p),[p]);
  assert.equal(r.goals[0]!.truncated,true);
  assert.equal(r.goals[0]!.verdict,"unknown");
  assert.ok(r.goalEvidence[0]!.reasons.length);
});

test("T8 순충전 목표를 생략하면 방전 여부를 쓰고 명시적으로 미확인이면 목표 세계에 남긴다",()=>{
  const f=fixture("fixtures/power","single-port"),request=f.doc.workloads[0]!.request;
  const goals:Goal[]=[{kind:"workload",id:"작업",workload:"idle"},{kind:"port",id:"충전 연결",instanceId:"a",workloads:["idle"]}];
  const target=request.targetW!;
  target.value=null;
  const scene=load(f,goals,power), row=effectiveClaim(scene,"workload",0,power.id,"targetW")!;
  const pending=evaluate(scene,[power]);
  assert.deepEqual(pending.goals.map(g=>[g.verdict,g.truncated]),[["unknown",true],["unknown",true]]);
  assert.ok(pending.goalEvidence.every(e=>e.claims.includes(row)));
  request.loadW!.value=null;
  target.value=0;
  const loadOnly=evaluate(load(f,goals,power),[power]);
  assert.ok(loadOnly.goals.every(g=>g.verdict==="unknown" && g.truncated));
  assert.ok(evaluate(load(f,[],power),[power]).measures.some(m=>m.kind==="netCharge" && m.low===null && m.high===60));
  target.value=null;
  assert.ok(evaluate(load(f,goals,power),[power]).goals.every(g=>g.verdict==="unknown" && g.truncated));
  delete request.targetW;
  for (const [loadW,want] of [[60,"ok"],[61,"impossible"]] as const) {
    request.loadW!.value=loadW;
    const omitted=load(f,goals,power);
    assert.equal(effectiveClaim(omitted,"workload",0,power.id,"targetW"),undefined);
    const result=evaluate(omitted,[power]);
    assert.deepEqual(result.goals.map(g=>[g.verdict,g.truncated]),[[want,false],[want,false]]);
  }
});

test("목표 입력은 중복 ID·없는 멤버·포트·지표·단위를 필드 위치와 함께 거절한다", () => {
  const f=fixture(), p=trialDomain();
  const g=metric("기준",["a"],0);
  for (const [goals,field] of [
    [[g,g],"id"], [[metric("없는 작업",["none"],0)],"workloads"], [[metric("중복",["a","a"],0)],"workloads"],
    [[{id:"포트",kind:"port",instanceId:"host",portId:"none",workloads:["a"]}],"portId"],
    [[metric("없는 지표",["a"],0,"회/s","bogus")],"metric"], [[metric("다른 단위",["a"],0,"W")],"unit"],
  ] as [Goal[],string][]) assert.throws(()=>load(f,goals,p),new RegExp("goals.*"+field));
  f.doc.scenarios[0]!.members=["b"];
  assert.throws(()=>load(f,[g],p),/goals.*workloads/);
});

test("한 세계의 목표 표는 입력 장면과 기술 결과를 바꾸지 않고 다시 읽을 수 있다", () => {
  const f=fixture(), p=trialDomain(), scene=load(f,[metric("복사",["a"],100)],p);
  const result=evaluate(scene,[p]), before=structuredClone(result);
  const judged=judgeGoals(scene,result);
  assert.deepEqual(result,before);
  assert.deepEqual(judged,{goals:before.goals,goalEvidence:before.goalEvidence});
});

test("시나리오 전체 목표는 평가할 때 현재 멤버를 읽고 빈 목록은 미확인이다", () => {
  const f=fixture(), p=trialDomain(), s=load(f,[{id:"전체",kind:"scenario"}],p);
  assert.equal(evaluate(s,[p]).goals[0]!.verdict,"impossible");
  s.members=s.members.filter(m=>m.workload===0);
  assert.equal(evaluate(s,[p]).goals[0]!.verdict,"ok");
  s.members=[];
  assert.equal(evaluate(s,[p]).goals[0]!.verdict,"unknown");
});

test("미확인 상위 모드와 확인된 대체 모드가 다른 포트를 쓰면 각 포트 목표는 고정한 두 장면의 합이다", () => {
  const f=fixture(), p=trialDomain(), sink=f.models.get("sink@1")!, port=sink.ports[0]!;
  sink.ports.push({...port,id:"also",interfaces:port.interfaces.map(i=>({...i,id:"also-if"}))});
  f.doc.connections[1]!.to={instanceId:"a",id:"also"};
  f.doc.scenarios[0]!.members=["a"];
  const base=p.demand, offer=p.negotiate;
  p.demand=(s,w)=>[0,1].map(preference=>({...base(s,w)[0]!,mode:preference ? "fallback" : "preferred",preference}));
  let supported:boolean|null=null;
  p.negotiate=link=>offer(link).map(o=>({...o,mode:link.connection===1 ? "preferred" : "fallback",
    verdict:link.connection!==1 || supported===true ? "ok" : supported===false ? "impossible" : "unknown",
    limit:link.connection===1 && supported===null ? null : o.limit}));
  const anchor={id:"모든 포트",kind:"port" as const,instanceId:"host",workloads:["a"]};
  const s=load(f,[anchor,...["a","b","c"].map(portId=>({...anchor,id:portId,portId}))],p);
  const judge=()=>evaluate(s,[p]).goals.map(g=>g.verdict);
  supported=false; assert.deepEqual(judge(),["ok","ok","impossible","impossible"]);
  supported=true; assert.deepEqual(judge(),["ok","impossible","ok","impossible"]);
  supported=null; assert.deepEqual(judge(),["ok","unknown","unknown","impossible"]);
});

test("요청 모드가 사라진 세계의 전달량 0이 100과 합쳐져 150 목표는 미달이다",()=>{
  const f=fixture(), p=trialDomain(), base=p.demand;
  f.doc.scenarios[0]!.members=["a"];
  f.doc.sources.push({...f.doc.sources[0]!,id:"other"});
  f.doc.workloads[0]!.request.rate!.conflicts=[{value:0,confidence:"review",sources:["other"]}];
  p.demand=(s,w)=>base(s,w).filter(d=>d.requested!==0);
  const s=load(f,[metric("높은 목표",["a"],150),metric("중간",["a"],50)],p), r=evaluate(s,[p]);
  assert.deepEqual(r.goals.map(g=>g.verdict),["impossible","unknown"]);
  assert.deepEqual(r.metrics.filter(m=>m.kind==="together").map(m=>[m.unit,m.low,m.high]),[["회/s",0,100]]);
  const withoutGoals=evaluate({...s,goals:[]},[p]);
  assert.deepEqual(withoutGoals.metrics.filter(m=>m.kind==="together").map(m=>[m.unit,m.low,m.high]),[["회/s",0,100]]);
  f.doc.workloads[0]!.request.rate!.value=0;
  delete f.doc.workloads[0]!.request.rate!.conflicts;
  const fixed=evaluate(loadSceneDocuments(f.doc,f,[p]),[p]);
  assert.deepEqual(fixed.metrics.filter(m=>m.kind==="together").map(m=>[m.unit,m.value]),[["",0]]);
  assert.deepEqual(fixed.goals.map(g=>g.verdict),["impossible","impossible"]);
});

test("T5 같은 선호의 두 경로와 상위 모드의 포트·전달 목표는 지원 여부를 고정한 장면의 합과 같다",()=>{
  for (const separateMode of [false,true]) for (const incumbent of [80,100]) {
    const f=fixture(), p=trialDomain(), sink=f.models.get("sink@1")!, first=sink.ports[0]!;
    sink.ports.push({...first,id:"other",interfaces:first.interfaces.map(i=>({...i,id:"other-if"}))});
    f.doc.connections[1]!.to={instanceId:"a",id:"other"};
    f.doc.scenarios[0]!.members=["a"];
    const negotiate=p.negotiate, demand=p.demand;
    let limit:number|null=null;
    if (separateMode) p.demand=(s,w)=>[...demand(s,w),{...demand(s,w)[0]!,mode:"fallback",preference:1}];
    p.negotiate=link=>negotiate(link).map(o=>({...o,
      mode:separateMode && link.connection===0 ? "fallback" : o.mode,
      limit:link.connection===1 ? limit : incumbent,
      verdict:link.connection!==1 || limit!==null && limit>0 ? "ok" : limit===0 ? "impossible" : "unknown"}));
    const target={id:"포트",kind:"port" as const,workloads:["a"],instanceId:"host"};
    const s=load(f,[target,...["a","b","c"].map(portId=>({...target,id:portId,portId})),
      {id:"작업 성립",kind:"workload",workload:"a"},{id:"전체 성립",kind:"scenario"},
      ...[0,80,90,100,101].map(n=>metric(String(n),["a"],n)),
      {id:"단독 100",kind:"metric",workloads:["a"],metric:"delivery",minimum:100,unit:"회/s",run:"solo"}],p);
    const judge=()=>evaluate(s,[p]).goals.map(g=>g.verdict);
    const concrete=[0,1,79,80,99,100].map(value=>{limit=value;return judge();});
    const oracle=concrete[0]!.map((v,i)=>concrete.every(g=>g[i]===v) ? v : "unknown");
    limit=null;
    assert.deepEqual(judge(),oracle,`상위 모드 ${separateMode}, 확인된 전달량 ${incumbent}`);
    const bounded=[60,80,90].map(value=>{limit=value;return judge();});
    const offer=p.negotiate;
    p.negotiate=link=>offer(link).map(o=>link.connection===1 ? {...o,verdict:"ok",limit:null,bounds:{low:60,high:90}} : o);
    assert.deepEqual(judge(),bounded[0]!.map((v,i)=>bounded.every(g=>g[i]===v) ? v : "unknown"),"판정이 같은 경로의 한도만 변하는 경우");
  }
});

test("T5 공유 자원에 100을 예약하면 미확인 우회의 포트와 동시 목표는 두 고정 장면의 합이다",()=>{
  for (const axis of ["경로","모드","출처","요청 지원"] as const) {
    const f=fixture(), p=trialDomain(), host=f.models.get("source@1")!, sink=f.models.get("sink@1")!;
    host.resources[0]!.capacity.value=150;
    host.ports[1]!.attachment.value="root";
    const port=sink.ports[0]!;
    sink.ports.push({...port,id:"other",interfaces:port.interfaces.map(i=>({...i,id:"other-if"}))});
    f.doc.connections[1]!.to={instanceId:"a",id:"other"};
    f.doc.workloads[2]!.request.rate!.value=100;
    f.doc.scenarios[0]!.members=["a",{workload:"c",priority:{...f.doc.connections[0]!.evidence,value:1}}];
    const support=supportClaims(host,p,["bypass"]).bypass!;
    const negotiate=p.negotiate, demand=p.demand;
    p.negotiate=link=>negotiate(link).map(o=>{
      if (link.connection!==1) return {...o,limit:100};
      const row=effectiveClaim(link.scene,"item",0,p.id,"bypass")!, value=link.scene.claims[row]!.value;
      return {...o,mode:axis==="모드" ? "bypass" : o.mode,limit:80,inputs:axis==="요청 지원" ? o.inputs : [...o.inputs,row],
        verdict:axis==="요청 지원" || value===true ? "ok" : value===false ? "impossible" : "unknown"};
    });
    if (axis==="요청 지원") p.match=(link,option)=>{
      const row=effectiveClaim(link.scene,"item",0,p.id,"bypass")!, value=link.scene.claims[row]!.value;
      return {rule:"우회 요청 지원 여부",inputs:[...option.inputs,row],specs:[],
        verdict:link.connection!==1 || value===true ? "ok" : value===false ? "impossible" : "unknown"};
    };
    p.demand=(s,w)=>demand(s,w).flatMap(d=>s.workloads[w]!.id==="c" ? [{...d,elastic:false}]
      : axis==="모드" ? [{...d,preference:1},{...d,mode:"bypass"}] : [d]);
    const anchor={kind:"port" as const,instanceId:"host",workloads:["a"]};
    const goals:Goal[]=[...["a","b"].map(portId=>({...anchor,id:portId,portId})),
      ...[50,70,81].map(n=>metric("동시 "+n,["a"],n)),metric("예약",["c"],100)];
    const judge=()=>evaluate(load(f,goals,p),[p]);
    const fixed=[false,true].map(value=>{support.value=value;return judge();});
    assert.deepEqual(fixed.map(r=>r.metrics.filter(m=>m.kind==="together").map(m=>m.value)),[[50,100],[80,100]],axis);
    if (axis==="출처") {
      host.sources.push({...host.sources[0]!,id:"other"});
      support.conflicts=[{value:false,confidence:"review",sources:["other"]}];
    } else support.value=null;
    const merged=judge();
    assert.deepEqual(merged.goals.map(g=>g.verdict),fixed[0]!.goals.map((g,i)=>
      fixed[1]!.goals[i]!.verdict===g.verdict ? g.verdict : "unknown"),axis);
    assert.deepEqual(merged.metrics.filter(m=>m.kind==="together").map(m=>[m.low,m.high]),[[50,80],[100,100]],axis);
    assert.ok(merged.goalEvidence.every(e=>e.reasons.length && e.claims.length));
    assert.ok(merged.quests.some(q=>q.claim>=0 && q.instruction.length));
    const rate=merged.metrics.find(m=>m.kind==="together" && m.low===50)!;
    assert.ok(merged.profileWorlds.some(v=>v.world===rate.lowWorld && v.value===false));
    assert.ok(merged.profileWorlds.some(v=>v.world===rate.highWorld && v.value===true));
  }
});

test("T5 예약 작업의 유일한 경로만 미확인이어도 이웃이 고른 포트는 예약 유무 두 장면의 합이다",()=>{
  const f=fixture(), p=trialDomain(), host=f.models.get("source@1")!, sink=f.models.get("sink@1")!;
  host.resources[0]!.capacity.value=150;
  host.ports[1]!.attachment.value="root";
  const port=sink.ports[0]!;
  sink.ports.push({...port,id:"other",interfaces:port.interfaces.map(i=>({...i,id:"other-if"}))});
  f.doc.connections[1]!.to={instanceId:"a",id:"other"};
  f.doc.workloads[2]!.request.rate!.value=100;
  f.doc.scenarios[0]!.members=["a","c"];
  const negotiate=p.negotiate, demand=p.demand;
  const support=supportClaims(host,p,["reservation"]).reservation!;
  p.negotiate=link=>negotiate(link).map(o=>{
    const row=effectiveClaim(link.scene,"item",0,p.id,"reservation")!, value=link.scene.claims[row]!.value;
    return {...o,limit:link.connection===1 ? 80 : 100,inputs:link.connection===2 ? [...o.inputs,row] : o.inputs,
      verdict:link.connection!==2 || value===true ? "ok" : value===false ? "impossible" : "unknown"};
  });
  p.demand=(s,w)=>demand(s,w).map(d=>({...d,elastic:s.workloads[w]!.id!=="c"}));
  const anchor={kind:"port" as const,instanceId:"host",workloads:["a"]};
  const judge=()=>evaluate(load(f,[...["a","b"].map(portId=>({...anchor,id:portId,portId})),metric("보장",["a"],80),metric("최대",["a"],100)],p),[p]).goals.map(g=>g.verdict);
  support.value=false; assert.deepEqual(judge(),["ok","impossible","ok","ok"]);
  support.value=true; assert.deepEqual(judge(),["impossible","ok","ok","impossible"]);
  support.value=null; assert.deepEqual(judge(),["unknown","unknown","ok","unknown"]);
});

test("T5 지원 여부가 독립인 우회 8개의 후보 세계가 상한을 넘으면 기본 포트와 목표를 확정하지 않는다",()=>{
  const f=fixture(), p=trialDomain(), host=f.models.get("source@1")!, sink=f.models.get("sink@1")!;
  f.doc.connections.length=1;
  const base=f.doc.connections[0]!;
  for (let i=0;i<8;i++) {
    for (const model of [host,sink]) {
      const first=model.ports[0]!;
      model.ports.push({...first,id:"extra-"+i,interfaces:first.interfaces.map(v=>({...v,id:"interface-"+i}))});
    }
    f.doc.connections.push({...base,id:"extra-"+i,from:{...base.from,id:"extra-"+i},to:{...base.to,id:"extra-"+i}});
  }
  f.doc.scenarios[0]!.members=["a"];
  const negotiate=p.negotiate;
  supportClaims(host,p,f.doc.connections.slice(1).map(c=>c.id));
  p.negotiate=link=>negotiate(link).map(o=>{
    if (!link.connection) return o;
    const row=effectiveClaim(link.scene,"item",0,p.id,link.scene.connections[link.connection]!.id)!, value=link.scene.claims[row]!.value;
    return {...o,verdict:value===true ? "ok" : value===false ? "impossible" : "unknown",limit:80,inputs:[...o.inputs,row]};
  });
  const result=evaluate(load(f,[{kind:"port",id:"기존",instanceId:"host",portId:"a",workloads:["a"]},metric("하한",["a"],0)],p),[p]);
  assert.ok(result.goals.every(g=>g.truncated && g.verdict==="unknown"));
  assert.ok(result.goalEvidence.every(e=>e.low===null && e.high===null && e.claims.length));
  assert.ok(result.reasons.some(r=>r.rule.includes("상한")));
  host.ports[0]!.connector={...host.ports[0]!.connector,value:"trial-socket"};
  const broken=load(f,[metric("하한",["a"],0)],p), capped=evaluate(broken,[p]);
  assert.ok(capped.goals[0]!.truncated);
  assert.ok(capped.needs.some(n=>capped.outcomes[n.outcome]!.subjectRow===0 && n.requiredCapability==="trial-plug"));
  const blocked=capped.outcomes.flatMap((o,i)=>o.subjectKind==="connection" && o.subjectRow===0 ? [i] : []);
  assert.ok(blocked.length);
  for (const i of blocked) {
    assert.deepEqual([capped.outcomes[i]!.verdict,capped.outcomes[i]!.option],["impossible",undefined]);
    assert.deepEqual(capped.metrics.filter(m=>m.outcome===i && m.kind==="limit").map(m=>m.value),[0]);
  }
});

function parallelCharging() {
  const f=fixture("fixtures/power","single-port"), host=f.models.get("supply@1")!, sink=f.models.get("receiver@1")!;
  const extra=structuredClone(sink.ports[0]!);
  extra.id="in-alt"; extra.interfaces[0]!.id="in-alt-power"; sink.ports.push(extra);
  f.doc.items.push({...f.doc.items[2]!,instanceId:"wire-b"});
  const link=f.doc.connections[0]!;
  f.doc.connections.push({...structuredClone(link),id:"b",from:{...link.from,id:"b"},to:{...link.to,id:extra.id},
    parts:[{...link.parts[0]!,instanceId:"wire-b"}]});
  const small=f.doc.workloads[0]!, large=structuredClone(small);
  for (const [w,watts] of [[small,20],[large,30]] as const) {
    w.id=watts===20 ? "small" : "large"; w.request.requestedW!.value=watts; w.request.loadW!.value=0; w.request.targetW!.value=watts;
  }
  f.doc.workloads.push(large);
  const jobs=[small.id,large.id], current=host.ports[0]!.interfaces[0]!.params.pdo20!;
  for (const port of ["a","b"]) host.attributes!.power!["budget:a+b:"+port]={value:60,unit:"W",confidence:"inferred",sources:["table"]};
  return {f,host,small,large,link,jobs,current};
}

test("T8 소비 전력이 동시 계획 순위를 바꾸면 큰 작업의 포트와 작은 작업의 최저 전달량을 확정하지 않는다",()=>{
  const {f,host,small,large,current,jobs}=parallelCharging();
  current.value=.5;
  large.request.requestedW!.value=large.request.targetW!.value=40;
  host.resources[0]!.capacity.value=40;
  host.attributes!.power!["budget:a+b:b"]!.value=35;
  f.doc.scenarios[0]!.members=jobs;
  const goals:Goal[]=[{id:"큰 작업 포트",kind:"port",portId:"b",instanceId:"supply",workloads:[large.id]},
    metric("작은 작업 20 W",[small.id],20,"W")];
  const loadW=small.request.loadW!;
  function judge(value:number|null) {
    loadW.value=value;
    return evaluate(load(f,goals,power),[power]);
  }
  const fixed=[0,19,20,40].map(n=>judge(n).goals.map(g=>g.verdict));
  assert.deepEqual(fixed[0],["impossible","ok"]);
  assert.deepEqual(fixed.at(-1),["ok","impossible"]);
  const merged=judge(null);
  assert.deepEqual(merged.goals.map(g=>g.verdict),fixed[0]!.map((v,i)=>fixed.every(row=>row[i]===v) ? v : "unknown"));
  assert.ok(merged.goals.every(g=>g.truncated));
  loadW.conflicts=[{value:40,sources:loadW.sources,confidence:"review"}];
  const discrete=judge(0);
  assert.deepEqual(new Set(discrete.profileWorlds.map(w=>w.value)),new Set([0,40]));
  assert.ok(discrete.goals.every(g=>g.verdict==="unknown" && !g.truncated));

  delete loadW.conflicts;
  f.doc.connections.length=1;
  const single=judge(null);
  assert.ok(single.goals.every(g=>g.verdict==="unknown" && g.truncated));
  const input=effectiveClaim(load(f,goals,power),"workload",f.doc.workloads.indexOf(small),power.id,"loadW");
  assert.ok(single.quests.some(q=>q.claim===input));
});

test("T10 설정마다 계획이 하나여도 탈락한 설정의 점수 입력을 고정한 장면들과 대조한다",()=>{
  const f=fixture(), p=trialDomain();
  const host=f.models.get("source@1")!, flags=supportClaims(host,p,["enabled"]);
  f.doc.connections.length=1;
  f.doc.scenarios[0]!.members=["a"];
  f.doc.workloads[0]!.request.rate!.value=100;
  const offer=p.negotiate;
  p.negotiate=link=>[60,80].map(limit=>({...offer(link)[0]!,profile:String(limit),limit}));
  p.assess=(scene,_w,d,_steps,delivered)=>{
    if (delivered.low!==60) return {...d,possible:["conditional"],metrics:[]};
    const claim=effectiveClaim(scene,"item",0,p.id,"enabled")!;
    const enabled=scene.claims[claim]!.value;
    return {...d,inputs:[claim],possible:enabled===null ? ["ok","impossible"] : [enabled ? "ok" : "impossible"],metrics:[]};
  };
  function judge(value:boolean|null) {
    flags.enabled!.value=value;
    return evaluate(load(f,[metric("최저",["a"],70)],p),[p]);
  }
  assert.equal(judge(false).goals[0]!.verdict,"ok");
  assert.equal(judge(true).goals[0]!.verdict,"impossible");
  const unknown=judge(null);
  assert.deepEqual(new Set(unknown.profileWorlds.map(w=>w.value)),new Set([true,false]));
  assert.equal(unknown.goals[0]!.verdict,"unknown");
});

test("T8 규격 걸음은 PDO 전류에 적용하고 일반 전력과 자원 용량은 저장 정밀도를 보존한다",()=>{
  const f=fixture("fixtures/power","single-port"),host=f.models.get("supply@1")!;
  const capacity=65.1234567;
  host.resources[0]!.capacity.value=capacity;
  f.doc.workloads[0]!.request.loadW!.value=capacity;
  const pdo=host.ports[0]!.interfaces[0]!.params.pdo20!;
  pdo.value=.51;
  const s=load(f,[],power);
  for (const owner of ["workload","resource"] as const) assert.ok(s.claims.some(c=>c.ownerKind===owner && c.value===capacity));
  pdo.value=.505;
  assert.throws(()=>load(f,[],power),/ports\.0\.interfaces\.0\.params\.pdo20\.value.*USB PD.*0\.50.*0\.51/);
  pdo.value=.51;
  host.ports[0]!.interfaces[0]!.params.pdo5={...pdo,value:3.005};
  assert.throws(()=>load(f,[],power),/pdo5\.value.*USB PD.*3\.00 A입니다/);
});

test("T8 PD 전류 격자에서 작업마다 다른 문턱과 우선순위에 따른 자리 이동을 미확인 세계와 대조한다",()=>{
  const {f,host,small,large,link,jobs,current}=parallelCharging();
  const goals:Goal[]=[{id:"같은 포트",kind:"port",instanceId:"supply",workloads:jobs},
    ...["a","b"].map(portId=>({id:portId,kind:"port" as const,instanceId:"supply",portId,workloads:jobs}))];
  const judge=(amps:number|null)=>{current.value=amps;return evaluate(load(f,goals,power),[power]);};
  for (const priority of [false,true]) {
    f.doc.scenarios[0]!.members=priority ? [small.id,{workload:large.id,priority:{...link.evidence,value:1}}] : jobs;
    const grid=Array.from({length:41},(_,i)=>judge(Math.round(i*12.5)/100)), merged=judge(null);
    assert.deepEqual([0,10,40].map(i=>grid[i]!.goals[0]!.verdict),["ok","impossible","ok"]);
    const ports=(r:typeof merged)=>r.outcomes.filter(o=>o.subjectKind==="workload").map(o=>
      r.steps.find(s=>s.path===o.path && s.kind==="connection")!.row);
    assert.deepEqual([0,10,13,40].map(i=>ports(grid[i]!)),[[1,1],[1,0],[0,1],[0,0]]);
    assert.deepEqual(merged.goals.map(g=>g.verdict),goals.map((_,i)=>{
      const first=grid[0]!.goals[i]!.verdict; return grid.every(r=>r.goals[i]!.verdict===first) ? first : "unknown";
    }));
    for (const m of merged.metrics.filter(m=>m.kind==="together")) {
      const values=grid.map(r=>r.metrics.find(v=>v.outcome===m.outcome && v.kind===m.kind)!.value!);
      assert.equal(merged.outcomes[m.outcome]!.conservative?.cause,"limit");
      assert.ok(m.low!<=Math.min(...values) && (m.high===null || m.high>=Math.max(...values)));
    }
    assert.ok(merged.goalEvidence.filter(e=>e.goal===0).every(e=>e.connections.length===2 && e.reasons.length));
  }
  f.doc.scenarios[0]!.members=jobs;
  large.request.requestedW!.value=large.request.targetW!.value=40;
  host.resources[0]!.capacity.value=55;
  host.attributes!.power!["budget:a+b:b"]!.value=40;
  goals.push(metric("작은 작업에 10.1 W", [small.id], 10.1, "W"));
  const fixed=Array.from({length:501},(_,i)=>{
    const r=judge(i/100);
    const e=r.goalEvidence.find(e=>e.goal===goals.length-1)!;
    return {verdict:r.goals.at(-1)!.verdict, value:e.low!};
  });
  const merged=judge(null), e=merged.goalEvidence.find(e=>e.goal===goals.length-1)!;
  assert.equal(fixed[50]!.value,10);
  assert.deepEqual(new Set(fixed.map(f=>f.verdict)),new Set(["ok","impossible"]));
  assert.equal(merged.goals.at(-1)!.verdict,"unknown");
  assert.deepEqual([e.low,e.high],[Math.min(...fixed.map(f=>f.value)),Math.max(...fixed.map(f=>f.value))]);
  assert.throws(()=>judge(.505),/pdo20/);
});

test("T5 두 원시 한도의 걸음 격자에서 다른 한도가 옮긴 선택 문턱과 전달량을 대조한다",()=>{
  const f=fixture(),p=trialDomain(),host=f.models.get("source@1")!,sink=f.models.get("sink@1")!;
  const second=structuredClone(sink.ports[0]!);second.id="also";second.interfaces[0]!.id="also-if";sink.ports.push(second);
  f.doc.connections.length=2;f.doc.connections[1]!.to={instanceId:"a",id:second.id};f.doc.scenarios[0]!.members=["a"];
  const fact={value:null as number|null,confidence:"inferred" as const,sources:[host.sources[0]!.id]};
  const left={...fact},right={...fact};host.attributes={trial:{left,right}};
  const quantity=z.strictObject({value:z.number().min(0).max(1).multipleOf(.25).nullable(),unit:z.literal("")});
  p.attributes=z.strictObject({left:quantity,right:quantity});
  const negotiate=p.negotiate;
  p.negotiate=link=>negotiate(link).map(o=>{
    const field=link.connection===0 ? "left" : "right", claim=effectiveClaim(link.scene,"item",0,p.id,field)!;
    const n=link.scene.claims[claim]!.value;
    return {...o,inputs:[...o.inputs,claim],limit:typeof n==="number" ? (field==="left" ? 40 : 45)+n*50 : null};
  });
  const goals:Goal[]=[...["a","b"].map(portId=>({kind:"port" as const,id:portId,instanceId:"host",portId,workloads:["a"]})),metric("최저",["a"],45),metric("최대",["a"],95)];
  const judge=()=>evaluate(load(f,goals,p),[p]);
  const grid=[0,.25,.5,.75,1].flatMap(a=>[0,.25,.5,.75,1].map(b=>{left.value=a;right.value=b;return judge();}));
  left.value=right.value=null;
  const merged=judge();
  assert.deepEqual(merged.goals.map(g=>g.verdict),grid[0]!.goals.map((g,i)=>grid.every(r=>r.goals[i]!.verdict===g.verdict) ? g.verdict : "unknown"));
  const values=grid.map(r=>r.metrics.find(m=>m.kind==="together")!.value!);
  const m=merged.metrics.find(m=>m.kind==="together")!;
  assert.deepEqual([m.low,m.high],[Math.min(...values),Math.max(...values)]);
  const worlds=Map.groupBy(merged.profileWorlds,s=>s.world);
  assert.ok([...worlds.values()].some(rows=>rows.length===2 && rows.every(s=>typeof s.value==="number" && s.value>0 && s.value<1)));
  assert.ok(merged.profileWorlds.every(s=>typeof s.value==="number" && Number.isInteger(s.value*4)));
  const fine=z.strictObject({value:z.number().min(0).max(1).multipleOf(.01).nullable(),unit:z.literal("")});
  const open=z.strictObject({value:z.number().nonnegative().nullable(),unit:z.literal("")});
  for (const [first,second] of [[fine,fine],[open,quantity]] as const) {
    p.attributes=z.strictObject({left:first,right:second});
    const over=judge();
    if (first!==open) assert.equal(over.profileWorlds.length,0);
    assert.ok(over.goals.every(g=>g.truncated && g.verdict==="unknown"));
    if (first===open) {
      assert.ok(over.goals.every(g=>!g.limitClaims && g.openClaims?.length===1));
      assert.ok(over.reasons.some(r=>r.rule.includes("가능한 값을 모두 열거할 수 없음")));
    } else {
      assert.ok(over.goals.every(g=>g.limitClaims && !g.openClaims?.length));
      assert.ok(over.reasons.some(r=>r.rule.includes("조합 상한")));
    }
  }
});

test("T5 경계가 알려진 한도의 양 끝과 안쪽 문턱에서 고른 서비스·포트·수치 목표를 대조한다",()=>{
  for (const rawBounds of [true,false]) {
    const f=fixture(),p=trialDomain(),host=f.models.get("source@1")!,sink=f.models.get("sink@1")!;
    f.doc.scenarios[0]!.members=["a"];
    const other=sink.ports[0]!;
    sink.ports.push({...other,id:"also",interfaces:other.interfaces.map(i=>({...i,id:"also-if"}))});
    f.doc.connections[1]!.to={instanceId:"a",id:"also"};
    const source=host.sources[0]!.id;
    const boost={value:null as boolean|null,confidence:"inferred" as const,sources:[source]};
    const limit={value:null as number|null,unit:"원시 단위",confidence:"inferred" as const,sources:[source]};
    host.attributes={trial:{boost,limit}};
    p.attributes=z.strictObject({boost:z.strictObject({value:z.boolean().nullable(),unit:z.literal("")}),
      limit:z.strictObject({value:(rawBounds ? z.number().min(7).max(10).multipleOf(.1) : z.number()).nullable(),unit:z.literal("원시 단위")})});
    const offer=p.negotiate;
    p.negotiate=link=>{
      const o=offer(link)[0]!;
      if (link.connection!==0) return [{...o,limit:90}];
      const flag=effectiveClaim(link.scene,"item",0,p.id,"boost")!,on=link.scene.claims[flag]!.value;
      const inputs=[...o.inputs,flag];
      let rate:number|null=null;
      if (on===true) {
        const n=effectiveClaim(link.scene,"item",0,p.id,"limit")!,v=link.scene.claims[n]!.value;
        inputs.push(n);if (typeof v==="number") rate=10*v;
      }
      return [{...o,limit:80},{...o,rule:"가변 서비스",inputs,limit:rate,
        verdict:on===false ? "impossible" : rate===null ? "unknown" : "ok",
        ...(on===true && rate===null ? {bounds:{low:70,high:100}} : {})}];
    };
    const anchor={kind:"port" as const,instanceId:"host",workloads:["a"]};
    const goals:Goal[]=[...["a","b"].map(portId=>({...anchor,id:portId,portId})),
      ...[90,100,101].map(n=>metric("동시 "+n,["a"],n))];
    const judge=()=>evaluate(load(f,goals,p),[p]);
    boost.value=true;
    const samples=Array.from({length:31},(_,i)=>{limit.value=7+i/10;return judge();});
    const combine=(results:typeof samples)=>samples[0]!.goals.map((g,i)=>results.every(r=>r.goals[i]!.verdict===g.verdict) ? g.verdict : "unknown");
    const oracle=combine(samples);
    assert.deepEqual(oracle,["unknown","unknown","ok","unknown","impossible"]);
    assert.deepEqual(oracle,combine([samples[0]!,samples.at(-1)!]));
    limit.value=null;
    for (const on of [true,null]) {
      boost.value=on;
      const scene=load(f,goals,p), merged=evaluate(scene,[p]);
      assert.deepEqual(merged.goals.map(g=>g.verdict),rawBounds ? oracle : goals.map(()=>"unknown"),"원시 경계 "+rawBounds+" 지원 "+on);
      const work=merged.outcomes.find(o=>o.subjectKind==="workload")!;
      assert.equal(work.conservative?.cause,rawBounds ? undefined : "open");
      const claim=effectiveClaim(scene,"item",0,p.id,"limit")!;
      assert.ok(merged.quests.some(q=>q.claim===claim));
      assert.ok(merged.goalEvidence.some(e=>e.claims.includes(claim) && e.reasons.length));
      if (rawBounds) {
        const delivery=merged.goalEvidence.find(e=>goals[e.goal]?.id==="동시 90")!;
        assert.deepEqual([delivery.low,delivery.high],[90,100]);
      }
    }
  }
});

test("T5 확인된 서비스 뒤에 숨은 미확인 서비스도 실제로 읽은 불리언·열거값의 고정 장면과 같다",()=>{
  const f=fixture(), p=trialDomain(), sink=f.models.get("sink@1")!, host=f.models.get("source@1")!;
  f.doc.scenarios[0]!.members=["a"];
  const socket=sink.ports[0]!;
  sink.ports.push({...socket,id:"also",interfaces:socket.interfaces.map(i=>({...i,id:"also-if"}))});
  f.doc.connections[1]!.to={instanceId:"a",id:"also"};
  const flag=(value:z.ZodType)=>z.strictObject({value:value.nullable(),unit:z.literal("")});
  const unused=Array.from({length:10},(_,i)=>"unused-"+i);
  p.attributes=z.union([z.strictObject({other:flag(z.number())}),
    z.strictObject({boost:flag(z.boolean()),setting:flag(z.enum(["slow","fast"])),
      ...Object.fromEntries(unused.map(name=>[name,flag(z.boolean())]))})]);
  const source=host.sources[0]!.id;
  const boost={value:null as boolean|null,confidence:"inferred" as const,sources:[source]};
  const setting={value:null as string|null,confidence:"inferred" as const,sources:[source]};
  host.attributes={trial:{boost,setting,...Object.fromEntries(unused.map(name=>[name,{...boost}]))}};
  const offer=p.negotiate;
  p.negotiate=link=>{
    const o=offer(link)[0]!;
    if (link.connection!==0) return [{...o,limit:90}];
    const claim=effectiveClaim(link.scene,"item",0,p.id,"boost")!;
    const inputs=[...o.inputs,claim], enabled=link.scene.claims[claim]!.value;
    let rate:number|null=enabled===false ? 0 : null;
    if (enabled===true) {
      const row=effectiveClaim(link.scene,"item",0,p.id,"setting")!;
      inputs.push(row);
      const v=link.scene.claims[row]!.value;
      rate=v===null ? null : v==="fast" ? 100 : 70;
    }
    return [{...o,limit:80},{...o,rule:"추가 서비스",inputs,limit:rate,
      verdict:rate===null ? "unknown" : rate===0 ? "impossible" : "ok"}];
  };
  const anchor={kind:"port" as const,instanceId:"host",workloads:["a"]};
  const goals:Goal[]=[...["a","b"].map(portId=>({...anchor,id:portId,portId})),
    ...[90,100,101].map(n=>metric("동시 "+n,["a"],n))];
  const judge=()=>evaluate(load(f,goals,p),[p]);
  const fixed=[false,true].flatMap(on=>["slow","fast"].map(v=>{boost.value=on;setting.value=v;return judge();}));
  assert.deepEqual(fixed.map(r=>r.metrics.find(m=>m.kind==="together")!.value),[90,90,90,100]);
  boost.value=null;setting.value=null;
  const merged=judge();
  assert.deepEqual(merged.goals.map(g=>g.verdict),fixed[0]!.goals.map((g,i)=>
    fixed.every(r=>r.goals[i]!.verdict===g.verdict) ? g.verdict : "unknown"));
  assert.deepEqual(merged.metrics.filter(m=>m.kind==="together").map(m=>[m.low,m.high]),[[90,100]]);
  assert.ok(new Set(merged.profileWorlds.map(v=>v.claim)).size===2);
  assert.ok(merged.goals.every(g=>!g.truncated));
  const negotiate=p.negotiate;
  p.negotiate=link=>{
    const rows=negotiate(link);
    if (link.connection===0 && rows[1]?.limit===100) for (const name of unused)
      rows[1].inputs.push(effectiveClaim(link.scene,"item",0,p.id,name)!);
    return rows;
  };
  const capped=judge();
  assert.ok(capped.goals.every(g=>g.truncated && g.verdict==="unknown"));
  assert.ok(capped.reasons.some(r=>r.rule.includes("모든 후보를 확인하지 못함")));
});

test("T8 연결 중간 케이블의 한 포트 목표는 경로가 사용한 두 포트를 근거로 보여 준다",()=>{
  const f=fixture("fixtures/power","single-port");
  const s=load(f,[{kind:"port",id:"케이블",instanceId:"wire-a",workloads:["idle"]}],power);
  const r=evaluate(s,[power]), e=r.goalEvidence[0]!;
  assert.equal(e.verdict,"impossible");
  assert.deepEqual(e.connections,[0]);
  assert.deepEqual(e.portVisits?.map(v=>s.ports[v.port]!.id),["first","second"]);
});

test("내장 전달량 이름을 가로채거나 다른 영역의 동명 지표를 하나로 묶을 수 없다",()=>{
  const f=fixture(), p=trialDomain(), q=trialDomain("another");
  p.goalMeasures=[{kind:"delivery",unit:"회/s",label:"폐기율"}];
  assert.throws(()=>load(f,[metric("충돌",["a"],10)],p),/delivery/);
  p.goalMeasures=q.goalMeasures=[{kind:"score",unit:"점",label:"각 영역의 점수"}];
  f.doc.workloads[1]!.domain=q.id;
  const g=metric("점수",["a","b"],10,"점","score");
  f.doc.scenarios[0]!.goals=[g];
  assert.throws(()=>loadSceneDocuments(f.doc,f,[p,q]),/영역/);
  f.doc.scenarios[0]!.goals=[{...metric("다른 영역",["a"],10,"점","score"),metricDomain:q.id} as Goal];
  assert.throws(()=>loadSceneDocuments(f.doc,f,[p,q]),/영역/);
});

test("빠진 멤버에 대한 목표는 어느 작업이 시나리오에서 빠졌는지 알려 준다",()=>{
  const p=trialDomain(), s=load(fixture(),[metric("복사",["a","b"],1000)],p);
  s.members=s.members.filter(m=>m.workload!==1);
  const r=evaluate(s,[p]);
  assert.equal(r.goals[0]!.verdict,"unknown");
  assert.ok(r.goalEvidence.some(e=>e.workload===1 && e.issue==="notMember"));
});
