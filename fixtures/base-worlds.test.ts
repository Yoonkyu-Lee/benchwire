// 목표가 없는 제품 장면의 판정과 전달량을 같은 장면의 고정 세계와 대조한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadScene } from "../cli/load.ts";
import { data } from "../domains/data/data.ts";
import { network } from "../domains/network/network.ts";
import { effectiveClaim, type DomainPlugin, type Scene } from "../engine/contract.ts";
import { evaluate } from "../engine/evaluate.ts";

function load(plugin: DomainPlugin) {
  const dir = "fixtures/" + plugin.id;
  return loadScene(dir + "/scene.json", {modelsDir:dir, connectorsFile:dir+"/connectors.json"}, [plugin]);
}
function observed(scene: Scene, plugin: DomainPlugin, workload: number, scenario: number) {
  const result = evaluate(scene,[plugin]);
  const row = result.outcomes.findIndex(o=>o.subjectKind==="workload" && o.subjectRow===workload && o.scenario===scenario);
  assert.ok(row>=0);
  const metric=result.metrics.find(m=>m.outcome===row && m.kind==="together")!;
  return {verdicts:result.possibleVerdicts.filter(v=>v.outcome===row).map(v=>v.verdict).sort(), low:metric.low, high:metric.high};
}
test("T2 목표 없는 USB4 벌크와 PCIe 동시 전달량은 두 케이블 지원 세계의 합이다",()=>{
  const scene=load(data);
  const cable=scene.claims.find(c=>c.field==="cableUsb4")!;
  scene.claims.find(c=>c.field==="cableDataGbps")!.value=40;
  for(const c of scene.claims) if(c.field==="tunnelGbps") c.value=1;
  const request=scene.claims.findIndex(c=>c.field==="throughput");
  scene.claims[request]!.value=2500;
  const workload=scene.workloads.push({...scene.workloads[0]!,id:"pcie",kind:"pcie-tunnel"})-1;
  const claim=scene.claims.push({...scene.claims[request]!,owner:workload,value:100})-1;
  scene.claimSources.push({...scene.claimSources.find(s=>s.claim===request)!,claim});
  scene.members.push({scenario:0,workload});
  for(const w of [0,workload]){
    const fixed=[false,true].map(value=>{cable.value=value; return observed(scene,data,w,0);});
    const expected={verdicts:[...new Set(fixed.flatMap(f=>f.verdicts))].sort(),
      low:Math.min(...fixed.map(f=>f.low!)),high:Math.max(...fixed.map(f=>f.high!))};
    if(w===workload) assert.equal(expected.high,62.5);
    else assert.deepEqual(expected.verdicts,["conditional"]);
    cable.value=null;
    scene.goals=[];
    assert.deepEqual(observed(scene,data,w,0),expected);
    scene.goals=[{id:"전달",kind:"workload",workload:w,scenario:0}];
    assert.deepEqual(observed(scene,data,w,0),expected);
  }
});
test("T7 목표 없는 Cat5e의 채널 길이 문턱 양쪽은 900 Mbps와 0 Mbps다",()=>{
  const scene=load(network);
  const item=scene.items.findIndex(i=>i.id==="lan-a-wire");
  const length=scene.claims[effectiveClaim(scene,"item",item,"network","length")!]!;
  const scenario=scene.scenarios.findIndex(s=>s.id==="first-hop"), work=scene.members.find(m=>m.scenario===scenario)!.workload;
  for (const [value,expected] of [[100,900],[101,0]] as const) {
    length.value=value;
    assert.equal(observed(scene,network,work,scenario).high,expected);
  }
  length.value=null;
  assert.deepEqual(observed(scene,network,work,scenario),{verdicts:["impossible","ok"],low:0,high:900});
});


