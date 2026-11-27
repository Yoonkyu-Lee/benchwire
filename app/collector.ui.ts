// 가상 수집 JSON으로 캔버스의 맞춤·저장·다시 가져오기까지 Edge에서 확인한다.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { edgeSession } from "./edge-session.ts";

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
