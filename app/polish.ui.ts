// 처음 쓰는 사용자의 연결·배치·검증·비교 흐름을 Edge에서 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright";
import type { Library, SceneDocument } from "./document.ts";
import { edgeSession, waitForAssessment } from "./edge-session.ts";

const edge = edgeSession();
const button = (root: Page | Locator, name: string | RegExp) => root.getByRole("button", { name, exact: typeof name === "string" });
const panel = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
const evidence = (page: Page) => page.getByRole("region", { name: "선택한 항목 근거", exact: true });
const port = (page: Page, item: string, id: string) => page.locator('[data-item="'+item+'"][data-port="'+id+'"]');

async function get<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(new URL(path,page.url()).href);
  assert(res.ok());
  return await res.json() as T;
}
async function put(page: Page, path: string, data: unknown) {
  const res = await page.request.put(new URL(path,page.url()).href,{ headers:{ Origin:new URL(page.url()).origin },data });
  assert(res.ok(),await res.text());
}
async function open(page: Page, id: string) {
  await page.reload();
  const scenes=page.getByLabel("장면",{exact:true});
  if (await scenes.inputValue()!==id) await scenes.selectOption(id);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#app")?.inert);
  await waitForAssessment(page);
}
async function chargeScene(page: Page,id: string,field: "capacity" | "maxW") {
  const base=await get<SceneDocument>(page,"/api/scenes/three-ports");
  const lib=await get<Library>(page,"/api/library");
  const source=structuredClone(lib.models.find(m=>m.modelId==="supply")!);
  source.modelId=id;
  source.name="이름이 있는 연습 충전기";
  const claim=field==="capacity" ? source.resources[0]!.capacity : source.ports[0]!.interfaces[0]!.params.maxW!;
  Object.assign(claim,{ value:null, confidence:"unknown" });
  await put(page,"/api/models/"+id+"/1",source);
  const scene={...base,sceneId:id,items:base.items.map(i=>i.instanceId==="supply" ? {...i,alias:"",modelId:id}:i)};
  await put(page,"/api/scenes/"+id,scene);
  await open(page,id);
}

test("전력 장비 두 대에 영상 예제 USB-C 케이블을 끼워 공용 결합 근거를 본다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    const base=await get<SceneDocument>(page,"/api/scenes/three-ports");
    const id="polish-cross-usbc";
    await put(page,"/api/scenes/"+id,{...base,sceneId:id,items:base.items.filter(i=>["supply","a"].includes(i.instanceId)),
      connections:[],workloads:[],scenarios:[],layout:{placements:[{instanceId:"supply",x:10,y:30},{instanceId:"a",x:600,y:30}]}});
    await open(page,id);
    const cable=page.locator("[data-inventory]").filter({ has:page.getByText("USB-C 영상 케이블",{exact:true}) });
    await button(cable,"연결에 사용").click();
    await port(page,"supply","a").press("Enter");
    await port(page,"a","in").press("Space");
    await page.locator('[data-connection="connection-1"]').first().waitFor({timeout:1800});
    await page.getByText("저장됨",{exact:true}).waitFor();
    await waitForAssessment(page);
    const lib=await get<Library>(page,"/api/library");
    assert.equal(lib.connectors.connectors.filter(c=>c.glyph==="usb-c").length,2);
    assert(lib.connectors.sources.some(row=>row.title.includes("USB Type-C") && row.title.includes("§")));
    await page.screenshot({path:"work/polish-cross-usbc.png"});
  }finally{await page.close();}
});

test("첫 인벤토리에서 수전 기기와 USB-C 전력 케이블을 바로 배치에 쓸 수 있다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    await open(page,"three-ports");
    for(const [name,action] of [["연습용 수전 기기","캔버스에 놓기"],["연습용 USB-C 전력 케이블","연결에 사용"]] as const){
      const card=page.locator("[data-inventory]").filter({has:page.getByText(name,{exact:true})});
      await button(card,action).waitFor({timeout:1800});
      await card.scrollIntoViewIfNeeded();
    }
    await page.screenshot({path:"work/polish-practice-inventory.png"});
    await button(page,"새 아이템").click();
    const form=panel(page,"새 아이템");
    await button(form,"USB-C 충전기 불러오기").click();
    await form.getByLabel("브랜드",{exact:true}).fill("합성 연습");
    await form.getByLabel("모델 이름",{exact:true}).fill("연습 USB-C 충전기");
    await form.getByLabel("제목",{exact:true}).fill("연습용 포장지");
    await form.getByLabel("주소",{exact:true}).fill("fixture:polish/practice");
    await button(form,"저장하고 배치").click();
    await form.waitFor({state:"hidden"});
    await page.getByText("저장됨",{exact:true}).waitFor();
    const charge=page.locator(".surface .device").filter({has:page.getByText("연습 USB-C 충전기",{exact:true})});
    const chargerId=(await charge.getAttribute("data-instance"))!;
    await button(page.locator('[data-inventory="practice-receiver"]'),"캔버스에 놓기").click();
    await port(page,"practice-receiver","in").waitFor();
    await button(page.locator('[data-inventory="practice-usbc-wire"]'),"연결에 사용").click();
    await port(page,chargerId,"port-1").press("Enter");
    await port(page,"practice-receiver","in").press("Space");
    await page.locator('[data-connection="connection-1"] .wire-name').waitFor();
    await page.getByText("저장됨",{exact:true}).waitFor();
    await waitForAssessment(page);
    await page.screenshot({path:"work/polish-practice-connected.png"});
  }finally{await page.close();}
});

