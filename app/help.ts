// 처음 작업대를 열었을 때 할 일을 보여 주고 도움말을 닫은 선택을 저장한다.
export function mountHelp(fetchLocal: (url: string, init?: RequestInit) => Promise<Response | undefined>) {
  const endpoint = "/api/settings/help";
  const dialog = document.createElement("dialog");
  dialog.className = "creator help-dialog";
  dialog.setAttribute("aria-labelledby", "help-title");
  dialog.innerHTML = `
    <header><h2 id="help-title">작업대 도움말</h2></header>
    <dl class="creator-body help-topics">
      <dt>인벤토리</dt><dd>장면 선택기에서 예제를 골라 보세요. 인벤토리의 실물을 빈 곳에 끌어 놓거나 <b>캔버스에 놓기</b>를 누릅니다.</dd>
      <dt>연결과 근거</dt><dd>포트에서 상대 포트로 끌어 연결합니다. 케이블을 쓰려면 먼저 <b>연결에 사용</b>을 누르세요. 배선을 누르면 <b>결과 · 왜?</b>에서 한도와 출처를 볼 수 있습니다.</dd>
      <dt>시나리오 · 작업</dt><dd>함께 돌릴 작업을 고르고 요청값을 바꿔, 단독으로 쓸 때와 함께 쓸 때를 비교합니다.</dd>
      <dt>검증 퀘스트</dt><dd>판정이나 범위를 바꿀 값을 확인하고 해당 실물의 측정값과 조건을 기록합니다.</dd>
      <dt>수집기</dt><dd><b>실행 방법과 대본 전문</b>을 검토하고 원할 때 Windows PowerShell에서 직접 실행합니다. 생성된 JSON을 가져와 확인한 행을 적용합니다.</dd>
      <dt>구매 예산</dt><dd><b>구매 목록 편집</b>과 <b>수동 견적 입력</b>으로 예산을 확인하고, <b>로드아웃 비교</b>에서 두 구성을 비교합니다.</dd>
      <dt>새 아이템</dt><dd>직접 입력하거나 템플릿·기존 모델에서 시작합니다. <b>AI 조사</b>는 서버에 Claude 키를 설정하면 사용할 수 있습니다.</dd>
    </dl>
    <footer>
      <span role="status"></span>
      <form method="dialog"><button autofocus>닫기</button></form>
    </footer>`;
  document.body.append(dialog);

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "도움말";
  trigger.setAttribute("aria-haspopup", "dialog");
  let opened = false;
  let dismissed = false;
  function open() {
    opened = true;
    dialog.showModal();
  }
  trigger.onclick = open;
  dialog.onclose = async () => {
    if (dismissed) return;
    dismissed = true;
    const response = await fetchLocal(endpoint, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ helpDismissed: true }), keepalive: true,
    });
    dismissed = Boolean(response?.ok);
    dialog.querySelector("[role=status]")!.textContent = dismissed ? "" : "도움말 닫기를 기억하지 못했습니다.";
  };

  return { trigger, async showOnFirstRun() {
    const response = await fetchLocal(endpoint);
    if (!response?.ok) return;
    const { helpDismissed } = await response.json() as { helpDismissed: boolean };
    dismissed ||= helpDismissed;
    if (!opened && !dismissed) open();
  } };
}
