// 설치된 Edge에서 작업대의 편집 동작과 50기기 장면의 프레임 시간을 검증한다.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { build } from "vite";
import { startServer } from "../server/http.ts";

const viewport = { width: 1440, height: 900 };
const root = resolve("app");
const outDir = resolve("work/ui-dist");
let browser: Browser;
let server: Server | undefined;
let dataDir: string;
let base: string;

async function openServer() {
  server = await startServer({ port: 0, dataDir, buildDir: outDir });
  const address = server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  const closing = server;
  server = undefined;
  if (closing) await new Promise<void>((done, fail) => closing.close(error => error ? fail(error) : done()));
}

before(async () => {
  await mkdir("work", { recursive: true });
  dataDir = await mkdtemp(resolve("work/ui-data-"));
  await build({ root, logLevel: "error", build: { outDir, emptyOutDir: true,
    rolldownOptions: { input: [join(root, "index.html"), join(root, "testbed.html")] } } });
  await openServer();
  browser = await chromium.launch({ channel: "msedge", headless: true });
});

after(async () => {
  await Promise.all([browser?.close(), closeServer()]);
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  assert(box);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function newPage(path: string, context?: BrowserContext) {
  const page = context ? await context.newPage() : await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors: Error[] = [];
  page.on("pageerror", error => errors.push(error));
  await page.goto(base + path);
  await page.locator(".surface").waitFor();
  assert.deepEqual(errors, []);
  return { page, errors };
}

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
    const power = wire.locator('[data-layer="power"]');
    const network = wire.locator('[data-layer="network"]');
    const powerToggle = page.getByRole("button", { name: "전력" });
    const networkToggle = page.getByRole("button", { name: "네트워크" });
    assert(await power.isVisible());
    assert(await network.isVisible());
    assert.equal(await networkToggle.evaluate(button => getComputedStyle(button, "::before").backgroundColor),
      await network.evaluate(path => getComputedStyle(path).stroke));
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
  const tabs = await browser.newContext({ viewport, deviceScaleFactor: 1 });
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
    assert(await world.evaluate((g: SVGGElement) => g.getScreenCTM()!.a) > pannedScale);
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
    assert.equal(await page.evaluate(() => window.benchwire.tried().length), 0);

    await a.press("Enter");
    await c.press("Space");
    assert.match((await page.getByRole("status").textContent())!, /커넥터가 맞지 않습니다.*USB-C → DP 어댑터/);
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
    assert.deepEqual(edited.connections[0]!.parts, [{ instanceId: "wire", entry: "p0", exit: "p1" }]);
    assert.deepEqual(edited.connections[1]!.parts, []);
    assert.equal(edited.sources.filter(source => source.locator === "canvas:placement").length, 1);
    await page.getByRole("button", { name: "추천", exact: true }).click();
    assert.equal(await page.locator(".inventory-empty").textContent(), "표시할 추천 장비가 없습니다.");
    await page.screenshot({ path: "work/m3-canvas-edit.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

type Motion = "drag" | "pan" | "zoom";
const duration = 2000;

async function measure(page: Page, motion: Motion) {
  await page.goto(base + "/testbed.html?performance");
  const cardTitle = page.locator('[data-instance="grid-12"] .device-name');
  await cardTitle.waitFor();
  assert.equal(await page.locator(".device").count(), 50);
  assert.equal(await page.locator(".port").count(), 400);
  assert.equal(await page.locator(".wire-line").count(), 100);
  assert.equal(await page.locator("animateMotion").count(), 100);
  const target = motion === "drag" ? await center(cardTitle)
    : motion === "pan" ? { x: 288, y: 134 } : { x: 848, y: 432 };
  const carrier = motion === "drag" ? page.locator('[data-instance="grid-12"]') : page.locator(".world");
  const before = await carrier.getAttribute("transform");
  await page.mouse.move(target.x, target.y);
  if (motion !== "zoom") await page.mouse.down();
  await page.waitForTimeout(350);
  const frameTimes = page.evaluate(ms => new Promise<number[]>(done => {
    const samples: number[] = [];
    requestAnimationFrame(start => {
      let last = start;
      function sample(now: number) {
        samples.push(now - last);
        last = now;
        if (now - start < ms) requestAnimationFrame(sample);
        else done(samples);
      }
      requestAnimationFrame(sample);
    });
  }), duration);
  const start = performance.now();
  const steps = motion === "zoom" ? 80 : 120;
  for (let i = 0; i < steps; i++) {
    const delay = start + i * duration / steps - performance.now();
    if (delay > 0) await sleep(delay);
    if (motion === "zoom") await page.mouse.wheel(0, i % 12 < 7 ? -8 : 8);
    else await page.mouse.move(target.x + 105 * i / steps, target.y + Math.sin(i / 12) * 38 + 35 * i / steps);
  }
  const times = (await frameTimes).sort((a, b) => a - b);
  if (motion !== "zoom") await page.mouse.up();
  assert.notEqual(await carrier.getAttribute("transform"), before, motion);
  const quantile = (q: number) => Number(times[Math.ceil(q * times.length) - 1]!.toFixed(2));
  return { motion, samples: times.length, inputs: steps, p50: quantile(0.5), p95: quantile(0.95), max: quantile(1) };
}

test("50기기·400포트·100선 장면의 드래그·팬·줌 프레임 p95가 20 ms 이하다", { timeout: 60_000 }, async context => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    const samples = [];
    for (let trial = 1; trial <= 3; trial++) {
      for (const motion of ["drag", "pan", "zoom"] as const) samples.push({ trial, ...await measure(page, motion) });
    }
    const stats = { browser: browser.version(), viewport, duration, samples };
    await writeFile("work/m3-canvas-perf.json", JSON.stringify(stats, null, 2));
    for (const sample of samples) {
      context.diagnostic(JSON.stringify(sample));
      assert(sample.p95 <= 20, `${sample.motion} ${sample.trial}: p95 ${sample.p95} ms`);
    }
  } finally { await page.close(); }
});