test("배치 단추와 연속 생성기의 카드가 모두 화면 안에서 서로 겹치지 않는다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    const id="polish-spaces";
    await put(page,"/api/scenes/"+id,{sceneId:id,sources:[],items:[],connections:[],workloads:[],scenarios:[]});
    await open(page,id);
    for(const id of ["pse","pd"]){
      await button(page.locator('[data-inventory="'+id+'"]'),"캔버스에 놓기").click();
      await page.locator('[data-instance="'+id+'"]').waitFor();
    }
    for(const n of [1,2]){
      await button(page,"새 아이템").click();
      const form=panel(page,"새 아이템");
      await form.getByLabel("복제할 모델 판본").selectOption("network-host@1");
      await button(form,"모델 복제").click();
      await form.getByLabel("모델 이름",{exact:true}).fill("연습 단말 "+n);
      await button(form,"저장하고 배치").click();
      await form.waitFor({state:"hidden"});
      await page.getByText("저장됨",{exact:true}).waitFor();
    }
    const boxes=await page.locator(".surface .device-body").evaluateAll(nodes=>nodes.map(node=>{
      const {left,top,right,bottom}=node.getBoundingClientRect();
      return {left,top,right,bottom};
    }));
    assert.equal(boxes.length,4);
    const bounds=(await page.locator(".surface").boundingBox())!;
    for(const [i,a] of boxes.entries()){
      assert(a.left>=bounds.x && a.top>=bounds.y && a.right<=bounds.x+bounds.width && a.bottom<=bounds.y+bounds.height);
      for(const b of boxes.slice(i+1)) assert(a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top,
        JSON.stringify([a,b]));
    }
    await page.screenshot({path:"work/polish-placement.png"});
  }finally{await page.close();}
});

async function openPoe(page: Page) {
  await open(page,"network");
  await page.locator('[data-connection="poe"] .wire-name').click();
  return evidence(page);
}

test("배선 요약에서 PoE 정방향의 판정과 쓰이지 않는 역방향 능력을 구별한다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    const proof=await openPoe(page);
    await proof.getByRole("heading",{name:"→ 정방향",exact:true}).waitFor({timeout:1600});
    await proof.getByRole("heading",{name:"← 역방향",exact:true}).waitFor();
    await proof.locator(".connection-summary").getByText("PoE 불가 · 연결 능력",{exact:true}).waitFor();
    const reverse=proof.getByText(/PoE 불가.*역방향/u).first();
    assert.match((await reverse.textContent())!,/능력/u);
    assert.doesNotMatch((await reverse.textContent())!,/❌/u);
    await page.screenshot({path:"work/polish-evidence.png"});
  }finally{await page.close();}
});

test("배선을 고르면 협상 출처가 펼쳐지고 표시할 성능 이름표가 보인다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    const proof=await openPoe(page);
    const rows=proof.locator("details.negotiation-evidence");
    assert(await rows.count()>1);
    assert.equal(await proof.locator("details.negotiation-evidence[open]").count(),await rows.count());
    assert(await page.getByText("표시할 성능",{exact:true}).isVisible());
    await proof.getByText("합성 PoE 송전 장치",{exact:true}).first().waitFor();
    await page.getByText("표시할 성능",{exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:"work/polish-evidence-label.png"});
  }finally{await page.close();}
});

test("실물 별칭이 비어도 모델 이름과 포트 이름으로 퀘스트와 펌웨어 칸을 찾는다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    await chargeScene(page,"polish-port-name","maxW");
    await button(page,/^검증 퀘스트/u).click();
    const quest=panel(page,"검증 퀘스트");
    const row=quest.locator("details.quest-card > summary").filter({hasText:/포트 최대 전력.*이름이 있는 연습 충전기.*a/u});
    await row.click({timeout:1700});
    assert.doesNotMatch((await row.textContent())!,/a-power/u);
    await row.locator("..").getByLabel("현재 펌웨어 · 이름이 있는 연습 충전기",{exact:true}).waitFor();
  }finally{await page.close();}
});

