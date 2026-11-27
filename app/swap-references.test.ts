// 슬롯 사본의 배선·목표·작업 참조가 같은 대응으로 옮겨지는지 실제 저장 장면과 대조한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plugins } from "../domains/registry.ts";
import { evaluate } from "../engine/evaluate.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { modelKey, type Library, type Model, type SceneDocument } from "./document.ts";
import { compareSwap, swapSlot } from "./swap.ts";

function fixture(dir: string, name: string, originalId: string) {
  function read<T>(id: string): T {
    return JSON.parse(readFileSync(new URL("../fixtures/"+dir+"/"+id+".json",import.meta.url),"utf8"));
  }
  const scene=read<SceneDocument>(name), models=new Map<string, Model>();
  for (const item of scene.items) models.set(modelKey(item),read<Model>(modelKey(item)));
  const documents={models,connectors:read<Library["connectors"]>("connectors")};
  const item=scene.items.find(i=>i.instanceId===originalId)!;
  const replacement=structuredClone(models.get(modelKey(item))!);
  replacement.revision="2";
  models.set(modelKey(replacement),replacement);
  const replacementId=originalId+"-new";
  function snapshot(doc: SceneDocument) {
    const scene=loadSceneDocuments(doc,documents,plugins);
    return {scene,result:evaluate(scene,plugins)};
  }
  return {scene,replacement,replacementId,snapshot,swap:(choices?:ReadonlyMap<string,string>)=>
    swapSlot(scene,documents,{originalId,replacementId,replacement,choices,sceneId:name+"-swap"})};
}

function renameNode(model:Model, from:string, to:string) {
  model.nodes.find(n=>n.id===from)!.id=to;
  for (const p of model.ports) if (p.attachment.value===from) p.attachment.value=to;
  for (const e of model.edges) {
    if (e.from===from) e.from=to;
    if (e.to===from) e.to=to;
  }
}

test("T5 경유 호스트의 같은 판본 구조를 교체하면 사본을 다시 평가하고 기술 차이 없이 비교한다",()=>{
  const f=fixture("storage","host-copy","host"), before=structuredClone(f.scene);
  const {document,pending}=f.swap();
  assert(document);
  assert.deepEqual(pending,[]);
  const a=f.snapshot(before), b=f.snapshot(document);
  assert.deepEqual(compareSwap(a,b,"host",f.replacementId),[]);
  const request=document.workloads[0]!.request;
  assert.deepEqual(request.viaInstance,{...before.workloads[0]!.request.viaInstance,value:f.replacementId});
  assert.deepEqual(request.viaNode,before.workloads[0]!.request.viaNode);
  assert.deepEqual(f.scene,before);
});

test("T5 경유 주장과 충돌 후보·포트 목표·구매행은 선택한 노드와 포트로 함께 옮긴다",()=>{
  const f=fixture("storage","host-copy","host"), w=f.scene.workloads[0]!, s=f.scene.scenarios[0]!;
  const candidate={value:"controller-a",confidence:"inferred" as const,sources:["scene"]};
  w.request.viaNode!.conflicts=[candidate];
  renameNode(f.replacement,"copy-service","copy-v2");
  renameNode(f.replacement,"controller-a","controller-v2");
  f.replacement.ports.find(p=>p.id==="a")!.id="port-v2";
  s.goals=[{id:"포트",kind:"port",instanceId:"host",portId:"a",workloads:[w.id]},
    {id:"장비",kind:"port",instanceId:"host",workloads:[w.id]}];
  s.purchases=[{instanceId:"host"},{ownedInstanceId:"host",modelRef:"host@1"}];
  const original=structuredClone(f.scene), waiting=f.swap();
  assert.equal(waiting.document,null);
  assert.deepEqual(waiting.pending.map(p=>p.source).sort(),["a","controller-a","copy-service"]);
  const chosen=new Map([["a","port-v2"],["copy-service","copy-v2"],["controller-a","controller-v2"]]);
  const choices=new Map(waiting.pending.map(p=>[p.key,chosen.get(p.source)!]));
  const after=f.swap(choices).document;
  assert(after);
  assert.deepEqual(after.workloads[0]!.request.viaNode,{...w.request.viaNode,value:"copy-v2",conflicts:[{...candidate,value:"controller-v2"}]});
  assert.deepEqual(after.scenarios[0]!.goals,[{...s.goals[0],instanceId:f.replacementId,portId:"port-v2"},{...s.goals[1],instanceId:f.replacementId}]);
  assert.deepEqual(after.scenarios[0]!.purchases,[{instanceId:f.replacementId},{instanceId:f.replacementId}]);
  f.snapshot(after);
  assert.deepEqual(f.scene,original);
});

