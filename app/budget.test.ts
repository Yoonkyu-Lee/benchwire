// 시나리오의 구매 수량·묶음·품절과 가격 미확인이 예산 및 로드아웃 차액에 미치는 영향을 확인한다.
import assert from "node:assert/strict";
import test from "node:test";
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
function total(purchases: Purchases, budget = 100, data = stock) {
  return calculateBudget({ id: "작업대", members: ["작업1", "작업2"], purchases, budget }, items, data);
}
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
