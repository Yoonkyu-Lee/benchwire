// 모델·개인 검증·충돌 후보가 참조하는 실물 표를 실제 로더에서 대조한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plugins } from "../domains/registry.ts";
import { power } from "../domains/power/power.ts";
import { evaluate } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";

function fixture(dir: string, name: string) {
  const read = (id: string) => JSON.parse(readFileSync(new URL("./"+dir+"/"+id+".json",import.meta.url),"utf8"));
  const scene=read(name), models=new Map<string,ReturnType<typeof read>>();
  for (const {modelId,revision} of scene.items) {
    const key=modelId+"@"+revision;
    if (!models.has(key)) models.set(key,read(key));
  }
  return {scene,models,load:()=>loadSceneDocuments(scene,{models,connectors:read("connectors")},plugins)};
}

for (const personal of [false,true]) for (const conflict of [false,true]) {
  test("T8 독립 전원 노드 오기를 거절한다 · "+(personal ? "개인 검증" : "모델")+" · "+(conflict ? "충돌 후보" : "본값"),()=>{
    const f=fixture("power","serial-passthrough");
    const params=f.models.get("supply@1").ports[0].interfaces[0].params;
    const fact=personal ? {value:"root",confidence:"user_verified",sources:["scene"]} : params.sourceNode;
    if (personal) f.scene.personal=[{instanceId:"supply",ownerKind:"interface",ownerId:"a-power",
      field:"sourceNode",domain:"power",claim:fact}];
    const prefix=personal ? "scene.json#personal.0.claim" : "supply@1.json#ports.0.interfaces.0.params.sourceNode";
    for (const bad of ["roo","entry"]) {
      if (conflict) fact.conflicts=[{value:bad,confidence:fact.confidence,sources:fact.sources}];
      else fact.value=bad;
      assert.throws(f.load,(err: Error)=>err.message.startsWith(prefix+(conflict ? ".conflicts.0" : "")+".value") &&
        err.message.includes("노드") && err.message.includes(bad));
    }
  });
}

test("T8 파일 경계 밖에서 잘못된 전원 참조를 받아도 예약 없음을 확정하지 않는다",()=>{
  const s=fixture("power","serial-passthrough").load();
  const source=s.claims.find(c=>c.field==="sourceNode" && c.owner===0)!;
  source.value="roo";
  const r=evaluate(s,[power]);
  const row=r.outcomes.findIndex(o=>o.subjectKind==="workload");
  const m=r.metrics.find(m=>m.outcome===row && m.kind==="together")!;
  assert.deepEqual([m.low,m.high],[40,60]);
});

test("T7 PoE 예산 참조는 같은 실물의 네트워크 W 자원이어야 한다",()=>{
  const f=fixture("network","scene"), model=f.models.get("network-pse@1");
  const fact=model.ports[0].interfaces[0].params.budgetResource;
  model.resources.push({...structuredClone(model.resources[0]),id:"backplane",domain:"network",unit:"Mbps",
    capacity:{...model.resources[0].capacity,unit:"Mbps"}});
  for (const bad of ["not-a-budget","backplane"]) {
    fact.conflicts=[{value:bad,confidence:"inferred",sources:fact.sources}];
    assert.throws(f.load,(err: Error)=>err.message.includes("budgetResource.conflicts.0.value") &&
      err.message.includes("자원") && err.message.includes(bad));
  }
  model.resources=[];
  delete fact.conflicts;
  assert.throws(f.load,/budgetResource\.value.*자원.*port-budget/);
});

test("T8 전력 조합표 키의 포트 참조는 같은 모델의 실제 출력과 대조한다",()=>{
  const f=fixture("power","serial-passthrough");
  const limits=f.models.get("supply@1").attributes.power, sample=limits["budget:a:a"];
  for (const key of ["budget:a+typo:a","budget:a:typo","budget:a:b"]) {
    limits[key]=sample;
    assert.throws(f.load,(err: Error)=>err.message.startsWith("supply@1.json#attributes.power."+key+" — ") && err.message.includes("포트"));
    delete limits[key];
  }
  f.scene.personal=[{instanceId:"supply",ownerKind:"item",ownerId:"supply",domain:"power",field:"budget:a:typo",
    claim:{value:10,unit:"W",confidence:"user_verified",sources:["scene"]}}];
  assert.throws(f.load,/scene\.json#personal\.0\.field — .*포트.*typo/);
  delete f.scene.personal;
  const model=f.models.get("supply@1");
  model.ports[2].id="c+:%";
  for (const key of Object.keys(limits)) if (key.includes("c")) {
    delete limits[key];
    limits[key.replaceAll("c","c%2B%3A%25")]=sample;
  }
  assert.doesNotThrow(f.load);
});

test("T5 복사 경유 실물·노드 참조의 본값과 후보를 같은 실물에서 찾는다",()=>{
  const f=fixture("storage","host-copy"), w=f.scene.workloads[0].request;
  const via=w.viaInstance, node=w.viaNode, original=via.value;
  f.scene.workloads[0].request={viaNode:node,viaInstance:via,throughput:w.throughput};
  via.value="no-host";
  assert.throws(f.load,/workloads\.0\.request\.viaInstance\.value.*실물.*no-host/);
  via.value=original;
  node.conflicts=[{value:"no-node",confidence:"inferred",sources:node.sources}];
  assert.throws(f.load,/workloads\.0\.request\.viaNode\.conflicts\.0\.value.*노드.*no-node/);
  delete node.conflicts;
  via.conflicts=[{value:"ssd-b",confidence:"inferred",sources:via.sources}];
  assert.throws(f.load,/경유.*노드/);
  delete via.conflicts;
  via.value=null; via.confidence="unknown";
  assert.doesNotThrow(f.load);
});
