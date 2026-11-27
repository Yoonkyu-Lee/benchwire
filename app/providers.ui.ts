// 합성 Claude·Products 응답으로 전송 동의, 모델 매칭 확인, 열린 예산과 비교의 견적 만료를 Edge에서 검사한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import extracted from "../fixtures/receipt/response.json" with {type:"json"};
import products from "../fixtures/bestbuy/products.json" with {type:"json"};
import { BESTBUY_TTL, openBestBuy } from "../server/bestbuy.ts";
import { edgeSession, waitForAssessment } from "./edge-session.ts";

const edge = edgeSession();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1sAAAAASUVORK5CYII=","base64");
test("키가 없으면 두 외부 기능의 설정 안내와 수동 견적 입력을 볼 수 있다",async () => {
  const {page} = await edge.newPage("/");
  try {
    await page.getByRole("button",{name:"구매 예산"}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("영수증 · 장바구니 가져오기",{exact:true}).click();
    await panel.getByText(/ANTHROPIC_API_KEY/).waitFor();
    assert.ok(await panel.locator(".receipt button").isDisabled());
    await panel.getByText("Best Buy 상품 검색",{exact:true}).click();
    await panel.getByText(/BESTBUY_API_KEY/).waitFor();
    assert.ok(await panel.locator(".search button").isDisabled());
    await panel.getByText("수동 견적 입력",{exact:true}).click();
    assert.ok(await panel.getByRole("button",{name:"견적 저장"}).isEnabled());
  } finally {await page.close();}
});
test("파일 선택은 전송하지 않고 확인한 모델로 영수증과 보유 실물을 저장한다",async () => {
  await edge.closeServer();
  let calls = 0;
  await edge.openServer({stream:() => ({finalMessage:async () => {
    calls++;
    const rows = extracted.rows.map((r,i) => i === 0 ? {...r,name:"network-host 연습 상품"} : r);
    return {stop_reason:"end_turn",usage:{input_tokens:800,output_tokens:240},content:[{type:"text",text:JSON.stringify({...extracted,rows})}]} as Anthropic.Message;
  }})});
  const {page,errors} = await edge.newPage("/");
  try {
    await page.getByRole("button",{name:"구매 예산"}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("영수증 · 장바구니 가져오기",{exact:true}).click();
    await panel.getByText(/한 장 최대 US\$0.15/).waitFor();
    await panel.getByLabel("이미지 한 장").setInputFiles({name:"demo.png",mimeType:"image/png",buffer:png});
    await panel.getByRole("button",{name:"이미지 읽기"}).click();
    assert.equal(calls,0);
    await panel.getByLabel(/Claude로 보내는 데 동의/).check();
    await panel.getByRole("button",{name:"이미지 읽기"}).click();
    const rows = panel.locator(".review tbody tr"), row = rows.first();
    await panel.getByText(/행 합계와 단가 × 수량 확인 필요/).waitFor();
    await panel.getByText(/수량 10개 확인/).waitFor();
    assert.equal(await row.getByLabel("단가",{exact:true}).inputValue(),"15.00");
    assert.equal(await row.getByLabel("인벤토리 모델").inputValue(),"network-host@1");
    await row.getByLabel("인벤토리 모델").selectOption("network-copper@1");
    await row.getByLabel("인벤토리에도 추가").check();
    await row.getByRole("button",{name:"확인한 행 저장"}).click();
    await row.getByText("저장됨 · network-copper@1").waitFor();
    await panel.getByText(/구매 · 연습 상점.*행 합계 \$30.00/).waitFor();
    assert.equal(calls,1);
    await page.screenshot({path:resolve("work/m6-receipt.png")});
    await panel.getByRole("button",{name:"닫기"}).click();
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/library")).json()).inventory
      .filter((i:{instanceId:string;state:string}) => i.instanceId.startsWith("receipt-") && i.state === "owned").length),2);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("장바구니의 확인한 관측일과 재고로 예산을 계산하고 저장한 행에서 후보 두 개를 추가한다",async () => {
  await edge.closeServer();
  const row = {...extracted.rows[0]!,date:null,stock:"unknown",name:"모형 장바구니 상품"};
  await edge.openServer({stream:() => ({finalMessage:async () => ({
    stop_reason:"end_turn",usage:{input_tokens:400,output_tokens:150},
    content:[{type:"text",text:JSON.stringify({kind:"cart",rows:[row]})}],
  } as Anthropic.Message)})});
  const {page,errors} = await edge.newPage("/");
  try {
    await page.getByRole("button",{name:"구매 예산"}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("영수증 · 장바구니 가져오기",{exact:true}).click();
    // 다른 이미지의 관측 한 건으로 저장한다.
    await panel.getByLabel("이미지 한 장").setInputFiles({name:"cart.png",mimeType:"image/png",
      buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64")});
    await panel.getByLabel(/Claude로 보내는 데 동의/).check();
    await panel.getByRole("button",{name:"이미지 읽기"}).click();
    const parsed = panel.locator(".review tbody tr").first();
    await parsed.getByLabel("인벤토리 모델").selectOption("network-host@1");
    await parsed.getByLabel("구매일 또는 관측일").fill("2025-02-03");
    await parsed.getByLabel("관측일 재고").selectOption("in");
    await parsed.getByRole("button",{name:"확인한 행 저장"}).click();
    const history = panel.locator(".history li").filter({hasText:"모형 장바구니 상품"});
    await history.getByRole("button",{name:"인벤토리에 추가"}).click();
    await history.getByRole("button").waitFor({state:"detached"});
    await panel.getByText("구매 목록 편집",{exact:true}).click();
    await panel.getByLabel("구매할 항목").selectOption({label:"상품 · 연습 상점 / 모형 장바구니 상품"});
    await panel.getByLabel("구매 수량").fill("2");
    await panel.getByRole("button",{name:"목록에 추가"}).click();
    await panel.getByText("확인된 상품 소계 $30.00",{exact:true}).waitFor();
    await panel.locator(".totals").getByText(/2025-02-03 관측 · 오래된 견적/).waitFor();
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/library")).json()).inventory
      .filter((i:{instanceId:string;state:string}) => i.instanceId.startsWith("cart-") && i.state === "candidate").length),2);
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
});

test("T9 Best Buy 가상 견적은 만료 순간 열린 화면과 비교에서 사라지고 구매 목록에는 모델만 남는다",async () => {
  await edge.closeServer();
  let now = Date.UTC(2026,10,27,12);
  const calls: URL[] = [];
  await edge.openServer(null,openBestBuy("fixture",async url => {calls.push(url);return Response.json(products);},() => now));
  const {page,errors} = await edge.newPage("/");
  try {
    await page.route("https://developer.bestbuy.com/**",route => route.fulfill({contentType:"image/png",body:png}));
    const scenePicker = page.getByRole("combobox",{name:"장면",exact:true});
    await page.clock.install({ time: new Date(now - 60_000) });
    await scenePicker.selectOption("network");
    await waitForAssessment(page);
    await page.clock.pauseAt(new Date(now));
    await page.getByRole("button",{name:"구매 예산"}).click();
    const panel = page.getByRole("dialog",{name:"구매 예산"});
    await panel.getByText("Best Buy 상품 검색",{exact:true}).click();
    await panel.getByLabel("연결할 모델").selectOption("network-copper@1");
    await panel.getByLabel("검색할 상품명").fill("모형 케이블");
    await panel.getByRole("button",{name:"Best Buy 검색"}).click();
    await panel.getByRole("button",{name:"선택한 견적 사용"}).click();
    await panel.getByText(/Best Buy 견적을 적용/).waitFor();
    await panel.getByText("구매 목록 편집",{exact:true}).click();
    const model = panel.getByLabel("구매할 항목").locator("option").filter({hasText:/^모델 · .*network-copper@1$/});
    await panel.getByLabel("구매할 항목").selectOption(await model.getAttribute("value") ?? "");
    await panel.getByRole("button",{name:"목록에 추가"}).click();
    await panel.getByText("확인된 상품 소계 $15.25",{exact:true}).waitFor();
    await panel.locator("[data-scene-save-status]").getByText("저장됨", { exact: true }).waitFor();
    await panel.getByText("구매 목록 편집",{exact:true}).click();
    await panel.getByText("Best Buy 상품 검색",{exact:true}).click();
    await panel.getByText("로드아웃 비교",{exact:true}).click();
    await panel.getByLabel("비교할 장면").selectOption("network");
    await panel.getByRole("button",{name:"두 구성 비교"}).click();
    await panel.getByText("가격 차이 −$15.25").waitFor();
    await panel.getByRole("img",{name:"Best Buy Developer API"}).waitFor();
    await page.screenshot({path:resolve("work/m6-bestbuy.png")});
    now += BESTBUY_TTL - 1;
    await page.clock.fastForward(BESTBUY_TTL - 1);
    assert.equal(await page.evaluate(() => Date.now()), now);
    assert.ok(await panel.getByText("확인된 상품 소계 $15.25", { exact: true }).isVisible());
    now++;
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => Date.now()), now);
    await panel.getByText("확인된 상품 소계 $0.00").waitFor();
    await panel.getByText(/가격 미확인 1개/).waitFor();
    assert.doesNotMatch(await panel.innerText(),/15\.25|9000001/);
    await panel.getByRole("button",{name:"두 구성 비교"}).click();
    await panel.getByText("가격 차이 미확인").waitFor();
    assert.equal(calls.length,2);
    const saved = await page.evaluate(async id => (await fetch("/api/scenes/"+encodeURIComponent(id))).text(),await scenePicker.inputValue());
    assert.ok(saved.includes("purchases"));
    assert.doesNotMatch(saved,/9000001|15\.25|Best Buy/);
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});
