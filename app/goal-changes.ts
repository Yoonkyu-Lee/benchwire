// 체크리스트와 비교 화면에 같은 목표 판정과 미완료 근거를 표시한다.
import { hasUnsteppedNumber } from "./field.ts";
import { claimQuest, questName } from "./quests.ts";
import type { ResultView } from "./results.ts";

type GoalOutcome = ResultView["result"]["goals"][number];
export const goalVerdictText = { ok: "✅ 달성", impossible: "❌ 미달", unknown: "❓ 미확인" };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

export function renderIncompleteGoal(view: ResultView, outcome: GoalOutcome, openQuest?: (claim: number) => void) {
  const note = document.createDocumentFragment();
  function claimRow(claim: number, cause: "limit" | "open") {
    const q = claimQuest(view, claim);
    const name = questName(q);
    const li = element("li", name);
    if (cause === "open") li.append(hasUnsteppedNumber(q.property)
      ? " 값은 규격 걸음이 없어 모든 값을 확인할 수 없습니다." : "의 가능한 값을 모두 확인할 수 없습니다.");
    if (openQuest) {
      const verify = element("button", "확인 퀘스트 열기");
      verify.type = "button";
      verify.onclick = () => openQuest(claim);
      verify.setAttribute("aria-label", name + " 확인 퀘스트 열기");
      li.append(" ", verify);
    }
    return li;
  }
  if (outcome.limitClaims) {
    note.append(element("p", "후보 조합 수가 검산 상한을 넘었습니다."));
    if (outcome.limitClaims.length) {
      const details = element("details"), claims = element("ul");
      details.append(element("summary", "조합을 이루는 주장 " + outcome.limitClaims.length + "개"), claims);
      claims.append(...outcome.limitClaims.map(claim => claimRow(claim, "limit")));
      note.append(details);
    }
  }
  if (outcome.openClaims?.length) {
    const claims = element("ul");
    claims.append(...outcome.openClaims.map(claim => claimRow(claim, "open")));
    note.append(claims);
  }
  if (!outcome.limitClaims && !outcome.openClaims?.length)
    note.append(element("p", "전달량이 범위로만 알려져 이 목표를 판정할 수 없습니다."));
  return note;
}

export function renderGoalChanges(before: ResultView, after: ResultView,
  labels: readonly { id: string; label?: string | undefined }[]) {
  const goals = (view: ResultView) => new Map(view.result.goals.filter(goal => goal.scenario === view.scenario).map(goal => [goal.id, goal]));
  const old = goals(before), next = goals(after);
  const names = new Map(labels.flatMap(({ id, label }) => label ? [[id, label] as const] : []));
  const list = element("ul");
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id), b = next.get(id);
    if (a?.verdict === b?.verdict) continue;
    const row = element("li");
    row.append(element("span", (names.get(id) ?? id) + " · " + (a ? goalVerdictText[a.verdict] : "없음") +
      " → " + (b ? goalVerdictText[b.verdict] : "없음")));
    if (a?.truncated) row.append(renderIncompleteGoal(before, a));
    if (b?.truncated) row.append(renderIncompleteGoal(after, b));
    list.append(row);
  }
  if (!list.childElementCount) return undefined;
  const section = element("section");
  section.setAttribute("aria-label", "목표 변화");
  section.append(element("h3", "목표 변화 " + list.childElementCount + "건"), list);
  return section;
}
