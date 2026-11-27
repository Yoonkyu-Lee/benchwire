// 시나리오의 구매 수량·묶음·품절과 가격 미확인이 예산 및 로드아웃 차액에 미치는 영향을 확인한다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { effectiveClaim } from "../engine/scene.ts";
import { trialDomain } from "../fixtures/trial.ts";
import { loadSceneDocuments } from "../scene/load.ts";
import { evaluate } from "../engine/evaluate.ts";
import { resultView } from "./results.ts";
import { calculateBudget, compareBudgets } from "./budget.ts";
import type { Quote } from "../server/prices.ts";
import type { Item, SceneDocument } from "./document.ts";

const items: Item[] = ["a", "b", "c", "owned"].map(instanceId => ({
  instanceId, modelId: "cable", revision: "1", state: instanceId === "owned" ? "owned" : "candidate",
}));
const offer: Quote = { modelRef: "cable@1", seller: "선호점", productId: "낱개", unitPriceCents: 4000,
  saleUnit: 1, currency: "USD", stock: "in", retrievedAt: "2026-01-01T00:00:00Z", source: "매장", provider: "manual" };
const stock = { quotes: [offer], preferredSellers: ["선호점", "다음점"] };
type Purchases = NonNullable<SceneDocument["scenarios"][number]["purchases"]>;
test("T9 주장 종류마다 고정 장면의 목표와 결합 비용을 모두 합친 판정과 비교한다",()=>{
  const read=(name:string)=>JSON.parse(readFileSync("fixtures/"+name+".json","utf8"));
  type Value=string | number | boolean;
  const flags=z.boolean(), modes=z.enum(["낮음","중간","높음"]), grid=z.number().min(0).max(1).multipleOf(.01);
  for (const [kind,schema,values,exception] of [
    ["불리언",flags,[false,true],true],["열거",modes,modes.options,"중간"],
    ["격자",grid,Array.from({length:101},(_,i)=>i/100),.37],
    ["충돌",grid,[.1,.9],.9],["커넥터",null,["trial-plug","trial-socket"],null],["부착점",null,["root","out","isolated"],null],
  ] as const) {
    const plugin=trialDomain(), doc:SceneDocument=read("three-flows"), host=read("source@1"), scenario=doc.scenarios[0]!;
    doc.connections.length=1;scenario.members=["a"];scenario.budget=0;
    scenario.goals=[{id:"최저",kind:"metric",workloads:["a"],run:"together",metric:"delivery",unit:"회/s",minimum:50}];
    const table=read("connectors"), sources=host.ports[0].connector.sources;
    const models=new Map([["source@1",host],["sink@1",read("sink@1")]]);
    const field=kind==="커넥터" ? host.ports[0].connector : kind==="부착점" ? host.ports[0].attachment :
      {value:null,confidence:"inferred",sources};
    if (kind==="부착점") host.nodes.push({id:"isolated",kind:"junction",label:"분리됨"});
    if (schema) {
      host.attributes={trial:{setting:field}};
      plugin.attributes=z.strictObject({setting:z.strictObject({value:schema.nullable(),unit:z.literal("")})});
      const negotiate=plugin.negotiate;
      plugin.negotiate=link=>negotiate(link).map(o=>{
        const id=effectiveClaim(link.scene,"item",0,plugin.id,"setting")!;
        return {...o,inputs:[...o.inputs,id],limit:link.scene.claims[id]!.value===exception ? 0 : 100};
      });
    }
    function judge() {
      const scene=loadSceneDocuments(doc,{models,connectors:table},[plugin]), r=evaluate(scene,[plugin]);
      const b=calculateBudget(scenario,doc.items,stock,resultView(scene,r,0,"together"));
      return {goal:r.goals[0]!.verdict,budget:b.limitStatus,low:b.unknownRange.low,high:b.unknownRange.high};
    }
    const fixed=(values as readonly Value[]).map(value=>{field.value=value;return judge();});
    if (kind==="충돌") {
      field.value=values[0];field.conflicts=[{value:values[1],confidence:"review",sources}];
    } else field.value=null;
    const first=fixed[0]!;
    const lows=fixed.map(f=>f.low), highs=fixed.map(f=>f.high);
    assert.ok(highs.every(n=>n!==null));
    assert.deepEqual(judge(),{goal:fixed.every(f=>f.goal===first.goal) ? first.goal : "unknown",
      budget:fixed.every(f=>f.budget===first.budget) ? first.budget : "unknown",
      low:lows.reduce((a,b)=>a<b ? a : b), high:highs.reduce((a,b)=>a>b ? a : b)},kind);
  }
});
test("T9 커넥터 후보별 결합 요구로 0달러 예산을 판정하고 후보 상한에서 확인한 초과만 확정한다",()=>{
  const read=(name:string)=>JSON.parse(readFileSync("fixtures/"+name+".json","utf8"));
  const doc:SceneDocument=read("three-flows"), scenario=doc.scenarios[0]!, host=read("source@1"), sink=read("sink@1");
  doc.connections.length=1; scenario.members=["a"]; scenario.budget=0; scenario.goals=[{kind:"scenario",id:"작업"}];
  const plugin=trialDomain(), library={models:new Map([["source@1",host],["sink@1",sink]]),connectors:read("connectors")};
  const judge=()=>{const scene=loadSceneDocuments(doc,library,[plugin]), r=evaluate(scene,[plugin]);
    return calculateBudget(scenario,doc.items,stock,resultView(scene,r,0,"together"));};
  const connector=sink.ports[0].connector;
  connector.value="trial-plug"; const bad=judge();
  connector.value="trial-socket"; const good=judge();
  assert.deepEqual([good.limitStatus,bad.limitStatus],["within","unknown"]);
  connector.value=null;
  for (const goals of [scenario.goals,[]]) {
    scenario.goals=goals;
    const unknown=judge();
    assert.equal(unknown.limitStatus,"unknown");
    assert.deepEqual(unknown.unknownRange,{low:0n,high:1n});
  }
  scenario.goals=[{kind:"scenario",id:"작업"}];
  connector.value="trial-socket";
  connector.conflicts=[{value:"trial-plug",confidence:"review",sources:connector.sources}];
  const merged=judge();
  assert.equal(merged.limitStatus,"unknown");
  assert.deepEqual(merged.unknownRange,{low:0n,high:1n});
  assert.ok(merged.requirements.some(r=>r.need.connection==="wire-a" && r.conditional));
  scenario.purchases=merged.requirements.map((r,i)=>({ownedInstanceId:"adapter-"+i,modelRef:"adapter@1",need:r.need}));
  assert.equal(judge().limitStatus,"within");
  scenario.purchases=[];
  doc.workloads[0]!.request.rate!.conflicts=Array.from({length:257},(_,i)=>({value:i+101,confidence:"review",sources:[doc.sources[0]!.id]}));
  const capped=judge();
  assert.equal(capped.limitStatus,"unknown");
  assert.equal(capped.unknownRange.high,null);
  assert.equal(capped.unassignedNeeds,null);
  scenario.purchases=merged.requirements.map((r,i)=>({ownedInstanceId:"adapter-"+i,modelRef:"adapter@1",need:r.need}));
  assert.equal(judge().limitStatus,"unknown");
  scenario.purchases=[{modelRef:offer.modelRef,quantity:1}];
  assert.equal(judge().limitStatus,"over");
});
test("T9 한 모델의 커넥터 후보가 두 연결의 결합품을 번갈아 요구하면 미지정은 항상 한 개다",()=>{
  const read=(name:string)=>JSON.parse(readFileSync("fixtures/"+name+".json","utf8"));
  const doc:SceneDocument=read("three-flows"),host=read("source@1"),sink=read("sink@1");
  const scenario=doc.scenarios[0]!,connector=sink.ports[0].connector;
  doc.connections.length=2;host.ports[1].connector.value="trial-socket";
  scenario.budget=0;
  const plugins=[trialDomain()],library={models:new Map([["source@1",host],["sink@1",sink]]),connectors:read("connectors")};
  const judge=()=>{const s=loadSceneDocuments(doc,library,plugins);return calculateBudget(scenario,doc.items,stock,resultView(s,evaluate(s,plugins),0,"together"));};
  const fixed=["trial-plug","trial-socket"].map(v=>{connector.value=v;return judge();});
  connector.conflicts=[{value:"trial-plug",confidence:"review",sources:connector.sources}];
  const merged=judge();
  assert.ok(fixed.every(b=>b.limitStatus===merged.limitStatus && b.unassignedNeeds===1));
  assert.deepEqual(merged.unknownRange,{low:1n,high:1n});
  assert.equal(merged.requirements.filter(r=>r.conditional).length,2);
});
test("T9 후보 조합이 상한을 넘어도 필요한 결합품을 지정하지 않은 0달러 예산은 미확인이다", () => {
  const read = (name: string) => JSON.parse(readFileSync("fixtures/" + name + ".json", "utf8"));
  const doc: SceneDocument = read("three-flows"), scenario = doc.scenarios[0]!;
  scenario.budget = 0;
  scenario.goals = [{kind:"scenario",id:"전체"}];
  doc.workloads[0]!.request.rate!.conflicts = Array.from({length:257}, (_,i) => ({
    value:i+1000, confidence:"review", sources:[doc.sources[0]!.id],
  }));
  const host = read("source@1");
  host.ports[0].connector.value = "trial-socket";
  const models = new Map([["source@1",host],["sink@1",read("sink@1")]]);
  const plugins = [trialDomain()], scene = loadSceneDocuments(doc,{models,connectors:read("connectors")},plugins);
  const result = evaluate(scene,plugins);
  assert.ok(result.goals[0]!.truncated);
  const budget = calculateBudget(scenario,doc.items,{quotes:[],preferredSellers:[]},resultView(scene,result,0,"together"));
  assert.deepEqual([budget.limitStatus,budget.unassignedNeeds],["unknown",1]);
});
function total(purchases: Purchases, budget = 100, data = stock) {
  return calculateBudget({ id: "작업대", members: ["작업1", "작업2"], purchases, budget }, items, data,
    {scene:{scenarios:[{id:"작업대"}]},scenario:0,negotiations:new Map(),result:{needs:[]}});
}
test("T9 결합 요구 평가를 기다리거나 다른 시나리오의 결과만 있으면 확정된 초과만 표시한다", () => {
  const s={id:"현재",members:[],purchases:[{instanceId:"a"}],budget:100};
  const other={scene:{scenarios:[{id:"이전"}]},scenario:0,negotiations:new Map(),result:{needs:[]}};
  for (const view of [undefined,other]) {
    const pending=calculateBudget(s,items,stock,view);
    assert.equal(pending.limitStatus,"unknown");
    assert.equal(compareBudgets(pending,pending),null);
    assert.equal(calculateBudget({...s,budget:1},items,stock,view).limitStatus,"over");
  }
});
test("T9 공유 실물은 한 번, 같은 모델 두 실물은 두 번, 다른 시나리오 실물과 보유품은 비용 0", () => {
  assert.equal(total([{instanceId:"a"},{instanceId:"a"},{instanceId:"owned"}]).subtotalCents, 4000n);
  assert.equal(total([{instanceId:"a"},{instanceId:"b"}]).subtotalCents, 8000n);
  assert.equal(total([]).subtotalCents, 0n);
});
test("T9 선호점의 현재 품절은 과거 재고를 덮고, 다음점의 묶음을 올림해 실제 적용 할인만 한 번 뺀다", () => {
  const quotes: Quote[] = [offer, {...offer, stock:"out", retrievedAt:"2026-01-02T00:00:00Z"},
    {...offer, seller:"다음점", productId:"두개", saleUnit:2, unitPriceCents:3000, coupon:"가입 쿠폰",
      discountCents:200}, {...offer, purchasedAt:"2025-01-01", unitPriceCents:100, productId:"과거"}];
  const b = total([{instanceId:"a"},{instanceId:"b"},{instanceId:"c"}],100,{...stock,quotes});
  assert.equal(b.subtotalCents, 5600n);
  assert.deepEqual(b.lines[0]!.skippedSellers, ["선호점"]);
  assert.equal(b.lines[0]!.packs, 2n);
});
test("T9 확인분 80달러에 가격 미확인 1개면 상한 75달러는 5달러 초과, 100달러는 미확인", () => {
  const rows = [{instanceId:"a"},{instanceId:"b"},{modelRef:"adapter@1",quantity:1}];
  const low = total(rows,75);
  assert.equal(low.unknownCount,1n);
  assert.equal(low.limitStatus,"over");
  assert.equal(low.subtotalCents - low.limitCents!,500n);
  assert.equal(total(rows).limitStatus,"unknown");
  assert.equal(total([{instanceId:"a"}],40).limitStatus,"within");
});
test("T9 같은 판매처·상품 번호에 낱개와 묶음이 있으면 사용자가 지정한 판매 단위로 견적한다", () => {
  const data = {...stock,quotes:[offer,{...offer,saleUnit:2,unitPriceCents:6000}]};
  const row = {modelRef:"cable@1",quantity:1,product:{seller:offer.seller,productId:offer.productId,saleUnit:1}};
  assert.equal(total([row],100,data).subtotalCents,4000n);
  assert.equal(total([{...row,product:{...row.product,saleUnit:2}}],100,data).subtotalCents,6000n);
  assert.equal(compareBudgets(total([row],100,{...stock,quotes:[]}),
    total([{...row,product:{...row.product,saleUnit:2}}],100,{...stock,quotes:[]})),null);
});
test("T9 저장 가능한 정수 단가와 수량을 곱해도 확인 소계에서 1센트를 잃지 않는다", () => {
  const unitPriceCents = 3_002_399_751_580_331;
  assert.equal(String(total([{modelRef:"cable@1",quantity:3}],75,{...stock,quotes:[{...offer,unitPriceCents}]}).subtotalCents),
    "9007199254740993");
});
test("T9 같은 미확인 상품·수량만 상쇄하고 다른 상품, SKU 또는 다른 수량은 차액 미확인", () => {
  const unknown = {modelRef:"adapter@1",quantity:1};
  const extra = {modelRef:"spare@1",quantity:1};
  const data = {...stock,quotes:[offer,{...offer,modelRef:"spare@1",productId:"spare",unitPriceCents:3000}]};
  const left = total([{instanceId:"a"},{instanceId:"b"},unknown],150,data);
  const right = total([{instanceId:"a"},{instanceId:"b"},unknown,extra],150,data);
  assert.equal(compareBudgets(left,right),3000n);
  for (const different of [{...unknown,modelRef:"other@1"},{...unknown,quantity:2},
    {...unknown,product:{seller:"다음점",productId:"두개",saleUnit:2}}]) {
    assert.equal(compareBudgets(left,total([{instanceId:"a"},{instanceId:"b"},different,extra],150,data)),null);
  }
});

