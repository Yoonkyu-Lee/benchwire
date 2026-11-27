// 실제 추천 카드를 눌러 비교한 사본을 저장하고 같은 목표·기술 결과·구매 예산을 다시 검사한다.
import assert from "node:assert/strict";
import {test} from "node:test";
import type { Page } from "playwright";
import {testEdgeSession,waitForAssessment} from "./edge-session.ts";
import {modelKey,type Library,type Model,type SceneDocument} from "./document.ts";
import {plugins} from "../domains/registry.ts";
import {evaluate} from "../engine/evaluate.ts";
import {loadSceneDocuments} from "../scene/load.ts";

test("추천 탭에서 달성한 목표와 비용을 확인한 사본을 그대로 저장한다",{timeout:30_000},async t=>{
  const edge = await testEdgeSession(t);
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


test("추천 탭은 최대 여덟 편집을 검산하고 미완료 사유와 퀘스트를 보여 준다", { timeout: 35_000 }, async t => {
  const edge = await testEdgeSession(t);
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
    for (const port of model.ports.filter(p=>p.id==="lan-a" || p.id==="lan-b"))
      Object.assign(port.interfaces[0]!.params.baseTModes!,{value:null,confidence:"unknown"});
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
    assert.match(await first.innerText(), /조합.*상한/);
    assert.match(await first.innerText(), /확인 퀘스트.*지원 BASE-T 모드/);
    assert.doesNotMatch(await first.innerText(), /이 아이템으로 해결|이 조건에서 가능/);
    await page.screenshot({ path: "work/recommend-incomplete.png" });

    await scenes.selectOption("three-ports");
    await waitForAssessment(page);
    await recommend.click();
    await panel.getByText(/^표시할 추천 장비가 없습니다\./).waitFor();
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
      await panel.getByText(/^표시할 추천 장비가 없습니다\./).waitFor();
      assert.equal(await panel.getByRole("article").count(), 0);
    } finally { release(); }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});



async function putReviewInputs(page: Page, inputs: readonly (readonly [string, unknown])[]) {
  const origin = new URL(page.url()).origin;
  for (const [path, data] of inputs) {
    const response = await page.request.put(origin + path, { headers: { Origin: origin }, data });
    assert.ok(response.ok(), await response.text());
  }
}

async function openReviewScene(page: Page, sceneId: string) {
  await page.reload();
  await page.locator(".surface").waitFor();
  await page.getByLabel("장면", { exact: true }).selectOption(sceneId);
  await waitForAssessment(page);
}

async function reviewCard(page: Page, model: Model, doc: SceneDocument) {
  const item = { instanceId: "review-" + model.revision, modelId: model.modelId, revision: model.revision, state: "owned" };
  await putReviewInputs(page, [["/api/models/" + model.modelId + "/" + model.revision, model],
    ["/api/inventory/" + item.instanceId, item], ["/api/scenes/" + doc.sceneId, doc]]);
  await openReviewScene(page, doc.sceneId);
  await page.getByRole("button", { name: "추천", exact: true }).click();
  const panel = page.locator(".recommendations");
  await panel.getByText(/^후보 \d+개 중 \d+개 확인$/).waitFor();
  const card = panel.getByRole("article").filter({ hasText: model.name });
  assert.equal(await card.count(), 1, await panel.innerText());
  return card;
}

test("추천 카드에 모든 시나리오의 작업 판정과 목표 회귀를 표시한다", { timeout: 30_000 }, async t => {
  const edge = await testEdgeSession(t);
  const { page, errors } = await edge.newPage("/");
  try {
    const origin = new URL(page.url()).origin;
    const library = await (await page.request.get(origin + "/api/library")).json() as Library;
    const doc = await (await page.request.get(origin + "/api/scenes/network")).json() as SceneDocument;
    const model = structuredClone(library.models.find(m => m.modelId === "network-router")!);
    model.revision = "drops-concurrent";
    model.name = "시험 전송 중단 스위치";
    model.ports.find(p => p.id === "lan-b")!.interfaces[0]!.params.baseTModes!.value = "100BASE-TX";
    const goal = { id: "공통목표", label: "A 전송 확보", kind: "metric", unit: "Mbps", minimum: 800,
      metric: "delivery", run: "together", workloads: ["lan-a"] } as const;
    doc.sceneId = "recommend-regressions";
    doc.scenarios[0]!.goals = [{ ...goal, workloads: ["lan-a"] }];
    doc.scenarios.push({ id: "b-alone", name: "B 단독", members: ["lan-b"],
      goals: [{ ...goal, label: "B 전송 유지", minimum: 500, workloads: ["lan-b"] }] });
    const card = await reviewCard(page, model, doc);
    const text = await card.innerText();
    assert.match(text, /목표는 달성, 다른 작업이 깨짐.*A 전송 확보/);
    assert.doesNotMatch(text, /이 아이템으로 해결/);
    assert.match(text, /PoE와 업링크 동시 사용 · lan-b · 동시.*조건부.*600 Mbps → .*불가.*0 Mbps/);
    assert.match(text, /B 단독 · lan-b · 동시.*900 Mbps → .*불가.*0 Mbps/);
    assert.match(text, /B 단독 · B 전송 유지 · .*달성 → .*미달/);
    await page.screenshot({ path: "work/recommend-regressions.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("조건부 추천에서 값마다 실물과 포트를 확인하는 퀘스트를 연다", { timeout: 30_000 }, async t => {
  const edge = await testEdgeSession(t);
  const { page, errors } = await edge.newPage("/");
  try {
    const origin = new URL(page.url()).origin;
    const library = await (await page.request.get(origin + "/api/library")).json() as Library;
    const doc = await (await page.request.get(origin + "/api/scenes/network")).json() as SceneDocument;
    const model = structuredClone(library.models.find(m => m.modelId === "network-router")!);
    model.revision = "two-links";
    model.name = "시험 포트 둘 스위치";
    for (const [id, value, alternate] of [["lan-a", "1000BASE-T", "100BASE-TX"], ["lan-b", "100BASE-TX", "1000BASE-T"]] as const) {
      const port = model.ports.find(p => p.id === id)!;
      port.label = "LAN";
      const claim = port.interfaces[0]!.params.baseTModes!;
      claim.value = value;
      claim.conflicts = [{ value: alternate, confidence: "review", sources: [...claim.sources] }];
    }
    doc.sceneId = "recommend-condition-targets";
    doc.scenarios[0]!.goals = [{ id: "전송 확보", kind: "metric", unit: "Mbps", minimum: 800,
      metric: "delivery", run: "together", workloads: ["lan-a"] },
      { id: "B 연결", kind: "workload", workload: "lan-b" }];
    const card = await reviewCard(page, model, doc);
    await card.getByText(/이 조건에서 가능.*전송 확보/).waitFor();
    const text = await card.innerText();
    assert.match(text, /시험 포트 둘 스위치 · LAN \(lan-a\) · Ethernet · 지원 BASE-T 모드 = 1000BASE-T/);
    assert.match(text, /시험 포트 둘 스위치 · LAN \(lan-b\) · Ethernet · 지원 BASE-T 모드 = 100BASE-TX/);
    await card.getByText("이 조건에서 가능 · B 연결", { exact: true }).waitFor();
    const nameA = "전송 확보 · 시험 포트 둘 스위치 · LAN (lan-a) · Ethernet · 지원 BASE-T 모드 = 1000BASE-T 확인 퀘스트";
    const nameB = "B 연결 · 시험 포트 둘 스위치 · LAN (lan-a) · Ethernet · 지원 BASE-T 모드 = 100BASE-TX 확인 퀘스트";
    const button = (name: string) => card.getByRole("button", { name, exact: true });
    assert.equal(await button(nameA).count(), 1);
    assert.equal(await button(nameB).count(), 1);
    assert.equal(await button("전송 확보 · 시험 포트 둘 스위치 · LAN (lan-b) · Ethernet · 지원 BASE-T 모드 = 100BASE-TX 확인 퀘스트").count(), 1);
    await button(nameA).click();
    const detailA = card.getByRole("region", { name: nameA, exact: true });
    await detailA.waitFor();
    assert.match(await detailA.innerText(), /1000BASE-T/);
    const detailB = card.getByRole("region", { name: nameB, exact: true });
    assert.equal(await detailB.count(), 0);
    await button(nameB).click();
    await detailB.waitFor();
    assert.match(await detailB.innerText(), /100BASE-TX/);
    await card.screenshot({ path: "work/recommend-duplicate-port-labels.png" });

    const open = structuredClone(model);
    open.revision = "two-links-unverified";
    for (const port of open.ports.filter(p => p.label === "LAN")) {
      const claim = port.interfaces[0]!.params.baseTModes!;
      Object.assign(claim, { value: null, confidence: "unknown" });
      delete claim.conflicts;
    }
    doc.sceneId = "test-port-checklist";
    doc.items.find(item => item.instanceId === "router")!.revision = open.revision;
    await putReviewInputs(page, [["/api/models/" + open.modelId + "/" + open.revision, open], ["/api/scenes/" + doc.sceneId, doc]]);
    await openReviewScene(page, doc.sceneId);
    await page.getByRole("button", { name: "목표 체크리스트", exact: true }).click();
    const checklist = page.getByRole("dialog", { name: "목표 체크리스트" });
    const goal = checklist.getByRole("article").filter({ has: page.getByRole("heading", { name: "전송 확보", exact: true }) });
    await goal.getByText("조합을 이루는 주장 2개",{exact:true}).click();
    await goal.getByRole("button", { name: /LAN \(lan-a\).*지원 BASE-T 모드 확인 퀘스트 열기/ }).click();
    const quests = page.getByRole("dialog", { name: "검증 퀘스트" });
    for (const id of ["lan-a", "lan-b"]) {
      await quests.locator("summary").filter({ hasText: new RegExp("LAN \\(" + id + "\\).*Ethernet") }).waitFor();
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});



test("전달량 상한만 줄면 정보로 표시하고 보장 하한이 줄 때만 순위를 낮춘다", { timeout: 30_000 }, async t => {
  const edge = await testEdgeSession(t);
  const { page, errors } = await edge.newPage("/");
  try {
    const origin = new URL(page.url()).origin;
    const library = await (await page.request.get(origin + "/api/library")).json() as Library;
    const doc = await (await page.request.get(origin + "/api/scenes/network")).json() as SceneDocument;
    const source = structuredClone(library.models.find(m => m.modelId === "network-router")!);
    source.revision = "range-before";
    source.name = "시험 원본 스위치";
    function addPortLimit(port: string, value: number, upper?: number) {
      const resource = structuredClone(source.resources[0]!);
      resource.id = port + "-limit";
      resource.capacity.value = value;
      if (upper !== undefined) resource.capacity.conflicts = [{ value: upper, confidence: "review", sources: [...resource.capacity.sources] }];
      source.resources.push(resource);
      const edge = source.edges.find(e => e.id === port + "-fabric")!;
      edge.uses.push({ resource: resource.id, evidence: edge.evidence });
    }
    addPortLimit("lan-a", 300);
    addPortLimit("lan-b", 600, 800);
    const wide = structuredClone({ ...source, revision: "range-kept", name: "시험 범위 유지 스위치" });
    wide.resources.find(r => r.id === "lan-a-limit")!.capacity.value = 1000;
    const narrow = structuredClone({ ...wide, revision: "range-upper", name: "시험 상한 축소 스위치" });
    narrow.resources.find(r => r.id === "lan-b-limit")!.capacity.conflicts![0]!.value = 700;
    const lower = structuredClone({ ...wide, revision: "range-lower", name: "시험 하한 축소 스위치" });
    lower.resources.find(r => r.id === "lan-b-limit")!.capacity.value = 550;
    const goal = { kind: "metric", metric: "delivery", unit: "Mbps", run: "together" } as const;
    doc.sceneId = "recommend-ranges";
    doc.items.find(i => i.instanceId === "router")!.revision = source.revision;
    doc.scenarios = [
      { id: "a-use", name: "A 작업", members: ["lan-a"], goals: [{ ...goal, id: "A-800", minimum: 800, workloads: ["lan-a"] }] },
      { id: "b-use", name: "B 작업", members: ["lan-b"], goals: [{ ...goal, id: "B-500", minimum: 500, workloads: ["lan-b"] }] },
    ];
    await putReviewInputs(page, [source, wide, lower].map(model => ["/api/models/" + model.modelId + "/" + model.revision, model]));
    const card = await reviewCard(page, narrow, doc);
    const text = await card.innerText();
    assert.match(text, /이 아이템으로 해결 · A-800/);
    assert.match(text, /B 작업 · lan-b · 동시 · 전달량 상한 감소 · .*조건부 · 600–800 Mbps → .*조건부 · 600–700 Mbps/);
    assert.doesNotMatch(text, /다른 작업이 깨짐|B-500|미달/);
    const cards = page.locator(".recommendations").getByRole("article");
    assert.match(await cards.first().innerText(), /시험 상한 축소 스위치/);
    const lowerText = await cards.filter({ hasText: lower.name }).innerText();
    assert.match(lowerText, /목표는 달성, 다른 작업이 깨짐 · A-800/);
    assert.match(lowerText, /B 작업 · lan-b · 동시 · .*조건부 · 600–800 Mbps → .*조건부 · 550–800 Mbps/);
    assert.doesNotMatch(lowerText, /B-500|미달/);
    await card.screenshot({ path: "work/recommend-upper-bound.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
