// Edge에서 모델·인벤토리 카드의 슬롯 교체 비교와 사본 저장을 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { modelKey, type Library, type Model, type SceneDocument } from "./document.ts";
import { edgeSession, waitForAssessment } from "./edge-session.ts";

const edge = edgeSession();
const url = (page: Page, api: string) => new URL(api, page.url()).href;
async function read<T>(page: Page, api: string) {
  const response = await page.request.get(url(page, api));
  assert(response.ok());
  return await response.json() as T;
}
async function put(page: Page, api: string, data: unknown) {
  const response = await page.request.put(url(page, api), { headers: { Origin: new URL(page.url()).origin }, data });
  assert(response.ok(), await response.text());
}
async function openScene(page: Page, id: string) {
  await page.reload();
  await page.locator(".surface").waitFor();
  await waitForAssessment(page);
  assert.equal(await page.getByRole("combobox", { name: "장면", exact: true }).inputValue(), id);
}

test("라이브러리 모델로 바꿔 기술 차이 없이 비용이 달라진 사본을 원본과 별도로 저장한다", { timeout: 20_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const base = await read<SceneDocument>(page, "/api/scenes/network");
    const lib = await read<Library>(page, "/api/library");
    const router = lib.models.find(model => model.modelId === "network-router")!;
    const replacement = { ...router, revision: "swap-price-only", name: "다른 가격의 스위치" };
    await put(page, "/api/models/network-router/" + replacement.revision, replacement);
    const offer = { seller: "교체 시험 매장", saleUnit: 1, currency: "USD", stock: "in",
      retrievedAt: "2026-01-01T00:00:00Z", source: "시험 견적", provider: "manual" };
    await put(page, "/api/prices", { ...offer, modelRef: modelKey(router), productId: "원본 스위치", unitPriceCents: 2000 });
    await put(page, "/api/prices", { ...offer, modelRef: modelKey(replacement), productId: "교체 스위치", unitPriceCents: 3500 });
    const sceneId = "swap-price-fixture";
    const original: SceneDocument = { ...base, sceneId,
      items: base.items.map(item => item.instanceId === "router" ? { ...item, state: "candidate" } : item),
      scenarios: base.scenarios.map(scenario => ({ ...scenario, purchases: [{ instanceId: "router" }] })) };
    await put(page, "/api/scenes/" + sceneId, original);
    await openScene(page, sceneId);
    await page.getByRole("button", { name: "모델", exact: true }).click();
    await page.locator(`[data-model-card="${modelKey(replacement)}"]`).dragTo(page.locator('[data-instance="router"] .device-name'));
    const dialog = page.getByRole("dialog", { name: "슬롯 교체" });
    await dialog.getByText("기술 차이 없음", { exact: true }).waitFor();
    await dialog.getByText("비용 차이 +$15.00", { exact: true }).waitFor();
    await dialog.getByText("$20.00 → $35.00", { exact: true }).waitFor();
    await page.screenshot({ path: "work/m7-swap-price.png" });

    const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().includes("/api/scenes/swap-") && response.status() === 201);
    await dialog.getByRole("button", { name: "사본 저장", exact: true }).click();
    const location = (await saved).headers()["location"]!;
    assert(location.startsWith("/api/scenes/swap-"));
    const copy = await read<SceneDocument>(page, location);
    await dialog.getByText("사본을 저장했습니다.", { exact: true }).waitFor();
    const item = copy.items.find(item => item.revision === replacement.revision)!;
    assert.notEqual(item.instanceId, "router");
    assert.equal(item.state, "candidate");
    assert.deepEqual(copy.scenarios[0]?.purchases, [{ instanceId: item.instanceId }]);
    assert.deepEqual(await read<SceneDocument>(page, "/api/scenes/" + sceneId), original);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    const picker = page.getByRole("combobox", { name: "장면", exact: true });
    assert.equal(await picker.inputValue(), sceneId);
    await picker.selectOption(copy.sceneId);
    await page.locator(`[data-instance="${item.instanceId}"]`).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("인벤토리 교체의 여러 호환 포트는 비교 전에 화면에서 선택한다", { timeout: 20_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const base = await read<SceneDocument>(page, "/api/scenes/network");
    const lib = await read<Library>(page, "/api/library");
    const host = lib.models.find(model => model.modelId === "network-host")!;
    const port = host.ports[0]!;
    const replacement = { ...host, revision: "swap-two-ports", name: "단자 두 개가 있는 모델",
      ports: ([["left", "왼쪽"], ["right", "오른쪽"]] as const).map(([id, label]) => ({ ...port, id, label,
        interfaces: port.interfaces.map(iface => ({ ...iface, id: iface.id + "-" + id })),
      })) };
    await put(page, "/api/models/network-host/" + replacement.revision, replacement);
    await put(page, "/api/inventory/swap-owned-host", {
      instanceId: "swap-owned-host", modelId: replacement.modelId, revision: replacement.revision, state: "owned",
    });
    const sceneId = "swap-wiring-fixture";
    const original = { ...base, sceneId };
    await put(page, "/api/scenes/" + sceneId, original);
    await openScene(page, sceneId);
    await page.locator('[data-inventory="swap-owned-host"]').dragTo(page.locator('[data-instance="host-a"] .device-name'));
    const dialog = page.getByRole("dialog", { name: "슬롯 교체" });
    await dialog.getByText("연결 위치 선택 필요", { exact: true }).waitFor();
    const save = dialog.getByRole("button", { name: "사본 저장", exact: true });
    assert(await save.isDisabled());
    const choice = dialog.getByRole("combobox", { name: /포트.*연결 lan-a/ });
    assert.deepEqual(await choice.getByRole("option").allTextContents(), ["선택", "왼쪽 (left)", "오른쪽 (right)"]);
    await page.screenshot({ path: "work/m7-swap-choice.png" });
    await choice.selectOption("right");
    await dialog.getByText("선택한 연결 위치", { exact: true }).waitFor();
    await dialog.getByText("기술 차이 없음", { exact: true }).waitFor();
    assert(await save.isEnabled());
    const saved = page.waitForResponse(response => response.request().method() === "PUT" && response.status() === 201);
    await save.click();
    const location = (await saved).headers()["location"]!;
    assert(location.startsWith("/api/scenes/swap-"));
    const copy = await read<SceneDocument>(page, location);
    const item = copy.items.find(row => row.revision === replacement.revision)!;
    assert.equal(item.state, "candidate");
    assert.notEqual(item.instanceId, "swap-owned-host");
    assert.deepEqual(copy.connections.find(row => row.id === "lan-a")?.from, { instanceId: item.instanceId, id: "right" });
    assert.deepEqual(copy.workloads.find(row => row.id === "lan-a")?.from, { instanceId: item.instanceId, id: "nic" });
    assert.deepEqual(copy.scenarios[0]?.members, original.scenarios[0]?.members);
    assert.deepEqual(await read<SceneDocument>(page, "/api/scenes/" + sceneId), original);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("같은 이더넷 성능에서 지정 단자의 목표만 깨지는 교체를 두 비교 화면에 표시한다", { timeout: 25_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  page.setDefaultTimeout(7_000);
  try {
    const base = await read<SceneDocument>(page, "/api/scenes/network");
    const library = await read<Library>(page, "/api/library");
    const pse = library.models.find(model => model.modelId === "network-pse")!;
    const pd = library.models.find(model => model.modelId === "network-pd")!;
    function alternatePort(port: Model["ports"][number], node: string) {
      return { ...port, id: "backup", label: "예비 단자", attachment: { ...port.attachment, value: node },
        interfaces: port.interfaces.map(iface => ({ ...iface, id: iface.id + "-backup" })) };
    }
    const source = { ...pse, revision: "dual-port", ports: [...pse.ports, alternatePort(pse.ports[0]!, "supply")] };
    const receiver = { ...pd, revision: "dual-port", nodes: [...pd.nodes, { id: "park", label: "예비 노드", kind: "junction" }],
      ports: [...pd.ports, alternatePort(pd.ports[0]!, "park")] };
    const replacement = { ...receiver, revision: "reversed", name: "예비 단자에 부하가 연결된 장비",
      ports: receiver.ports.map(port => ({ ...port, attachment: { ...port.attachment, value: port.id === "pd" ? "park" : "load" } })) };
    for (const model of [source, receiver, replacement]) await put(page, "/api/models/" + model.modelId + "/" + model.revision, model);

    const wire = base.connections.find(row => row.id === "poe")!;
    const sceneId = "swap-goal-fixture", workload = "poe-ethernet";
    const goal = { id: "specified-port", label: "지정 단자로 받기", kind: "port" as const, workloads: [workload], instanceId: "pd", portId: "pd" };
    const scenario = { id: "포트 기준", members: [workload], goals: [goal] };
    const original: SceneDocument = { ...base, sceneId,
      items: [...base.items.filter(row => ["pse", "pd", "poe-wire"].includes(row.instanceId))
        .map(item => item.instanceId === "poe-wire" ? item : { ...item, revision: "dual-port" }),
        { ...base.items.find(row => row.instanceId === "poe-wire")!, instanceId: "backup-wire" }],
      connections: [wire, { ...wire, id: "backup", from: { ...wire.from, id: "backup" }, to: { ...wire.to, id: "backup" },
        parts: [{ ...wire.parts[0]!, instanceId: "backup-wire" }] }],
      workloads: base.workloads.filter(row => row.id === workload), scenarios: [scenario],
      layout: { placements: base.layout!.placements!.filter(row => row.instanceId === "pse" || row.instanceId === "pd") },
    };
    await put(page, "/api/scenes/" + sceneId, original);
    await openScene(page, sceneId);

    await page.getByRole("button", { name: "모델", exact: true }).click();
    await page.locator('[data-model-card="' + modelKey(replacement) + '"]').dragTo(page.locator('[data-instance="pd"] .device-name'));
    const swap = page.getByRole("dialog", { name: "슬롯 교체", exact: true });
    const change = "지정 단자로 받기 · ✅ 달성 → ❌ 미달";
    await swap.getByText(change, { exact: true }).waitFor({ timeout: 5000 });
    await swap.getByText("기술 차이 없음", { exact: true }).waitFor();
    await swap.getByText("비용 차이 $0.00", { exact: true }).waitFor();
    await page.screenshot({ path: "work/m7-swap-goal-change.png" });

    const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().includes("/api/scenes/swap-") && response.status() === 201);
    await swap.getByRole("button", { name: "사본 저장", exact: true }).click();
    const copy = await read<SceneDocument>(page, (await saved).headers()["location"]!);
    const newId = copy.items.find(row => row.revision === replacement.revision)!.instanceId;
    assert.deepEqual(copy.scenarios[0]?.goals, [{ ...goal, instanceId: newId }]);
    assert.deepEqual(await read<SceneDocument>(page, "/api/scenes/" + sceneId), original);
    await swap.getByRole("button", { name: "닫기", exact: true }).click();

    await page.getByRole("button", { name: "구매 예산", exact: true }).click();
    const budget = page.getByRole("dialog", { name: "구매 예산", exact: true });
    await budget.getByText("로드아웃 비교", { exact: true }).click();
    await budget.getByLabel("비교할 장면").selectOption(copy.sceneId);
    await budget.getByLabel("비교할 시나리오").selectOption(scenario.id);
    await budget.getByRole("button", { name: "두 구성 비교", exact: true }).click();
    await budget.getByText(change, { exact: true }).waitFor({ timeout: 5000 });
    await budget.getByText("기술 차이 없음", { exact: true }).waitFor();
    await budget.getByText("가격 차이 $0.00", { exact: true }).waitFor();
    await budget.getByText(change, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m7-loadout-goal-change.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("로드아웃 비교는 목표 이름이 바뀌어도 ID로 맞추고 한쪽에만 있는 목표를 표시한다", { timeout: 20_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const base = await read<SceneDocument>(page, "/api/scenes/network");
    const sceneId = "loadout-goal-fixture";
    const passed = { kind: "workload" as const, workload: "poe-ethernet" };
    const baseline = { ...base.scenarios[0]!, id: "기준", goals: [
      { ...passed, id: "same", label: "처음 이름" }, { ...passed, id: "left", label: "기준에만 있는 목표" },
    ] };
    const alternate = { ...baseline, id: "대안", goals: [
      { ...passed, id: "same", label: "바뀐 이름" }, { ...passed, id: "right", label: "대안에만 있는 목표" },
    ] };
    await put(page, "/api/scenes/" + sceneId, { ...base, sceneId, scenarios: [baseline, alternate] });
    await openScene(page, sceneId);
    await page.getByRole("button", { name: "구매 예산", exact: true }).click();
    const budget = page.getByRole("dialog", { name: "구매 예산", exact: true });
    await budget.getByText("로드아웃 비교", { exact: true }).click();
    await budget.getByLabel("비교할 시나리오").selectOption(alternate.id);
    await budget.getByRole("button", { name: "두 구성 비교", exact: true }).click();
    const goals = budget.getByRole("region", { name: "목표 변화", exact: true });
    await goals.getByRole("heading", { name: "목표 변화 2건", exact: true }).waitFor({ timeout: 5000 });
    assert.deepEqual((await goals.getByRole("listitem").allTextContents()).sort(), [
      "기준에만 있는 목표 · ✅ 달성 → 없음", "대안에만 있는 목표 · 없음 → ✅ 달성",
    ]);
    await budget.getByText("기술 차이 없음", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


test("슬롯과 로드아웃 비교에 교체 후 목표의 미확인 판정과 미완료 사유가 표시된다", { timeout: 30_000 }, async () => {
  const { page, errors } = await edge.newPage("/");
  page.setDefaultTimeout(7_000);
  try {
    const base = await read<SceneDocument>(page, "/api/scenes/three-ports");
    const library = await read<Library>(page, "/api/library");
    const supply = structuredClone(library.models.find(model => model.modelId === "supply")!);
    supply.revision = "swap-open-capacity";
    Object.assign(supply.resources[0]!.capacity, { value: null, confidence: "unknown" });
    await put(page, "/api/models/supply/" + supply.revision, supply);

    const sceneId = "swap-open-goal", work = base.workloads[0]!;
    const scenario = { id: "충전 검증", members: [work.id],
      goals: [{ id: "charge", label: "충전 목표", kind: "workload" as const, workload: work.id }] };
    await put(page, "/api/scenes/" + sceneId, { ...base, sceneId,
      items: base.items.filter(item => ["supply", "a", "wire-a"].includes(item.instanceId)),
      workloads: [work], connections: base.connections.slice(0, 1), scenarios: [scenario],
      layout: { placements: [{ instanceId: "supply", x: 60, y: 60 }, { instanceId: "a", x: 420, y: 60 }] } });
    await openScene(page, sceneId);
    await page.getByRole("button", { name: "모델", exact: true }).click();
    await page.locator('[data-model-card="' + modelKey(supply) + '"]').dragTo(page.locator('[data-instance="supply"] .device-name'));

    const swap = page.getByRole("dialog", { name: "슬롯 교체" });
    const change = "충전 목표 · ✅ 달성 → ❓ 미확인";
    const cause = /총 출력.*규격 걸음이 없어 모든 값을 확인할 수 없습니다/;
    await swap.getByText(change, { exact: true }).waitFor({ timeout: 5000 });
    await swap.getByText(cause).waitFor({ timeout: 5000 });
    await page.screenshot({ path: "work/m7-swap-goal-incomplete.png" });

    const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
      response.url().includes("/api/scenes/swap-") && response.status() === 201);
    await swap.getByRole("button", { name: "사본 저장", exact: true }).click();
    const copy = await read<SceneDocument>(page, (await saved).headers()["location"]!);
    await swap.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByRole("button", { name: "구매 예산", exact: true }).click();
    const budget = page.getByRole("dialog", { name: "구매 예산" });
    await budget.getByText("로드아웃 비교", { exact: true }).click();
    await budget.getByLabel("비교할 장면").selectOption(copy.sceneId);
    await budget.getByLabel("비교할 시나리오").selectOption(scenario.id);
    await budget.getByRole("button", { name: "두 구성 비교", exact: true }).click();
    await budget.getByText(change, { exact: true }).waitFor({ timeout: 5000 });
    await budget.getByText(cause).waitFor({ timeout: 5000 });
    await budget.getByText(cause).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "work/m7-loadout-goal-incomplete.png" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
