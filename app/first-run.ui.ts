// 첫 실행의 작업대 도움말을 보고 닫은 뒤 새 Edge 세션에서도 선택을 기억하는지 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeSession, waitForAssessment } from "./edge-session.ts";

const edge = edgeSession({ firstRun: true });
const helpName = "작업대 도움말";

test("처음에는 도움말이 열리고 닫은 뒤 서버를 다시 켜도 도움말 단추로 다시 열 수 있다", async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const help = page.getByRole("dialog", { name: helpName, exact: true });
    await help.waitFor({ timeout: 2500 });
    for (const label of ["인벤토리", "연결과 근거", "시나리오 · 작업", "검증 퀘스트", "수집기", "구매 예산", "새 아이템"]) {
      assert(await help.getByText(label, { exact: true }).isVisible(), label);
    }
    const dismissed = page.waitForResponse(response =>
      response.url().endsWith("/api/settings/help") && response.request().method() === "PUT");
    await page.keyboard.press("Escape");
    assert.equal((await dismissed).status(), 204);
    await help.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }

  await edge.closeServer();
  await edge.openServer();
  const reopened = await edge.newPage("/");
  try {
    const { page } = reopened;
    const prefs = await page.request.get(new URL("/api/settings/help", page.url()).href);
    assert.deepEqual(await prefs.json(), { helpDismissed: true });
    const help = page.getByRole("dialog", { name: helpName, exact: true });
    const trigger = page.getByRole("button", { name: "도움말", exact: true });
    await trigger.click();
    await help.waitFor();
    await help.getByRole("button", { name: "닫기", exact: true }).click();
    await help.waitFor({ state: "hidden" });
    await page.getByRole("combobox", { name: "장면", exact: true }).selectOption("t2-alt-mode");
    await trigger.click();
    await help.waitFor();
    assert.deepEqual(reopened.errors, []);
  } finally { await reopened.page.close(); }
});



test("기본 후보인 연습용 스위치가 공유 업링크의 목표를 해결하고 사본에 남는다", async () => {
  const { page, errors } = await edge.newPage("/");
  try {
    const btn = (name: string) => page.getByRole("button", { name, exact: true });
    const help = page.getByRole("dialog", { name: helpName });
    if (await help.isVisible()) await help.getByRole("button", { name: "닫기", exact: true }).click();
    await btn("후보").click();
    await page.locator("[data-inventory]").getByText("연습용 스위치", { exact: true }).waitFor({ timeout: 3500 });
    await btn("목표 체크리스트").click();
    const checklist = page.getByRole("dialog", { name: "목표 체크리스트" });
    await checklist.getByRole("button", { name: "목표 추가", exact: true }).click();
    await checklist.getByLabel("목표 이름", { exact: true }).fill("LAN A 전송");
    await checklist.getByLabel("lan-a", { exact: true }).check();
    await checklist.getByLabel("하한", { exact: true }).fill("800");
    await checklist.getByRole("button", { name: "목표 저장", exact: true }).click();
    await checklist.getByText("❌ 미달 · 동시 전달량 ≥ 800 Mbps", { exact: true }).waitFor();
    await checklist.getByRole("button", { name: "닫기", exact: true }).click();
    await btn("추천").click();
    const card = page.locator(".recommendations").getByRole("article").filter({ hasText: "연습용 스위치" });
    await card.getByText("이 아이템으로 해결 · LAN A 전송", { exact: true }).waitFor();
    await card.getByRole("button", { name: "사본 비교", exact: true }).click();
    const compare = page.getByRole("dialog", { name: "슬롯 교체" });
    await compare.getByText(/LAN A 전송 · .*미달 → .*달성/).waitFor();
    const saved = page.waitForResponse(r => r.url().includes("/api/scenes/recommend-") &&
      r.request().method() === "PUT" && r.status() === 201);
    await compare.getByRole("button", { name: "사본 저장", exact: true }).click();
    const copy = await (await saved).json();
    assert.ok(copy.items.some((item: {instanceId: string}) => item.instanceId === "practice-uplink-switch"));
    await page.getByLabel("장면", { exact: true }).selectOption(copy.sceneId);
    await waitForAssessment(page);
    await btn("목표 체크리스트").click();
    await checklist.getByText("✅ 달성 · 동시 전달량 ≥ 800 Mbps", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("추천 빈 화면에서 후보의 출처와 모델을 추가하는 방법을 안내한다", async () => {
  const { page } = await edge.newPage("/");
  try {
    const help = page.getByRole("dialog", { name: helpName });
    if (await help.isVisible()) await help.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByLabel("장면", { exact: true }).selectOption("three-ports");
    await waitForAssessment(page);
    await page.getByRole("button", { name: "추천", exact: true }).click();
    await page.locator(".recommendations").getByText(/보유·후보 인벤토리.*내 모델.*카탈로그.*새 아이템/).waitFor({ timeout: 3500 });
  } finally { await page.close(); }
});
