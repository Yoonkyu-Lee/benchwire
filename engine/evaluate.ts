// 후보마다 단독 성립 여부와 성능을 비교한 뒤 같은 배선으로 시나리오를 계산한다.
import type { DomainPlugin, Scene } from "./contract.ts";
import { allocationGroup, type Flow, type Use } from "./allocate.ts";
import { negotiate, verdictOrder } from "./negotiate.ts";
import { paths, type RouteInputs } from "./path.ts";
import { judgeConnections, judgeWork } from "./judge.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";

import { policyAllocation } from "./policy.ts";
import { uncertainPolicies } from "./policy-range.ts";
import { uncertainPreferences } from "./preference.ts";
import { resolveUnknowns } from "./unknown.ts";

function evaluateWiring(scene: Scene, plugins: readonly DomainPlugin[], routeInputs: RouteInputs[] = []): Results {
  const result: Results = { physical: [], options: [], demands: [], paths: [], steps: [], allocations: [], bindings: [], outcomes: [],
    possibleVerdicts: [], quests: [], wirings: [], metrics: [], reasons: [], reasonInputs: [], reasonParents: [], reasonSpecs: [], needs: [], errors: [], linkResources: [],
    specSources: plugins.flatMap(p => p.sources.map(s => ({ ...s, domain: p.id }))) };
  negotiate(scene, plugins, result);
  paths(scene, plugins, result, routeInputs);
  judgeConnections(scene, plugins, result);
  const chosen = scene.workloads.map((w, workload) => {
    const plugin = plugins.find(p => p.id === w.domain)!;
    const inputs = routeInputs[workload]!;
    const candidates = result.paths.flatMap((p, path) => {
      if (p.workload !== workload) return [];
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
        uses.push({ resource: scene.resources.length + o.linkResource, option: s.option, coefficient: d.elastic ? 1 : 0,
          fixed: d.elastic ? 0 : d.requested ?? 0, rule: "같은 방향의 링크 한도", inputs: o.inputs, specs: o.specs });
      }
      const flow: Flow = { workload, path, cap: d.requested, elastic: d.elastic, uses,
        verdict: unknownConsumption ? "unknown" : p.verdict,
        bestCase: unknownConsumption ? "unknown" : p.bestCase ?? p.verdict };
      const solo = policyAllocation(scene, plugins, result, [flow])[0]!;
      if (p.verdict === "impossible") {
        for (const step of steps) if (step.option !== null) {
          const o = result.options[step.option]!;
          if (o.verdict !== "impossible" && o.limit === 0 && o.mode === d.mode && o.unit === d.unit)
            solo.bindings.push(scene.resources.length + o.linkResource);
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
      return { flow, solo: policyAllocation(scene, plugins, result, [flow])[0]!, refused: [] };
    }
    if (candidates.some(c => c.truncated)) {
      best.flow.verdict = "unknown";
      best.flow.bestCase = "unknown";
      best.solo = { workload, value: null, verdict: "unknown", bindings: [] };
    } else if (best.solo.verdict === "impossible" && !best.solo.policies?.length) best.flow.verdict = "impossible";
    const refused = candidates.filter(c => c.preference < best.preference);
    return { ...best, refused };
  });
  scene.scenarios.forEach((_, scenario) => {
    const active = scene.members.filter(m => m.scenario === scenario).map(m => chosen[m.workload]!.flow)
      .sort((a, b) => {
        const x = scene.workloads[a.workload]!.id, y = scene.workloads[b.workload]!.id;
        return x < y ? -1 : x > y ? 1 : 0;
      });
    const together = policyAllocation(scene, plugins, result, active);
    const outcomes = active.map((f, i) => {
      const plugin = plugins.find(p => p.id === scene.workloads[f.workload]!.domain)!;
      const { solo, refused } = chosen[f.workload]!;
      for (const policy of together[i]!.policies ?? []) for (const id of policy.inputs) routeInputs[f.workload]!.claims.add(id);
      const peers = f.verdict === "impossible" ? [f] : allocationGroup(active, f);
      return judgeWork(scene, result, plugin, scenario, f, solo, f.verdict === "impossible" ? solo : together[i]!, peers, refused);
    });
    uncertainPolicies(scene, plugins, result, active, together, active.map(f => chosen[f.workload]!.solo), outcomes);
    uncertainPreferences(plugins, result, active.map(f => f.workload), outcomes, routeInputs, chosen);
  });
  return result;
}

export function evaluate(scene: Scene, plugins: readonly DomainPlugin[]): Results {
  const routeInputs: RouteInputs[] = [];
  const result = evaluateWiring(scene, plugins, routeInputs);
  resolveUnknowns(scene, plugins, result, evaluateWiring, routeInputs);
  return result;
}