test("T7 채널 총길이의 문턱에는 모든 패치 코드가 들어가고 열린 길이가 둘이면 해당 연결에만 보수 표시한다",()=>{
  const scene=load(network);
  const first=scene.parts.find(p=>scene.items[p.item]!.id==="lan-a-wire")!;
  const other=scene.parts.find(p=>scene.items[p.item]!.id==="lan-b-wire")!;
  other.connection=first.connection;
  other.order=first.order+1;
  const length=(item:number)=>effectiveClaim(scene,"item",item,"network","length")!;
  const a=length(first.item), b=length(other.item);
  const scenario=scene.scenarios.findIndex(s=>s.id==="first-hop");
  const w=scene.members.find(m=>m.scenario===scenario)!.workload;
  scene.goals=[];
  for (const known of [40,100,100+1e-12,101]) {
    scene.claims[b]!.value=known;
    const fixed=[0,Math.max(0,100-known),101].map(v=>{
      scene.claims[a]!.value=v;
      return observed(scene,network,w,scenario);
    });
    scene.claims[a]!.value=null;
    assert.deepEqual(observed(scene,network,w,scenario),{
      verdicts:[...new Set(fixed.flatMap(f=>f.verdicts))].sort(),
      low:Math.min(...fixed.map(f=>f.low!)),high:Math.max(...fixed.map(f=>f.high!)),
    });
  }
  scene.claims[b]!.value=null;
  const result=evaluate(scene,[network]);
  const job=result.outcomes.findIndex(o=>o.subjectKind==="workload" && o.scenario===scenario && o.subjectRow===w);
  assert.deepEqual(new Set(result.outcomes[job]!.conservative?.claims),new Set([a,b]));
  assert.ok([a,b].every(claim=>result.quests.some(q=>q.outcome===job && q.claim===claim)));
  const independent=scene.workloads.findIndex(w=>w.id==="poe-12");
  const peer=result.outcomes.findIndex(o=>o.subjectKind==="workload" && o.subjectRow===independent);
  assert.ok(peer>=0);
  assert.equal(result.outcomes[peer]!.verdict,"ok");
  assert.equal(result.outcomes[peer]!.conservative,undefined);
  assert.ok(!result.quests.some(q=>q.outcome===peer && [a,b].includes(q.claim)));
});

test("T2 같은 케이블 지원 세계를 기본 결과와 목표 계산에 한 번씩만 사용한다",()=>{
  const scene=load(data);
  const row=scene.claims.findIndex(c=>c.field==="cableUsb4");
  scene.claims[row]!.value=null;
  scene.claims.find(c=>c.field==="cableDataGbps")!.value=40;
  for (const goals of [[],[{id:"전송",kind:"workload" as const,workload:0,scenario:0}]]) {
    const calls:(boolean|null)[]=[];
    const probe:DomainPlugin={...data,standingLoads(view){
      calls.push(view.claims[row]!.value as boolean|null);
      return [];
    }};
    evaluate({...scene,goals},[probe]);
    assert.deepEqual(calls,[null,false,true]);
  }
});

test("T10 기본 예산 안의 유한 수요는 목표 검산 상한을 넘어도 고정 세계 전부를 합친다",()=>{
  const scene=load(data);
  const request=scene.claims.find(c=>c.field==="throughput")!;
  request.value=null;
  request.discrete=Array.from({length:130},(_,i)=>i+1);
  delete request.openDomain;
  scene.claims.find(c=>c.field==="cableUsb4")!.value=false;
  for (const goals of [[],[{id:"전송",kind:"workload" as const,workload:0,scenario:0}]]) {
    const result=evaluate({...scene,goals},[data]);
    const metric=result.metrics.find(m=>m.kind==="together")!;
    assert.deepEqual([metric.low,metric.high],[1,53.248]);
    assert.equal(new Set(result.profileWorlds.map(w=>w.world)).size,130);
    assert.equal(result.outcomes[metric.outcome]!.conservative,undefined);
    if (goals.length) assert.equal(result.goals[0]!.truncated,true);
  }
});
