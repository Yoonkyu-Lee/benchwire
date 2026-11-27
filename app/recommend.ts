// 실패한 목표의 결합점과 병목에서 단일 편집을 만들고 사본의 실제 목표·부하·비용으로 순위를 정한다.
import { compare, type Snapshot } from "../engine/compare.ts";
import { compareQuantity, type Verdict } from "../engine/contract.ts";
import type { GoalVerdict, Results, Run } from "../engine/results.ts";
import { portFacts } from "../engine/scene.ts";
import type { PriceBook } from "../server/prices.ts";
import type { Documents } from "./assessment.ts";
import { calculateBudget, compareBudgets } from "./budget.ts";
import { modelKey, type Library, type Model, type SceneDocument, type InventoryItem } from "./document.ts";
import { outcomeVerdict, resultView } from "./results.ts";
import { swapSlot } from "./swap.ts";

// 한 번 연 추천 탭에서 실제로 평가하는 서로 다른 편집 수다.
export const MAX_RECOMMENDATIONS = 8;
export interface RecommendationEdit {
  kind:"insert"|"replace"; target:string; item:InventoryItem; model:Model; document:SceneDocument;
}
type WorkState = { verdict: Verdict | null; delivery: Results["metrics"][number] | undefined };
type WorkRegression = { scenario: string; workload: string; runs: { run: Run; before: WorkState; after: WorkState | null }[] };
type GoalRegression = { scenario: string; goal: string; before: GoalVerdict; after: GoalVerdict | null };
type Assignments = NonNullable<Results["goalSuccesses"]>[number]["assignments"];

export interface Recommendation {
  edit: RecommendationEdit; achieved: string[];
  workloadRegressions: WorkRegression[]; goalRegressions: GoalRegression[]; budgetRegression: boolean;
  conditional: { goal: string; assignments: Assignments }[]; incomplete: string[]; cost: bigint | null;
}

