// 단독 후보를 검산하고 시나리오의 연결 설정·동시 모드를 선택해 판정과 대안을 낸다.
import type { Choice, DomainPlugin, Scene } from "./contract.ts";
import { allocationGroup, allocationInputs } from "./allocate.ts";
import { assessWork } from "./assess.ts";
import { negotiate } from "./negotiate.ts";
import { paths, type RouteInputs } from "./path.ts";
import { judgeConnections, judgeWork } from "./judge.ts";
import { addReason, type Results } from "./results.ts";

import { candidatesFor } from "./candidates.ts";
import { uncertainPolicies } from "./policy-range.ts";
import { pendingChoices, uncertainPreferences } from "./preference.ts";
import { recordUsage, type GrossLimits } from "./resource-usage.ts";
import { availableOption } from "./pools.ts";
import { reserveStanding } from "./standing.ts";
import { combinations, compareScores, MAX_COMBINATIONS, planModes, profileGroups, reservationAlternatives, type Candidate, type Plan, type WorkloadSelection } from "./selection.ts";
import { claimRows, evaluationScene, readClaim } from "./scene.ts";
import { feedBudgets, type Supply } from "./feed.ts";
import { competingWorks, resolveUnknowns } from "./unknown.ts";

// 단독 후보의 순위가 갈릴 때 그 배분에 읽힌 예산과 경쟁 작업의 예산도 선택 근거다.
function recordRankInputs(scene: Scene, result: Results, routes: RouteInputs[], members: Scene["members"], candidates: Candidate[][]) {
  if (!result.readClaims) return;
  const jobs = members.map(m => m.workload);
  const compared = new Set<number>();
  for (const w of jobs) {
    const viable = candidates[w]!.filter(c => c.flow.path !== null && result.paths[c.flow.path]!.verdict !== "impossible");
    if (viable.length > 1) for (const peer of competingWorks(w,jobs,routes)) compared.add(peer);
  }
  if (!compared.size) return;
  for (const w of compared) for (const c of candidates[w]!)
    for (const id of allocationInputs(scene,result,[c.flow],c.solo,"score")) result.readClaims[id] = "selection";
}

type LockedSelection = { choices: Choice[]; confirmed: boolean; workloads?: WorkloadSelection };
function profileKey(choices: Choice[]) {
  return JSON.stringify(choices.map(c => [c.connection,c.profile]));
}

