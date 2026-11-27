// 합성 장면의 개인 실측과 연결 관측이 측정한 실물·조건·배선에서만 판정과 근거에 들어가는지 확인한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plugins } from "../cli/domains.ts";
import { printResults } from "../cli/print.ts";
import { evaluate, evaluateVariants } from "../engine/evaluate.ts";
import { fixture } from "./document.ts";

const source = { id:"capture", title:"사용자 검증", locator:"fixture:measurement", retrievedAt:"2026-11-27" };
const verified = (value: number | string, unit: string) => ({ value, unit, confidence:"user_verified", sources:[source.id] });
const personal = { instanceId:"supply", ownerKind:"resource", ownerId:"total", domain:"power", field:"capacity",
  firmware:"1.0", measurementCondition:"대기", claim:verified(65,"W") };

function powerPair() {
  const f = fixture("power","single-port"), d = f.document;
  const twin = (ref: { instanceId: string }) => ({ ...ref, instanceId:ref.instanceId + "-b" });
  const c = d.connections[0], w = d.workloads[0];
  d.items.push(...d.items.map(twin));
  d.connections.push({ ...c,id:"b",from:twin(c.from),to:twin(c.to),parts:c.parts.map(twin) });
  d.workloads.push({ ...w,id:"idle-b",from:twin(w.from),to:twin(w.to) });
  d.scenarios[0].members.push("idle-b");
  Object.assign(f.models.get("supply@1").resources[0].capacity,{value:null,confidence:"unknown"});
  for (const item of d.items) Object.assign(item,{firmware:"1.0",measurementCondition:"대기"});
  d.personal = [structuredClone(personal)];
  d.sources.push(structuredClone(source));
  return f;
}

test("T8 개인 총용량은 같은 실물·펌웨어·측정 조건에서만 순충전을 확정하고 이전 측정은 근거에 남긴다", () => {
  const f = powerPair();
  for (const [firmware, measurementCondition, applies, why] of [
    ["1.0","대기",true,""], ["2.0","대기",false,"펌웨어 다름"], ["1.0","부하",false,"측정 조건 다름"],
    ["1.0","대기",true,""],
  ] as const) {
    Object.assign(f.document.items[0],{firmware,measurementCondition});
    const scene=f.load(), result=evaluate(scene,plugins);
    const rows=result.outcomes.flatMap((o,i) => o.subjectKind==="workload" ? [i] : []);
    assert.deepEqual(rows.map(i=>result.outcomes[i]!.verdict),[applies?"ok":"unknown","unknown"]);
    const observed=scene.claims.findIndex(c=>c.scope==="personal" && c.value===65);
    assert.ok(observed>=0);
    const cited = result.reasonInputs.some(i=>i.claim===observed && result.reasons[i.reason]!.outcome===rows[0]);
    assert.equal(cited,applies);
    if (applies) {
      assert.equal(result.measures.find(m=>m.outcome===rows[0] && m.run==="together")!.low,40);
    } else {
      const text=printResults(scene,result);
      assert.ok(text.includes("적용 안 됨: "+why));
      assert.match(text,/사용자 검증.*2026-11-27/u);
    }
  }
});

test("T8 같은 측정과 출처를 재입력해도 주장·인용·판정은 한 번 입력한 것과 같다", () => {
  const f=powerPair();
  f.document.sources.push({...source,id:"second-source"});
  f.document.personal[0].claim.sources.push("second-source");
  const before=f.load(), repeat=structuredClone(f.document.personal[0]);
  repeat.claim.sources.reverse();
  f.document.personal.push(repeat);
  f.document.sources.push(structuredClone(source));
  assert.deepEqual(f.load(),before);
  f.document.personal[1].claim.value=30;
  assert.throws(()=>f.load(),/중복/u);
});

type Endpoint = { instanceId:string; id:string };
type Wiring = { from:Endpoint; to:Endpoint; parts:{instanceId:string;entry:string;exit:string}[] };
const context = {firmware:"v1",measurementCondition:"대기"};
function ports(c: Wiring) {
  return [c.from,...c.parts.flatMap(p=>[{instanceId:p.instanceId,id:p.entry},{instanceId:p.instanceId,id:p.exit}]),c.to].map(p=>({...p,...context}));
}