test("T9 지정한 묶음의 남은 칸과 여러 판매 단위를 함께 써서 선호점에서 최소 금액을 고른다", () => {
  const single = {...offer,unitPriceCents:600};
  const pair = {...offer,productId:"두개",saleUnit:2,unitPriceCents:1000};
  const triple = {...offer,productId:"세개",saleUnit:3,unitPriceCents:1100};
  const other = {...offer,seller:"다음점",productId:"다른 낱개",unitPriceCents:1};
  const pinned = {modelRef:pair.modelRef,quantity:1,product:{seller:pair.seller,productId:pair.productId,saleUnit:pair.saleUnit}};
  const data = {...stock,quotes:[single,pair,triple,other]};
  const reused = total([pinned,{instanceId:"a"}],10,data);
  assert.equal(reused.subtotalCents,1000n);
  assert.equal(reused.limitStatus,"within");
  assert.deepEqual(reused.lines.flatMap(line => line.instances),["a"]);
  const mixed = total([{modelRef:offer.modelRef,quantity:7}],100,data);
  assert.equal(mixed.subtotalCents,2800n);
  assert.deepEqual(mixed.lines.map(line => [line.quote?.productId,line.packs]).sort(),[["낱개",1n],["세개",2n]]);
  assert.equal(mixed.lines.reduce((count,line) => count+line.quantity,0n),7n);
});

test("T9 조합 탐색 상한을 넘기면 비용을 미확인으로 남기고 한 판매 단위는 큰 수량도 계산한다", () => {
  const demand = [{modelRef:offer.modelRef,quantity:50_001}];
  const pair = {...offer,productId:"두개",saleUnit:2};
  const bounded = total(demand,1,{...stock,quotes:[offer,pair]});
  assert.equal(bounded.unknownCount,50_001n);
  assert.equal(bounded.limitStatus,"unknown");
  assert.equal(bounded.lines[0]?.searchExceeded,true);
  assert.equal(total(demand,1,{...stock,quotes:[pair]}).subtotalCents,100_004_000n);
});
