// 설치된 Edge에서 작업대의 편집 결과와 저장·복구 동작을 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { center, edgeSession, viewport, waitForAssessment } from "./edge-session.ts";

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

async function movePse(page: Page, dx: number, dy: number) {
  const card = page.locator('[data-instance="pse"]');
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
    await movePse(second, -18, 30);
    await second.getByText("다른 곳에서 장면을 저장했습니다. 다시 열어 주세요.").waitFor();
    await second.getByRole("button", { name: "다시 열기" }).click();
    await second.waitForFunction(expected => document.querySelector('[data-instance="pse"]')?.getAttribute("transform") === expected, moved);
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
    assert.equal(await selector.inputValue(), "작업 시험");
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
    assert.equal(await selector.inputValue(), "이더넷 우선");
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
    await selector.selectOption("이더넷 우선");
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
    for (const label of [/→ 이더넷 성립/, /→ PoE 성립/]) {
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
