// 단독 후보를 검산하고 시나리오의 연결 설정·동시 모드를 선택해 판정과 대안을 낸다.
import type { Choice, Demand, DomainPlugin, Scene } from "./contract.ts";
import { allocationGroup, type Flow, type Use } from "./allocate.ts";
import { assessWork } from "./assess.ts";
import { negotiate, verdictOrder } from "./negotiate.ts";
import { paths, type RouteInputs } from "./path.ts";
import { judgeConnections, judgeWork } from "./judge.ts";
import { addReason, checkedQuantity, checkedTrace, type Results } from "./results.ts";

import { policyAllocation } from "./policy.ts";
import { uncertainPolicies } from "./policy-range.ts";
import { uncertainPreferences } from "./preference.ts";
import { recordUsage, type GrossLimits } from "./resource-usage.ts";
import { reserveStanding } from "./standing.ts";
import { combinations, compareScores, MAX_COMBINATIONS, planModes, profileGroups, reservationAlternatives, type Candidate, type Plan, type WorkloadSelection } from "./selection.ts";
import { evaluationScene } from "./scene.ts";
import { resolveUnknowns } from "./unknown.ts";

// 내부 자원이 쓰이는 간선의 운반 단위로 공정 몫을 비교한다. 실제 점유 비용은 consume의 계수를 따른다.
function internalConversion(scene: Scene, steps: Results["steps"], demand: Demand, resource: number) {
  if (!demand.carriers || demand.carriers.length === 1) return demand.carriers?.[0]?.conversion;
  if (!demand.carriers.some(c => c.conversion)) return;
  const edges = new Set(scene.resourceUses.filter(u => u.resource === resource).map(u => u.edge));
  const local = steps.filter(s => s.kind === "edge" && edges.has(s.row)).map(s => s.carrier?.conversion);
  // 장치 전체에 부과한 비용에도 선택 경로에서 환산을 하나로 정할 수 있으면 같은 기준을 쓴다.
  const path = local.length ? local : demand.carriers.map(c => c.conversion);
  const matching = path.filter(c => (c?.unit ?? demand.unit) === scene.resources[resource]!.unit);
  const uses = matching.length ? matching : path;
  const unit = uses[0]?.unit ?? demand.unit;
  if (!uses.every(c => (c?.unit ?? demand.unit) === unit)) return;
  const rate = uses[0]?.perUnit ?? 1;
  if (uses.every(c => (c?.perUnit ?? 1) === rate)) return uses[0];
  if (!local.length) return;
  return { unit, perUnit: uses.reduce((sum, c) => sum + (c?.perUnit ?? 1) / uses.length, 0) };
}

