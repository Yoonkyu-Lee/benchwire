// 추천 탭이 보고 있는 장면의 편집을 워커에서 하나씩 검산하고 확인된 카드부터 보여 준다.
import type {Snapshot} from "../engine/compare.ts";
import {plugins} from "../domains/registry.ts";
import {scenarioName} from "../scene/files.ts";
import {measurementValueText} from "../scene/measurement.ts";
import type {Documents} from "./assessment.ts";
import type {Library,SceneDocument} from "./document.ts";
import {prices,snapshot,money} from "./swap-view.ts";
import {goalVerdictText,renderIncompleteGoal} from "./goal-changes.ts";
import {appendQuestInstructions,claimQuest,questName} from "./quests.ts";
import {interval,quantity,resultView,verdictText,type ResultView} from "./results.ts";
import {recommendationEdits,reviewRecommendation,recommendationCost,rankRecommendations,workloadRegressionCount,type Recommendation,type RecommendationEdit} from "./recommend.ts";

interface Input { doc:SceneDocument; before:Snapshot; scenario:string|null; library:Library }

function workText(state: Recommendation["workloadChanges"][number]["runs"][number]["after"]) {
  if (!state) return "없음";
  const { verdict, delivery } = state;
  const range = delivery ? interval(delivery, delivery.unit) : "전달량 미확인";
  const value = delivery && delivery.value !== null && (delivery.low !== delivery.value || delivery.high !== delivery.value)
    ? (delivery.basis === "assumed" ? "가정 " : "값 ") + quantity(delivery.value, delivery.unit) : "";
  return [verdict && verdictText[verdict], range, value].filter(Boolean).join(" · ");
}
export function mountRecommendations(documents:Documents, read:()=>Input|undefined, compare:(edit:RecommendationEdit)=>void) {
  const panel=document.createElement("section");
  panel.className="recommendations";
  const owner={};
  let current:Input|undefined, inventory:Library["inventory"]|undefined, models:Library["models"]|undefined, generation=0;
  let running=false;
  return (list:HTMLElement)=>{
    if (panel.parentElement!==list) list.replaceChildren(panel);
    const input=read();
    if (input && current?.doc===input.doc && current.before.result===input.before.result && current.scenario===input.scenario &&
        inventory===input.library.inventory && models===input.library.models && (running || panel.childElementCount)) return;
    const turn=++generation;
    current=input; inventory=input?.library.inventory; models=input?.library.models;
    panel.replaceChildren();
    const status=document.createElement("p");
    status.setAttribute("role","status");
    panel.append(status);
    if (!input) {status.textContent="장면 판정을 기다리는 중입니다.";return;}
    const {doc,before,scenario,library}=input;
    function empty() {
      status.className="inventory-empty";
      status.textContent="표시할 추천 장비가 없습니다.";
    }
    if (!scenario) {empty();return;}
    const startedInventory=library.inventory, startedModels=library.models;
    const plan=recommendationEdits(doc,documents,library,before,scenario);
    if (!plan.total) {empty();return;}
    let count=0, failures=0;
    const cards:{card:Recommendation; view:ResultView}[]=[];
    const scenarios = new Map(doc.scenarios.map(s => [s.id, s]));
    const name = (id: string, inScenario = scenario) => scenarios.get(inScenario)?.goals?.find(g => g.id === id)?.label ?? id;
    const expanded = new Set<string>();
    const stillCurrent=()=>{
      const now=read();
      return turn===generation && panel.isConnected && now?.doc===doc && now.scenario===scenario &&
        now.before.result===before.result && now.library.inventory===startedInventory && now.library.models===startedModels;
    };
    const paint=()=>{
      status.textContent="후보 "+plan.total+"개 중 "+count+"개 확인"+(running ? " 중…" : "")+
        (failures ? " · 평가할 수 없는 편집 "+failures+"개" : "")+(!running && !cards.length ? " · 목표 달성 사례 없음" : "");
      const rows=cards.sort((a,b)=>rankRecommendations(a.card,b.card)).map(({card,view})=>{
        const row=document.createElement("article");
        row.className="inventory-item";
        const title=document.createElement("strong"); title.textContent=card.edit.model.name+" · "+card.edit.model.revision;
        row.append(title);
        const line=(s:string)=>{const p=document.createElement("p");p.textContent=s;row.append(p);};
        if (card.achieved.length) {
          const summary = workloadRegressionCount(card) ? "목표는 달성, 다른 작업이 깨짐" :
            card.goalRegressions.length ? "목표는 달성, 기존 목표 회귀" :
            card.budgetRegression ? "목표는 달성, 구매 예산에 영향" : "이 아이템으로 해결";
          line(summary + " · " + card.achieved.map(id => name(id)).join(", "));
        }
        for (const [index, condition] of card.conditional.entries()) {
          line("이 조건에서 가능 · " + name(condition.goal));
          for (const { claim, value } of condition.assignments) {
            const source = view.scene.claims[claim]!, q = claimQuest(view, claim), label = questName(q);
            const expected = label + " = " + measurementValueText(value, source.unit);
            const key = card.edit.document.sceneId + "-quest-" + index + "-" + claim;
            const control = document.createElement("button");
            control.type = "button";
            control.textContent = "확인 퀘스트";
            control.setAttribute("aria-label", label + " 확인 퀘스트");
            control.setAttribute("aria-controls", key);
            const detail = document.createElement("section");
            detail.id = key;
            detail.setAttribute("aria-label", label + " 확인 퀘스트");
            detail.hidden = !expanded.has(key);
            control.setAttribute("aria-expanded", String(!detail.hidden));
            const check = document.createElement("p");
            check.textContent = "달성 조건 · " + expected;
            detail.append(check);
            appendQuestInstructions(detail, { ...q, instruction: plugins.find(p => p.id === source.domain)?.quest(source.field) ??
              label + " 값을 확인하세요." });
            control.onclick = () => {
              detail.hidden = !detail.hidden;
              if (detail.hidden) expanded.delete(key);
              else expanded.add(key);
              control.setAttribute("aria-expanded", String(!detail.hidden));
            };
            const assignment = document.createElement("p");
            assignment.append(expected + " ", control);
            row.append(assignment, detail);
          }
        }
        for (const id of card.incomplete) {
          const index=view.result.goals.findIndex(goal=>goal.id===id && goal.scenario===view.scenario);
          const goal=view.result.goals[index]!;
          line("❓ 목표 검산 미완료 · "+name(id));
          row.append(renderIncompleteGoal(view,goal));
          const outcomes=new Set(view.result.goalEvidence.filter(e=>e.goal===index).map(e=>e.outcome));
          const claims=new Set([...(goal.limitClaims ?? []),...(goal.openClaims ?? []),
            ...view.result.quests.filter(q=>outcomes.has(q.outcome)).map(q=>q.claim)]);
          for (const claim of claims) {
            const c=view.scene.claims[claim]!, q=claimQuest(view,claim);
            const label=questName(q);
            const instruction=plugins.find(p=>p.id===c.domain)?.quest(c.field) ?? label+" 값을 확인하세요.";
            line("확인 퀘스트 · "+label+" · "+instruction);
          }
        }
        for (const { scenario, workload, runs } of card.workloadChanges) for (const run of runs) {
          line([scenarioName(scenarios.get(scenario)!), workload, run.run === "together" ? "동시" : "단독",
            !run.regression && "전달량 상한 감소", workText(run.before) + " → " + workText(run.after)].filter(Boolean).join(" · "));
        }
        for (const change of card.goalRegressions) {
          line([scenarioName(scenarios.get(change.scenario)!), name(change.goal, change.scenario),
            goalVerdictText[change.before] + " → " + (change.after ? goalVerdictText[change.after] : "없음")].join(" · "));
        }
        if (card.budgetRegression) line("구매 예산 · 한도 이내에서 미확인 또는 한도 초과로 변경");
        line(card.cost===null ? "추가 비용 미확인" : "추가 비용 "+money(card.cost)+(card.edit.item.state==="owned" ? " · 보유" : ""));
        const button=document.createElement("button");button.textContent="사본 비교";
        button.onclick=()=>{if (stillCurrent()) compare(card.edit);};row.append(button);
        return row;
      });
      panel.replaceChildren(status,...rows);
    };
    running=true;paint();
    void (async()=>{
      const book=await prices().catch(()=>null);
      for (const edit of plan.edits) {
        if (!stillCurrent()) break;
        try {
          const after=await snapshot(edit.document,documents,owner);
          if (!stillCurrent()) break;
          const card=reviewRecommendation(before,after,edit,scenario);
          if (card) {
            if (book) recommendationCost(doc,before,after,card,scenario,book);
            const index=after.scene.scenarios.findIndex(s=>s.id===scenario);
            cards.push({card,view:resultView(after.scene,after.result,index,"together")});
          }
        } catch (error) {if (!(error instanceof Error)) throw error;failures++;}
        count++;paint();
      }
      if (turn!==generation) return;
      running=false;
      if (stillCurrent()) paint();
      else current=undefined;
    })();
  };
}
