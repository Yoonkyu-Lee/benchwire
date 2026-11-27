// 실제 작업대에서 수동 견적·구매 목록을 저장하고 기술이 같은 두 로드아웃의 가격 차이를 확인한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { edgeSession, waitForAssessment } from "./edge-session.ts";
import type { SceneDocument } from "./document.ts";

const edge = edgeSession();
test("T9 예제에서 입력한 견적과 예산은 사본에 남고 같은 기술 결과 옆에도 가격 차이가 보인다", async () => {
  const {page, errors} = await edge.newPage("/");
  try {
    const open = page.getByRole("button",{name:"구매 예산",exact:true});
    await open.click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("수동 견적 입력",{exact:true}).click();
    await panel.getByLabel("견적 모델").selectOption("network-copper@1");
    await panel.getByLabel("판매처",{exact:true}).fill("시험 매장");
    await panel.getByLabel("상품 번호").fill("wire-pack");
    await panel.getByLabel("판매 단가 (USD)").fill("40.00");
    await panel.getByLabel("조회 시각").fill("2025-01-02T13:00");
    await panel.getByRole("button",{name:"견적 저장"}).click();
    await panel.getByText("견적을 저장했습니다.").waitFor();
    await panel.getByText("구매 목록 편집",{exact:true}).click();
    await panel.getByLabel("구매할 항목").selectOption({label:"상품 · 시험 매장 / wire-pack"});
    await panel.getByLabel("구매 수량").fill("2");
    await panel.getByRole("button",{name:"목록에 추가"}).click();
    await panel.getByLabel("상품 예산 상한 (USD)").fill("75");
    await panel.getByRole("button",{name:"상한 저장"}).click();
    await panel.getByText("상품 예산 $5.00 초과").waitFor();
    await panel.getByText(/오래된 견적/).first().waitFor();
    await panel.getByRole("button",{name:"닫기"}).click();
    await page.locator('.scene-title select option:checked[value="network-copy"]').waitFor({state:"attached"});
    await page.reload();
    await waitForAssessment(page);
    await open.click();
    await panel.getByText("상품 예산 $5.00 초과").waitFor();
    await panel.getByText("로드아웃 비교",{exact:true}).click();
    await panel.getByLabel("비교할 장면").selectOption("network");
    await panel.getByRole("button",{name:"두 구성 비교"}).click();
    await panel.getByText("가격 차이 −$80.00").waitFor();
    await panel.getByText("기술 차이 없음").waitFor();
    await page.screenshot({path:resolve("work/m6-budget-compare.png")});
    await panel.getByRole("button",{name:"닫기"}).click();
    // 다른 탭의 보유품 지정 뒤 예전 ETag로 이름을 고쳐도 두 편집이 남는다.
    await page.evaluate(async () => {
      const path = "/api/scenes/network-copy";
      const res = await fetch(path), doc = await res.json() as SceneDocument;
      const s = doc.scenarios[0]!;
      const next = {...doc,scenarios:doc.scenarios.with(0,{...s,purchases:[...s.purchases!,{instanceId:"host-a"}]})};
      const put = await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":res.headers.get("ETag")!},
        body:JSON.stringify(next)});
      if (!put.ok) throw new Error(await put.text());
    });
    const editor = page.locator(".scenario-panel").first();
    await editor.locator("summary").first().click();
    await editor.getByLabel("시나리오 이름",{exact:true}).fill("이름 변경");
    await editor.getByRole("button",{name:"시나리오 적용"}).click();
    await page.locator("#storage-status").getByText("저장됨",{exact:true}).waitFor();
    await page.reload();
    await waitForAssessment(page);
    await open.click();
    await panel.getByText("상품 예산 $5.00 초과").waitFor();
    await panel.getByText("host-a · 보유 $0.00").waitFor();
    await panel.getByRole("heading",{name:"이름 변경"}).waitFor();
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("T9 같은 미확인 상품은 비교에서 상쇄하고 다른 상품은 미확인으로 두며 빠진 결합에 보유품을 지정한다",async () => {
  const {page, errors} = await edge.newPage("/");
  try {
    await page.evaluate(async () => {
      const doc: SceneDocument = await (await fetch("/api/scenes/network")).json();
      const headers = {"Content-Type":"application/json"};
      const put = async (path:string,body:unknown) => {
        const reply = await fetch(path,{method:"PUT",headers,body:JSON.stringify(body)});
        if (!reply.ok) throw new Error(await reply.text());
      };
      const offer = {modelRef:"network-host@1",seller:"우선",productId:"기본형",currency:"USD",unitPriceCents:8000,
        saleUnit:1,stock:"out",source:"매장 확인",provider:"manual",retrievedAt:"2026-01-01T00:00:00Z"};
      await put("/api/prices",offer);
      await put("/api/prices",{...offer,stock:"in",seller:"대체"});
      await put("/api/prices",{...offer,stock:"in",seller:"대체",productId:"장비",modelRef:"network-pse@1",unitPriceCents:3000});
      await put("/api/prices/preferences",["우선","대체"]);
      const unknown = {modelRef:"network-pd@1",quantity:1}, known = {modelRef:"network-host@1",quantity:1};
      const more = {modelRef:"network-pse@1",quantity:1};
      const {members} = doc.scenarios[0]!;
      await put("/api/scenes/budget-e2e",{...doc,sceneId:"budget-e2e",
        connections:doc.connections.map((c,i) => i ? c : {...c,parts:[]}),
        scenarios:[{id:"기준",members,budget:100,purchases:[known,unknown]},
          {id:"같은 미확인",members,purchases:[known,unknown,more]},
          {id:"다른 미확인",members:[],purchases:[known,{modelRef:"unquoted@1",quantity:1},more]}]});
    });
    await page.reload();
    const open = page.getByRole("button",{name:"구매 예산",exact:true});
    await waitForAssessment(page);
    await open.click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("상품 예산 $100.00 · 충족 여부 미확인").waitFor();
    await panel.getByText(/우선 품절/).waitFor();
    await panel.getByText("로드아웃 비교",{exact:true}).click();
    const comparison = panel.getByLabel("비교할 시나리오");
    await comparison.selectOption("같은 미확인");
    await panel.getByRole("button",{name:"두 구성 비교"}).click();
    await panel.getByText("가격 차이 +$30.00").waitFor();
    await panel.getByText("기술 차이 없음").waitFor();
    await comparison.selectOption("다른 미확인");
    await panel.getByRole("button",{name:"두 구성 비교"}).click();
    await panel.getByText("가격 차이 미확인").waitFor();
    await panel.getByRole("heading",{name:/기술 차이 [1-9]/}).waitFor();
    const need = panel.locator(".needs p").filter({hasText:"lan-a · "}).first();
    await need.getByRole("button",{name:"품목 지정"}).click();
    await panel.getByLabel("구매할 항목").selectOption({label:"보유 · LAN 케이블 A / lan-a-wire"});
    await panel.getByRole("button",{name:"목록에 추가"}).click();
    await need.filter({hasText:"lan-a-wire"}).waitFor();
    await panel.getByText("lan-a-wire · 보유 $0.00").waitFor();
    await page.screenshot({path:resolve("work/m6-budget-needs.png")});
    await need.getByRole("button",{name:"연결 근거"}).click();
    await page.locator("#results-panel").waitFor();
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("T9 결합품을 고르기 전에는 상한 충족이 미확인이고 보유품을 지정하면 확인된다",async () => {
  const {page} = await edge.newPage("/");
  try {
    await page.evaluate(async () => {
      const doc = await (await fetch("/api/scenes/network")).json() as SceneDocument;
      const next = {...doc,sceneId:"budget-unassigned",
        connections:doc.connections.map((c,i) => i ? c : {...c,parts:[]}),
        scenarios:[{...doc.scenarios[0]!,budget:0}]};
      const put = await fetch("/api/scenes/" + next.sceneId, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
      if (!put.ok) throw new Error(await put.text());
    });
    await page.reload();
    await waitForAssessment(page);
    await page.getByRole("button",{name:"구매 예산",exact:true}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    const need = panel.locator(".needs p").filter({hasText:"lan-a · "}).first();
    await need.getByText(/해결 품목 미지정/).waitFor();
    const totals = panel.locator(".totals");
    assert.match(await totals.innerText(),/가격 미확인 [1-9]\d*개/);
    assert.match(await totals.innerText(),/상품 예산 \$0.00 · 충족 여부 미확인/);
    await page.screenshot({path:resolve("work/m6-budget-unassigned.png")});
    for (const pending of await panel.locator(".needs p").all()) {
      await pending.getByRole("button",{name:"품목 지정"}).click();
      await panel.getByLabel("구매할 항목").selectOption({label:"보유 · LAN 케이블 A / lan-a-wire"});
      await panel.getByRole("button",{name:"목록에 추가"}).click();
      await pending.filter({hasText:"lan-a-wire"}).waitFor();
    }
    await totals.getByText("상품 예산 $0.00 이내",{exact:true}).waitFor();
    await page.screenshot({path:resolve("work/m6-budget-assigned.png")});
  } finally { await page.close(); }
});

test("T9 다른 탭에서 시나리오 이름이 먼저 바뀌어도 상한을 저장하고 충돌 안내는 예산 창에 표시한다",async () => {
  const {page,errors} = await edge.newPage("/");
  try {
    await page.evaluate(async () => {
      const doc = await (await fetch("/api/scenes/network")).json() as SceneDocument;
      const next = {...doc,sceneId:"budget-race",scenarios:doc.scenarios.with(-1,{...doc.scenarios.at(-1)!,id:"공유망 기존 이름"})};
      const put = await fetch("/api/scenes/" + next.sceneId,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
      if (!put.ok) throw new Error(await put.text());
    });
    await page.reload();
    await waitForAssessment(page);
    const editor = page.locator(".scenario-panel").first();
    await editor.locator("summary").first().click();
    await editor.getByLabel("현재 시나리오",{exact:true}).selectOption("공유망 기존 이름");
    const open = page.getByRole("button",{name:"구매 예산",exact:true});
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await open.click();
    await panel.getByRole("heading",{name:"공유망 기존 이름",exact:true}).waitFor();
    const updateOtherTab = (id:string, budget?:number) => page.evaluate(async ({id,budget}) => {
      const path = "/api/scenes/budget-race";
      const get = await fetch(path), doc = await get.json() as SceneDocument;
      const next = {...doc,scenarios:doc.scenarios.with(-1,{...doc.scenarios.at(-1)!,id,...(budget !== undefined && {budget})})};
      const put = await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":get.headers.get("ETag")!},body:JSON.stringify(next)});
      if (!put.ok) throw new Error(await put.text());
    },{id,budget});
    await updateOtherTab("공유망 이름 변경");
    await panel.getByText("구매 목록 편집",{exact:true}).click();
    const limit = panel.getByLabel("상품 예산 상한 (USD)");
    const save = panel.getByRole("button",{name:"상한 저장"});
    const storage = page.locator("#storage-status");
    await limit.fill("121");
    await save.click();
    await storage.getByText(/저장됨|다시 적용하지 못한 편집/).waitFor();
    const readSaved = () => page.evaluate(async () => (await (await fetch("/api/scenes/budget-race")).json() as SceneDocument).scenarios.at(-1));
    assert.equal((await readSaved())?.budget,121);
    await panel.getByRole("heading",{name:"공유망 이름 변경",exact:true}).waitFor();
    await updateOtherTab("공유망 이름 변경",122);
    await limit.fill("123");
    await save.click();
    await panel.getByText(/다시 적용하지 못한 편집/).waitFor();
    assert.equal((await readSaved())?.budget,122);
    await page.screenshot({path:resolve("work/m6-budget-conflict.png")});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("T9 안전한 범위의 수동 단가·할인을 센트로 그대로 저장하고 초과액은 입력 오류로 표시한다",async () => {
  const {page} = await edge.newPage("/");
  try {
    await page.getByRole("button",{name:"구매 예산",exact:true}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("수동 견적 입력",{exact:true}).click();
    await panel.getByLabel("견적 모델").selectOption("network-copper@1");
    await panel.getByLabel("판매처",{exact:true}).fill("센트 확인점");
    await panel.getByLabel("상품 번호").fill("high-cents");
    const price = panel.getByLabel("판매 단가 (USD)");
    const discount = panel.getByLabel("묶음당 확인된 할인 (USD)");
    const save = panel.getByRole("button",{name:"견적 저장"});
    await price.fill("70368744177664.01");
    await discount.fill("70368744177664.01");
    await save.click();
    await panel.getByText("견적을 저장했습니다.",{exact:true}).waitFor();
    const sold = await page.evaluate(async () => (await (await fetch("/api/prices")).json()).quotes.find((q: {productId:string}) => q.productId === "high-cents"));
    assert.equal(sold.unitPriceCents,7_036_874_417_766_401);
    assert.equal(sold.discountCents,7_036_874_417_766_401);
    await price.fill("90071992547409.92");
    await save.click();
    await panel.getByText(/안전하게 저장할 수 있는 금액/).waitFor();
  } finally { await page.close(); }
});