function candidatesFor(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routeInputs: RouteInputs[], choices: Choice[]): Candidate[][] {
  const start = result.paths.length;
  paths(scene, plugins, result, routeInputs, choices);
  return scene.workloads.map((w, workload) => {
    const plugin = plugins.find(p => p.id === w.domain)!;
    const inputs = routeInputs[workload]!;
    const candidates = result.paths.flatMap((p, path) => {
      if (path < start || p.workload !== workload) return [];
      const d = result.demands[p.demand]!, steps = result.steps.filter(s => s.path === path);
      let unknownConsumption = false;
      const uses: Use[] = p.verdict === "impossible" ? [] : plugin.consume(scene, workload, steps, d, result.options)
        .map(raw => {
          const trace = checkedTrace(result, w.domain, "consume", path, raw);
          const fixed = checkedQuantity(result, w.domain, "consume", path, "fixed", trace.fixed);
          const coefficient = checkedQuantity(result, w.domain, "consume", path, "coefficient", trace.coefficient);
          const unknown = fixed === null || coefficient === null;
          unknownConsumption ||= unknown;
          const u = { ...trace, fixed: fixed ?? 0, coefficient: coefficient ?? 0, unknown,
            conversion: internalConversion(scene, steps, d, raw.resource) };
          return !d.elastic && d.requested !== null ? { ...u, fixed: u.fixed + u.coefficient * d.requested, coefficient: 0 } : u;
        })
        .filter(u => u.coefficient > 0 || u.fixed > 0 || u.unknown);
      for (const s of steps) if (s.option !== null && p.verdict !== "impossible") {
        const o = result.options[s.option]!;
        const rate = s.carrier?.conversion?.perUnit ?? 1;
        uses.push({ resource: scene.resources.length + (o.serviceResource ?? o.linkResource), option: s.option, conversion: s.carrier?.conversion, coefficient: d.elastic ? rate : 0,
          fixed: d.elastic ? 0 : (d.requested ?? 0) * rate, rule: "같은 방향의 링크 한도", inputs: o.inputs, specs: o.specs });
        if (o.poolResource !== undefined) {
          const pool = result.linkResources[o.poolResource]!.pool!, scale = rate * o.pool!.perUnit;
          uses.push({ resource: scene.resources.length + o.poolResource, option: s.option, pool: o.poolResource, conversion: s.carrier?.conversion,
            coefficient: d.elastic ? scale : 0, fixed: d.elastic ? 0 : (d.requested ?? 0) * scale,
            rule: pool.rule, inputs: pool.inputs, specs: pool.specs });
        }
      }
      const flow: Flow = { workload, path, cap: d.requested, elastic: d.elastic, uses,
        verdict: unknownConsumption ? "unknown" : p.verdict,
        bestCase: unknownConsumption ? "unknown" : p.bestCase ?? p.verdict };
      const solo = policyAllocation(scene, plugins, result, [flow])[0]!;
      if (p.verdict === "impossible") {
        for (const step of steps) if (step.option !== null) {
          const o = result.options[step.option]!;
          if (o.verdict === "impossible" || o.unit !== (step.carrier?.conversion?.unit ?? d.unit) || o.mode !== (step.carrier?.mode ?? d.mode)) continue;
          if (o.limit === 0) solo.bindings.push(scene.resources.length + (o.serviceResource ?? o.linkResource));
          if (o.poolResource !== undefined) {
            const pool = result.linkResources[o.poolResource]!.pool!;
            if ((pool.limit ?? pool.bounds?.high) === 0) solo.bindings.push(scene.resources.length + o.poolResource);
          }
        }
      }
      if (p.verdict !== "impossible") {
        for (const id of d.inputs) inputs.claims.add(id);
        for (const u of uses) {
          inputs.resources.add(u.resource);
          for (const id of u.inputs) inputs.claims.add(id);
        }
        for (const policy of solo.policies ?? []) for (const id of policy.inputs) inputs.claims.add(id);
      }
      return [{ flow, solo, preference: d.preference, length: steps.length, key: p.key, truncated: p.truncated }];
    });
    candidates.sort((a, b) => verdictOrder.indexOf(a.solo.verdict) - verdictOrder.indexOf(b.solo.verdict) ||
      a.preference - b.preference || (b.solo.value ?? 0) - (a.solo.value ?? 0) || a.length - b.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const best = candidates[0];
    if (!best) {
      const flow: Flow = { workload, path: null, cap: 0, elastic: false, verdict: "impossible", uses: [] };
      return [{ flow, solo: policyAllocation(scene, plugins, result, [flow])[0]!, preference: 0, length: 0, key: "", truncated: false }];
    }
    if (candidates.some(c => c.truncated)) {
      best.flow.verdict = "unknown";
      best.flow.bestCase = "unknown";
      best.solo = { workload, value: null, verdict: "unknown", bindings: [] };
    } else if (best.solo.verdict === "impossible" && !best.solo.policies?.length) best.flow.verdict = "impossible";
    return candidates;
  });
}

type LockedSelection = { choices: Choice[]; confirmed: boolean; workloads?: WorkloadSelection };
function profileKey(choices: Choice[]) {
  return JSON.stringify(choices.map(c => [c.connection,c.profile]));
}

function prepare(scene: Scene, plugins: readonly DomainPlugin[], locked?: (LockedSelection | undefined)[]) {
  const result: Results = { physical: [], options: [], demands: [], paths: [], steps: [], resourceUsage: [], allocations: [], bindings: [], outcomes: [],
    reservations: [], choices: [], searches: [], standingErrors: [], standingLoads: [], matches: [], assessments: [], measures: [], possibleVerdicts: [], quests: [], rangeInputs: [], wirings: [], profileWorlds: [],
    metrics: [], reasons: [], reasonInputs: [], reasonParents: [], reasonSpecs: [], needs: [], errors: [], linkResources: [],
    specSources: plugins.flatMap(p => p.sources.map(s => ({ ...s, domain: p.id }))) };
  negotiate(scene, plugins, result);
  const gross = { options: result.options.map(o => o.limit), pools: result.linkResources.map(l => l.pool?.limit ?? null) };
  reserveStanding(scene,plugins,result);
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
    const members = scene.members.filter(m => m.scenario === scenario).sort((a,b) =>
      scene.workloads[a.workload]!.id.localeCompare(scene.workloads[b.workload]!.id));
    const plans: Plan[] = [], budget = { examined: 0, truncated: false };
    const connections = new Set(members.flatMap(m => [...possibleLinks[m.workload]!]));
    const fixed = locked?.[scenario];
    const settingsList = fixed ? [fixed.choices.map(choice => ({ choice, confirmed: fixed.confirmed }))] : combinations(profileGroups(scene,result,connections));
    for (const settings of settingsList) {
      if (budget.examined >= MAX_COMBINATIONS) { budget.truncated = true; break; }
      const choices = settings.map(s => s.choice);
      const key = profileKey(choices);
      let candidates = cache.get(key);
      if (!candidates) {
        candidates = candidatesFor(scene,plugins,result,routes,choices);
        cache.set(key,candidates);
      }
      plans.push(...planModes(scene,plugins,result,members,candidates,choices,settings.every(s => s.confirmed),budget,fixed?.workloads));
    }
    plans.sort((a,b) => compareScores(b.score,a.score) || Number(b.confirmed)-Number(a.confirmed) || a.key.localeCompare(b.key));
    const alternatives = locked ? [] : plans.flatMap(p => reservationAlternatives(scene,plugins,result,p,budget));
    result.searches.push({ scenario, ...budget });
    return [...plans,...alternatives];
  });
  if (!scenarios.length) candidatesFor(scene,plugins,result,routes,[]);
  return { result, routes, scenarios, gross };
}