test("T7 같은 모델·VID/PID의 NIC 중 지정한 배선만 1 Gbps가 되고 다른 장면의 2.5 GbE 능력은 남는다", () => {
  const f=fixture("network","scene"), d=f.document;
  const router=f.models.get("network-router@1");
  for(const port of router.ports.slice(0,2)) port.interfaces[0].params.baseTModes.value="1000BASE-T,2.5GBASE-T";
  f.models.get("network-copper@1").attributes.network.category.value="Cat6A";
  for(const item of d.items) if(item.modelId==="network-host") item.alias="VID_1234&PID_0001";
  d.workloads.find((w:{id:string})=>w.id==="first-hop").request.throughput.value=2000;
  d.sources.push(source);
  const wire=d.connections[0];
  for(const item of d.items) Object.assign(item,context);
  wire.observations=[{ports:ports(wire),domain:"network",field:"linkSpeed",claim:verified(1000,"Mbps")}];
  const limit=(f:ReturnType<typeof fixture>)=>{
    const scene=f.load(), r=evaluate(scene,plugins);
    const work = scene.workloads.findIndex(w=>w.id==="first-hop");
    const row = r.outcomes.findIndex(o=>o.subjectKind==="workload" && o.subjectRow===work);
    const delivered = r.metrics.find(m=>m.outcome===row && m.kind==="together")!.value;
    assert.equal(delivered,wire.observations ? 1000*(1500/1538) : 2000);
    return [0,1].map(connection=>{
      const option=r.options.find(o=>o.connection===connection && o.domain==="network" && o.mode==="mac" && o.direction==="forward")!;
      return {limit:option.limit,observed:option.inputs.some(i=>scene.claims[i]!.field==="linkSpeed")};
    });
  };
  // 같은 관측을 두 번 가져와도 같은 출처 행 하나로 평가한다.
  const once = f.load();
  wire.observations.push(structuredClone(wire.observations[0]));
  assert.deepEqual(f.load(),once);
  const mac=1500/1538;
  assert.deepEqual(limit(f),[{limit:1000*mac,observed:true},{limit:2500*mac,observed:false}]);
  const supported = router.ports[0].interfaces[0].params.baseTModes;
  const previous = structuredClone(supported);
  Object.assign(supported,{value:null,confidence:"unknown"});
  const measured = evaluate(f.load(),plugins).options.find(o=>o.connection===0 && o.mode==="mac" && o.direction==="forward")!;
  assert.equal(measured.limit,1000*mac);
  assert.equal(measured.unused,undefined,"현재 회선 속도를 확인해도 상대 포트의 남는 능력은 미확인");
  Object.assign(supported,previous);
  d.sceneId="다른 배선";
  delete wire.observations;
  assert.deepEqual(limit(f),[{limit:2500*mac,observed:false},{limit:2500*mac,observed:false}]);
});

test("T5 관측한 USB 세대만 벌크 서비스를 제한하고 포트·케이블·펌웨어를 바꾸면 원래 협상을 쓴다", () => {
  const f=fixture("data","scene"), d=f.document, wire=d.connections[0];
  f.models.get("usb-cable@1").attributes.data.cableDataGbps.value=20;
  const model=f.models.get("usb-endpoint@1");
  const other=structuredClone(model.ports[0]); other.id="second";
  for(const iface of other.interfaces) iface.id += "-second";
  model.ports.push(other);
  d.items.push({...d.items[2],instanceId:"spare"});
  d.sources.push(source);
  for(const item of d.items) Object.assign(item,context);
  wire.observations=[{ports:structuredClone(ports(wire)),domain:"data",field:"usbMode",claim:verified("Gen 1x1","")}];
  function check(expected:number, observed:boolean) {
    const scene=f.load(),r=evaluate(scene,plugins);
    const option=r.options.find(o=>o.mode==="bulk" && o.direction==="forward" && o.domain==="data")!;
    assert.equal(option.limit,expected);
    const row = r.outcomes.findIndex(o=>o.subjectKind==="workload");
    assert.equal(r.metrics.find(m=>m.outcome===row && m.kind==="together")!.value,Math.min(500,expected));
    assert.equal(option.inputs.some(i=>scene.claims[i]!.field==="usbMode"),observed);
  }
  check(450,true);
  wire.from.id="second"; check(2200,false);
  wire.from.id="usb"; wire.parts[0].instanceId="spare"; check(2200,false);
  wire.parts[0].instanceId="cable"; d.items[0].firmware="new"; check(2200,false);
  const current = structuredClone(wire.observations[0]);
  current.ports[0].firmware="new";
  current.claim.value="Gen 2x1";
  wire.observations.push(current);
  check(1100,true);
});

test("T10 연결 관측은 다른 영역의 화면 모드도 저장하고 자료형·단위가 틀린 협상 관측은 거절한다", () => {
  const f=fixture("data","scene"), d=f.document, wire=d.connections[0];
  d.sources.push(source);
  const captured=ports(wire);
  wire.observations=[{ports:captured, domain:"display",field:"displayMode",claim:verified("3840×2160@60","")}];
  const scene=f.load(), row=scene.claims.findIndex(c=>c.ownerKind==="connection" && c.field==="displayMode");
  assert.ok(row>=0 && scene.claimSources.some(s=>s.claim===row && scene.sources[s.source]!.id===source.id));
  wire.observations=[{ports:captured,domain:"network",field:"linkSpeed",claim:verified(1000,"MB/s")}];
  assert.throws(()=>f.load(),/observations.*unit/u);
});

function observed(folder:string, name:string, field:"usbMode"|"linkSpeed") {
  const f=fixture(folder,name), d=f.document, wire=d.connections[0];
  for(const item of d.items) Object.assign(item,context);
  for(const p of d.personal??[]) Object.assign(p,context);
  d.sources.push(source);
  const usb=field==="usbMode";
  wire.observations=[{ports:ports(wire),domain:usb?"data":"network",field,claim:verified(usb?"Gen 1x1":1000,usb?"":"Mbps")}];
  return f;
}

