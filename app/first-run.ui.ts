// 첫 실행의 작업대 도움말을 보고 닫은 뒤 새 Edge 세션에서도 선택을 기억하는지 검증한다.
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeSession } from "./edge-session.ts";

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