function prepare(scene: Scene, plugins: readonly DomainPlugin[], locked?: (LockedSelection | undefined)[]) {
  const result: Results = { physical: [], options: [], demands: [], paths: [], steps: [], resourceUsage: [], allocations: [], bindings: [], outcomes: [],
    reservations: [], choices: [], searches: [], standingErrors: [], standingLoads: [], matches: [], assessments: [], measures: [], possibleVerdicts: [], quests: [], rangeInputs: [], wirings: [], profileWorlds: [],
    metrics: [], reasons: [], reasonInputs: [], reasonParents: [], reasonSpecs: [], needs: [], errors: [], linkResources: [], goals: [], goalEvidence: [], goalWitnesses: [],
    specSources: plugins.flatMap(p => p.sources.map(s => ({ ...s, domain: p.id }))) };
  if (claimRows(scene).some(row=>{
    const c=readClaim(scene,row);
    return c.value===null && !c.inactive;
  })) scene={...scene,claimUses:result.readClaims=[]};
  negotiate(scene, plugins, result);
  const gross = { options: result.options.map(o => o.limit), pools: result.linkResources.map(l => l.pool?.limit ?? null) };
  const feeds=reserveStanding(scene,plugins,result);
  // 설정별 잔여 표를 복사해도 사용자 작업과 상시 입력의 훅 조회는 한 표에 모은다.
  if (feeds.length && result.readClaims) result.hookReads ??= [];
  const supplies=new Map<string,Supply>();
  function budgets(choices:Choice[]) {
    if (!feeds.length) return result;
    const key=profileKey(choices);
    if (!supplies.has(key)) supplies.set(key,feedBudgets(scene,plugins,result,choices,feeds));
    return {...result,...supplies.get(key)!};
  }
  const feedLinks=new Set<number>();
  if (feeds.length && result.options.some(o=>o.profile)) {
    supplies.set(profileKey([]),feedBudgets(scene,plugins,result,[],feeds,feedLinks));
  }
  const possibleLinks = scene.workloads.map(() => new Set<number>());
  if ((!locked || locked.some(p => !p)) && result.options.some(o => o.profile)) {
    const discovery: Results = { ...result, paths: [], steps: [], demands: [], matches: [] };
    const routeInputs: RouteInputs[] = [];
    paths(scene,plugins,discovery,routeInputs);
    for (const step of discovery.steps) if (step.kind === "connection") possibleLinks[discovery.paths[step.path]!.workload]!.add(step.row);
    routeInputs.forEach((used,w) => {
      for (const r of used.resources) {
        const link = result.linkResources[r - scene.resources.length];
        if (link) possibleLinks[w]!.add(link.connection);
      }
    });
  }
  const routes: RouteInputs[] = [], cache = new Map<string,Candidate[][]>();
  const scenarios = scene.scenarios.map((_,scenario) => {
    const members = scene.members.filter(m => m.scenario === scenario).map(m=>{
      if (m.evidence===undefined) return m;
      const value=readClaim(scene,m.evidence).value;
      return typeof value==="number" ? {...m,priority:value} : {scenario:m.scenario,workload:m.workload,evidence:m.evidence};
    }).sort((a,b) =>
      scene.workloads[a.workload]!.id.localeCompare(scene.workloads[b.workload]!.id));
    const plans: Plan[] = [], budget = { examined: 0, truncated: false };
    const scoreInputs = result.readClaims && new Set<number>();
    const connections = new Set([...feedLinks,...members.flatMap(m => [...possibleLinks[m.workload]!])]);
    const fixed = locked?.[scenario];
    const settingsList = fixed ? [fixed.choices.map(choice => ({ choice, confirmed: fixed.confirmed }))] : combinations(profileGroups(scene,result,connections));
    for (const settings of settingsList) {
      if (budget.examined >= MAX_COMBINATIONS) { budget.truncated = true; break; }
      const choices = settings.map(s => s.choice);
      const key = profileKey(choices);
      const available=budgets(choices);
      let candidates = cache.get(key);
      if (!candidates) {
        candidates = candidatesFor(scene,plugins,available,routes,choices);
        cache.set(key,candidates);
      }
      recordRankInputs(scene,available,routes,members,candidates);
      plans.push(...planModes(scene,plugins,available,members,candidates,choices,settings.every(s => s.confirmed),budget,fixed?.workloads,scoreInputs));
    }
    // 탈락한 모드와 다른 연결 설정까지 순위를 비교했을 때만 점수 입력이 선택을 바꿀 수 있다.
    if (scoreInputs && budget.examined > 1) for (const claim of scoreInputs) result.readClaims![claim] = "selection";
    plans.sort((a,b) => compareScores(b.score,a.score) || Number(b.confirmed)-Number(a.confirmed) || a.key.localeCompare(b.key));
    const alternatives = locked ? [] : plans.flatMap(p => reservationAlternatives(scene,plugins,budgets(p.choices),p,budget));
    result.searches.push({ scenario, ...budget });
    return [...plans,...alternatives];
  });
  if (!scenarios.length) candidatesFor(scene,plugins,budgets([]),routes,[]);
  return { result, routes, scenarios, gross, supplies };
}

