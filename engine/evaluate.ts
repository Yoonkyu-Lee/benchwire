// 단독 후보를 검산하고 시나리오의 연결 설정·동시 모드를 선택해 판정과 대안을 낸다.
import type { Choice, DomainPlugin, Scene } from "./contract.ts";
import { allocationGroup, type Flow, type Use } from "./allocate.ts";
import { assessWork } from "./assess.ts";
import { negotiate, verdictOrder } from "./negotiate.ts";
import { paths, type RouteInputs } from "./path.ts";
import { judgeConnections, judgeWork } from "./judge.ts";
import { addReason, checkedQuantity, checkedTrace, type Results } from "./results.ts";

import { policyAllocation } from "./policy.ts";
import { uncertainPolicies } from "./policy-range.ts";
import { uncertainPreferences } from "./preference.ts";
import { reserveStanding } from "./standing.ts";
import { combinations, compareScores, MAX_COMBINATIONS, planModes, profileGroups, reservationAlternatives, type Candidate, type Plan } from "./selection.ts";
import { resolveUnknowns } from "./unknown.ts";

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
          const u = { ...trace, fixed: fixed ?? 0, coefficient: coefficient ?? 0, unknown };
          return !d.elastic && d.requested !== null ? { ...u, fixed: u.fixed + u.coefficient * d.requested, coefficient: 0 } : u;
        })
        .filter(u => u.coefficient > 0 || u.fixed > 0 || u.unknown);
      for (const s of steps) if (s.option !== null && p.verdict !== "impossible") {
        const o = result.options[s.option]!;
        uses.push({ resource: scene.resources.length + (o.serviceResource ?? o.linkResource), option: s.option, coefficient: d.elastic ? 1 : 0,
          fixed: d.elastic ? 0 : d.requested ?? 0, rule: "같은 방향의 링크 한도", inputs: o.inputs, specs: o.specs });
        if (o.poolResource !== undefined) {
          const pool = result.linkResources[o.poolResource]!.pool!, scale = o.pool!.perUnit;
          uses.push({ resource: scene.resources.length + o.poolResource, option: s.option, pool: o.poolResource,
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
          if (o.verdict === "impossible" || o.unit !== d.unit || o.mode !== (step.carrier?.mode ?? d.mode)) continue;
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

function prepare(scene: Scene, plugins: readonly DomainPlugin[], locked?: Plan[], modeLock?: number) {
  const result: Results = { physical: [], options: [], demands: [], paths: [], steps: [], allocations: [], bindings: [], outcomes: [],
    reservations: [], choices: [], searches: [], standingErrors: [], standingLoads: [], matches: [], assessments: [], measures: [], possibleVerdicts: [], quests: [], rangeInputs: [], wirings: [],
    metrics: [], reasons: [], reasonInputs: [], reasonParents: [], reasonSpecs: [], needs: [], errors: [], linkResources: [],
    specSources: plugins.flatMap(p => p.sources.map(s => ({ ...s, domain: p.id }))) };
  negotiate(scene, plugins, result);
  reserveStanding(scene,plugins,result);
  const possibleLinks = scene.workloads.map(() => new Set<number>());
  if (!locked && result.options.some(o => o.profile)) {
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
      const key = JSON.stringify(choices.map(c => [c.connection,c.profile]));
      let candidates = cache.get(key);
      if (!candidates) {
        candidates = candidatesFor(scene,plugins,result,routes,choices);
        cache.set(key,candidates);
      }
      plans.push(...planModes(scene,plugins,result,members,candidates,choices,settings.every(s => s.confirmed),budget,modeLock === scenario ? fixed : undefined));
    }
    plans.sort((a,b) => compareScores(b.score,a.score) || Number(b.confirmed)-Number(a.confirmed) || a.key.localeCompare(b.key));
    const alternatives = locked ? [] : plans.flatMap(p => reservationAlternatives(scene,plugins,result,p,budget));
    result.searches.push({ scenario, ...budget });
    return [...plans,...alternatives];
  });
  if (!scenarios.length) candidatesFor(scene,plugins,result,routes,[]);
  return { result, routes, scenarios };
}

function render(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routes: RouteInputs[], selected: Plan[]) {
  const configured = new Set(selected.flatMap(p => p.choices.map(c => c.connection)));
  judgeConnections(scene,plugins,result, c => !configured.has(c));
  selected.forEach((plan, scenario) => {
    const { active, together, picked, candidates, choices } = plan;
    for (const workload of plan.advances ?? []) result.reservations.push({ scenario, workload });
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
      if (plan.advances?.some(w => peerIds.has(w))) addReason(result,{outcome:row,stage:"allocate",
        rule:"선택 대안에서 먼저 들인 고정 예약",targetKind:"workload",targetRow:w},
        plan.advances.flatMap(w => {
          const f = active.find(f => f.workload === w)!;
          return f.path === null ? [] : result.demands[result.paths[f.path]!.demand]!.inputs;
        }),[prior]);
      const edges = result.steps.filter(s => s.path === f.path && s.kind === "connection");
      for (const c of choices) if (edges.some(e => e.row === c.connection))
        addReason(result,{outcome:row,stage:"negotiate",rule:"연결 설정 " + c.profile,targetKind:"connection",targetRow:c.connection},
          c.inputs,[prior],c.domain,c.specs);
      if (result.searches[scenario]!.truncated) addReason(result,{outcome:row,stage:"judge",rule:"조합 탐색 상한에서 확인한 결과",
        targetKind:"workload",targetRow:w},[],[prior]);
      return row;
    });
    uncertainPolicies(scene,plugins,result,active,together,active.map(f => chosen[f.workload]!.solo),outcomes);
    uncertainPreferences(plugins,result,active.map(f => f.workload),outcomes,routes,chosen);
    for (const row of outcomes) assessWork(scene,plugins.find(p => p.id === result.outcomes[row]!.domain)!,result,row);
  });
  return result;
}

function evaluatePlans(scene: Scene, plugins: readonly DomainPlugin[], scenario?: number) {
  const prepared = prepare(scene,plugins), { scenarios, routes } = prepared;
  const primary = scenarios.map(plans => plans[0]!);
  const alternatives = scenario === undefined ? [] : scenarios[scenario]!.slice(1).filter(p => p.confirmed);
  const selections = [primary, ...alternatives.map(p => primary.map((base,i) => i === scenario ? p : base))];
  return selections.map((selected,i) => {
    const tables = i === selections.length-1 ? prepared.result : structuredClone(prepared.result);
    const result = render(scene,plugins,tables,routes,selected);
    resolveUnknowns(scene,plugins,result,(world,domains) => {
      const modeLock = i > 0 && scenario !== undefined && scenarios[scenario]!.some(p => p !== selected[scenario] &&
        p.choices === selected[scenario]!.choices) ? scenario : undefined;
      const next = prepare(world,domains,selected,modeLock);
      const plans = next.scenarios.map(list => list[0]!);
      return render(world,domains,next.result,next.routes,plans);
    },routes);
    return { choices: scenario === undefined ? [] : selected[scenario]!.choices, result };
  });
}

export function evaluate(scene: Scene, plugins: readonly DomainPlugin[]): Results {
  return evaluatePlans(scene,plugins)[0]!.result;
}

export function evaluateVariants(scene: Scene, plugins: readonly DomainPlugin[], scenario: number): { choices: Choice[]; result: Results }[] {
  return evaluatePlans(scene,plugins,scenario);
}