export function recommendationEdits(doc:SceneDocument, documents:Documents, library:Library, before:Snapshot, scenarioId:string) {
  const {scene,result}=before, scenario=scene.scenarios.findIndex(s=>s.id===scenarioId);
  const failures=new Set(result.goals.flatMap((g,i)=>g.scenario===scenario && g.verdict!=="ok" ? [i] : []));
  const tasks=new Set(result.goalEvidence.filter(e=>failures.has(e.goal)).map(e=>e.workload));
  const swaps=new Set<string>(), links=new Set<number>(), blocked=new Set<number>();
  for (const b of result.bindings) if (b.scenario===scenario && tasks.has(b.workload)) {
    if (b.resourceKind==="scene") swaps.add(scene.items[scene.resources[b.resource]!.item]!.id);
    else blocked.add(result.linkResources[b.resource]!.connection);
  }
  for (const p of result.paths.filter(p=>tasks.has(p.workload))) for (const c of p.disconnected??[]) links.add(c);
  for (const step of result.steps) if (step.kind==="connection" && tasks.has(result.paths[step.path]!.workload)) {
    links.add(step.row);
    if (result.paths[step.path]!.verdict!=="ok") blocked.add(step.row);
  }
  for (const p of result.physical) if (links.has(p.connection) && p.verdict!=="ok") blocked.add(p.connection);
  for (const row of blocked) for (const part of doc.connections[row]!.parts) swaps.add(part.instanceId);
  const failedMates=result.physical.filter(p=>links.has(p.connection) && p.direction==="forward" && p.kind==="mate" && p.verdict==="impossible");
  const seen=new Set<string>(), edits:RecommendationEdit[]=[];
  const available=library.inventory.filter(i=>!doc.items.some(v=>v.instanceId===i.instanceId));
  const stock=new Map<string,InventoryItem>();
  for (const item of available.toSorted((a,b)=>Number(b.state==="owned")-Number(a.state==="owned")))
    if (!stock.has(modelKey(item))) stock.set(modelKey(item),item);
  const candidates=[...new Map([...library.models,...available.flatMap(i=>documents.models.get(modelKey(i))??[])].map(m=>[modelKey(m),m])).values()]
    .sort((a,b)=>Number(stock.get(modelKey(b))?.state==="owned")-Number(stock.get(modelKey(a))?.state==="owned"));
  function add(kind:RecommendationEdit["kind"],target:string,at:number,entry:string,exit:string,model:Model) {
    const key=JSON.stringify([kind,target,at,entry,exit,modelKey(model)]);
    if (seen.has(key)) return;
    const item=stock.get(modelKey(model))??{instanceId:"item-"+crypto.randomUUID(),state:"candidate",modelId:model.modelId,revision:model.revision};
    const sceneId="recommend-"+crypto.randomUUID();
    let copy:SceneDocument;
    if (kind==="replace") {
      const {document}=swapSlot(doc,documents,{originalId:target,replacementId:item.instanceId,sceneId,replacement:model});
      if (!document) return;
      copy={...document,items:document.items.map(v=>v.instanceId===item.instanceId ? item : v)};
    } else {
      copy={...doc,sceneId,items:[...doc.items,item],connections:doc.connections.map(c=>c.id!==target ? c :
        {...c,parts:c.parts.toSpliced(at,0,{instanceId:item.instanceId,entry,exit})})};
    }
    seen.add(key);
    if (edits.length===MAX_RECOMMENDATIONS) return;
    copy.scenarios=copy.scenarios.map(s=>{
      if (s.id!==scenarioId || s.purchases?.some(p=>"instanceId" in p && p.instanceId===item.instanceId || "ownedInstanceId" in p && p.ownedInstanceId===item.instanceId)) return s;
      return {...s,purchases:[...s.purchases??[],{instanceId:item.instanceId}]};
    });
    edits.push({kind,target,item,model,document:copy});
  }
  function fits(port:number,connector:Model["ports"][number]["connector"]) {
    const index=portFacts(scene,port).connector, a=index===null ? null : scene.connectors[index]!.id, b=connector.value;
    return a===null || b===null || connector.conflicts?.length || library.connectors.mates.some(m=>m.a===a && m.b===b || m.b===a && m.a===b);
  }
  for (const model of candidates) {
    if (model.kind!=="device") for (const mate of failedMates) {
      for (const entry of model.ports.filter(p=>fits(mate.entry,p.connector)))
        for (const exit of model.ports.filter(p=>p!==entry && fits(mate.exit,p.connector)))
          add("insert",doc.connections[mate.connection]!.id,mate.order/2,entry.id,exit.id,model);
    }
    for (const id of swaps) {
      const old=doc.items.find(v=>v.instanceId===id)!, source=documents.models.get(modelKey(old))!;
      if (model.kind===source.kind && model.category===source.category && modelKey(model)!==modelKey(source))
        add("replace",id,0,"","",model);
    }
  }
  return {total:seen.size,edits};
}

const verdictRank = { impossible: 0, unknown: 1, conditional: 2, ok: 3 };
const runs = ["together", "solo"] as const;

function workloadRegressions(before: Snapshot, after: Snapshot): WorkRegression[] {
  function state(result: Results, row: number, run: Run): WorkState {
    return { verdict: outcomeVerdict(result, row, run), delivery: result.metrics.find(m => m.outcome === row && m.kind === run) };
  }
  return compare(before, after).flatMap(({ before: left, after: right, changed }) => {
    if (left === null || !changed.some(key => key === "removed" || key === "verdict" || key === "value" || key === "range")) return [];
    const outcome = before.result.outcomes[left]!;
    if (outcome.subjectKind !== "workload") return [];
    const losses = runs.flatMap(run => {
      const a = state(before.result, left, run), b = right === null ? null : state(after.result, right, run);
      if (a.verdict === null && !a.delivery) return [];
      const verdictLost = a.verdict !== null && (b?.verdict == null || verdictRank[b.verdict] < verdictRank[a.verdict]);
      const prior = a.delivery, next = b?.delivery;
      const valueLost = prior && next && prior.unit === next.unit && (["value", "low", "high"] as const).some(field => {
        const old = prior[field], updated = next[field];
        return old !== null && updated !== null && compareQuantity(updated, old) < 0;
      });
      return b === null || verdictLost || valueLost ? [{ run, before: a, after: b }] : [];
    });
    return losses.length ? [{ scenario: before.scene.scenarios[outcome.scenario!]!.id,
      workload: before.scene.workloads[outcome.subjectRow]!.id, runs: losses }] : [];
  });
}