function render(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routes: RouteInputs[], selected: Plan[], gross: GrossLimits) {
  const configured = new Set(selected.flatMap(p => p.choices.map(c => c.connection)));
  judgeConnections(scene,plugins,result, c => !configured.has(c));
  selected.forEach((plan, scenario) => {
    const { active, together, picked, candidates, choices } = plan;
    for (const workload of plan.workloads.advances ?? []) result.reservations.push({ scenario, workload });
    result.choices.push(...choices.map(c => ({ ...c, scenario })));
    if (configured.size) judgeConnections(scene,plugins,result,c => configured.has(c),choices,scenario);
    const chosen = candidates.map(list => {
      const best = list[0]!;
      return { ...best, refused: list.filter(c => c.preference < best.preference) };
    });
    const outcomes = active.map((f,i) => {
      const w = f.workload, plugin = plugins.find(p => p.id === scene.workloads[w]!.domain)!;
      const base = candidates[w]![0]!, pick = picked[i]!;
      const refused = candidates[w]!.filter(c => c.preference < pick.preference);
      chosen[w] = { ...pick, solo: base.solo, refused };
      for (const policy of together[i]!.policies ?? []) for (const claim of policy.inputs) routes[w]!.claims.add(claim);
      const peers = f.verdict === "impossible" ? [f] : allocationGroup(active, f);
      const row = judgeWork(scene,result,plugin,scenario,f,base.solo,f.verdict === "impossible" ? pick.solo : together[i]!,peers,refused,base.flow.path);
      const prior = result.reasons.length - 1;
      const peerIds = new Set(peers.map(p => p.workload));
      const ranks = scene.members.filter(m => m.scenario === scenario && m.priority !== undefined && peerIds.has(m.workload));
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
    recordUsage(scene, result, scenario, active, outcomes, gross, chosen);
    for (const row of outcomes) assessWork(scene,plugins.find(p => p.id === result.outcomes[row]!.domain)!,result,row);
  });
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
    const result = render(scene,plugins,tables,routes,selected,prepared.gross);
    function evaluateWorld(world: Scene, domains: readonly DomainPlugin[], profileChanged: boolean, resolveWiring: boolean,
      prior = selected) {
      const locks = profileChanged && !explicit ? undefined : prior.map((plan,index) => {
        const chosen = explicit && index === scenario;
        if (profileChanged && !chosen) return undefined;
        const lock: LockedSelection = { choices: plan.choices, confirmed: plan.confirmed };
        if (chosen && fixWorkloads) lock.workloads = plan.workloads;
        return lock;
      });
      const next = prepare(world,domains,locks);
      const plans = next.scenarios.map(list => list[0]!);
      const answer = render(world,domains,next.result,next.routes,plans,next.gross);
      if (resolveWiring) resolveUnknowns(world,domains,answer,(s,p,changed,again) => evaluateWorld(s,p,changed,again,plans),next.routes,false);
      return answer;
    }
    resolveUnknowns(scene,plugins,result,evaluateWorld,routes);
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