test("T5 현재 USB 관측은 그 연결의 모델 후보보다 우선하고 관측 없는 배선은 후보로 평가한다",()=>{
  const f=observed("data","scene","usbMode"), d=f.document;
  f.models.get("usb-cable@1").attributes.data.cableDataGbps.value=5;
  d.workloads[0].request.throughput.value=400;
  const modes=f.models.get("usb-endpoint@1").ports[0].interfaces[0].params.modes;
  Object.assign(modes,{value:"Gen 1x1",conflicts:[{value:"High Speed",confidence:"review",sources:["endpoint"]}]});
  for(const active of [true,false]) {
    if(!active) delete d.connections[0].observations;
    const s=f.load(),r=evaluate(s,plugins), row=r.outcomes.findIndex(o=>o.subjectKind==="workload");
    assert.equal(r.outcomes[row]!.verdict,active?"ok":"unknown");
    const m=r.metrics.find(m=>m.outcome===row && m.kind==="together")!;
    assert.equal(m.high,400);
    assert.equal(m.low,active?400:53.248);
  }
});

test("T7 같은 모델 두 배선 중 관측이 있는 배선만 모델 충돌과 관계없이 500 Mbps를 전달한다",()=>{
  const f=observed("network","scene","linkSpeed"),d=f.document;
  const modes=f.models.get("network-host@1").ports[0].interfaces[0].params.baseTModes;
  Object.assign(modes,{value:"1000BASE-T",conflicts:[{value:"2.5GBASE-T",confidence:"review",sources:["network-host"]}]});
  const work=d.workloads.find((w:{id:string})=>w.id==="first-hop"); work.request.throughput.value=500;
  d.workloads=[work,{...structuredClone(work),id:"peer",from:{instanceId:"host-b",id:"nic"},to:{instanceId:"router",id:"lan-b"}}];
  d.scenarios=[{id:"both",members:["first-hop","peer"]}];
  const s=f.load(),r=evaluate(s,plugins);
  const workloads=r.outcomes.flatMap((o,i)=>o.subjectKind==="workload"?[{o,m:r.metrics.find(m=>m.outcome===i&&m.kind==="together")!}]:[]);
  assert.deepEqual(workloads.map(({o,m})=>[o.verdict,m.low,m.high]),[["ok",500,500],["unknown",0,500]]);
});

test("T2 현재 Gen 1x1과 함께 쓸 설정만 선택하고 영상·허브 작업에서 관측 출처를 인용한다",()=>{
  const f=observed("t2","scene","usbMode"),s=f.load(),variants=evaluateVariants(s,plugins,0);
  assert.equal(variants[0]!.choices[0]!.profile,"dp-2lane");
  assert.ok(variants.every(v=>v.choices.every(c=>c.profile!=="dp-4lane")));
  const r=variants[0]!.result, claim=s.claims.findIndex(c=>c.field==="usbMode");
  for(const [i,o] of r.outcomes.entries()) if(o.subjectKind==="workload"){
    assert.ok(r.reasonInputs.some(x=>r.reasons[x.reason]!.outcome===i && x.claim===claim),s.workloads[o.subjectRow]!.id);
    if(s.workloads[o.subjectRow]!.id==="hub") assert.equal(r.metrics.find(m=>m.outcome===i&&m.kind==="together")!.value,400);
  }
  assert.ok(s.claimSources.some(c=>c.claim===claim && s.sources[c.source]!.id==="capture"));
});

test("T5 생략한 범위와 확인한 해당 없음을 구별하고 이력에 달라진 포트의 측정 당시·현재 값을 보인다",()=>{
  const f=observed("data","scene","usbMode"),d=f.document, obs=d.connections[0].observations[0], cable=d.items[2];
  const cablePorts=obs.ports.slice(1,-1);
  function inactive(){return f.load().claims.find(c=>c.field==="usbMode")!.inactive;}
  delete cable.firmware; for(const p of cablePorts) delete p.firmware;
  assert.equal(inactive(),"firmware");
  cable.firmware=null; for(const p of cablePorts) p.firmware=null;
  assert.equal(inactive(),undefined);
  delete cable.measurementCondition; for(const p of cablePorts) delete p.measurementCondition;
  assert.equal(inactive(),"measurementCondition");
  cable.measurementCondition=null; for(const p of cablePorts) p.measurementCondition=null;
  assert.equal(inactive(),undefined);
  d.items[0].firmware="v2"; const scene=f.load(),text=printResults(scene,evaluate(scene,plugins));
  assert.match(text,/측정 당시[^\n]*left\/usb[^\n]*v1[^\n]*대기[^\n]*cable\/a[^\n]*해당 없음/u);
  assert.match(text,/현재 배선[^\n]*left\/usb[^\n]*v2[^\n]*대기/u);
});