function render(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routes: RouteInputs[], selected: Plan[], gross: GrossLimits, supplies:Map<string,Supply>) {
  // 사용량 표는 모든 자원의 용량을 표시한다. 실제 판정·정책 계산의 조회만 목표 세계에 보탠다.
  const inventory=scene;
  if (result.readClaims) scene={...scene,claimUses:result.readClaims};
  const configured = new Set(selected.flatMap(p => p.choices.map(c => c.connection)));
  const keys=new Set(selected.map(p=>profileKey(p.choices)));
  const byScenario=supplies.size>0 && keys.size>1;
  const supply=supplies.get(keys.values().next().value ?? "[]");
  if (supply && !byScenario) Object.assign(result,structuredClone(supply));
  if (byScenario) for (const key of keys) for (const load of supplies.get(key)!.standingLoads) {
    if (load.kind==="link") configured.add(result.linkResources[load.resource]!.connection);
  }
  judgeConnections(scene,plugins,result,c=>!configured.has(c));
  const negotiated={options:result.options,linkResources:result.linkResources};
  const standing:Results["standingLoads"]=[];
  const netOptions:{outcome:number;option:Results["options"][number]}[]=[];
  selected.forEach((plan, scenario) => {
    const { active, together, picked, candidates, choices } = plan;
    // 판정·병목 등은 같은 결과에 누적하고, 각 시나리오의 배분 입력만 갈아 끼운다.
    if (byScenario) {
      delete result.feedTotals;
      Object.assign(result,supplies.get(profileKey(choices))!);
      standing.push(...result.standingLoads.map(l=>({...l,scenario})));
    }
    for (const workload of plan.workloads.advances ?? []) result.reservations.push({ scenario, workload });
    result.choices.push(...choices.map(c => ({ ...c, scenario })));
    const firstOutcome=result.outcomes.length;
    if (configured.size) judgeConnections(scene,plugins,result,c=>configured.has(c),choices,scenario);
    if (byScenario) for (let row=firstOutcome; row<result.outcomes.length; row++) {
      const o=result.outcomes[row]!;
      if (o.option===undefined) continue;
      const cap=availableOption(result,o.option), common=availableOption(negotiated,o.option);
      if (cap.limit!==common.limit || cap.bounds?.low!==common.bounds?.low || cap.bounds?.high!==common.bounds?.high)
        netOptions.push({outcome:row,option:{...result.options[o.option]!,...cap,effective:true}});
    }
    const chosen: (Candidate & {pending: ReturnType<typeof pendingChoices>})[] = [];
    const outcomes = active.map((f,i) => {
      const w = f.workload, plugin = plugins.find(p => p.id === scene.workloads[w]!.domain)!;
      const base = candidates[w]![0]!, pick = picked[i]!;
      const shared = candidates[w]!.length > 1 && competingWorks(w,active.map(f=>f.workload),routes).size > 1;
      const pending = pendingChoices(result,candidates[w]!,pick,shared);
      const refused = candidates[w]!.flatMap(c => {
        const unresolved = pending.some(p => p.flow === c.flow);
        return unresolved || c.preference < pick.preference && c.solo.verdict !== "unknown"
          ? [{flow:c.flow,solo:c.solo,pending:unresolved}] : [];
      });
      chosen[w] = { ...pick, solo: base.solo, pending };
      for (const policy of together[i]!.policies ?? []) for (const claim of policy.inputs) routes[w]!.claims.add(claim);
      const peers = f.verdict === "impossible" ? [f] : allocationGroup(active, f);
      const row = judgeWork(scene,result,plugin,scenario,f,base.solo,f.verdict === "impossible" ? pick.solo : together[i]!,peers,refused,base.flow);
      const prior = result.reasons.length - 1;
      const peerIds = new Set(peers.map(p => p.workload));
      const ranks = scene.members.filter(m => m.scenario === scenario && m.evidence !== undefined && peerIds.has(m.workload));
      if (ranks.length) addReason(result,{outcome: row,stage:"allocate",rule:"시나리오의 고정 예약 우선순위",targetKind:"workload",targetRow:w},
        ranks.flatMap(m => m.evidence === undefined ? [] : [m.evidence]),[prior]);
      if (plan.workloads.advances?.some(w => peerIds.has(w))) addReason(result,{outcome:row,stage:"allocate",
        rule:"선택 대안에서 먼저 들인 고정 예약",targetKind:"workload",targetRow:w},
        plan.workloads.advances.flatMap(w => {
          const f = active.find(f => f.workload === w)!;
          return f.path === null ? [] : result.demands[result.paths[f.path]!.demand]!.inputs;
        }),[prior]);
      const edges = result.steps.filter(s => s.path === f.path && s.kind === "connection");
      for (const c of choices) if (edges.some(e => e.row === c.connection))
        addReason(result,{outcome:row,stage:"negotiate",rule:"연결 설정 " + c.profile,profile:c.profile,targetKind:"connection",targetRow:c.connection},
          c.inputs,[prior],c.domain,c.specs);
      if (result.searches[scenario]!.truncated) addReason(result,{outcome:row,stage:"judge",rule:"조합 탐색 상한에서 확인한 결과",
        targetKind:"workload",targetRow:w},[],[prior]);
      return row;
    });
    uncertainPolicies(scene,plugins,result,active,together,active.map(f => chosen[f.workload]!.solo),outcomes);
    uncertainPreferences(plugins,result,active.map(f => f.workload),outcomes,routes,chosen);
    recordUsage(inventory, result, scenario, active, outcomes, gross, chosen);
    for (const row of outcomes) assessWork(scene,plugins.find(p => p.id === result.outcomes[row]!.domain)!,result,row);
  });
  if (byScenario) {
    Object.assign(result,negotiated,{standingLoads:standing});
    delete result.feedRequirements;
    delete result.feedTotals;
  }
  for (const {outcome,option} of netOptions) result.outcomes[outcome]!.option=result.options.push(option)-1;
  return result;
}