export function reviewRecommendation(before:Snapshot, after:Snapshot, edit:RecommendationEdit, scenarioId:string):Recommendation|null {
  const members = (s: Snapshot) => s.scene.members.map(m => JSON.stringify([s.scene.scenarios[m.scenario]!.id, s.scene.workloads[m.workload]!.id]));
  const remaining = new Set(members(after));
  if (members(before).some(id => !remaining.has(id)) ||
      before.scene.workloads.some(w => !after.scene.workloads.some(v => v.id === w.id))) return null;
  const loads=(s:Snapshot,remap:boolean)=>s.result.standingLoads.map(l=>{
    const id=s.scene.items[l.item]!.id;
    return JSON.stringify([remap && edit.kind==="replace" && id===edit.target ? edit.item.instanceId : id,l.id,l.domain,l.kind,l.unit,l.amount,l.bounds]);
  });
  const nextLoads=loads(after,false);
  for (const row of loads(before,true)) {
    const index=nextLoads.indexOf(row);
    if (index<0) return null;
    nextLoads.splice(index,1);
  }
  const key = (scenario: string, goal: string) => JSON.stringify([scenario, goal]);
  const next = new Map(after.result.goals.map((g, row) => [key(after.scene.scenarios[g.scenario]!.id, g.id), row]));
  const witnesses = new Map(after.result.goalSuccesses?.map(witness => [witness.goal, witness.assignments]));
  const reviewed: Recommendation = { edit, achieved: [], workloadRegressions: workloadRegressions(before, after),
    goalRegressions: [], budgetRegression: false, conditional: [], incomplete: [], cost: edit.item.state === "owned" ? 0n : null };
  for (const goal of before.result.goals) {
    const scenario = before.scene.scenarios[goal.scenario]!.id;
    const row = next.get(key(scenario, goal.id));
    const current = row === undefined ? undefined : after.result.goals[row]!;
    if (!current || verdictRank[current.verdict] < verdictRank[goal.verdict])
      reviewed.goalRegressions.push({ scenario, goal: goal.id, before: goal.verdict, after: current?.verdict ?? null });
    if (scenario !== scenarioId || !current || row === undefined || goal.verdict === "ok") continue;
    if (current.verdict === "ok") reviewed.achieved.push(goal.id);
    if (current.verdict !== "unknown") continue;
    if (current.truncated) reviewed.incomplete.push(goal.id);
    const assignments = witnesses.get(row);
    if (assignments?.length) reviewed.conditional.push({ goal: goal.id, assignments });
  }
  return reviewed.achieved.length || reviewed.conditional.length || reviewed.incomplete.length ? reviewed : null;
}

export function recommendationCost(beforeDoc:SceneDocument,before:Snapshot,after:Snapshot,card:Recommendation,scenarioId:string,book:PriceBook) {
  function budget(doc:SceneDocument,s:Snapshot) {
    const index=s.scene.scenarios.findIndex(row=>row.id===scenarioId);
    return calculateBudget(doc.scenarios.find(row=>row.id===scenarioId)!,doc.items,book,resultView(s.scene,s.result,index,"together"));
  }
  const prior=budget(beforeDoc,before), next=budget(card.edit.document,after);
  if (prior.limitStatus==="within" && next.limitStatus!=="within") card.budgetRegression = true;
  if (card.edit.item.state!=="owned") card.cost=compareBudgets(prior,next);
}
export function rankRecommendations(a:Recommendation,b:Recommendation) {
  const regressions = (card: Recommendation) => card.workloadRegressions.length + card.goalRegressions.length + Number(card.budgetRegression);
  const status = (card: Recommendation) => card.achieved.length ? 0 : card.conditional.length ? 1 : 2;
  return regressions(a)-regressions(b) || status(a)-status(b) ||
    Number(a.cost===null)-Number(b.cost===null) || (a.cost!==null && b.cost!==null && a.cost!==b.cost ? a.cost<b.cost ? -1 : 1 : 0) ||
    a.edit.model.name.localeCompare(b.edit.model.name);
}