test("개인 검증값은 펌웨어 모름과 측정 조건을 함께 저장하고 버전을 기록하면 이력으로 남는다",async()=>{
  const {page}=await edge.newPage("/");
  page.setDefaultTimeout(5500);
  try{
    const id="polish-unknown-firmware";
    await chargeScene(page,id,"capacity");
    await button(page,/^검증 퀘스트/u).click();
    const quest=panel(page,"검증 퀘스트");
    const headline=quest.locator("details.quest-card > summary").filter({hasText:/총 출력/u}).first();
    await headline.click();
    const card=headline.locator("..");
    await card.getByLabel("총 출력 (W)",{exact:true}).fill("65");
    await card.getByLabel("측정 조건",{exact:true}).fill("대기");
    const firmware=card.locator('select[aria-label^="현재 펌웨어"]');
    await firmware.selectOption({label:"모름"},{timeout:1800});
    await card.getByText(/펌웨어를 기록하면.*적용/u).waitFor();
    await page.screenshot({path:"work/polish-firmware.png"});
    await button(card,"검증값 저장").click();
    await button(quest,"닫기").click();
    await page.getByText("저장됨",{exact:true}).waitFor();
    await waitForAssessment(page);
    const saved=await get<SceneDocument>(page,"/api/scenes/"+id);
    assert.equal(saved.personal?.[0]?.claim.value,65);
    assert.equal(saved.personal?.[0]?.measurementCondition,"대기");
    assert.equal(saved.personal?.[0]?.firmware,undefined);
    const supply=page.locator('[data-instance="supply"]');
    await supply.getByText("전력 예산 65 W",{exact:true}).waitFor();
    await button(page,/^검증 퀘스트/u).click();
    await quest.getByText("실물의 현재 펌웨어 · 측정 조건",{exact:true}).click();
    await quest.getByLabel("실물",{exact:true}).selectOption("supply");
    await quest.getByLabel("현재 펌웨어 상태",{exact:true}).selectOption("value");
    await quest.getByLabel("현재 펌웨어",{exact:true}).fill("2.0");
    await button(quest,"실물 상태 적용").click();
    await button(quest,"닫기").click();
    await page.getByText("저장됨",{exact:true}).waitFor();
    await waitForAssessment(page);
    await supply.getByText("전력 예산 미확인",{exact:true}).waitFor();
    await button(page,"결과 · 근거").click();
    await page.locator(".result-list").first().getByRole("button").first().click();
    await evidence(page).getByText(/적용 안 됨.*펌웨어 미확인/u).waitFor();
    await page.screenshot({path:"work/polish-firmware-history.png"});
  }finally{await page.close();}
});

test("충전기 템플릿은 한 포트 기본값으로 바로 불러올 수 있다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    await button(page,"새 아이템").click();
    const form=panel(page,"새 아이템");
    assert.equal(await form.getByLabel("충전기 포트 수").inputValue(),"1");
    await button(form,"USB-C 충전기 불러오기").click();
    await form.getByRole("group",{name:"포트 1",exact:true}).waitFor();
  }finally{await page.close();}
});

test("로드아웃과 슬롯 교체에서 배선의 방향을 표시한다",async()=>{
  const {page}=await edge.newPage("/");
  try{
    const base=await get<SceneDocument>(page,"/api/scenes/network");
    const id="polish-compare-directions";
    await put(page,"/api/scenes/"+id,{...base,sceneId:id,connections:base.connections.filter(c=>c.id!=="poe")});
    await open(page,"network");
    await button(page,"구매 예산").click();
    const budget=panel(page,"구매 예산");
    await budget.getByText("로드아웃 비교",{exact:true}).click();
    await budget.getByLabel("비교할 장면").selectOption(id);
    await budget.getByLabel("비교할 시나리오").selectOption(base.scenarios[0]!.id);
    await button(budget,"두 구성 비교").click();
    await budget.getByText(/^poe → ·/u).first().waitFor({timeout:1800});
    await budget.getByText(/^poe ← ·/u).first().waitFor();
    await budget.getByText(/^poe → ·/u).first().scrollIntoViewIfNeeded();
    await page.screenshot({path:"work/polish-compare.png"});
    await button(budget,"닫기").click();

    const lib=await get<Library>(page,"/api/library");
    const replacement=structuredClone(lib.models.find(model=>model.modelId==="network-pse")!);
    replacement.revision="polish-arrows";
    replacement.resources[0]!.capacity.value=1;
    await put(page,"/api/models/network-pse/"+replacement.revision,replacement);
    await open(page,"network");
    await button(page,"모델").click();
    await page.locator('[data-model-card="network-pse@polish-arrows"]').dragTo(page.locator('[data-instance="pse"] .device-name'));
    const swap=panel(page,"슬롯 교체");
    await swap.getByText(/^poe → ·/u).first().waitFor();
    await page.screenshot({path:"work/polish-swap-compare.png"});
  }finally{await page.close();}
});
