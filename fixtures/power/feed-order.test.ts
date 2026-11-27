// 독립 공급원의 위치와 공급 위상만 바꾼 장면을 고정 예약의 손계산과 대조한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadSceneDocuments } from "../../scene/load.ts";
import { evaluate } from "../../engine/evaluate.ts";
import { power } from "../../domains/power/power.ts";

function document(id: string) {
  return JSON.parse(readFileSync(new URL(id+".json",import.meta.url),"utf8"));
}
function setup() {
  const scene=document("serial-passthrough");
  const models=new Map([ "supply","relay","receiver","cable-3a" ].map(id=>[id+"@1",document(id+"@1")]));
  function solve() {
    const s=loadSceneDocuments(scene,{models,connectors:document("connectors")},[power]);
    const r=evaluate(s,[power]), row=r.outcomes.findIndex(o=>o.subjectKind==="workload");
    const delivery=r.metrics.find(m=>m.outcome===row && m.kind==="together")!;
    return {s,r,delivery};
  }
  scene.scenarios[0].goals=[{id:"전력",kind:"metric",metric:"delivery",unit:"W",run:"together",minimum:45,workloads:["charge"]}];
  return {scene,models,solve};
}

test("T8 대체 전원이 하류에 더 가까워도 상류 입력부터 공급한다",()=>{
  const {scene,models,solve}=setup();
  function addModel(id:string,base:string) {
    const m=structuredClone(models.get(base+"@1"));
    m.modelId=id; models.set(id+"@1",m);
    return m;
  }
  const alternate=addModel("alternate","supply"), passive=addModel("passive","relay"), upstream=addModel("upstream","relay");
  const aux=structuredClone(upstream.ports[0]);
  Object.assign(aux,{id:"aux", attachment:{...aux.attachment,value:"exit"}});
  aux.interfaces[0].id="aux-power";
  delete aux.interfaces[0].params.reserveW;
  upstream.ports.push(aux);
  scene.items[1].modelId="upstream";
  delete passive.ports[0].interfaces[0].params.reserveW;
  for (const [instanceId,modelId] of [["alt","alternate"],["pre","passive"],["w1","cable-3a"],["w2","cable-3a"]])
    scene.items.push({instanceId,modelId,revision:"1"});
  const first=scene.connections[0];
  function addLink(id:string,from:typeof first.from,to:typeof first.to,wire:string) {
    scene.connections.push({...structuredClone(first),id,from,to,parts:[{...first.parts[0],instanceId:wire}]});
  }
  addLink("pre",first.from,{instanceId:"pre",id:"in"},"w1");
  first.from={instanceId:"pre",id:"out"};
  addLink("alt",{instanceId:"alt",id:"a"},{instanceId:"relay-a",id:"aux"},"w2");
  models.get("supply@1").resources[0].capacity.value=15;
  alternate.resources[0].capacity.value=8;
  scene.scenarios[0].goals[0].minimum=5;
  for (const extended of [false,true]) {
    if (extended) {
      const edge=alternate.edges[0];
      alternate.nodes.push({id:"extra",kind:"junction",label:"중간 노드"});
      alternate.edges.push({...edge,id:"end",from:"extra",uses:[]});
      edge.to="extra";
      scene.items.reverse();
    }
    const {s,r,delivery}=solve();
    assert.equal(delivery.value,5);
    assert.equal(r.goals[0]!.verdict,"ok");
    assert.deepEqual(r.standingLoads.filter(l=>l.kind==="scene" && l.amount).map(l=>
      [s.items[l.item]!.id,s.items[s.resources[l.resource]!.item]!.id,l.amount]).sort(),
      [["relay-a","supply",10],["relay-b","alt",8]]);
  }
});

test("T8 역방향 내부 간선이 있어도 독립 전원 모델 주장과 생략한 주장의 고정 세계를 구별한다",()=>{
  const {scene,models,solve}=setup();
  const supply=models.get("supply@1");
  supply.edges.push({...structuredClone(supply.edges[0]),id:"reverse",from:"out",to:"root",uses:[]});
  const params=supply.ports[0].interfaces[0].params;
  const sample=(value:string)=>({value,unit:"",confidence:"inferred",sources:["supply"]});
  const values:number[]=[];
  for (const node of ["root","out",""]) {
    params.sourceNode=sample(node);
    const {delivery}=solve();
    assert.notEqual(delivery.value,null);
    values.push(delivery.value!);
  }
  assert.deepEqual(values,[40,40,60]);
  delete params.sourceNode;
  for (const goals of [scene.scenarios[0].goals,[]]) {
    scene.scenarios[0].goals=goals;
    const {s,r,delivery}=solve();
    assert.deepEqual([delivery.low,delivery.high],[Math.min(...values),Math.max(...values)]);
    if (goals.length) assert.equal(r.goals[0]!.verdict,"unknown");
    const source=s.claims.findIndex(c=>c.ownerKind==="interface" && c.owner===0 && c.field==="sourceNode");
    assert.ok(s.claimSources.some(c=>c.claim===source && s.sources[c.source]!.title==="모델에 값 없음"));
    assert.deepEqual(new Set(r.profileWorlds.filter(w=>w.claim===source).map(w=>w.value)),new Set(["","out","root"]));
    assert.ok(r.quests.some(q=>q.claim===source));
  }
});

test("T8 순서가 없는 두 입력은 각 순서의 5–10 W를 보존하고 충전기에서 합계 15 W를 쓴다",()=>{
  const {scene,models,solve}=setup();
  scene.connections[1].from={instanceId:"supply",id:"b"};
  scene.connections[2].from={instanceId:"supply",id:"c"};
  models.get("supply@1").resources[0].capacity.value=15;
  const relay=models.get("relay@1"), other=structuredClone(relay);
  other.modelId="other"; models.set("other@1",other);
  scene.items[2].modelId="other";
  const fixed=[];
  for (const [a,b] of [[5,10],[10,5]]) {
    relay.ports[0].interfaces[0].params.reserveW.value=a;
    other.ports[0].interfaces[0].params.reserveW.value=b;
    fixed.push(solve().delivery.value);
  }
  relay.ports[0].interfaces[0].params.reserveW.value=10;
  other.ports[0].interfaces[0].params.reserveW.value=10;
  const {r,delivery}=solve();
  assert.deepEqual(fixed,[0,0]);
  assert.deepEqual([delivery.low,delivery.high],[0,0]);
  assert.deepEqual(r.standingLoads.filter(l=>l.kind==="scene").map(l=>l.bounds),
    [{low:5,high:10},{low:5,high:10}]);
  assert.equal(r.resourceUsage.find(u=>u.resourceKind==="scene")!.used,15);
});