test("T5 경유 실물의 충돌 후보도 옮기고 다른 실물과 공유하는 노드 이름은 보존한다",()=>{
  const f=fixture("storage","host-copy","host"), request=f.scene.workloads[0]!.request;
  f.scene.items.push({instanceId:"other",modelId:"host",revision:"1"});
  const owner=request.viaInstance!;
  owner.value="other";
  owner.conflicts=[{value:"host",confidence:"review",sources:["scene"]}];
  const same=f.swap().document;
  assert(same);
  assert.deepEqual(same.workloads[0]!.request.viaInstance,{...owner,conflicts:[{...owner.conflicts[0],value:f.replacementId}]});
  f.snapshot(same);
  renameNode(f.replacement,"copy-service","new-service");
  const pending=f.swap();
  assert.equal(pending.document,null);
  assert.deepEqual(pending.pending.map(p=>[p.source,p.options]),[["copy-service",[]]]);
  owner.value=null; owner.confidence="unknown"; delete owner.conflicts;
  assert.equal(f.swap().document,null);
});

test("T5 실물이 미확인인 경유 노드와 출처 후보를 보존하고 두 후보가 한 행으로 합쳐지는 대응은 다시 고른다",()=>{
  const f=fixture("storage","host-copy","host"), request=f.scene.workloads[0]!.request;
  request.viaInstance!.value=null;
  request.viaInstance!.confidence="unknown";
  request.viaNode!.conflicts=[{value:"controller-a",confidence:"review",sources:["scene"]}];
  renameNode(f.replacement,"copy-service","new-service");
  const waiting=f.swap();
  assert.equal(waiting.pending.length,1);
  const key=waiting.pending[0]!.key;
  const overlap=f.swap(new Map([[key,"controller-a"]]));
  assert.equal(overlap.document,null);
  assert.deepEqual(overlap.pending.map(p=>p.source).sort(),["controller-a","copy-service"]);
  const after=f.swap(new Map([[key,"new-service"]])).document;
  assert(after);
  assert.deepEqual(after.workloads[0]!.request.viaInstance,request.viaInstance);
  assert.deepEqual(after.workloads[0]!.request.viaNode,{...request.viaNode,value:"new-service"});
  f.snapshot(after);
});

test("T8 교체한 전원 장치의 노드·조합 포트·PoE 자원은 새 판본의 주장을 사용한다",()=>{
  const f=fixture("shared-power","mixed","supply"), m=f.replacement;
  renameNode(m,"supply","supply-v2");
  const usb=m.ports.find(p=>p.id==="usb")!;
  usb.id="usb-v2";
  usb.interfaces[0]!.params.sourceNode!.value="supply-v2";
  m.attributes={power:{"budget:usb-v2:usb-v2":{value:60,unit:"W",confidence:"inferred",sources:["table"]}}};
  for (const p of m.ports) for (const i of p.interfaces) if (i.params.budgetResource) i.params.budgetResource.value="other-budget";
  const waiting=f.swap(), choices=new Map(waiting.pending.map(p=>[p.key,p.kind==="port" ? "usb-v2" : "supply-v2"]));
  const after=f.swap(choices).document;
  assert(after);
  const {scene}=f.snapshot(after);
  const item=scene.items.findIndex(i=>i.id===f.replacementId);
  assert.ok(scene.claims.some(c=>c.ownerKind==="item" && c.owner===item && c.field==="budget:usb-v2:usb-v2"));
  assert.ok(scene.claims.some(c=>c.field==="sourceNode" && c.value==="supply-v2"));
  assert.ok(scene.claims.some(c=>c.field==="budgetResource" && c.value==="other-budget"));
});
