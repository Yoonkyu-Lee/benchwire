// 설치된 Edge에서 작업대의 편집 결과와 저장·복구 동작을 검증한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import type { Library, Model, SceneDocument } from "./document.ts";
import { center, edgeSession, viewport, waitForAssessment } from "./edge-session.ts";
import { fixtureClient, recording } from "../fixtures/research/recording.ts";

const edge = edgeSession();
const { newPage, openServer, closeServer } = edge;

function port(page: Page, item: string, id: string) {
  return page.locator(`[data-item="${item}"][data-port="${id}"]`);
}

function closeTo(actual: number, expected: number) {
  assert(Math.abs(actual - expected) < 1, `${actual} ≈ ${expected}`);
}

test("예제 한 케이블의 전력과 네트워크 레이어를 독립적으로 숨기고 복원한다", async () => {
  const { page, errors } = await newPage("/");
  try {
    const wire = page.locator('[data-connection="poe"]');
    assert.equal(await wire.locator(".wire-name").textContent(), "이더넷 케이블");
    assert.equal(await port(page, "pse", "pse").getAttribute("data-face"), "list");
    assert.equal(await port(page, "pse", "pse").locator("path").getAttribute("data-glyph"), "rj45");
    assert.equal(await page.locator('[data-inventory="spare-wire"] strong').textContent(), "예비 이더넷 케이블");
    const power = wire.locator('[data-layer="power"][data-direction="forward"][data-result-kind="negotiation"]');
    const network = wire.locator('[data-layer="network"][data-direction="forward"][data-result-kind="negotiation"]');
    const powerToggle = page.getByRole("button", { name: "전력" });
    const networkToggle = page.getByRole("button", { name: "네트워크" });
    assert(await power.isVisible());
    assert(await network.isVisible());

    await powerToggle.click();
    assert.equal(await powerToggle.getAttribute("aria-pressed"), "false");
    assert(await power.isHidden());
    assert(await network.isVisible());
    await networkToggle.click();
    assert(await wire.locator(".wire-name").isHidden());
    await powerToggle.click();
    await networkToggle.click();
    assert(await power.isVisible());
    assert(await network.isVisible());
    await page.screenshot({ path: "work/m3-canvas.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function movePse(page: Page, dx: number, dy: number, item = "pse") {
  const card = page.locator(`[data-instance="${item}"]`);
  const point = await center(card.locator(".device-name"));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 5 });
  await page.mouse.up();
}

test("예제의 자동 저장은 사본으로 이어지고 새로고침·다른 탭·서버 재시작에서도 장면을 지킨다", async () => {
  const tabs = await edge.browser.newContext({ viewport, deviceScaleFactor: 1 });
  const { page, errors } = await newPage("/", tabs);
  const picker = page.getByRole("combobox", { name: "장면" });
  const card = page.locator('[data-instance="pse"]');
  const exampleId = await picker.inputValue();
  const original = await card.getAttribute("transform");
  let copyId: string;
  let moved: string | null;
  try {
    const creation = page.waitForResponse(response => response.request().method() === "PUT" && response.status() === 201);
    await movePse(page, 42, 26);
    const copy = await (await creation).json();
    await page.getByText("저장됨", { exact: true }).waitFor();
    copyId = await picker.inputValue();
    assert.equal(copyId, copy.sceneId);
    assert.notEqual(copyId, exampleId);
    assert.notEqual(await card.getAttribute("transform"), original);

    const update = page.waitForResponse(response => response.url().endsWith("/api/scenes/" + copyId) && response.status() === 204);
    await movePse(page, 27, 14);
    await update;
    await page.getByText("저장됨", { exact: true }).waitFor();
    moved = await card.getAttribute("transform");
    await page.reload();
    await card.waitFor();
    assert.equal(await picker.inputValue(), copyId);
    assert.equal(await card.getAttribute("transform"), moved);

    const second = (await newPage("/", tabs)).page;
    const newer = page.waitForResponse(response => response.url().endsWith("/api/scenes/" + copyId) && response.status() === 204);
    await movePse(page, 25, -18);
    await newer;
    await page.getByText("저장됨", { exact: true }).waitFor();
    moved = await card.getAttribute("transform");
    const pd = second.locator('[data-instance="pd"]');
    const pdBefore = await pd.getAttribute("transform");
    const stale = second.waitForResponse(r => r.request().method() === "PUT" && r.status() === 412);
    const merged = second.waitForResponse(r => r.request().method() === "PUT" && r.status() === 204, { timeout: 3500 });
    await movePse(second, -18, 30, "pd");
    await stale;
    await merged;
    await second.getByText("저장됨", { exact: true }).waitFor();
    const pdAfter = await pd.getAttribute("transform");
    assert.notEqual(pdAfter, pdBefore);
    assert.equal(await second.locator('[data-instance="pse"]').getAttribute("transform"), moved);
    await second.reload();
    await pd.waitFor();
    assert.equal(await pd.getAttribute("transform"), pdAfter);
    assert.deepEqual(errors, []);
  } finally {
    await tabs.close();
  }

  await closeServer();
  await openServer();
  const restarted = (await newPage("/")).page;
  try {
    assert.equal(await restarted.getByRole("combobox", { name: "장면" }).inputValue(), copyId);
    assert.equal(await restarted.locator('[data-instance="pse"]').getAttribute("transform"), moved);
    await restarted.getByRole("combobox", { name: "장면" }).selectOption(exampleId);
    await restarted.waitForFunction(expected => document.querySelector('[data-instance="pse"]')?.getAttribute("transform") === expected, original);
  } finally { await restarted.close(); }
});

test("잘못된 장면은 서버가 가리킨 필드를 표시하고 마지막 유효한 카드 위치를 되돌린다", async () => {
  const { page } = await newPage("/");
  try {
    const card = page.locator('[data-instance="pse"]');
    const saved = await card.getAttribute("transform");
    await page.route("**/api/scenes/*", async route => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      const draft = route.request().postDataJSON();
      draft.layout.placements[0].instanceId = "missing";
      await route.continue({ postData: JSON.stringify(draft) });
    }, { times: 1 });
    await movePse(page, 33, -12);
    await page.getByText(/layout\.placements\.0\.instanceId/).waitFor();
    assert.equal(await card.getAttribute("transform"), saved);
  } finally { await page.close(); }
});

test("팬·줌 뒤 실물 드롭과 카드 이동을 문서에 담고 다시 열면 같은 위치에 그린다", async () => {
  const { page, errors } = await newPage("/testbed.html");
  try {
    const surface = page.locator(".surface");
    const card = page.locator('[data-instance="a"]');
    const rear = card.locator('.port-face[data-face="rear"]');
    const first = port(page, "a", "p0");
    const listPort = port(page, "a", "p2");
    assert.equal(await first.getAttribute("data-face"), "rear");
    assert.equal(await first.getAttribute("transform"), `translate(${Number(await rear.getAttribute("x")) + 0.2 * Number(await rear.getAttribute("width"))} ${Number(await rear.getAttribute("y")) + 0.5 * Number(await rear.getAttribute("height"))})`);
    assert.equal(await listPort.getAttribute("data-face"), "list");
    assert.equal(await listPort.locator("path").getAttribute("data-glyph"), "neutral");
    assert.match((await listPort.getAttribute("aria-label"))!, /test-connector/);
    const world = page.locator(".world");
    const viewBefore = await world.getAttribute("transform");
    await page.mouse.move(374, 109);
    await page.mouse.down();
    await page.mouse.move(442, 142, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await world.getAttribute("transform"), viewBefore);
    const pannedScale = await world.evaluate((g: SVGGElement) => g.getScreenCTM()!.a);
    await page.mouse.move(772, 347);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(scale => document.querySelector<SVGGElement>(".world")!.getScreenCTM()!.a > scale, pannedScale);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 0);

    const viewportBox = await surface.boundingBox();
    assert(viewportBox);
    const target = { x: 884, y: 575 };
    const expected = await world.evaluate((g: SVGGElement, client) => {
      const point = new DOMPoint(client.x, client.y).matrixTransform(g.getScreenCTM()!.inverse());
      return { x: point.x, y: point.y };
    }, { x: viewportBox.x + target.x, y: viewportBox.y + target.y });
    await page.getByRole("button", { name: "후보", exact: true }).click();
    await page.locator('[data-inventory="d"]').dragTo(surface, { sourcePosition: { x: 70, y: 18 }, targetPosition: target });
    await page.locator('[data-instance="d"]').waitFor();
    const dropped = await page.evaluate(() => window.benchwire.read().layout!.placements!.find(p => p.instanceId === "d")!);
    closeTo(dropped.x, expected.x);
    closeTo(dropped.y, expected.y);

    const header = await center(card.locator(".device-name"));
    const initialTransform = await card.getAttribute("transform");
    const scale = await world.evaluate((g: SVGGElement) => g.getScreenCTM()!.a);
    await page.mouse.move(header.x, header.y);
    await page.mouse.down();
    await page.mouse.move(header.x + 90, header.y + 42, { steps: 9 });
    assert.notEqual(await card.getAttribute("transform"), initialTransform);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 1);
    assert.deepEqual(await page.evaluate(() => window.benchwire.read().layout!.placements!.find(p => p.instanceId === "a")),
      { instanceId: "a", x: 50, y: 50 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 2);
    const placed = await page.evaluate(() => window.benchwire.read().layout!.placements!.find(p => p.instanceId === "a")!);
    closeTo(placed.x, 50 + 90 / scale);
    closeTo(placed.y, 50 + 42 / scale);
    const committedTransform = await card.getAttribute("transform");
    const snapshot = await page.evaluate(() => JSON.stringify(window.benchwire.read()));
    await page.evaluate(json => window.benchwire.open(JSON.parse(json)), snapshot);
    assert.equal(await card.getAttribute("transform"), committedTransform);
    assert.equal(await page.locator('[data-instance="d"]').getAttribute("transform"), `translate(${dropped.x} ${dropped.y})`);
    assert.equal(await page.evaluate(() => JSON.stringify(window.benchwire.read())), snapshot);
    assert.equal(await world.getAttribute("transform"), viewBefore);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("포인터와 키보드로 연결하고 취소하거나 거절한 포트는 비워 둔다", async () => {
  const { page, errors } = await newPage("/testbed.html");
  try {
    const a = port(page, "a", "p0"), b = port(page, "b", "p0"), c = port(page, "c", "p0");
    const cable = page.locator('[data-inventory="wire"]').getByRole("button", { name: "연결에 사용" });
    await cable.click();
    await a.focus();
    await page.keyboard.press("Enter");
    assert.equal(await a.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await a.getAttribute("aria-pressed"), null);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 0);

    await a.press("Enter");
    await c.press("Space");
    assert.match((await page.getByRole("status").textContent())!, /커넥터가 맞지 않습니다.*network-socket/);
    assert.equal(await a.getAttribute("aria-disabled"), "false");
    assert.equal(await c.getAttribute("aria-disabled"), "false");
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 0);
    assert.equal(await page.evaluate(() => window.benchwire.read().items.length), 3);

    const start = await center(a), end = await center(b);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    assert(await page.locator(".connection-preview").getAttribute("d"));
    await page.mouse.up();
    assert.equal(await a.getAttribute("aria-disabled"), "true");
    assert.equal(await b.getAttribute("aria-disabled"), "true");
    const wire = page.locator('[data-connection="connection-1"]');
    const caption = wire.locator(".wire-name");
    assert.equal(await caption.textContent(), "시험 케이블");
    const captionBox = (await caption.boundingBox())!;
    const sourceBox = (await page.locator('[data-instance="a"] .device-body').boundingBox())!;
    const sinkBox = (await page.locator('[data-instance="b"] .device-body').boundingBox())!;
    assert(captionBox.x > sourceBox.x + sourceBox.width);
    assert(captionBox.x + captionBox.width < sinkBox.x);
    const a2 = port(page, "a", "p1"), b2 = port(page, "b", "p1");
    await a2.press("Space");
    await b2.press("Enter");
    assert.equal(await a2.getAttribute("aria-disabled"), "true");
    const edited = await page.evaluate(() => window.benchwire.read());
    assert.equal(edited.connections.length, 2);
    assert.deepEqual(edited.connections[0]!.parts, [{ instanceId: "wire", entry: "a", exit: "b" }]);
    assert.deepEqual(edited.connections[1]!.parts, []);
    assert.equal(edited.sources.filter(source => source.locator === "canvas:placement").length, 1);
    await page.getByRole("button", { name: "추천", exact: true }).click();
    assert.equal(await page.locator(".inventory-empty").textContent(), "표시할 추천 장비가 없습니다.");
    await page.screenshot({ path: "work/m3-canvas-edit.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Mbps·W 작업, 멤버, 우선순위, 미확인 요청을 고쳐 문서 왕복 후 다시 연다", async () => {
  const { page, errors } = await newPage("/testbed.html?example");
  try {
    const panel = page.locator(".scenario-panel");
    await panel.locator("summary").click();
    const selector = panel.getByLabel("현재 시나리오", { exact: true });
    const submitScenario = panel.getByRole("button", { name: "시나리오 적용", exact: true });
    const name = panel.getByLabel("시나리오 이름", { exact: true });
    await panel.getByRole("button", { name: "새 시나리오", exact: true }).click();
    await name.fill("작업 시험");
    await panel.getByRole("button", { name: "시나리오 만들기", exact: true }).click();
    const scenarioId = await selector.inputValue();
    assert.match(scenarioId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(await selector.locator("option:checked").textContent(), "작업 시험");
    async function newWorkload(preset: string, label: string, value: string) {
      await panel.getByRole("button", { name: "새 작업", exact: true }).click();
      await panel.getByLabel("작업 프리셋", { exact: true }).selectOption({ label: preset });
      await panel.getByLabel("출발 실물", { exact: true }).selectOption("pse");
      await panel.getByLabel("출발 포트", { exact: true }).selectOption({ label: "pse" });
      await panel.getByLabel("도착 실물", { exact: true }).selectOption("pd");
      await panel.getByLabel("도착 포트", { exact: true }).selectOption({ label: "pd" });
      await panel.getByLabel(label, { exact: true }).fill(value);
      await panel.getByRole("button", { name: "작업 만들기", exact: true }).click();
    }
    await newWorkload("이더넷 전송", "요청 처리량 (Mbps)", "525");
    await newWorkload("PoE 전력 공급", "요청 전력 (W)", "8");
    assert.match((await page.locator('.wire-result[data-workload="power-1"]').textContent())!, /PoE 전력 공급/);

    const chooseWorkload = panel.getByLabel("작업", { exact: true });
    const submitWorkload = panel.getByRole("button", { name: "작업 적용", exact: true });
    await chooseWorkload.selectOption("traffic-1");
    const throughput = panel.getByLabel("요청 처리량 (Mbps)", { exact: true });
    await throughput.fill("-1");
    const invalidRequest = panel.locator('[data-path="workloads.2.request.throughput"]');
    await submitWorkload.click();
    assert.match((await invalidRequest.textContent())!, /number|0/);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 3);
    assert.equal(await page.evaluate(() => window.benchwire.read().workloads[2]!.request.throughput!.value), 525);
    await throughput.fill("625");
    await submitWorkload.click();
    assert(await invalidRequest.isHidden());

    await chooseWorkload.selectOption("power-1");
    const mode = panel.getByLabel("요청 전력 (W) 상태", { exact: true });
    await mode.selectOption("unknown");
    await submitWorkload.click();
    assert.equal(await mode.inputValue(), "unknown");

    const traffic = panel.getByRole("checkbox", { name: "이더넷 전송 · traffic-1", exact: true });
    const power = panel.getByRole("checkbox", { name: "PoE 전력 공급 · power-1", exact: true });
    const rank = panel.getByLabel("traffic-1 우선순위", { exact: true });
    await rank.fill("1.25");
    await submitScenario.click();
    const invalidPriority = rank.locator("..").locator(".scenario-error");
    assert.match((await invalidPriority.textContent())!, /단위 없는 정수/);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 5);
    await rank.fill("2");
    await power.uncheck();
    await name.fill("이더넷 우선");
    await submitScenario.click();
    assert.equal(await selector.inputValue(), scenarioId);
    assert.equal(await selector.locator("option:checked").textContent(), "이더넷 우선");
    assert(await traffic.isChecked());
    assert(!(await power.isChecked()));

    await selector.selectOption("poe-and-ethernet");
    assert(!(await traffic.isChecked()));
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 6);
    const saved = await page.evaluate(() => JSON.stringify(window.benchwire.read()));
    const parsed = JSON.parse(saved) as ReturnType<Window["benchwire"]["read"]>;
    const [ethernet, poe] = parsed.workloads.slice(-2);
    assert.deepEqual(ethernet?.from, { instanceId: "pse", id: "supply" });
    assert.deepEqual(ethernet?.to, { instanceId: "pd", id: "load" });
    assert.equal(ethernet?.request.throughput?.value, 625);
    const watts = poe?.request.watts;
    assert.equal(watts?.value, null);
    assert.equal(watts.confidence, "unknown");
    const members = parsed.scenarios[1]!.members;
    assert.equal(members.length, 1);
    assert.deepEqual(members[0], { workload: "traffic-1", priority: { value: 2, unit: "",
      confidence: "inferred", sources: watts.sources } });
    assert.equal(parsed.sources.find(source => source.id === watts.sources[0])?.locator, "canvas:scenario");
    await page.evaluate(json => window.benchwire.open(JSON.parse(json)), saved);
    await panel.locator("summary").click();
    assert.equal(parsed.scenarios[1]!.id, scenarioId);
    assert.equal(parsed.scenarios[1]!.name, "이더넷 우선");
    await selector.selectOption(scenarioId);
    assert(await traffic.isChecked());
    assert(!(await power.isChecked()));
    assert.equal(await rank.inputValue(), "2");
    await chooseWorkload.selectOption("power-1");
    assert.equal(await mode.inputValue(), "unknown");
    await chooseWorkload.selectOption("traffic-1");
    assert.equal(await throughput.inputValue(), "625");
    assert.equal(await page.evaluate(() => JSON.stringify(window.benchwire.read())), saved);
    await page.screenshot({ path: "work/m3-scenario.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("PoE 예제의 작업량, 협상 출처와 자원 막대를 열고 의미 편집 후 한 흐름만 지운다", async () => {
  const { page, errors } = await newPage("/testbed.html?example");
  try {
    const wire = page.locator('[data-connection="poe"]');
    const flow = wire.locator(".wire-result[data-workload]");
    const flowBefore = await flow.allTextContents();
    assert.equal(flowBefore.length, 2);
    assert(flowBefore.some(text => text.includes("12 W")));
    assert(flowBefore.some(text => text.includes("900 Mbps")));
    assert.equal(await wire.locator('[data-result-kind="negotiation"]').count(), 4);
    await wire.locator(".wire-name").click();
    const panel = page.getByRole("complementary", { name: "결과와 근거" });
    const detail = panel.getByRole("region", { name: "선택한 항목 근거" });
    assert.match(await detail.innerText(), /PoE 성립/);
    assert.match(await detail.innerText(), /이더넷 성립/);
    for (const label of [/이더넷 성립.*정방향/, /PoE 성립.*정방향/]) {
      const negotiation = detail.locator(".negotiation-evidence").filter({ has: page.locator("summary").filter({ hasText: label }) });
      await negotiation.locator(":scope > summary").click();
      const link = negotiation.locator(".specs a").first();
      assert(await link.isVisible());
      assert.match((await link.getAttribute("href"))!, /^https?:\/\//);
    }
    const hiddenSource = detail.getByText("합성 PoE 송전 장치", { exact: true });
    assert(await hiddenSource.count() > 0);
    await detail.locator(".reason-tree details:not([open]) > summary").first().click();
    assert(await detail.locator(".reason-tree details[open]").count() > 4);
    await panel.evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: "work/m3-results-evidence.png" });

    await panel.locator("summary").getByText(/^자원 /).click();
    await panel.getByRole("button", { name: /포트|port-budget/ }).first().click();
    assert.match(await detail.innerText(), /사용 14 W \/ 용량 15 W/);
    assert.equal(await detail.locator("meter").getAttribute("value"), "14");
    await panel.getByRole("button", { name: "닫기" }).click();

    const layout = await page.evaluate(() => window.benchwire.read().layout);
    assert.equal(await page.evaluate(() => {
      const scene = window.benchwire.read();
      return window.benchwire.edit({ ...scene, workloads: scene.workloads.filter(w => w.id !== "poe-12"),
        scenarios: [{ id: "poe", members: ["poe-ethernet"] }] });
    }), true);
    await waitForAssessment(page);
    assert.deepEqual(await flow.allTextContents(), flowBefore.filter(text => text.includes("900 Mbps")));
    assert.equal(await wire.locator('[data-result-kind="negotiation"]').count(), 4);
    const inactivePower = wire.locator('[data-direction="forward"][data-unit="W"][data-result-kind="negotiation"]');
    assert.equal(await inactivePower.getAttribute("data-verdict"), null);
    assert.match((await inactivePower.getAttribute("class"))!, /wire-capability/);
    assert.deepEqual(await page.evaluate(() => window.benchwire.read().layout), layout);

    assert.equal(await page.evaluate(() => {
      const scene = window.benchwire.read();
      return window.benchwire.edit({ ...scene, scenarios: [{ id: "poe", members: ["missing"] }] });
    }), false);
    assert.match(await page.getByRole("alert").innerText(), /scene\.json#scenarios\.0.*missing/);
    assert.equal(await flow.count(), 1);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("PoE 손실이 미확인이면 케이블 위에 범위·점선을 그리고 검증 퀘스트를 연다", async () => {
  const { page, errors } = await newPage("/testbed.html?unknown");
  try {
    const wire = page.locator('[data-connection="poe"]');
    const power = wire.locator('path[data-direction="forward"][data-unit="W"][data-result-kind="negotiation"]');
    assert.equal(await power.getAttribute("data-verdict"), "unknown");
    assert.notEqual(await power.evaluate(path => getComputedStyle(path).strokeDasharray), "none");
    const unknown = wire.locator('.wire-result[data-verdict="unknown"]');
    assert((await unknown.allTextContents()).some(text => /0–15 W/.test(text)));
    await wire.locator(".wire-name").click();
    const detail = page.getByRole("region", { name: "선택한 항목 근거" });
    assert.match(await detail.innerText(), /검증 퀘스트/);
    assert.match(await detail.innerText(), /최대 전력 손실\(W\).*확인하세요/);
    await page.screenshot({ path: "work/m3-results-unknown.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("연속 편집의 최신 판정만 표시하고 판정 도착 중에도 카드 드래그를 마친다", async () => {
  const { page, errors } = await newPage("/testbed.html?performance");
  try {
    const rates = await page.evaluate(async () => {
      const flow = () => document.querySelector('.wire-result[data-workload="traffic-3"]')?.textContent;
      const stage = document.querySelector(".stage")!;
      const captured: (string | null | undefined)[] = [];
      const observer = new MutationObserver(() => captured.push(flow()));
      observer.observe(stage, { subtree: true, childList: true });
      for (const value of [850, 840, 830]) {
        const scene = window.benchwire.read();
        const workloads = scene.workloads.map(w => w.id === "traffic-3"
          ? { ...w, request: { ...w.request, throughput: { ...w.request.throughput!, value } } } : w);
        if (!window.benchwire.edit({ ...scene, workloads })) throw new Error("편집 실패");
      }
      if (!stage.hasAttribute("data-assessing") || !flow()?.includes("900 Mbps")) throw new Error("이전 판정을 흐리게 보존하지 않았습니다.");
      const opacity = getComputedStyle(stage.querySelector(".wires")!).opacity;
      if (Number(opacity) >= 1) throw new Error("이전 판정을 흐리게 표시하지 않았습니다.");
      await window.benchwire.workerBarrier();
      captured.push(flow());
      observer.disconnect();
      return captured;
    });
    assert(rates.some(rate => rate?.includes("830 Mbps")));
    assert(rates.every(rate => !rate?.match(/8[45]0 Mbps/)));
    const card = page.locator('[data-instance="grid-12"]');
    const before = await card.getAttribute("transform");
    const origin = await center(card.locator(".device-name"));
    await page.mouse.move(origin.x, origin.y);
    await page.mouse.down();
    await page.evaluate(async () => {
      const scene = window.benchwire.read();
      const workloads = scene.workloads.map(w => w.id === "traffic-3"
        ? { ...w, request: { ...w.request, throughput: { ...w.request.throughput!, value: 820 } } } : w);
      window.benchwire.edit({ ...scene, workloads });
      await window.benchwire.workerBarrier();
      if (!document.querySelector(".stage[data-assessing]")) throw new Error("드래그 중 판정으로 화면을 바꿨습니다.");
    });
    await page.screenshot({ path: "work/m3-perf-pending.png" });
    await page.mouse.move(origin.x + 65, origin.y + 24, { steps: 6 });
    await page.mouse.up();
    await waitForAssessment(page);
    assert.notEqual(await card.getAttribute("transform"), before);
    assert.match(await page.locator('.wire-result[data-workload="traffic-3"]').textContent() ?? "", /820 Mbps/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("미확인 핀의 연결 한도 범위를 그리고 두 후보값·출처·퀘스트를 표시한다", async () => {
  const { page, errors } = await newPage("/testbed.html?limit");
  try {
    const wire = page.locator('[data-connection="display-hub"]');
    const video = wire.locator('path[data-result-kind="negotiation"][data-direction="forward"][data-unit="Gbps"]');
    assert.equal(await video.getAttribute("data-verdict"), "ok");
    assert.match(await video.locator("title").textContent() ?? "", /12\.96–25\.92 Gbps/);
    assert(await video.evaluate(path => getComputedStyle(path).strokeDasharray !== "none"));
    const text = wire.locator(".wire-result").filter({ hasText: /영상 성립 12\.96–25\.92 Gbps/ });
    assert(await text.isVisible());
    await wire.locator(".wire-name").click();
    const detail = page.getByRole("region", { name: "선택한 항목 근거" });
    const limits = detail.locator(".limit-witnesses").filter({ hasText: "하한 12.96 Gbps" });
    assert.match(await limits.innerText(), /하한 12\.96 Gbps[\s\S]*pin = A[\s\S]*fixture:t2\/host/);
    assert.match(await limits.innerText(), /상한 25\.92 Gbps[\s\S]*pin = C[\s\S]*fixture:t2\/host/);
    assert.match(await detail.locator(".quests").innerText(), /DP Alt Mode 핀 할당을 확인하세요\.[^\n]*범위에 영향/);
    await limits.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m3-limit.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("다른 설정을 고르면 이미 평가한 시나리오의 핀 배정과 흐름을 바꿔 그린다", async () => {
  const { page, errors } = await newPage("/testbed.html?profile");
  try {
    const wire = page.locator('[data-connection="display-hub"]');
    const hub = wire.locator('.wire-result[data-workload="hub"]');
    const video = wire.locator('.wire-result[data-workload="video"]');
    assert.match(await hub.textContent() ?? "", /53\.248 MB\/s/);
    assert.match(await video.textContent() ?? "", /15\.674 Gbps/);
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    const panel = page.getByRole("complementary", { name: "결과와 근거" });
    await panel.getByText("다른 설정", { exact: true }).click();
    await panel.getByRole("button", { name: /대안.*dp-2lane/ }).click();
    assert.match(await hub.textContent() ?? "", /400 MB\/s/);
    assert.match(await video.textContent() ?? "", /12\.543 Gbps/);
    assert.equal(await page.evaluate(() => window.benchwire.scenario("hub-only")), true);
    assert.equal(await video.count(), 0);
    assert.equal(await page.evaluate(() => window.benchwire.changes()), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function checkExample(id: string, edit: (page: Page) => Promise<void>, verify: (page: Page) => Promise<void>) {
  const { page, errors } = await newPage("/");
  const picker = page.getByRole("combobox", { name: "장면" });
  let copyId: string;
  try {
    if (await picker.inputValue() !== id) {
      await picker.selectOption(id);
      await page.locator("#app:not([inert])").waitFor();
      await waitForAssessment(page);
    }
    const creation = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().endsWith("/api/scenes/" + id) && response.status() === 201);
    await edit(page);
    copyId = (await (await creation).json()).sceneId;
    assert.notEqual(copyId, id);
    await page.getByText("저장됨", { exact: true }).waitFor();
    assert.equal(await picker.inputValue(), copyId);
    await waitForAssessment(page);
    await verify(page);

    await page.reload();
    await picker.waitFor();
    assert.equal(await picker.inputValue(), copyId);
    await waitForAssessment(page);
    await verify(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }

  await closeServer();
  await openServer();
  const restarted = await newPage("/");
  try {
    assert.equal(await restarted.page.getByRole("combobox", { name: "장면" }).inputValue(), copyId);
    await verify(restarted.page);
    assert.deepEqual(restarted.errors, []);
  } finally { await restarted.page.close(); }
}

function exampleFlow(page: Page, connection: string, workload: string) {
  return page.locator(`[data-connection="${connection}"] .wire-result[data-workload="${workload}"]`);
}

test("네트워크 예제에서 PoE와 공유 업링크를 보고 LAN 작업 하나를 끈 상태를 다시 연다", async () => {
  await checkExample("network", async page => {
    assert.match(await exampleFlow(page, "poe", "poe-12").textContent() ?? "", /12 W/);
    assert.match(await exampleFlow(page, "poe", "poe-ethernet").textContent() ?? "", /900 Mbps/);
    for (const workload of ["lan-a", "lan-b"]) {
      const flow = exampleFlow(page, "uplink", workload);
      assert.match(await flow.textContent() ?? "", /600 Mbps/);
      assert.equal(await flow.getAttribute("data-verdict"), "conditional");
    }
    await page.screenshot({ path: "work/m3-example-network.png" });
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    await editor.getByRole("checkbox", { name: "이더넷 전송 · lan-b" }).uncheck();
    await editor.getByRole("button", { name: "시나리오 적용" }).click();
  }, async page => {
    assert.equal(await exampleFlow(page, "uplink", "lan-b").count(), 0);
    const flow = exampleFlow(page, "uplink", "lan-a");
    assert.match(await flow.textContent() ?? "", /900 Mbps/);
    assert.equal(await flow.getAttribute("data-verdict"), "ok");
    assert.equal(await exampleFlow(page, "poe", "poe-12").count(), 1);
    assert.equal(await exampleFlow(page, "poe", "poe-ethernet").count(), 1);
  });
});

test("영상 예제에서 DSC와 핀 배정 대안을 확인하고 60 Hz 요청을 다시 연다", async () => {
  await checkExample("t2-alt-mode", async page => {
    const video = exampleFlow(page, "display-hub", "4K 영상");
    const hub = exampleFlow(page, "display-hub", "모니터 허브");
    assert.equal(await video.getAttribute("data-verdict"), "conditional");
    assert.match(await hub.textContent() ?? "", /53\.248 MB\/s/);
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    const results = page.getByRole("complementary", { name: "결과와 근거" });
    await results.getByText("다른 설정", { exact: true }).click();
    await results.getByRole("button", { name: /기본.*dp-4lane.*DSC 영상 조건부/ }).waitFor();
    const twoLanes = results.getByRole("button", { name: /대안.*dp-2lane/ });
    await twoLanes.click();
    assert.equal(await twoLanes.getAttribute("aria-pressed"), "true");
    assert.match(await hub.textContent() ?? "", /400 MB\/s/);
    assert.equal(await video.getAttribute("data-verdict"), "conditional");
    await results.getByRole("button", { name: /^영상 출력 · / }).click();
    const proof = results.getByRole("region", { name: "선택한 항목 근거" });
    assert.match(await proof.textContent() ?? "", /60 Hz 폴백/);
    await results.evaluate(el => { el.scrollTop = 0; });
    await page.mouse.move(740, 680);
    await page.mouse.down();
    await page.mouse.move(550, 680);
    await page.mouse.up();
    await twoLanes.focus();
    await page.screenshot({ path: "work/m3-example-display.png" });

    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    await editor.getByLabel("작업", { exact: true }).selectOption("4K 영상");
    const refresh = editor.getByLabel("주사율 (Hz)", { exact: true });
    assert.equal(await refresh.inputValue(), "144");
    assert.equal(await editor.getByLabel("대안 주사율 (Hz)", { exact: true }).inputValue(), "60");
    await refresh.fill("60");
    await editor.getByRole("button", { name: "작업 적용" }).click();
  }, async page => {
    assert.equal(await exampleFlow(page, "display-hub", "4K 영상").getAttribute("data-verdict"), "ok");
    assert.match(await exampleFlow(page, "display-hub", "모니터 허브").textContent() ?? "", /400 MB\/s/);
    const editor = page.locator(".scenario-panel");
    if (await editor.getAttribute("open") === null) await editor.locator("summary").click();
    await editor.getByLabel("작업", { exact: true }).selectOption("4K 영상");
    assert.equal(await editor.getByLabel("주사율 (Hz)", { exact: true }).inputValue(), "60");
  });
});

test("충전 예제에서 세 포트와 소비 상태별 판정을 확인하고 높인 순충전 목표를 다시 연다", async () => {
  await checkExample("three-ports", async page => {
    for (const [port, workload, watts] of [["a", "대기", "50 W"], ["b", "기기 B", "30 W"], ["c", "기기 C", "20 W"]] as const) {
      const flow = exampleFlow(page, port, workload);
      assert((await flow.textContent())?.includes(watts));
      assert.equal(await flow.getAttribute("data-verdict"), "ok");
    }
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    const scenario = editor.getByLabel("현재 시나리오", { exact: true });
    await scenario.selectOption("노트북 일반");
    assert.equal(await exampleFlow(page, "a", "일반").getAttribute("data-verdict"), "conditional");
    await scenario.selectOption("노트북 최대");
    assert.equal(await exampleFlow(page, "a", "최대").getAttribute("data-verdict"), "impossible");
    await scenario.selectOption("노트북 대기");
    await editor.locator("summary").click();
    await page.screenshot({ path: "work/m3-example-power.png" });
    await editor.locator("summary").click();
    await editor.getByLabel("작업", { exact: true }).selectOption("대기");
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    const results = page.getByRole("complementary", { name: "결과와 근거" });
    await results.getByRole("button", { name: /USB PD 충전.*50 W/ }).click();
    const proof = results.getByRole("region", { name: "선택한 항목 근거" });
    const verdictReasons = proof.locator(".reason-tree > li > details > summary").filter({ hasText: "순충전 전력" });
    assert.equal(await verdictReasons.count(), 1);
    await results.getByLabel("표시할 성능").selectOption("solo");
    assert.equal(await verdictReasons.count(), 1);
    await page.screenshot({ path: "work/m3-polish-solo.png" });
    await results.getByRole("button", { name: "닫기" }).click();
    const target = editor.getByLabel("목표 순충전 (W)", { exact: true });
    assert.equal(await target.inputValue(), "30");
    await target.fill("35");
    await editor.getByRole("button", { name: "작업 적용" }).click();
  }, async page => {
    const laptop = exampleFlow(page, "a", "대기");
    assert.match(await laptop.textContent() ?? "", /50 W/);
    assert.equal(await laptop.getAttribute("data-verdict"), "conditional");
    const editor = page.locator(".scenario-panel");
    if (await editor.getAttribute("open") === null) await editor.locator("summary").click();
    await editor.getByLabel("작업", { exact: true }).selectOption("대기");
    assert.equal(await editor.getByLabel("목표 순충전 (W)", { exact: true }).inputValue(), "35");
  });
});

test("작업 요청을 적용해도 이름·멤버 초안이 남고 시나리오 적용이 작업 초안을 지우지 않는다", async () => {
  const { page, errors } = await newPage("/testbed.html?example");
  try {
    const panel = page.locator(".scenario-panel");
    await panel.locator("summary").click();
    const scenarioName = panel.getByLabel("시나리오 이름", { exact: true });
    await scenarioName.fill("편집 중인 이름");
    const priority = panel.getByLabel("poe-ethernet 우선순위", { exact: true });
    await priority.fill("3");
    const workload = panel.getByLabel("작업", { exact: true });
    await workload.selectOption("poe-ethernet");
    const throughput = panel.getByLabel("요청 처리량 (Mbps)", { exact: true });
    await throughput.fill("625");
    await panel.getByRole("button", { name: "작업 적용", exact: true }).click();
    assert.equal(await scenarioName.inputValue(), "편집 중인 이름");
    assert.equal(await priority.inputValue(), "3");
    assert.equal(await page.evaluate(() => window.benchwire.read().scenarios[0]!.id), "poe-and-ethernet");
    await throughput.fill("675");
    await panel.getByRole("button", { name: "시나리오 적용", exact: true }).click();
    assert.equal(await throughput.inputValue(), "675");
    const saved = await page.evaluate(() => window.benchwire.read());
    assert.equal(saved.scenarios[0]!.id, "poe-and-ethernet");
    assert.equal(saved.scenarios[0]!.name, "편집 중인 이름");
    assert.equal(saved.workloads.find(row => row.id === "poe-ethernet")!.request.throughput!.value, 625);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("USB-C 충전기 초안을 저장·배치하고 재시도와 서버 재시작 뒤 같은 실물로 판정한다", async () => {
  let instanceId: string;
  const { page, errors } = await newPage("/");
  try {
    assert(await page.evaluate(async () => {
      const response = await fetch("/api/scenes/three-ports");
      const scene = await response.json() as ReturnType<Window["benchwire"]["read"]>;
      const draft = { ...scene, sceneId: "creator-power", items: scene.items.filter(i => ["a", "wire-a"].includes(i.instanceId)),
        connections: [], workloads: [], scenarios: [],
        layout: { placements: [{ instanceId: "a", x: 585, y: 90 }, { instanceId: "wire-a", x: 20, y: 220 }] } };
      const created = await fetch("/api/scenes/" + draft.sceneId, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      return created.ok;
    }));
    await page.reload();
    await page.locator('[data-instance="a"]').waitFor();
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const form = page.getByRole("dialog", { name: "새 아이템" });
    await form.getByLabel("충전기 포트 수").fill("3");
    await form.getByRole("button", { name: "USB-C 충전기 불러오기" }).click();
    await form.getByLabel("브랜드", { exact: true }).fill("수동 입력");
    await form.getByLabel("모델 이름", { exact: true }).fill("수동 USB-C 충전기");
    await form.getByLabel("모델 ID", { exact: true }).fill("manual-charger");
    await form.getByLabel("제목", { exact: true }).fill("충전기 라벨");
    await form.getByLabel("주소", { exact: true }).fill("https://example.invalid/charger");
    const firstPort = form.getByRole("group", { name: "포트 1", exact: true });
    await firstPort.getByText("인터페이스 값", { exact: true }).click();
    await firstPort.getByLabel("5 V 송전 PDO 전류 (A) 상태", { exact: true }).selectOption("value");
    await firstPort.getByLabel("5 V 송전 PDO 전류 (A)", { exact: true }).fill("0");
    await firstPort.getByLabel("9 V 송전 PDO 전류 (A) 상태", { exact: true }).selectOption("omit");
    await firstPort.getByLabel("5 V 수전 지원 상태", { exact: true }).selectOption("value");
    await firstPort.getByLabel("5 V 수전 지원", { exact: true }).selectOption({ label: "아니요" });
    assert.equal(await firstPort.getByLabel("20 V 송전 PDO 전류 (A) 상태", { exact: true }).inputValue(), "unknown");
    assert.equal(await firstPort.getByLabel("포트 최대 전력 (W) 상태", { exact: true }).inputValue(), "unknown");
    await firstPort.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m4-creator.png" });

    const submit = form.getByRole("button", { name: "저장하고 배치", exact: true });
    await page.route("**/api/inventory/item-*", async route => {
      const result = await route.fetch();
      assert.equal(result.status(), 201);
      await route.abort();
    }, { times: 1 });
    await submit.click();
    await form.getByText(/저장 결과를 확인할 수 없습니다/).waitFor();
    await submit.click();
    await form.waitFor({ state: "hidden" });
    await page.getByText("저장됨", { exact: true }).waitFor();
    const saved = await page.evaluate(async () => {
      const response = await (await fetch("/api/library")).json() as import("./document.ts").Library;
      return { model: response.models.find(m => m.modelId === "manual-charger"),
        items: response.inventory.filter(item => item.modelId === "manual-charger") };
    });
    assert.equal(saved.items.length, 1);
    instanceId = saved.items[0]!.instanceId;
    assert(saved.model);
    assert.equal(saved.model.ports.length, 3);
    assert.equal(saved.model.ports[0]!.interfaces[0]!.params.pdo5!.value, 0);
    assert(!Object.hasOwn(saved.model.ports[0]!.interfaces[0]!.params, "pdo9"));
    assert.equal(saved.model.ports[0]!.interfaces[0]!.params.pdo20!.value, null);
    assert.equal(saved.model.ports[0]!.interfaces[0]!.params.accepts5!.value, false);
    assert(saved.model.ports.every(p => p.attachment.value === null));
    assert.deepEqual(saved.model.edges, []);
    assert.equal(saved.model.resources[0]!.capacity.value, null);
    assert.equal(saved.model.resources[0]!.policy.value, null);
    assert.equal(saved.model.sources[0]!.title, "충전기 라벨");
    await page.locator(`[data-instance="${instanceId}"]`).waitFor();

    await page.locator('[data-inventory="wire-a"]').getByRole("button", { name: "연결에 사용" }).click();
    await port(page, instanceId, "port-1").press("Enter");
    await port(page, "a", "in").press("Space");
    await page.getByText("저장됨", { exact: true }).waitFor();
    await waitForAssessment(page);
    const line = page.locator('[data-connection="connection-1"] [data-direction="forward"][data-unit="W"]');
    assert.equal(await line.getAttribute("data-verdict"), null);
    assert.match((await line.getAttribute("class"))!, /wire-capability/);
    await page.locator('[data-connection="connection-1"] .wire-name').click();
    const evidence = page.getByRole("region", { name: "선택한 항목 근거" });
    assert.match(await evidence.locator(".quests").innerText(), /maxW/);
    assert.match(await evidence.locator(".negotiation-evidence > summary").first().innerText(), /❓/);
    await page.screenshot({ path: "work/m4-creator-charge.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }

  await closeServer();
  await openServer();
  const reopened = (await newPage("/")).page;
  try {
    await reopened.locator(`[data-instance="${instanceId}"]`).waitFor();
    assert.equal(await reopened.locator(`[data-inventory="${instanceId}"]`).count(), 1);
    assert.equal(await reopened.locator('[data-connection="connection-1"] [data-direction="forward"][data-unit="W"].wire-capability').count(), 1);
  } finally { await reopened.close(); }
});


test("장면 저장 실패 후 다시 열어 같은 모델을 배치할 때 실물은 한 개다", async () => {
  const { page } = await newPage("/");
  const modelId = "retry-placement";
  async function draft() {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const form = page.getByRole("dialog", { name: "새 아이템" });
    await form.getByLabel("모델 ID", { exact: true }).fill(modelId);
    await form.getByLabel("브랜드", { exact: true }).fill("시험");
    await form.getByLabel("모델 이름", { exact: true }).fill("다시 배치할 모델");
    await form.getByLabel("카테고리", { exact: true }).fill("시험");
    await form.getByLabel("제목", { exact: true }).fill("모델 자료");
    await form.getByLabel("주소", { exact: true }).fill("fixture:retry-model");
    return form;
  }
  async function instances() {
    return await page.evaluate(async modelId => {
      const library = await (await fetch("/api/library")).json() as Library;
      return library.inventory.filter(item => item.modelId === modelId).map(item => item.instanceId);
    }, modelId);
  }
  try {
    let form = await draft();
    await page.route("**/api/scenes/*", route => route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { message: "시험 장면 저장 실패" } }) : route.continue(), { times: 1 });
    await form.getByRole("button", { name: "저장하고 배치" }).click();
    await page.locator("#storage-status").getByRole("button").waitFor();
    const before = await instances();
    assert.equal(before.length, 1);
    await page.reload();
    await page.locator(".surface").waitFor();
    form = await draft();
    const catalogWrites: string[] = [];
    page.on("request", request => {
      if (request.method() === "PUT" && /\/api\/(models|inventory)\//.test(request.url())) catalogWrites.push(request.url());
    });
    await form.getByRole("button", { name: "저장하고 배치" }).click();
    await form.waitFor({ state: "hidden" });
    await page.getByText("저장됨", { exact: true }).waitFor();
    assert.deepEqual(await instances(), before);
    assert.deepEqual(catalogWrites, []);
    assert.equal(await page.locator('[data-instance="' + before[0] + '"]').count(), 1);
    await page.screenshot({ path: "work/m4-placement-retry.png" });
  } finally { await page.close(); }
});

test("예제 사본 응답을 잃고 새로고침한 뒤 같은 모델을 제출해도 실물은 한 개다", async () => {
  const { page, errors } = await newPage("/");
  const picker = page.getByRole("combobox", { name: "장면", exact: true });
  const modelId = "retry-example-placement";
  async function submit() {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const form = page.getByRole("dialog", { name: "새 아이템" });
    await form.getByLabel("모델 ID", { exact: true }).fill(modelId);
    await form.getByLabel("브랜드", { exact: true }).fill("시험");
    await form.getByLabel("모델 이름", { exact: true }).fill("사본에 배치한 모델");
    await form.getByLabel("카테고리", { exact: true }).fill("시험");
    await form.getByLabel("제목", { exact: true }).fill("모델 자료");
    await form.getByLabel("주소", { exact: true }).fill("fixture:example-placement");
    await form.getByRole("button", { name: "저장하고 배치" }).click();
    return form;
  }
  async function inventoryIds() {
    const response = await page.request.get(new URL("/api/library", page.url()).href);
    const catalog = await response.json() as Library;
    return catalog.inventory.filter(item => item.modelId === modelId).map(item => item.instanceId);
  }
  try {
    await picker.selectOption("network");
    assert.equal(await picker.inputValue(), "network");
    let copied: SceneDocument | undefined;
    await page.route("**/api/scenes/network", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      copied = await response.json() as SceneDocument;
      await route.abort();
    });
    await submit();
    await page.locator("#storage-status").getByRole("button").waitFor();
    assert(copied);
    const original = await inventoryIds();
    assert.equal(original.length, 1);
    await page.reload();
    await page.locator(`[data-instance="${original[0]}"]`).waitFor();
    assert.equal(await picker.inputValue(), copied.sceneId);
    const form = await submit();
    await form.waitFor({ state: "hidden" });
    assert.deepEqual(await inventoryIds(), original);
    const response = await page.request.get(new URL("/api/scenes/" + copied.sceneId, page.url()).href);
    assert.deepEqual(await response.json(), copied);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: "work/m4-example-placement-retry.png" });
  } finally { await page.close(); }
});

test("키가 없으면 AI 조사가 꺼지고 수동 생성기를 계속 쓴다", async () => {
  const { page, errors } = await newPage("/");
  try {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 아이템" });
    await dialog.getByText("서버 .env에 ANTHROPIC_API_KEY를 넣으면 켜집니다.").waitFor();
    assert(await dialog.getByRole("button", { name: "조사 시작" }).isDisabled());
    assert(await dialog.getByRole("button", { name: "저장하고 배치" }).isEnabled());
    await page.screenshot({ path: "work/research-no-key.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("판본을 골라 가상 조사 초안을 확인·편집한 뒤 저장하고 배치한다", async () => {
  const { calls, client } = fixtureClient([recording.identify, recording.investigate, recording.conflicting]);
  await closeServer();
  await openServer(client);
  const { page, errors } = await newPage("/");
  try {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 아이템" });
    await dialog.getByLabel("모델 이름", { exact: true }).fill("작성 중인 수동 초안");
    const query = dialog.getByLabel("모델명 또는 공개 URL");
    await query.fill("https://manufacturer.example.com/product?code=비공개#fragment");
    assert.equal(await dialog.getByText("https://manufacturer.example.com/product", { exact: true }).count(), 1);
    const sent = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/research"));
    await dialog.getByRole("button", { name: "조사 시작" }).click();
    assert.equal((await sent).postDataJSON().query, "https://manufacturer.example.com/product");
    await dialog.getByRole("button", { name: "Morrow Finch · FA-25" }).waitFor();
    assert.equal(calls.length, 1);
    await dialog.getByRole("button", { name: "Morrow Finch · FA-24" }).click();
    const fill = dialog.getByRole("button", { name: "조사 초안 불러오기" });
    await fill.waitFor();
    assert.equal(calls.length, 3);
    assert.equal(await dialog.getByLabel("모델 이름", { exact: true }).inputValue(), "작성 중인 수동 초안");
    await dialog.getByText(/버린 필드 \d+개/).waitFor();
    await fill.click();
    const review = dialog.getByRole("group", { name: "조사 초안 확인", exact: true });
    const save = dialog.getByRole("button", { name: "저장하고 배치", exact: true });
    const inspect = (label: RegExp) => review.getByRole("group", { name: label }).getByLabel("검토", { exact: true });
    const max30 = inspect(/포트 최대 전력 · 30 W/);
    const max60 = inspect(/포트 최대 전력 · 60 W/);
    const max15 = inspect(/포트 최대 전력 · 15 W/);
    const attachment = inspect(/^부착 · USB-C A/);
    const bulk = review.getByRole("button", { name: "경고 없는 값 모두 확인" });
    assert(await save.isDisabled());
    await dialog.getByText(/확인 전 값·배선 \d+개/).waitFor();
    await review.getByRole("link", { name: "FA-24 제품 설명서" }).first().waitFor();
    assert.match(await review.innerText(), /are not connected/);
    assert.equal(await max30.inputValue(), "");
    await dialog.screenshot({ path: "work/m4-research-review.png" });
    const writes: string[] = [];
    page.on("request", request => { if (request.method() === "PUT") writes.push(request.url()); });
    await bulk.click();
    assert.equal(await inspect(/^간선 · Controller/).inputValue(), "confirmed");
    assert.equal(await inspect(/^자원 사용 · supply/).inputValue(), "confirmed");
    for (const warned of [max30, max60, max15, attachment]) assert.equal(await warned.inputValue(), "");
    assert(await save.isDisabled());
    await dialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
    assert.deepEqual(writes, []);
    await max30.focus();
    await dialog.screenshot({ path: "work/m4-research-warnings.png" });
    await max30.selectOption("confirmed");
    await max60.selectOption("confirmed");
    await max15.selectOption("cleared");
    await attachment.selectOption("cleared");
    assert(await save.isEnabled());
    assert.equal(await dialog.getByLabel("모델 이름", { exact: true }).inputValue(), "Morrow Finch");
    assert.equal(await dialog.getByLabel("판본", { exact: true }).inputValue(), "FA-24");
    await dialog.getByText("인터페이스 값", { exact: true }).click();
    assert.equal(await dialog.getByLabel("포트 최대 전력 (W)", { exact: true }).inputValue(), "30");
    await dialog.getByLabel("모델 이름", { exact: true }).fill("Morrow Finch 사용자 확인");
    await dialog.getByRole("button", { name: "저장하고 배치" }).click();
    await dialog.waitFor({ state: "hidden" });
    const stored = await page.evaluate(async () => (await (await fetch("/api/library")).json()).models
      .find((model: { modelId: string }) => model.modelId === "morrow-finch"));
    assert.equal(stored.name, "Morrow Finch 사용자 확인");
    assert.equal(stored.ports[0].attachment.value, null);
    assert.deepEqual(stored.edges.map((edge: Model["edges"][number]) => [edge.id, edge.uses.map(use => use.resource)]),
      [["feed", ["supply"]]]);
    const maxW = stored.ports[0].interfaces[0].params.maxW;
    assert.equal(maxW.value, 30);
    assert.deepEqual(maxW.sources, ["source-1"]);
    assert.equal(maxW.confidence, "official");
    assert.deepEqual(maxW.conflicts, [{ value: 60, confidence: "review", sources: ["detail-source-2"] }]);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await closeServer();
    await openServer();
  }
});

test("배선에 붙인 출처를 지우면 다른 출처의 제목을 바꿔도 저장이 막힌다", async () => {
  const { client } = fixtureClient([recording.identify, recording.investigate, recording.normalized]);
  await closeServer();
  await openServer(client);
  const { page, errors } = await newPage("/");
  try {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 아이템" });
    await dialog.getByLabel("모델명 또는 공개 URL").fill("배선 출처 삭제 시험");
    await dialog.getByRole("button", { name: "조사 시작" }).click();
    await dialog.getByRole("button", { name: "Morrow Finch · FA-24" }).click();
    const fill = dialog.getByRole("button", { name: "조사 초안 불러오기" });
    const review = dialog.getByRole("group", { name: "조사 초안 확인", exact: true });
    async function reviewConditional() {
      await fill.click();
      const inspect = (label: RegExp) => review.getByRole("group", { name: label }).getByLabel("검토", { exact: true });
      await review.getByRole("button", { name: "경고 없는 값 모두 확인" }).click();
      const conditional = inspect(/포트 최대 전력 · 15 W/);
      assert.equal(await conditional.inputValue(), "");
      assert.match(await review.innerText(), /other load condition/);
      assert.match(await review.innerText(), /조건이 붙은 값/);
      await inspect(/포트 최대 전력 · 30 W/).selectOption("cleared");
      await inspect(/^부착 · USB-C A/).selectOption("cleared");
      await conditional.selectOption("confirmed");
    }
    await reviewConditional();
    const edge = dialog.getByRole("group", { name: "간선 1", exact: true });
    const provenance = dialog.getByRole("group", { name: "출처", exact: true });
    await provenance.getByRole("group", { name: "출처 1", exact: true }).getByRole("button", { name: "출처 삭제" }).click();
    await provenance.getByLabel("제목", { exact: true }).fill("무관한 전력 측정");
    await dialog.getByLabel("모델 ID", { exact: true }).fill("missing-wiring-source");
    const writes: string[] = [];
    page.on("request", request => {
      if (request.method() === "PUT") writes.push(request.url());
    });
    await dialog.getByRole("button", { name: "저장하고 배치" }).click();
    assert(await dialog.isVisible());
    assert.match(await edge.getByLabel("간선 출처", { exact: true }).locator("option:checked").textContent() ?? "", /출처 없음/);
    assert.match(await edge.getByLabel("자원 사용 출처", { exact: true }).locator("option:checked").textContent() ?? "", /출처 없음/);
    await dialog.getByText(/출처가 없는 주장/).waitFor();
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    await edge.screenshot({ path: "work/m4-research-missing-source.png" });
    await reviewConditional();
    await dialog.getByLabel("모델 ID", { exact: true }).fill("reviewed-conditional-value");
    await dialog.getByText("인터페이스 값", { exact: true }).click();
    assert.equal(await dialog.getByLabel("포트 최대 전력 (W)", { exact: true }).inputValue(), "15");
    assert.equal(await dialog.getByLabel("포트 최대 전력 신뢰도", { exact: true }).inputValue(), "review");
    const saved = page.waitForResponse(response => response.request().method() === "PUT" && /\/api\/models\//.test(response.url()));
    await dialog.getByRole("button", { name: "저장하고 배치" }).click();
    const response = await saved;
    assert(response.ok());
    const model = response.request().postDataJSON() as Model;
    const claim = model.ports[0]?.interfaces[0]?.params.maxW;
    assert.deepEqual(claim, { value: 15, unit: "W", condition: "other load condition", confidence: "review", sources: ["detail-source-2"] });
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await page.close();
    await closeServer();
    await openServer();
  }
});

test("경고 없는 조사 초안은 한 번 대조해 저장하고 확인한 PDO 미지원만 미선언으로 남긴다", async () => {
  const normalized = structuredClone(recording.normalized);
  const text = normalized.content.find(row => row.type === "text")!;
  const document = JSON.parse(text.text);
  document.claims = document.claims.filter((row: { citation: string }) => row.citation === "quote-1");
  document.omissions = [{ target: "interface", id: "usb-a", domain: "power", field: "pdo20", citation: "quote-1" }];
  text.text = JSON.stringify(document);
  const { client } = fixtureClient([recording.identify, recording.investigate, normalized]);
  await closeServer();
  await openServer(client);
  const { page, errors } = await newPage("/");
  try {
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 아이템" });
    await dialog.getByLabel("모델명 또는 공개 URL").fill("경고 없는 조사 초안");
    await dialog.getByRole("button", { name: "조사 시작" }).click();
    await dialog.getByRole("button", { name: "Morrow Finch · FA-24" }).click();
    await dialog.getByRole("button", { name: "조사 초안 불러오기" }).click();
    const review = dialog.getByRole("group", { name: "조사 초안 확인", exact: true });
    const save = dialog.getByRole("button", { name: "저장하고 배치", exact: true });
    assert(await save.isDisabled());
    assert.equal(await review.getByText(/^경고 ·/).count(), 0);
    const pdo = review.getByRole("group", { name: /20 V .*미지원/ });
    assert.match(await pdo.innerText(), /All source PDOs/);
    await review.getByRole("button", { name: "경고 없는 값 모두 확인" }).click();
    assert(await save.isEnabled());
    await dialog.getByLabel("모델 ID", { exact: true }).fill("reviewed-clean-draft");
    const saved = page.waitForResponse(response => response.request().method() === "PUT" && /\/api\/models\//.test(response.url()));
    await save.click();
    const response = await saved;
    assert(response.ok());
    const model = response.request().postDataJSON() as Model;
    const params = model.ports[0]!.interfaces[0]!.params;
    assert.equal(params.maxW!.value, 30);
    assert.equal(params.maxW!.confidence, "official");
    assert(!Object.hasOwn(params, "pdo20"));
    assert.equal(params.pdo9!.value, null);
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await closeServer();
    await openServer();
  }
});

async function openConflictScene(page: Page, sceneId: string) {
  const status = await page.evaluate(async id => {
    const [base, library] = await Promise.all([
      fetch("/api/scenes/three-ports").then(response => response.json() as Promise<SceneDocument>),
      fetch("/api/library").then(response => response.json() as Promise<Library>),
    ]);
    const original = library.models.find(model => model.modelId === "supply")!;
    const model: Model = { ...original, modelId: "followup-supply", name: "시험 복제 원본" };
    model.sources = [
      { id: "spec", title: "시험 정격표", locator: "https://example.com/spec", retrievedAt: "2026-11-27" },
      { id: "review", title: "시험 출력 측정", locator: "https://example.com/review", retrievedAt: "2026-11-27" },
      ...model.sources,
    ];
    const [first, second] = model.ports;
    const { params } = first!.interfaces[0]!;
    params.maxW = { value: 30, unit: "W", confidence: "official", sources: ["spec"],
      conflicts: [{ value: 60, confidence: "review", sources: ["review"] }] };
    params.pdo5 = { value: 0, unit: "A", confidence: "official", sources: ["spec"] };
    params.accepts5 = { value: false, confidence: "official", sources: ["spec"] };
    params.pdo9 = { value: null, unit: "A", confidence: "unknown", sources: ["review"] };
    first!.position = { face: "front", x: 0.25, y: 0.75, confidence: "official", sources: ["spec"] };
    second!.attachment = { value: null, confidence: "unknown", sources: ["review"] };
    const headers = { "Content-Type": "application/json" };
    const saved = await fetch("/api/models/followup-supply/1", { method: "PUT", headers, body: JSON.stringify(model) });
    if (!saved.ok) return await saved.text();
    const scene = { ...base, sceneId: id, items: base.items.map(row => row.instanceId === "supply" ? { ...row, modelId: model.modelId } : row) };
    const created = await fetch("/api/scenes/" + id, { method: "PUT", headers, body: JSON.stringify(scene) });
    return created.ok ? "ok" : await created.text();
  }, sceneId);
  assert.equal(status, "ok");
  await page.reload();
  await port(page, "supply", "a").waitFor();
  await waitForAssessment(page);
}

test("모델 복제가 새 판본에 알려진 값과 원본을 남기고 미확인과 미선언을 보존한다", async () => {
  const { page, errors } = await newPage("/");
  try {
    await openConflictScene(page, "followup-clone");
    await page.getByRole("button", { name: "새 아이템", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 아이템" });
    const original = dialog.getByLabel("복제할 모델 판본");
    assert.equal(await original.count(), 1);
    await original.selectOption("followup-supply@1");
    await dialog.getByRole("button", { name: "모델 복제", exact: true }).click();
    const id = await dialog.getByLabel("모델 ID", { exact: true }).inputValue();
    assert.notEqual(id, "followup-supply");
    assert.equal(await dialog.getByLabel("모델 이름", { exact: true }).inputValue(), "시험 복제 원본 복제");
    await page.screenshot({ path: "work/m4-model-clone.png" });
    await dialog.getByRole("button", { name: "저장하고 배치", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const saved = await page.evaluate(async id => {
      const library = await (await fetch("/api/library")).json() as Library;
      return {
        copy: library.models.find(model => model.modelId === id), base: library.models.find(model => model.modelId === "followup-supply"),
        inventory: library.inventory.filter(item => item.modelId === id),
      };
    }, id);
    const { copy, base, inventory } = saved;
    assert(copy && base);
    assert.equal(inventory.length, 1);
    assert.equal(base.ports[0]!.interfaces[0]!.params.maxW!.confidence, "official");
    const params = copy.ports[0]!.interfaces[0]!.params;
    assert.deepEqual([params.maxW!.value, params.pdo5!.value, params.accepts5!.value], [30, 0, false]);
    const conflict = params.maxW!.conflicts![0]!;
    assert.equal(conflict.value, 60);
    assert.deepEqual(conflict.sources, ["review"]);
    for (const fact of [params.maxW!, conflict, params.pdo5!, params.accepts5!, copy.ports[0]!.connector, copy.ports[0]!.attachment,
      copy.ports[0]!.interfaces[0]!.evidence, copy.ports[0]!.position!, copy.resources[0]!.capacity, copy.resources[0]!.policy,
      copy.edges[0]!.evidence, copy.edges[0]!.uses[0]!.evidence, Object.values(copy.attributes!.power!)[0]!]) {
      assert.deepEqual([fact.confidence, fact.inferredFrom], ["inferred", "followup-supply@1"]);
    }
    assert.deepEqual([params.pdo9!.value, params.pdo9!.confidence, params.pdo9!.inferredFrom], [null, "unknown", undefined]);
    assert.equal(copy.ports[1]!.attachment.value, null);
    assert.equal(copy.ports[1]!.attachment.inferredFrom, undefined);
    assert(!Object.hasOwn(params, "pdo12"));
    await page.locator('[data-instance="' + inventory[0]!.instanceId + '"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("왜 패널과 캔버스 포트 툴팁에서 충돌 후보마다 해당 출처를 짝지어 표시한다", async () => {
  const { page, errors } = await newPage("/");
  try {
    await openConflictScene(page, "followup-evidence");
    const tooltip = (await port(page, "supply", "a").locator("title").textContent())!;
    await page.locator('[data-connection="a"] .wire-name').click();
    const detail = page.getByRole("region", { name: "선택한 항목 근거" });
    const sourcesByValue = await Promise.all(["충돌 후보 30 W · 공식", "충돌 후보 60 W · 리뷰"].map(label =>
      detail.getByText(label, { exact: true }).first().locator("..").getByRole("link", { includeHidden: true }).allTextContents()));
    assert.deepEqual({ sourcesByValue, matches: [
      /^.*30 W[^\n]*시험 정격표.*$/m.test(tooltip),
      /^.*60 W[^\n]*시험 출력 측정.*$/m.test(tooltip),
      /^.*30 W[^\n]*시험 출력 측정.*$/m.test(tooltip),
      /^.*60 W[^\n]*시험 정격표.*$/m.test(tooltip),
    ] }, { sourcesByValue: [["시험 정격표"], ["시험 출력 측정"]], matches: [true, true, false, false] });
    await detail.evaluate(root => root.querySelectorAll("details").forEach(row => row.open = true));
    await detail.getByText("충돌 후보 60 W · 리뷰", { exact: true }).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m4-claim-conflicts.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("등록한 영역의 어휘와 스키마 필드가 생성기와 시나리오에 나타난다", async () => {
  const { page, errors } = await newPage("/testbed.html?vocabulary");
  try {
    await page.getByRole("button", { name: "시험 생성기" }).click();
    const creator = page.getByRole("dialog", { name: "새 아이템" });
    await creator.getByRole("button", { name: "포트 추가" }).click();
    await creator.getByRole("button", { name: "인터페이스 추가" }).click();
    await creator.getByLabel("인터페이스 영역", { exact: true }).selectOption("test-area");
    assert.equal(await creator.getByLabel("프로토콜", { exact: true }).inputValue(), "test-protocol");
    await creator.getByText("인터페이스 값", { exact: true }).click();
    assert(await creator.getByLabel("시험 인터페이스 스위치 상태", { exact: true }).isVisible());
    const attributes = creator.locator("details").filter({ has: page.locator("summary", { hasText: /^시험 영역$/ }) });
    await attributes.locator("summary").click();
    assert(await attributes.getByLabel("시험 속성 스위치 상태", { exact: true }).isVisible());
    await creator.getByRole("button", { name: "닫기" }).click();
    const scenario = page.locator("#extra-scenario");
    await scenario.getByRole("button", { name: "새 작업", exact: true }).click();
    await scenario.getByLabel("작업 프리셋", { exact: true }).selectOption({ label: "시험 작업" });
    const request = scenario.getByLabel("시험 작업 요청", { exact: true });
    assert(await request.isVisible());
    assert.equal(await request.locator("option:checked").textContent(), "아니요");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function networkPage() {
  const { page } = await newPage("/");
  const picker = page.getByRole("combobox", { name: "장면" });
  if (await picker.inputValue() !== "network") await picker.selectOption("network");
  await page.locator('[data-instance="pse"]').waitFor();
  await waitForAssessment(page);
  return page;
}

test("저장 응답을 기다리는 동안 새로고침하기 전에 확인한다", async () => {
  const page = await networkPage();
  let release!: () => void;
  try {
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/scenes/*", async route => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      await blocked;
      await route.continue();
    });
    await movePse(page, 25, 16);
    await page.getByText("저장 중…", { exact: true }).waitFor();
    const dialog = page.waitForEvent("dialog", { timeout: 2500 });
    const reload = page.reload({ timeout: 4000 }).catch(() => null);
    const warning = await dialog;
    assert.equal(warning.type(), "beforeunload");
    await warning.dismiss();
    release();
    await page.getByText("저장됨", { exact: true }).waitFor({ timeout: 5000 });
    await reload;
  } finally { release?.(); await page.close(); }
});

test("서버 422 요청 오류는 작업 입력 칸에 붙인다", async () => {
  const page = await networkPage();
  try {
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    await editor.getByLabel("작업", { exact: true }).selectOption("lan-a");
    const input = editor.locator('.scenario-workload input[type="number"]').first();
    await input.fill("750");
    const path = "workloads.2.request.throughput.value";
    const message = "저장 요청에서 허용하지 않는 전송량입니다";
    await page.route("**/api/scenes/*", async route => {
      if (route.request().method() !== "PUT") { await route.continue(); return; }
      await route.fulfill({ status: 422, json: { path, message } });
    }, { times: 1 });
    const rejected = page.waitForResponse(r => r.request().method() === "PUT" && r.status() === 422);
    await editor.getByRole("button", { name: "작업 적용" }).click();
    await rejected;
    const fieldError = input.locator("..").locator('[role="alert"]');
    await fieldError.filter({ hasText: message }).waitFor({ timeout: 2500 });
    assert(await page.locator("#storage-status").isHidden());
    await page.screenshot({ path: "work/m3-polish-field.png" });
  } finally { await page.close(); }
});

test("카드를 끄는 동안 흐름 화살표가 실제 방향을 따른다", async () => {
  const { page } = await newPage("/testbed.html?example");
  try {
    await movePse(page, -420, -50, "pd");
    const source = page.locator('[data-instance="pse"] .device-name');
    const target = port(page, "pd", "pd");
    const label = page.locator('[data-connection="poe"] .wire-result[data-workload="poe-12"]');
    const start = await center(source);
    const end = await center(target);
    assert.match((await label.textContent())!, /→/);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x + 360, start.y + 45, { steps: 5 });
    assert.match((await label.textContent())!, /[←↖↙]/);
    assert.equal(await page.locator(".stage[data-assessing]").count(), 0);
    await page.mouse.up();
    assert.match((await label.textContent())!, /[←↖↙]/);
    await page.getByRole("button", { name: "전체 맞춤" }).click();
    await page.screenshot({ path: "work/m3-polish-direction.png" });
  } finally { await page.close(); }
});

async function readStored(page: Page, id: string) {
  const response = await page.request.get(new URL("/api/scenes/" + id, page.url()).href);
  assert.equal(response.status(), 200);
  return { document: await response.json() as SceneDocument, tag: response.headers().etag! };
}

async function saveFromAnotherTab(page: Page, document: SceneDocument, tag?: string) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.put(origin + "/api/scenes/" + document.sceneId, {
    headers: { Origin: origin, ...(tag ? { "If-Match": tag } : {}) }, data: document,
  });
  assert.equal(response.status(), tag ? 204 : 201);
}

async function openStored(page: Page, id: string) {
  await page.reload();
  const scenes = page.getByRole("combobox", { name: "장면" });
  if (await scenes.inputValue() !== id) await scenes.selectOption(id);
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#app")?.inert);
  await waitForAssessment(page);
}

test("검증 퀘스트는 충전기 실물 하나에만 적용되고 재개방과 펌웨어 변경 후에도 근거가 남는다", async () => {
  const { page, errors } = await newPage("/");
  const id = "quest-charge";
  try {
    const origin = new URL(page.url()).origin;
    const catalog = await (await page.request.get(origin + "/api/library")).json() as Library;
    const model = { ...catalog.models.find(m => m.modelId === "supply")!, modelId: "quest-supply" };
    model.resources[0]!.capacity = { ...model.resources[0]!.capacity, value: null, confidence: "unknown" };
    assert.equal((await page.request.put(origin + "/api/models/quest-supply/1", { headers: { Origin: origin }, data: model })).status(), 201);
    const document = JSON.parse(readFileSync("fixtures/power/single-port.json", "utf8")) as SceneDocument;
    document.sceneId = id;
    document.items[0]!.modelId = model.modelId;
    document.items[0]!.alias = "충전기 A";
    const twin = <T extends { instanceId: string }>(row: T) => ({ ...row, instanceId: row.instanceId + "-b" });
    document.items.push(...document.items.map(twin));
    document.items[3]!.alias = "충전기 B";
    const c = document.connections[0]!, w = document.workloads[0]!;
    document.connections.push({ ...c, id: "b", from: twin(c.from), to: twin(c.to), parts: c.parts.map(twin) });
    const other = { ...w, id: "idle-b", from: twin(w.from), to: twin(w.to) };
    document.workloads.push(other, { ...other, id: "idle-target",
      request: { ...w.request, targetW: { ...w.request.targetW!, value: null, confidence: "unknown" } } });
    document.scenarios[0]!.members.push("idle-b");
    document.scenarios.push({ id: "작업 요청 확인", members: ["idle-target"] });
    await saveFromAnotherTab(page, document);
    await openStored(page, id);

    await page.getByRole("button", { name: /^검증 퀘스트/ }).click({ timeout: 1500 });
    const panel = page.getByRole("dialog", { name: "검증 퀘스트" });
    const card = panel.locator("details.quest-card").filter({ hasText: /충전기 A.*총 출력|총 출력.*충전기 A/ });
    await card.locator(":scope > summary").click();
    await card.getByLabel("총 출력 (W)", { exact: true }).fill("65");
    await card.getByLabel("현재 펌웨어 · 충전기 A", { exact: true }).fill("1.0");
    await card.getByLabel("측정 조건", { exact: true }).fill("대기");
    await card.getByText("환경 · 증거", { exact: true }).click();
    await card.getByLabel("메모", { exact: true }).fill("동일한 부하 구성에서 측정");
    await card.getByLabel("사진", { exact: true }).setInputFiles({ name: "evidence.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm6kAAAAASUVORK5CYII=", "base64") });
    const save = card.getByRole("button", { name: "검증값 저장" });
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m5-quest-charge.png" });
    await save.dblclick();
    await panel.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();
    await waitForAssessment(page);

    const before = await readStored(page, id);
    assert.equal(before.document.personal?.length, 1);
    assert.equal(before.document.personal?.[0]?.claim.value, 65);
    assert.equal(before.document.sources.filter(s => s.title === "검증 퀘스트").length, 1);
    for (const reopen of [false, true]) {
      if (reopen) {
        await closeServer();
        await openServer();
        await edge.navigate(page, "/");
      }
      assert.equal(await exampleFlow(page, "a", "idle").getAttribute("data-verdict"), "ok");
      assert.equal(await exampleFlow(page, "b", "idle-b").getAttribute("data-verdict"), "unknown");
    }
    await page.getByRole("button", { name: /^검증 퀘스트/ }).click();
    await panel.getByText("실물의 현재 펌웨어 · 측정 조건", { exact: true }).click();
    await panel.getByLabel("실물", { exact: true }).selectOption("supply");
    await panel.getByLabel("현재 펌웨어", { exact: true }).fill("2.0");
    await panel.getByRole("button", { name: "실물 상태 적용" }).click();
    await panel.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();
    await waitForAssessment(page);
    const flow = exampleFlow(page, "a", "idle");
    assert.equal(await flow.getAttribute("data-verdict"), "unknown");
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    await page.locator(".result-list").first().getByRole("button").first().click();
    const proof = page.getByRole("region", { name: "선택한 항목 근거" });
    await proof.getByText(/적용 안 됨.*펌웨어 다름/).waitFor();
    assert.match(await proof.innerText(), /사용자 검증 · \d{4}-\d{2}-\d{2} · 대기/);
    assert.match(await proof.innerText(), /동일한 부하 구성에서 측정/);
    const photo = await proof.getByRole("link", { name: "첨부 사진" }).getAttribute("href");
    assert.match(photo ?? "", /^\/api\/evidence\//);
    assert.equal((await page.request.get(new URL(photo!, page.url()).href)).headers()["content-type"], "image/png");
    await page.screenshot({ path: "work/m5-quest-history.png" });
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    await editor.getByLabel("현재 시나리오", { exact: true }).selectOption("작업 요청 확인");
    await page.getByRole("button", { name: "검증 퀘스트", exact: true }).click();
    const request = panel.getByText(/^targetW · idle-target ·/);
    await request.click();
    await request.locator("..").getByRole("button", { name: "작업 편집" }).click();
    assert.notEqual(await editor.getAttribute("open"), null);
    assert.equal(await editor.getByLabel("작업", { exact: true }).inputValue(), "idle-target");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("이더넷 링크 속도 퀘스트는 선택한 배선만 좁히고 측정 전 회선 예측을 보존한다", async () => {
  const { page, errors } = await newPage("/");
  const id = "quest-network";
  try {
    const origin = new URL(page.url()).origin;
    const catalog = await (await page.request.get(origin + "/api/library")).json() as Library;
    const router = { ...catalog.models.find(m => m.modelId === "network-router")!, modelId: "quest-router" };
    for (const port of router.ports.slice(0, 2)) port.interfaces[0]!.params.baseTModes!.value = "1000BASE-T,2.5GBASE-T";
    const wire = { ...catalog.models.find(m => m.modelId === "network-copper")!, modelId: "quest-cat6a" };
    wire.attributes!.network!.category!.value = "Cat6A";
    for (const model of [router, wire])
      assert.equal((await page.request.put(origin + "/api/models/" + model.modelId + "/1", { headers: { Origin: origin }, data: model })).status(), 201);
    const document = JSON.parse(readFileSync("fixtures/network/scene.json", "utf8")) as SceneDocument;
    document.sceneId = id;
    const works = ["first-hop", "first-hop-b"];
    const firstHop = document.workloads.find(w => w.id === works[0])!;
    firstHop.request.throughput!.value = 2000;
    document.workloads.push({ ...firstHop, id: works[1]!, from: { ...firstHop.from, instanceId: "host-b" },
      to: { ...firstHop.to, id: "lan-b" } });
    document.scenarios.unshift({ id: "두 링크", members: works });
    for (const item of document.items) {
      if (item.modelId === "network-router") item.modelId = router.modelId;
      if (item.modelId === "network-copper") item.modelId = wire.modelId;
      item.firmware = "1.0";
      item.measurementCondition = "동시";
    }
    delete document.items.find(i => i.instanceId === "lan-a-wire")!.firmware;
    delete document.items.find(i => i.instanceId === "lan-a-wire")!.measurementCondition;
    await saveFromAnotherTab(page, document);
    await openStored(page, id);
    const first = exampleFlow(page, "lan-a", "first-hop");
    const other = exampleFlow(page, "lan-b", "first-hop-b");
    assert.match(await first.textContent() ?? "", /2000 Mbps/);
    const unchanged = await other.textContent();
    assert.match(unchanged ?? "", /2000 Mbps/);

    const open = page.getByRole("button", { name: "검증 퀘스트", exact: true });
    const panel = page.getByRole("dialog", { name: "검증 퀘스트" });
    for (const attempt of [0, 1]) {
      await open.click();
      const summary = panel.locator("details.quest-card > summary").filter({ hasText: /^이더넷 링크 속도 · lan-a ·/ });
      const card = summary.locator("..");
      if (await card.getAttribute("open") === null) await summary.click();
      await card.getByLabel("이더넷 링크 속도 (Mbps)", { exact: true }).selectOption({ label: "1000" });
      if (attempt === 0) {
        await card.getByLabel("현재 펌웨어 · lan-a-wire 상태", { exact: true }).selectOption("none");
        await card.getByLabel("측정 조건 · lan-a-wire 상태", { exact: true }).selectOption("none");
      }
      await card.getByRole("button", { name: "검증값 저장" }).click();
      if (attempt === 1) await card.getByText("이미 같은 값이 저장되어 있습니다.").waitFor();
      await panel.getByRole("button", { name: "닫기" }).click();
      await page.getByText("저장됨", { exact: true }).waitFor();
      await waitForAssessment(page);
    }
    assert.match(await first.textContent() ?? "", /975\.293 Mbps/);
    assert.equal(await other.textContent(), unchanged);
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    await page.locator(".result-list").first().getByRole("button").first().click();
    const proof = page.getByRole("region", { name: "선택한 항목 근거" });
    await proof.getByText("예측과 다름 · 모델 보정 후보").first().waitFor();
    assert.match(await proof.innerText(), /측정 전 예측 · 2500 Mbps/);
    await page.screenshot({ path: "work/m5-quest-network.png" });
    const saved = (await readStored(page, id)).document;
    assert.equal(saved.personal?.length ?? 0, 0);
    assert.equal(saved.sources.filter(s => s.title === "검증 퀘스트").length, 1);
    const obs = saved.connections[0]!.observations!;
    assert.deepEqual(obs.map(o => [o.domain, o.field, o.claim.value]), [["network", "linkSpeed", 1000]]);
    assert.deepEqual(obs[0]!.ports.map(p => p.id), ["lan", "a", "b", "lan-a"]);
    assert.deepEqual(obs[0]!.ports.slice(1, 3).map(p => [p.firmware, p.measurementCondition]), [[null, null], [null, null]]);
    assert.equal(saved.connections[1]!.observations, undefined);
    await open.click();
    const summary = panel.locator("details.quest-card > summary").filter({ hasText: /^이더넷 링크 속도 · lan-a ·/ });
    const card = summary.locator("..");
    if (await card.getAttribute("open") === null) await summary.click();
    await card.getByLabel("이더넷 링크 속도 (Mbps)", { exact: true }).selectOption({ label: "2500" });
    await card.getByRole("button", { name: "검증값 저장" }).click();
    await panel.getByRole("button", { name: "닫기" }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();
    const rechecked = (await readStored(page, id)).document;
    const verified = rechecked.connections[0]!.observations![0]!.claim;
    const source = rechecked.sources.find(s => s.id === verified.sources[0])!;
    const comparison = new URLSearchParams(source.locator.slice("verification:".length));
    assert.equal(verified.value, 2500);
    assert.equal(comparison.get("prediction"), "2500 Mbps");
    assert.equal(comparison.get("different"), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("이더넷 예측은 관측과 함께 입력한 측정 조건에 맞는 주장을 쓴다", async () => {
  const { page } = await newPage("/");
  const id = "quest-new-scope";
  try {
    const document = JSON.parse(readFileSync("fixtures/network/scene.json", "utf8")) as SceneDocument;
    document.sceneId = id;
    for (const item of document.items) {
      if (item.instanceId !== "lan-b-wire") {
        item.firmware = null;
        item.measurementCondition = null;
      }
    }
    document.personal = [{ instanceId: "lan-b-wire", ownerKind: "item", ownerId: "lan-b-wire",
      domain: "network", field: "length",
      claim: { value: 150, unit: "m", confidence: "user_verified", sources: [document.sources[0]!.id] } }];
    await saveFromAnotherTab(page, document);
    await openStored(page, id);
    await page.getByRole("button", { name: "검증 퀘스트", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "검증 퀘스트" });
    const summary = panel.locator("details.quest-card > summary").filter({ hasText: /^이더넷 링크 속도 · lan-b ·/ });
    await summary.click();
    const card = summary.locator("..");
    await card.getByLabel("현재 펌웨어 · lan-b-wire 상태", { exact: true }).selectOption("none");
    await card.getByLabel("측정 조건 · lan-b-wire 상태", { exact: true }).selectOption("none");
    await card.getByLabel("이더넷 링크 속도 (Mbps)", { exact: true }).selectOption({ label: "1000" });
    await card.getByRole("button", { name: "검증값 저장" }).click();
    await panel.getByRole("button", { name: "닫기" }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();
    const saved = (await readStored(page, id)).document;
    const observed = saved.connections[1]!.observations![0]!.claim;
    const source = saved.sources.find(s => s.id === observed.sources[0])!;
    const comparison = new URLSearchParams(source.locator.slice("verification:".length));
    assert.equal(comparison.get("prediction"), "1000 Mbps");
    assert.equal(comparison.get("different"), null);
  } finally { await page.close(); }
});

test("검증 퀘스트에서 쓰지 않는 증거를 확인하고 선택한 항목만 지운다", async () => {
  const { page, errors } = await newPage("/");
  try {
    const origin = new URL(page.url()).origin;
    async function attachNote(note: string) {
      const response = await page.request.post(origin + "/api/evidence", {
        headers: { Origin: origin }, multipart: { note },
      });
      assert.equal(response.status(), 201);
    }
    await attachNote("선택할 검증 메모");
    await attachNote("남겨둘 검증 메모");
    await page.getByRole("button", { name: "검증 퀘스트", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "검증 퀘스트" });
    await panel.getByText("쓰지 않는 증거 정리", { exact: true }).click();
    const choice = panel.getByRole("checkbox", { name: "선택할 검증 메모", exact: true });
    const kept = panel.getByRole("checkbox", { name: "남겨둘 검증 메모", exact: true });
    const remove = panel.getByRole("button", { name: "선택한 증거 지우기" });
    await kept.waitFor();
    assert(await remove.isDisabled());
    await choice.check();
    assert(await remove.isEnabled());
    await page.screenshot({ path: "work/m5-evidence-cleanup.png" });
    await remove.click();
    await choice.waitFor({ state: "detached" });
    await kept.waitFor();
    assert(await remove.isDisabled());
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("이더넷 링크 속도 퀘스트는 같은 케이블의 이더넷 작업에만 영향을 표시한다", async () => {
  const page = await networkPage();
  try {
    await page.getByRole("button", { name: "검증 퀘스트", exact: true }).click();
    const summary = page.getByRole("dialog", { name: "검증 퀘스트" }).getByText(/^이더넷 링크 속도 · poe ·/);
    await summary.click();
    const card = summary.locator("..");
    assert.match(await card.innerText(), /poe-ethernet/);
    assert.doesNotMatch(await card.innerText(), /poe-12/);
  } finally { await page.close(); }
});

test("저장 경합 뒤 작업과 시나리오 멤버를 순서대로 합치고 같은 칸의 충돌을 알린다", async () => {
  const page = await networkPage();
  const id = "network-merge";
  let release!: () => void;
  try {
    const example = (await readStored(page, "network")).document;
    await saveFromAnotherTab(page, { ...example, sceneId: id });
    await openStored(page, id);
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    const workload = editor.getByLabel("작업", { exact: true });
    const value = editor.getByLabel("요청 처리량 (Mbps)", { exact: true });
    const apply = editor.getByRole("button", { name: "작업 적용", exact: true });
    const baseline = await readStored(page, id);
    const remote = structuredClone(baseline.document);
    remote.workloads.find(w => w.id === "lan-b")!.request.throughput!.value = 700;
    remote.scenarios[0]!.members = remote.scenarios[0]!.members.filter(m => m !== "poe-ethernet");
    await saveFromAnotherTab(page, remote, baseline.tag);

    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/scenes/" + id, async route => {
      if (route.request().method() === "PUT") await blocked;
      await route.continue();
    }, { times: 1 });
    await workload.selectOption("lan-a");
    await value.fill("750");
    await apply.click();
    await editor.getByRole("checkbox", { name: /poe-12/ }).uncheck();
    await editor.getByRole("button", { name: "시나리오 적용" }).click();
    release();
    await page.getByText("저장됨", { exact: true }).waitFor({ timeout: 4000 });
    const merged = await readStored(page, id);
    assert.equal(merged.document.workloads.find(w => w.id === "lan-a")!.request.throughput!.value, 750);
    assert.equal(merged.document.workloads.find(w => w.id === "lan-b")!.request.throughput!.value, 700);
    assert.deepEqual(merged.document.scenarios[0]!.members, ["lan-a", "lan-b"]);

    merged.document.workloads.find(w => w.id === "lan-b")!.request.throughput!.value = 675;
    await saveFromAnotherTab(page, merged.document, merged.tag);
    await workload.selectOption("lan-b");
    await value.fill("650");
    await apply.click();
    await page.getByText(/다시 적용하지 못한 편집.*lan-b 작업 편집/).waitFor({ timeout: 4000 });
    assert.equal((await readStored(page, id)).document.workloads.find(w => w.id === "lan-b")!.request.throughput!.value, 675);
  } finally { release?.(); await page.close(); }
});

test("저장 경합 뒤 새 실물 배치와 케이블 연결을 순서대로 다시 적용한다", async () => {
  const page = await networkPage();
  const id = "network-merge-wire";
  let release!: () => void;
  try {
    const example = (await readStored(page, "network")).document;
    const withoutHost = (row: { instanceId: string }) => row.instanceId !== "host-b";
    await saveFromAnotherTab(page, { ...example, sceneId: id, connections: [], workloads: [], scenarios: [],
      items: example.items.filter(withoutHost), layout: { placements: example.layout!.placements!.filter(withoutHost) } });
    await openStored(page, id);
    const remote = await readStored(page, id);
    const router = remote.document.layout!.placements!.find(p => p.instanceId === "router")!;
    router.x += 27;
    const origin = new URL(page.url()).origin;
    const listing = await (await page.request.get(origin + "/api/library")).json() as Library;
    const model = { ...listing.models.find(m => m.modelId === "network-host")!, modelId: "review-network-host" };
    const item = { instanceId: "remote-host", modelId: model.modelId, revision: model.revision, state: "owned" };
    assert.equal((await page.request.put(origin + "/api/models/" + model.modelId + "/" + model.revision, {
      headers: { Origin: origin }, data: model,
    })).status(), 201);
    assert.equal((await page.request.put(origin + "/api/inventory/" + item.instanceId, {
      headers: { Origin: origin }, data: item,
    })).status(), 201);
    remote.document.items.push(item);
    await saveFromAnotherTab(page, remote.document, remote.tag);
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/scenes/" + id, async route => {
      if (route.request().method() === "PUT") await blocked;
      await route.continue();
    }, { times: 1 });
    await page.locator('[data-inventory="host-b"]').getByRole("button", { name: "캔버스에 놓기" }).click();
    await page.locator('[data-inventory="spare-wire"]').getByRole("button", { name: "연결에 사용" }).click();
    await port(page, "host-b", "lan").press("Enter");
    await port(page, "router", "lan-b").press("Space");
    release();
    await page.getByText("저장됨", { exact: true }).waitFor({ timeout: 4000 });
    const saved = (await readStored(page, id)).document;
    assert(saved.items.some(i => i.instanceId === "host-b"));
    assert(saved.items.some(i => i.instanceId === "spare-wire"));
    assert(saved.items.some(i => i.instanceId === item.instanceId));
    await page.locator('[data-instance="remote-host"]').waitFor();
    assert.equal(saved.connections[0]!.from.instanceId, "host-b");
    assert.equal(saved.connections[0]!.parts[0]!.instanceId, "spare-wire");
    assert.deepEqual(saved.layout!.placements!.find(p => p.instanceId === "router"), router);
  } finally { release?.(); await page.close(); }
});

test("사용하지 않는 자원의 용량 근거에 모델 출처를 표시한다", async () => {
  const page = await networkPage();
  try {
    const editor = page.locator(".scenario-panel");
    await editor.locator("summary").click();
    for (const check of await editor.getByRole("checkbox").all()) await check.uncheck();
    await editor.getByRole("button", { name: "시나리오 적용" }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();
    await waitForAssessment(page);
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    const panel = page.getByRole("complementary", { name: "결과와 근거" });
    await panel.getByText(/^자원 \d+개$/).click();
    await panel.getByRole("button", { name: /라우터 · uplink.*0 Mbps \/ 1200 Mbps/ }).click();
    const proof = panel.getByRole("region", { name: "선택한 항목 근거" });
    assert.match(await proof.innerText(), /용량 주장 · 1200 Mbps[\s\S]*fixture:network\/network-router/);
    await page.screenshot({ path: "work/m3-polish-capacity.png" });
  } finally { await page.close(); }
});

test("균등 분배 가정값을 배선과 작업 근거에 함께 표시한다", async () => {
  const page = await networkPage();
  try {
    await page.route("**/api/library", async route => {
      const response = await route.fetch();
      const library = await response.json() as Library & { defaultSceneId: string };
      const uplink = library.models.find(m => m.modelId === "network-router")!.resources.find(r => r.id === "uplink")!;
      uplink.policy = { ...uplink.policy, value: null, confidence: "unknown" };
      await route.fulfill({ response, json: { ...library, defaultSceneId: "network" } });
    });
    await openStored(page, "network");
    const summary = "0–900 Mbps · 보수적 경계 · 가정 600 Mbps";
    const label = exampleFlow(page, "uplink", "lan-a");
    await label.filter({ hasText: summary }).waitFor({ state: "attached", timeout: 3000 });
    await page.getByRole("button", { name: "결과 · 근거" }).click();
    const panel = page.getByRole("complementary", { name: "결과와 근거" });
    await panel.getByRole("button", { name: new RegExp(summary) }).first().click();
    const proof = panel.getByRole("region", { name: "선택한 항목 근거" });
    assert((await proof.innerText()).includes(summary));
    await page.screenshot({ path: "work/m3-polish-assumption.png" });
  } finally { await page.close(); }
});