function evaluatePlans(input: Scene, plugins: readonly DomainPlugin[], scenario?: number) {
  const scene = evaluationScene(input);
  const prepared = prepare(scene,plugins), { scenarios, routes } = prepared;
  const primary = scenarios.map(plans => plans[0]!);
  function solve(selected: Plan[], explicit: boolean, tables: Results) {
    // 같은 연결 설정 안에 여러 모드·예약 대안이 있어야 사용자가 작업 수준의 선택까지 한 것이다.
    const chosenProfile = explicit && scenario !== undefined ? profileKey(selected[scenario]!.choices) : undefined;
    const fixWorkloads = scenario !== undefined && chosenProfile !== undefined &&
      scenarios[scenario]!.filter(p => profileKey(p.choices) === chosenProfile).length > 1;
    const result = render(scene,plugins,tables,routes,selected,prepared.gross,prepared.supplies);
    function evaluateWorld(world: Scene) {
      const locks = !explicit ? undefined : selected.map((plan,index) => {
        if (index!==scenario) return undefined;
        const lock: LockedSelection = { choices: plan.choices, confirmed: plan.confirmed };
        if (fixWorkloads) lock.workloads = plan.workloads;
        return lock;
      });
      const next = prepare(world,plugins,locks);
      const plans = next.scenarios.map(list => list[0]!);
      return {result:render(world,plugins,next.result,next.routes,plans,next.gross,next.supplies),routes:next.routes};
    }
    resolveUnknowns(scene,plugins,result,routes,evaluateWorld,explicit ? scenario : undefined);
    delete result.readClaims;
    delete result.hookReads;
    delete result.feedRequirements;
    delete result.feedTotals;
    return { choices: scenario === undefined ? [] : result.choices.filter(c => c.scenario === scenario).map(({scenario: _scenario,...choice}) => choice), result };
  }
  if (scenario === undefined) return [solve(primary,false,prepared.result)];
  const first = solve(primary,false,structuredClone(prepared.result));
  // 임시 기본 설정이 후보마다 바뀌면, 그 설정을 고정한 결과도 사용자가 선택할 수 있는 별도 대안이다.
  const alternatives = scenarios[scenario]!.filter(p => p.confirmed && (p !== primary[scenario] ||
    p.choices.some(c => !first.choices.some(other => other.connection === c.connection && other.profile === c.profile))));
  return [first, ...alternatives.flatMap((plan,i) => {
    const variant = solve(primary.map((p,j) => j === scenario ? plan : p),true,
      i === alternatives.length - 1 ? prepared.result : structuredClone(prepared.result));
    // 설정을 전제로 만든 대안은 선택할 설정이 남아야 한다. 모드나 예약만 고르는 대안도 있다.
    return plan.choices.length && !variant.choices.length ? [] : [variant];
  })];
}

export function evaluate(scene: Scene, plugins: readonly DomainPlugin[]): Results {
  return evaluatePlans(scene,plugins)[0]!.result;
}

export function evaluateVariants(scene: Scene, plugins: readonly DomainPlugin[], scenario: number): { choices: Choice[]; result: Results }[] {
  return evaluatePlans(scene,plugins,scenario);
}
