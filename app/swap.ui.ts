// Edge에서 모델·인벤토리 카드의 슬롯 교체 비교와 사본 저장을 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { modelKey, type Library, type SceneDocument } from "./document.ts";
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
