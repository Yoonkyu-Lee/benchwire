// Edge에서 카드 근거, 흐름, 병목과 케이블 끝 편집을 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { Library, Model, SceneDocument } from "./document.ts";
import { center, edgeSession, waitForAssessment } from "./edge-session.ts";

const edge = edgeSession();
const path = (page: Page, api: string) => new URL(api, page.url()).href;
const port = (page: Page, item: string, id: string) => page.locator(`[data-item="${item}"][data-port="${id}"]`);

async function readScene(page: Page, id: string) {
  const response = await page.request.get(path(page, "/api/scenes/" + id));
  assert(response.ok());
  return await response.json() as SceneDocument;
}

async function put(page: Page, api: string, data: unknown) {
  const response = await page.request.put(path(page, api), { data, headers: { Origin: new URL(page.url()).origin } });
  assert.equal(response.status(), 201, await response.text());
}

async function openScene(page: Page, id: string) {
  await page.reload();
  await page.locator(".surface").waitFor();
  await waitForAssessment(page);
  assert.equal(await page.getByRole("combobox", { name: "장면", exact: true }).inputValue(), id);
}

test("인벤토리와 캔버스의 대표 스탯에 신뢰도·충돌을 표시하고 사용률에서 근거를 연다", async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const heat = page.getByRole("button", { name: "병목 히트맵", exact: true });
    assert.equal(await page.locator(".heat-mark").count(), 0);
    await heat.click();
    const binding = page.locator('[data-instance="router"] .heat-mark[data-usage="1"][data-bottleneck="true"]').filter({ hasText: "uplink" });
    assert.match((await binding.getAttribute("aria-label"))!, /1200 Mbps \/ 1200 Mbps/);
    await binding.press("Enter");
    await page.locator(".selected-evidence").getByText(/동시 사용 1200 Mbps \/ 용량 1200 Mbps/).waitFor();
    await heat.click();
    assert.equal(await page.locator(".heat-mark").count(), 0);

    const base = await readScene(page, "network");
    const lib = await (await page.request.get(path(page, "/api/library"))).json() as Library;
    const original = lib.models.find(model => model.modelId === "network-router")!;
    const revision = "visual-stats";
    const router: Model = { ...original, revision, resources: original.resources.map(resource => resource.id === "uplink"
      ? { ...resource, capacity: { ...resource.capacity, confidence: "official",
        conflicts: [{ value: 1500, confidence: "review", sources: resource.capacity.sources }] } }
      : { ...resource, capacity: { ...resource.capacity, confidence: "community" } }) };
    const sceneId = "visual-claims", instanceId = "visual-router";
    const item = { ...base.items.find(item => item.instanceId === "router")!, instanceId, revision };
    const endpoint = (ref: typeof base.connections[number]["from"]) => ref.instanceId === "router" ? { ...ref, instanceId } : ref;
    await put(page, "/api/models/network-router/" + revision, router);
    await put(page, "/api/inventory/" + instanceId, { ...item, state: "owned" });
    await put(page, "/api/scenes/" + sceneId, { ...base, sceneId,
      items: base.items.map(row => row.instanceId === "router" ? item : row),
      connections: base.connections.map(row => ({ ...row, from: endpoint(row.from), to: endpoint(row.to) })),
      layout: { ...base.layout, placements: base.layout!.placements!.map(row => row.instanceId === "router" ? { ...row, instanceId } : row) },
      personal: [{ instanceId, ownerKind: "resource", ownerId: "backplane", domain: "network", field: "capacity",
        claim: { value: 1400, unit: "Mbps", confidence: "user_verified", sources: ["network-scene"] } }] });
    await openScene(page, sceneId);
    const inventory = page.locator('[data-inventory="visual-router"]');
    const card = page.locator('[data-instance="visual-router"]');
    for (const where of [inventory, card]) {
      await where.getByText("충돌", { exact: true }).waitFor();
      await where.getByText("미확인", { exact: true }).waitFor();
      await where.getByText("내가 검증", { exact: true }).waitFor();
    }
    assert.match(await page.locator('[data-inventory="spare-wire"] .inventory-stats').innerText(), /케이블 등급 Cat5e/);
    await heat.click();
    const uncertain = card.locator('.heat-mark[data-usage="unknown"]');
    await uncertain.first().waitFor();
    assert.match((await uncertain.first().getAttribute("aria-label"))!, /사용률 미확인/);
    await page.screenshot({ path: "work/m7-cards-heat.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("흐름 입자는 작업 레이어와 시스템·사용자 움직임 설정을 따른다", async () => {
  const { page, errors } = await edge.newPage("/testbed.html?example");
  try {
    const particles = page.locator(".flow-particles");
    await particles.waitFor();
    assert.match((await particles.getAttribute("data-layers"))!, /network/);
    assert.match((await particles.getAttribute("data-layers"))!, /power/);
    assert(Number(await particles.getAttribute("data-count")) > 0);
    const network = page.getByRole("button", { name: "네트워크", exact: true });
    const power = page.getByRole("button", { name: "전력", exact: true });
    await network.click();
    assert.equal(await particles.getAttribute("data-layers"), "power");
    await power.click();
    await particles.waitFor({ state: "hidden" });
    await network.click();
    await particles.waitFor();

    const reduced = page.getByRole("button", { name: "움직임 줄이기", exact: true });
    await reduced.click();
    assert.equal(await reduced.getAttribute("aria-pressed"), "true");
    await particles.waitFor({ state: "hidden" });
    await page.reload();
    await reduced.waitFor();
    assert.equal(await reduced.getAttribute("aria-pressed"), "true");
    await particles.waitFor({ state: "hidden" });
    await reduced.click();
    await particles.waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await particles.waitFor({ state: "hidden" });
    assert.equal(await reduced.getAttribute("aria-pressed"), "false");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await particles.waitFor();
    await page.screenshot({ path: "work/m7-particles.png" });

    await page.evaluate(() => {
      const scene = window.benchwire.read();
      window.benchwire.open({ ...scene, workloads: scene.workloads.map(work => ({
        ...work, request: Object.fromEntries(Object.entries(work.request).map(([key, value]) => [key, { ...value, value: 0 }]))
      })) });
    });
    await waitForAssessment(page);
    assert.equal(await particles.getAttribute("data-count"), "0");
    await particles.waitFor({ state: "hidden" });

    await edge.navigate(page, "/testbed.html?unknown");
    const bounded = page.locator('.wire-line[data-layer="power"][data-result-kind="flow"].range-wire');
    await bounded.first().waitFor();
    assert(!((await particles.getAttribute("data-layers")) ?? "").includes("power"));
    assert.equal(await bounded.first().evaluate(node => getComputedStyle(node).animationName), "none");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("새 연결은 요청의 판정색으로 한 번 물들고 움직임 줄이기에서는 효과가 없다", async () => {
  const { page, errors } = await edge.newPage("/testbed.html?example");
  try {
    const prepare = () => page.evaluate(() => {
      const scene = window.benchwire.read();
      const connectedCables = new Set(scene.connections.flatMap(connection => connection.parts.map(part => part.instanceId)));
      window.benchwire.open({ ...scene, connections: [], items: scene.items.filter(item => !connectedCables.has(item.instanceId)) });
    });
    async function connect() {
      await page.locator('[data-inventory="spare-wire"]').getByRole("button", { name: "연결에 사용" }).click();
      await port(page, "pse", "pse").press("Enter");
      await port(page, "pd", "pd").press("Space");
      await waitForAssessment(page);
    }
    await prepare();
    await connect();
    const wire = page.locator('[data-connection="connection-1"]');
    const arrival = wire.locator('.wire-arrival[data-verdict][data-result-kind="flow"]').first();
    await arrival.waitFor();
    assert.equal(await arrival.evaluate(node => getComputedStyle(node).animationName), "wire-arrival");
    await wire.locator(".wire-arrival").evaluateAll(lines => {
      for (const line of lines) for (const animation of line.getAnimations()) { animation.pause(); animation.currentTime = 220; }
    });
    await page.locator(".inventory").evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: "work/m7-arrival.png" });
    await page.getByRole("button", { name: "병목 히트맵", exact: true }).click();
    assert.equal(await wire.locator(".wire-arrival").count(), 0);

    await prepare();
    await page.getByRole("button", { name: "움직임 줄이기", exact: true }).click();
    await connect();
    assert.equal(await arrival.evaluate(node => getComputedStyle(node).animationName), "none");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("케이블 끝을 끌어도 같은 연결과 관측이 남고 근거가 배선 다름을 표시한다", async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const base = await readScene(page, "network");
    const edge = base.connections.find(edge => edge.id === "lan-a")!;
    const source = "network-scene";
    const observation = { domain: "network", field: "linkSpeed",
      ports: [edge.from, { instanceId: "lan-a-wire", id: "a" }, { instanceId: "lan-a-wire", id: "b" }, edge.to],
      claim: { value: 100, unit: "Mbps", confidence: "user_verified" as const, sources: [source] } };
    const sceneId = "visual-rewire";
    const lib = await (await page.request.get(path(page, "/api/library"))).json() as Library;
    const incompatible = lib.models.find(model => model.kind === "device" && model.ports.some(port => port.connector.value === "c-receptacle"))!;
    const incompatiblePort = incompatible.ports.find(port => port.connector.value === "c-receptacle")!.id;
    await put(page, "/api/scenes/" + sceneId, { ...base, sceneId,
      items: [...base.items, { ...base.items.find(item => item.instanceId === "host-a")!, instanceId: "spare-host", alias: "대체 LAN 단말" },
        { instanceId: "incompatible", modelId: incompatible.modelId, revision: incompatible.revision }],
      connections: base.connections.map(row => row === edge ? { ...row, observations: [observation] } : row),
      layout: { ...base.layout, placements: [...base.layout!.placements!, { instanceId: "spare-host", x: 430, y: 80 },
        { instanceId: "incompatible", x: 820, y: 435 }] } });
    await openScene(page, sceneId);
    const origin = port(page, "host-a", "lan"), spare = port(page, "spare-host", "lan");
    const from = await center(origin);
    async function dragEnd(to: { x: number; y: number }) {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 9 });
      assert(await page.locator(".connection-preview").getAttribute("d"));
      await page.mouse.up();
    }
    await dragEnd(await center(port(page, "incompatible", incompatiblePort)));
    await page.getByRole("status").getByText(/커넥터가 맞지 않습니다/).waitFor();
    assert.deepEqual((await readScene(page, sceneId)).connections.find(row => row.id === edge.id)?.from, edge.from);
    await dragEnd(await center(spare));
    await page.getByText("저장됨", { exact: true }).waitFor();
    await waitForAssessment(page);
    const stored = await readScene(page, sceneId);
    const moved = stored.connections.find(row => row.id === edge.id)!;
    assert.deepEqual(moved.from, { instanceId: "spare-host", id: "lan" });
    assert.deepEqual(moved.to, edge.to);
    assert.deepEqual(moved.parts, edge.parts);
    assert.deepEqual(moved.observations, [observation]);
    assert.equal(stored.connections.length, base.connections.length);
    assert.equal(await origin.getAttribute("aria-disabled"), "false");
    assert.equal(await spare.getAttribute("aria-disabled"), "true");
    await page.locator('[data-connection="lan-a"]').press("Enter");
    await page.locator(".selected-evidence").getByText(/적용 안 됨.*배선 다름/).waitFor();
    await page.screenshot({ path: "work/m7-rewire.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
