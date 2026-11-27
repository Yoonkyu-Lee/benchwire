// 가상 수집 JSON으로 캔버스의 맞춤·저장·다시 가져오기까지 Edge에서 확인한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { center, edgeSession } from "./edge-session.ts";
import type { SceneDocument } from "./document.ts";

const edge = edgeSession();
test("같은 VID/PID의 두 어댑터 중 고른 한 행만 예제 사본에 적용한다",async () => {
  const {page,errors} = await edge.newPage("/");
  try {
    const file = resolve("fixtures/collect/twin-adapters.json");
    const open = page.getByRole("button",{name:"수집기",exact:true});
    await open.click();
    const panel = page.getByRole("dialog",{name:"Windows 수집기"});
    await panel.getByText("실행 방법과 대본 전문").click();
    assert.match(await panel.locator("pre").innerText(),/QueryDisplayConfig/);
    assert.equal(await panel.getByText(/로컬 드라이브의 절대 .json 경로에 씁니다.*임시 파일.*컴파일러 프로세스/).count(), 1);
    await page.screenshot({path:resolve("work/m5-collector-disclosure.png")});
    await panel.getByText("실행 방법과 대본 전문").click();
    await panel.locator('input[type="file"]').setInputFiles(file);
    const target = panel.getByRole("combobox",{name:"NIC 회선 속도 USB\\TEST_A"});
    await target.waitFor();
    await page.screenshot({path:resolve("work/m5-collector.png")});
    const choice = await target.locator("option").filter({hasText:"host-a/lan"}).getAttribute("value");
    assert(choice);
    await target.selectOption(choice);
    const apply = panel.getByRole("button",{name:"확인한 측정 적용"});
    assert(await apply.isDisabled());
    for (const id of ["host-a","lan-a-wire","router"]) {
      for (const field of ["펌웨어","측정 조건"]) await panel.getByRole("checkbox",{name:id+" "+field+" 해당 없음",exact:true}).check();
    }
    await panel.getByRole("checkbox",{name:/수집 당시/}).check();
    assert(await apply.isEnabled());
    await panel.getByRole("searchbox").fill("HUB\\A");
    assert.equal(await panel.locator("article:visible").count(),3);
    await panel.getByRole("searchbox").fill("");
    await page.screenshot({path:resolve("work/m5-collector-scope.png")});
    await apply.click();
    await page.locator('.scene-title select option:checked[value="network-copy"]').waitFor({state:"attached"});
    await open.click();
    await panel.locator('input[type="file"]').setInputFiles(file);
    await panel.getByText("이 배선에서 이미 확인한 맞춤").waitFor();
    assert(await target.isDisabled());
    assert.match(await target.locator("option:checked").innerText(),/host-a\/lan/);
    assert.equal(await panel.getByRole("combobox",{name:"NIC 회선 속도 USB\\TEST_B"}).inputValue(),"");
    assert(await apply.isDisabled());
    await panel.getByRole("button",{name:"닫기"}).click();
    await page.getByRole("button",{name:/^검증 퀘스트/}).click();
    const quests = page.getByRole("dialog",{name:"검증 퀘스트"});
    const summary = quests.locator("details.quest-card > summary").filter({hasText:/^이더넷 링크 속도 · lan-a ·/});
    await summary.click();
    const card = summary.locator("..");
    await card.getByLabel("이더넷 링크 속도 (Mbps)",{exact:true}).selectOption({label:"1000"});
    await card.getByRole("button",{name:"검증값 저장"}).click();
    await card.getByText("이미 같은 값이 저장되어 있습니다.").waitFor();
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});

test("카드를 옮겨 만든 예제 사본에 새로고침 없이 관측을 추가한다", async () => {
  const { page, errors } = await edge.newPage("/");
  const picker = page.getByRole("combobox", { name: "장면", exact: true });
  const scenePath = (id: string) => new URL("/api/scenes/" + id, page.url()).href;
  try {
    if (await picker.inputValue() !== "network") {
      const loaded = page.waitForResponse(response => response.url() === scenePath("network") && response.request().method() === "GET");
      await picker.selectOption("network");
      await loaded;
    }
    const original = await (await page.request.get(scenePath("network"))).json() as SceneDocument;
    const card = page.locator('[data-instance="pse"]');
    await card.waitFor();
    const point = await center(card.locator(".device-name"));
    const creating = page.waitForResponse(response => response.url() === scenePath("network") && response.status() === 201);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 60, point.y + 24, { steps: 5 });
    await page.mouse.up();
    const copy = await (await creating).json() as SceneDocument;
    await page.getByText("저장됨", { exact: true }).waitFor();
    assert.equal(await picker.inputValue(), copy.sceneId);
    assert.notDeepEqual(copy.layout, original.layout);

    await page.getByRole("button", { name: /^검증 퀘스트/ }).click();
    const quests = page.getByRole("dialog", { name: "검증 퀘스트" });
    await quests.getByText("실물의 현재 펌웨어 · 측정 조건", { exact: true }).click();
    await quests.getByLabel("실물", { exact: true }).selectOption("pse");
    await quests.getByLabel("현재 펌웨어 상태", { exact: true }).selectOption("value");
    await quests.getByLabel("현재 펌웨어", { exact: true }).fill("1.0");
    const verifying = page.waitForResponse(response => response.url() === scenePath(copy.sceneId) && response.status() === 204);
    await quests.getByRole("button", { name: "실물 상태 적용", exact: true }).click();
    await verifying;
    await quests.getByRole("button", { name: "닫기", exact: true }).click();
    await page.getByText("저장됨", { exact: true }).waitFor();

    await page.getByRole("button", { name: "수집기", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Windows 수집기" });
    const previewing = page.waitForRequest(request => request.url().endsWith("/api/collect") && "capture" in request.postDataJSON());
    await panel.locator('input[type="file"]').setInputFiles(resolve("fixtures/collect/twin-adapters.json"));
    const preview = await previewing;
    const target = panel.getByRole("combobox", { name: "NIC 회선 속도 USB\\TEST_A" });
    const choice = await target.getByRole("option", { name: /host-a\/lan/ }).getAttribute("value");
    assert(choice);
    await target.selectOption(choice);
    for (const id of ["host-a", "lan-a-wire", "router"]) {
      for (const field of ["펌웨어", "측정 조건"])
        await panel.getByRole("checkbox", { name: id + " " + field + " 해당 없음", exact: true }).check();
    }
    await panel.getByRole("checkbox", { name: /수집 당시/ }).check();
    const applying = page.waitForResponse(response => response.url().endsWith("/api/collect") && response.ok());
    await panel.getByRole("button", { name: "확인한 측정 적용" }).click();
    const applied = await applying;
    await panel.waitFor({ state: "hidden" });
    assert.equal(preview.postDataJSON().sceneId, copy.sceneId);
    assert.equal(applied.request().postDataJSON().sceneId, copy.sceneId);
    assert.equal((await applied.json() as { id: string }).id, copy.sceneId);
    assert.equal(await picker.inputValue(), copy.sceneId);
    const saved = await (await page.request.get(scenePath(copy.sceneId))).json() as SceneDocument;
    assert.deepEqual(saved.layout, copy.layout);
    assert.equal(saved.items.find(item => item.instanceId === "pse")?.firmware, "1.0");
    assert.deepEqual(saved.connections.flatMap(row => row.observations?.map(o => [row.id, o.claim.value]) ?? []), [["lan-a", 1000]]);
    assert.deepEqual(await (await page.request.get(scenePath("network"))).json(), original);
    await page.screenshot({ path: resolve("work/m5-collector-copy.png") });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
