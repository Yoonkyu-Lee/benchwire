// 실제 추천 카드를 눌러 비교한 사본을 저장하고 같은 목표·기술 결과·구매 예산을 다시 검사한다.
import assert from "node:assert/strict";
import {test} from "node:test";
import {edgeSession,waitForAssessment} from "./edge-session.ts";
import {modelKey,type Library,type SceneDocument} from "./document.ts";
import {plugins} from "../domains/registry.ts";
import {evaluate} from "../engine/evaluate.ts";
import {loadSceneDocuments} from "../scene/load.ts";

const edge=edgeSession();
test("추천 탭에서 달성한 목표와 비용을 확인한 사본을 그대로 저장한다",{timeout:30_000},async()=>{
  const {page,errors}=await edge.newPage("/");
  try {
    const origin=new URL(page.url()).origin;
    const get=async(path:string)=>(await page.request.get(origin+path)).json();
    async function put(path:string,data:unknown) {
      const response=await page.request.put(origin+path,{headers:{Origin:origin},data});
      assert.ok(response.ok(),await response.text());
    }
    const library=await get("/api/library") as Library, original=await get("/api/scenes/network") as SceneDocument;
    const model=structuredClone(library.models.find(m=>m.modelId==="network-router")!);
    model.revision="recommend";model.name="시험 고속 스위치";model.resources.forEach(r=>r.capacity.value=3000);
    await put("/api/models/network-router/recommend",model);
    await put("/api/prices",{seller:"시험 매장",saleUnit:1,currency:"USD",stock:"in",retrievedAt:"2026-11-27T00:00:00Z",
      source:"시험 견적",provider:"manual",modelRef:modelKey(model),productId:"빠른 스위치",unitPriceCents:3500});
    original.sceneId="recommend-fixture";
    original.scenarios[0]!.goals=[{id:"업링크 800",kind:"metric",workloads:["lan-a"],minimum:800,metric:"delivery",run:"together",unit:"Mbps"}];
    await put("/api/scenes/"+encodeURIComponent(original.sceneId),original);
    await page.reload();await page.locator(".surface").waitFor();await waitForAssessment(page);
    await page.getByRole("button",{name:"추천",exact:true}).click();
    const card=page.getByRole("article").filter({hasText:"시험 고속 스위치"});
    await card.getByText(/이 아이템으로 해결.*업링크 800/).waitFor({timeout:5000});
    assert.match(await card.innerText(),/35\.00/);
    await page.screenshot({path:"work/추천-검증.png"});
    await card.getByRole("button",{name:"사본 비교"}).click();
    const dialog=page.getByRole("dialog",{name:"슬롯 교체"});
    await dialog.getByText(/비용 차이 \+\$35.00/).waitFor();
    let submitted:SceneDocument|undefined;
    page.on("request",req=>{if(req.method()==="PUT" && req.url().includes("/api/scenes/recommend-")) submitted=req.postDataJSON();});
    const saved=page.waitForResponse(res=>res.request().method()==="PUT" && res.url().includes("/api/scenes/recommend-") && res.status()===201);
    await dialog.getByRole("button",{name:"사본 저장"}).click();
    const copy=await get((await saved).headers().location!) as SceneDocument;
    assert.ok(submitted);
    const docs={models:new Map([...library.models,model].map(m=>[modelKey(m),m])),connectors:library.connectors};
    const judge=(doc:SceneDocument)=>evaluate(loadSceneDocuments(doc,docs,plugins),plugins);
    assert.deepEqual(judge(copy),judge(submitted));
    assert.equal(judge(copy).goals[0]?.verdict,"ok");
    assert.deepEqual(copy.scenarios[0]?.purchases,submitted.scenarios[0]?.purchases);
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
});


test("추천 탭은 최대 여덟 편집을 검산하고 미완료 사유와 퀘스트를 보여 준다", { timeout: 35_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  page.setDefaultTimeout(7_000);
  try {
    const origin = new URL(page.url()).origin;
    const get = async (path: string) => (await page.request.get(origin + path)).json();
    async function put(path: string, data: unknown) {
      const response = await page.request.put(origin + path, { headers: { Origin: origin }, data });
      assert.ok(response.ok(), await response.text());
    }
    const library = await get("/api/library") as Library;
    const original = await get("/api/scenes/network") as SceneDocument;
    const model = structuredClone(library.models.find(m => m.modelId === "network-router")!);
    model.resources.forEach(r => r.capacity.value = 3000);
    const supported = model.ports.find(p => p.id === "lan-a")!.interfaces[0]!.params.baseTModes!;
    Object.assign(supported, { value: null, confidence: "unknown" });
    for (let i = 0; i < 9; i++) {
      const revision = "recommend-open-" + i;
      await put("/api/models/" + model.modelId + "/" + revision, { ...model, revision, name: "모드 확인 스위치 " + i });
    }
    const sceneId = "recommend-incomplete";
    original.sceneId = sceneId;
    original.scenarios[0]!.goals = [{ id: "uplink", label: "A 전송 회복", kind: "metric",
      workloads: ["lan-a"], minimum: 800, metric: "delivery", run: "together", unit: "Mbps" }];
    await put("/api/scenes/" + sceneId, original);
    await page.reload();
    await page.locator(".surface").waitFor();
    await waitForAssessment(page);
    const scenes = page.getByLabel("장면", { exact: true });
    assert.equal(await scenes.inputValue(), sceneId);
    const recommend = page.getByRole("button", { name: "추천", exact: true });
    await recommend.click();

    const panel = page.locator(".recommendations"), status = panel.getByRole("status");
    await panel.getByText(/^후보 \d+개 중 8개 확인$/).waitFor({ timeout: 7000 });
    assert.ok(Number((await status.innerText()).match(/^후보 (\d+)개/)?.[1]) > 8);
    const first = panel.getByRole("article").filter({ hasText: "모드 확인 스위치" }).first();
    await first.getByText("❓ 목표 검산 미완료 · A 전송 회복", { exact: true }).waitFor();
    assert.match(await first.innerText(), /지원 BASE-T 모드의 가능한 값을 모두 확인할 수 없습니다/);
    assert.match(await first.innerText(), /확인 퀘스트.*지원 BASE-T 모드/);
    assert.doesNotMatch(await first.innerText(), /이 아이템으로 해결|이 조건에서 가능/);
    await page.screenshot({ path: "work/recommend-incomplete.png" });

    await scenes.selectOption("three-ports");
    await waitForAssessment(page);
    await recommend.click();
    await panel.getByText("표시할 추천 장비가 없습니다.", { exact: true }).waitFor();
    assert.equal(await panel.getByRole("article").count(), 0);

    let release!: () => void;
    const paused = new Promise<void>(done => { release = done; });
    await page.route("**/api/prices", async route => { await paused; await route.continue(); });
    const requested = page.waitForRequest(r => r.url().endsWith("/api/prices"));
    try {
      await scenes.selectOption(sceneId);
      await waitForAssessment(page);
      await recommend.click();
      await requested;
      const response = page.waitForResponse(r => r.url().endsWith("/api/prices"));
      await scenes.selectOption("three-ports");
      await waitForAssessment(page);
      await recommend.click();
      release();
      assert.ok((await response).ok());
      await panel.getByText("표시할 추천 장비가 없습니다.", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("article").count(), 0);
    } finally { release(); }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
