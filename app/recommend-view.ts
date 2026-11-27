// 추천 탭이 보고 있는 장면의 편집을 워커에서 하나씩 검산하고 확인된 카드부터 보여 준다.
import type {Snapshot} from "../engine/compare.ts";
import {plugins} from "../domains/registry.ts";
import type {Documents} from "./assessment.ts";
import type {Library,SceneDocument} from "./document.ts";
import {prices,snapshot,money} from "./swap-view.ts";
import {renderIncompleteGoal} from "./goal-changes.ts";
import {claimQuest} from "./quests.ts";
import {resultView,type ResultView} from "./results.ts";
import {recommendationEdits,reviewRecommendation,recommendationCost,rankRecommendations,type Recommendation,type RecommendationEdit} from "./recommend.ts";

interface Input { doc:SceneDocument; before:Snapshot; scenario:string|null; library:Library }
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
    const names=new Map(doc.scenarios.find(s=>s.id===scenario)?.goals?.map(goal=>[goal.id,goal.label ?? goal.id]));
    const name=(id:string)=>names.get(id) ?? id;
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
        if (card.solved.length) line("이 아이템으로 해결 · "+card.solved.map(name).join(", "));
        for (const c of card.conditional) {line("이 조건에서 가능 · "+name(c.goal));for (const q of c.checks) line(q);}
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
            const label=[q.subject,q.template?.title ?? q.property?.title ?? q.title].filter(Boolean).join(" · ");
            const instruction=plugins.find(p=>p.id===c.domain)?.quest(c.field) ?? label+" 값을 확인하세요.";
            line("확인 퀘스트 · "+label+" · "+instruction);
          }
        }
        if (card.lost.length) line("기존 달성 목표에 영향 · "+card.lost.map(name).join(", "));
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
