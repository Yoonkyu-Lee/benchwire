// 목표를 작업대에서 편집·저장하고 같은 시나리오의 근거와 구매 예산을 확인한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { edgeSession, waitForAssessment } from "./edge-session.ts";
import type { Library, SceneDocument } from "./document.ts";

const edge = edgeSession();
test("목표 체크리스트에서 추가·수정·근거·삭제와 동시 편집 뒤 예산을 확인한다", async () => {
  const {page,errors} = await edge.newPage("/");
  try {
    const open = page.getByRole("button",{name:"목표 체크리스트",exact:true});
    await open.click({timeout:3500});
    const panel = page.getByRole("dialog",{name:"목표 체크리스트"});
    await panel.getByRole("button",{name:"목표 추가"}).click();
    await panel.getByLabel("목표 이름").fill("동시 전송");
    await panel.getByLabel("목표 종류").selectOption("metric");
    await panel.getByRole("checkbox").first().check();
    await panel.getByLabel("하한",{exact:true}).fill("1");
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await panel.getByRole("heading",{name:"동시 전송"}).waitFor();
    await page.locator("#storage-status").getByText("저장됨",{exact:true}).waitFor();
    await panel.getByRole("button",{name:"편집",exact:true}).click();
    await panel.getByLabel("목표 이름").fill("전송 확인");
    // 다른 탭에서 시나리오 이름과 상한을 바꿔도 같은 ID의 목표 편집은 함께 저장된다.
    await page.evaluate(async () => {
      const path="/api/scenes/network-copy", res=await fetch(path), doc=await res.json() as SceneDocument;
      doc.scenarios[0]!.budget=35;
      doc.scenarios[0]!.name="전력과 데이터 동시 측정";
      const put=await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json","If-Match":res.headers.get("etag")!},body:JSON.stringify(doc)});
      if (!put.ok) throw new Error(await put.text());
    });
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await page.locator("#storage-status").getByText("저장됨",{exact:true}).waitFor();
    await panel.getByText(/예산.*이내/).waitFor({timeout:4000});
    await panel.getByText("전력과 데이터 동시 측정",{exact:true}).waitFor({timeout:4000});
    await page.reload();
    await waitForAssessment(page);
    await open.click();
    await panel.getByRole("heading",{name:"전송 확인"}).waitFor({timeout:5000});
    await panel.getByText("전력과 데이터 동시 측정",{exact:true}).waitFor();
    await panel.getByText(/예산.*이내/).waitFor();
    await page.screenshot({path:resolve("work/목표-체크리스트.png")});
    await panel.getByRole("button",{name:/작업 근거/}).first().click();
    await page.locator("#results-panel:visible").waitFor();
    const scenario=page.locator(".scenario-panel").first();
    await scenario.locator("summary").first().click();
    await scenario.locator(".scenario-member input[type=checkbox]").first().uncheck();
    await scenario.getByRole("button",{name:"시나리오 적용"}).click();
    await scenario.getByRole("button",{name:"전송 확인 목표 편집"}).waitFor();
    await page.screenshot({path:resolve("work/목표-참조멤버-편집.png")});
    await scenario.getByRole("button",{name:"전송 확인 목표 편집"}).click({timeout:4000});
    await panel.getByLabel("목표 이름").waitFor();
    await panel.getByRole("button",{name:"취소"}).click();
    await panel.getByRole("button",{name:"삭제",exact:true}).click();
    await panel.getByText("등록한 목표가 없습니다.").waitFor();
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("체크리스트에서 여러 작업의 같은 포트를 지정하고 작업·시나리오 목표를 구별한다",async () => {
  const {page,errors}=await edge.newPage("/");
  try {
    await page.getByRole("button",{name:"목표 체크리스트"}).click();
    const panel=page.getByRole("dialog",{name:"목표 체크리스트"});
    async function start(kind:string,name:string) {
      await panel.getByRole("button",{name:"목표 추가"}).click();
      await panel.getByLabel("목표 이름").fill(name);
      await panel.getByLabel("목표 종류").selectOption(kind);
    }
    await start("port","한 포트로 전력과 데이터");
    await panel.getByLabel("poe-12",{exact:true}).check();
    await panel.getByLabel("poe-ethernet",{exact:true}).check();
    await panel.getByLabel("기준 실물").selectOption("pd");
    await panel.getByLabel("포트",{exact:true}).selectOption("pd");
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await panel.getByText(/✅ 달성 · .* · 포트 pd/).waitFor();
    await start("port","케이블 자체의 단일 포트");
    await panel.getByLabel("poe-12",{exact:true}).check();
    await panel.getByLabel("기준 실물").selectOption("poe-wire");
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await panel.getByText(/poe-12 · 포트 a ↔ b · 연결 poe/).waitFor();
    await page.screenshot({path:resolve("work/목표-중간부품-포트.png")});
    await start("workload","LAN 전송");
    await panel.getByLabel("작업",{exact:true}).selectOption("lan-a");
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await panel.getByText("❌ 미달 · 작업 성립",{exact:true}).waitFor();
    await start("scenario","전체 작업 성립");
    await panel.getByRole("button",{name:"목표 저장"}).click();
    await panel.getByText("❌ 미달 · 모든 작업 성립",{exact:true}).waitFor();
    await page.screenshot({path:resolve("work/목표-포트와-작업.png")});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("충돌 후보가 목표를 놓친 작업과 그 세계의 값을 체크리스트에 함께 표시한다",async () => {
  const {page,errors}=await edge.newPage("/");
  try {
    await page.evaluate(async () => {
      const doc: SceneDocument = await (await fetch("/api/scenes/network")).json();
      doc.sceneId="goal-witness";
      doc.sources.push({...doc.sources[0]!,id:"other"});
      const watts=doc.workloads.find(w=>w.id==="poe-12")!.request.watts!;
      watts.conflicts=[{value:8,confidence:"review",sources:["other"]}];
      doc.scenarios=[{id:"충돌",members:["poe-12"],goals:[{id:"충전",kind:"metric",workloads:["poe-12"],
        metric:"delivery",unit:"W",run:"together",minimum:10}]}];
      const put=await fetch("/api/scenes/goal-witness",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(doc)});
      if (!put.ok) throw new Error(await put.text());
    });
    await page.reload();
    await page.getByLabel("장면",{exact:true}).selectOption("goal-witness");
    await waitForAssessment(page);
    await page.getByRole("button",{name:"목표 체크리스트"}).click();
    const panel=page.getByRole("dialog",{name:"목표 체크리스트"});
    await panel.getByText(/미달 후보 .*watts=8.*poe-12 ≤ 8 W/).waitFor({timeout:5000});
    await page.screenshot({path:resolve("work/목표-후보별-미달.png")});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("목표 검산의 조합 상한과 열린 수를 구별하고 해당 주장의 확인 퀘스트를 연다",async()=>{
  const {page,errors}=await edge.newPage("/");
  try {
    await page.evaluate(async()=>{
      const library:Library=await (await fetch("/api/library")).json();
      const base:SceneDocument=await (await fetch("/api/scenes/three-ports")).json();
      const put=async(path:string,body:unknown)=>{
        const r=await fetch(path,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        if (!r.ok) throw Error(await r.text());
      };
      for (const revision of ["open-capacity","finite-grid","mixed"]) {
        const doc=structuredClone(base), item=doc.items.find(i=>i.instanceId==="supply")!;
        const model=structuredClone(library.models.find(m=>m.modelId===item.modelId && m.revision===item.revision)!);
        item.revision=model.revision=revision;
        const work=doc.workloads[0]!;
        doc.sceneId="goal-"+revision;
        doc.connections=doc.connections.slice(0,1); doc.workloads=[work];
        doc.scenarios=[{id:"충전 검증",members:[work.id],goals:[{id:"충전 성립",kind:"workload",workload:work.id}]}];
        if (revision==="open-capacity") model.resources![0]!.capacity.value=null;
        else {
          model.ports[0]!.interfaces![0]!.params.pdo20!.value=null;
          doc.sources.push({...doc.sources[0]!,id:"other"});
          work.request.loadW!.conflicts=[{value:33,sources:["other"],confidence:"review"}];
          if (revision==="mixed") work.request.targetW!.value=null;
        }
        await put("/api/models/"+model.modelId+"/"+revision,model);
        await put("/api/scenes/"+doc.sceneId,doc);
      }
    });
    await page.reload();
    const panel=page.getByRole("dialog",{name:"목표 체크리스트"});
    async function checklist(id:string) {
      await page.getByLabel("장면",{exact:true}).selectOption("goal-"+id);
      await waitForAssessment(page);
      await page.getByRole("button",{name:"목표 체크리스트",exact:true}).click();
      await panel.getByText("❓ 미확인 · 작업 성립",{exact:true}).waitFor();
    }
    await checklist("finite-grid");
    await panel.getByText("후보 조합 수가 검산 상한을 넘었습니다.").waitFor({timeout:4000});
    assert.doesNotMatch(await panel.innerText(),/규격 걸음/);
    await panel.getByText("조합을 이루는 주장 2개",{exact:true}).click();
    await panel.getByRole("button",{name:/20 V 송전 PDO 확인 퀘스트/}).click();
    const quests=page.getByRole("dialog",{name:"검증 퀘스트"});
    await quests.locator("details[open] > summary").filter({hasText:"20 V 송전 PDO"}).waitFor();
    await quests.getByRole("button",{name:"닫기",exact:true}).click();
    await checklist("open-capacity");
    const quest=panel.getByRole("button",{name:/100 W 충전기.*총 출력.*확인 퀘스트/});
    await quest.waitFor({timeout:4000});
    assert.match(await panel.innerText(),/규격 걸음이 없어 모든 값을 확인할 수 없습니다/);
    assert.doesNotMatch(await panel.innerText(),/검산 상한/);
    await quest.click();
    const card=page.getByRole("dialog",{name:"검증 퀘스트"}).locator("details[open]").filter({has:page.locator("summary").filter({hasText:"총 출력"})});
    await card.getByText(/충전기의 표시나 설명서/).waitFor();
    assert.match(await card.locator("summary").first().innerText(),/100 W 충전기/);
    await page.getByRole("dialog",{name:"검증 퀘스트"}).getByRole("button",{name:"닫기",exact:true}).click();
    await checklist("mixed");
    await panel.getByText("후보 조합 수가 검산 상한을 넘었습니다.").waitFor();
    await panel.getByText(/대기.*목표 순충전.*규격 걸음이 없어/).waitFor();
    assert.equal(await panel.getByRole("button",{name:/확인 퀘스트 열기/}).count(),1);
    await panel.getByText("조합을 이루는 주장 2개",{exact:true}).click();
    await page.screenshot({path:resolve("work/16차-미완료사유.png")});
    await panel.getByRole("button",{name:/목표 순충전 확인 퀘스트/}).click();
    const request=page.getByRole("dialog",{name:"검증 퀘스트"}).locator("details[open]").filter({has:page.locator("summary").filter({hasText:"목표 순충전"})});
    await request.getByRole("button",{name:"작업 편집"}).click();
    await page.getByRole("dialog",{name:"검증 퀘스트"}).waitFor({state:"hidden"});
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
});
