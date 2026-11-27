// 설정별 작업과 상시 입력의 경로에 실제 서비스·풀·내부 자원 소비를 붙인다.
import type { Choice, Demand, DomainPlugin, Scene } from "./contract.ts";
import type { Flow, Use } from "./allocate.ts";
import { paths, type FeedDemand, type RouteInputs } from "./path.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";
import { callHook } from "./hook-reads.ts";
import { policyAllocation } from "./policy.ts";
import { compareCandidates } from "./preference.ts";
import type { Candidate } from "./selection.ts";

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

export function candidatesFor(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routeInputs: RouteInputs[], choices: Choice[], feed?: FeedDemand): Candidate[][] {
  const start = result.paths.length;
  paths(scene, plugins, result, routeInputs, choices, feed);
  return scene.workloads.map((w, workload) => {
    if (feed && workload !== feed.workload) return [];
    const plugin = plugins.find(p => p.id === w.domain)!;
    const inputs = routeInputs[workload]!;
    const candidates = result.paths.flatMap((p, path) => {
      if (path < start || p.workload !== workload) return [];
      const d = result.demands[p.demand]!, steps = result.steps.filter(s => s.path === path);
      let unknownConsumption = false;
      const consumption = p.verdict==="impossible" ? [] : callHook(scene,result,"consume",path,
        view=>plugin.consume(view,workload,steps,d,result.options)).value;
      const uses: Use[] = consumption.map(raw => {
          const trace = checkedTrace(result, w.domain, "consume", path, raw);
          const fixed = checkedQuantity(result, w.domain, "consume", path, "fixed", trace.fixed);
          const coefficient = checkedQuantity(result, w.domain, "consume", path, "coefficient", trace.coefficient);
          const {fixedHigh:rawHigh,...reservation}=trace;
          const high=rawHigh===undefined ? undefined : checkedQuantity(result,w.domain,"consume",path,"fixedHigh",rawHigh);
          const unknown = fixed === null || coefficient === null || high===null;
          unknownConsumption ||= unknown;
          const reserveRequest = !d.elastic && d.requested !== null;
          const carried = reserveRequest ? (coefficient ?? 0) * d.requested! : 0;
          return { ...reservation, fixed: (fixed ?? 0) + carried, coefficient: reserveRequest ? 0 : coefficient ?? 0, unknown,
            ...(typeof high==="number" && high!==fixed && {fixedHigh:high+carried}),
            conversion: internalConversion(scene, steps, d, raw.resource) };
        })
        .filter(u => u.coefficient > 0 || u.fixed > 0 || u.fixedHigh || u.unknown);
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
      // 같은 예산이 먼저 소진돼 부하가 덜 공급됐다면 그 예산을 쓰는 사용자 작업도 0이다.
      // 양수인 세계에서는 그 부하가 전부 공급됐다. 여러 상한을 따로 최대화해 합칠 수 없다.
      if (result.feedRequirements?.length) {
        const residual=new Map<number,number>();
        for (const costs of result.feedRequirements) {
          if (!costs.every(c=>uses.some(u=>u.resource===c.resource && (c.option===undefined || c.option===u.option)))) continue;
          for (const c of costs) residual.set(c.resource,(residual.get(c.resource)??c.capacity)-c.amount);
        }
        let ceiling=d.requested??Infinity;
        for (const [row,available] of residual) {
          const costs=uses.filter(u=>u.resource===row);
          const left=available-costs.reduce((sum,u)=>sum+u.fixed,0);
          const slope=costs.reduce((sum,u)=>sum+u.coefficient,0);
          if (left<0) ceiling=0;
          else if (slope>0) ceiling=Math.min(ceiling,left/slope);
        }
        if (ceiling<(d.requested??Infinity)) flow.standingUpper=ceiling;
      }
      const solo = policyAllocation(scene, plugins, result, [flow])[0]!;
      if (p.verdict === "impossible") {
        for (const step of steps) if (step.option !== null) {
          const o = result.options[step.option]!;
          if (o.unit !== (step.carrier?.conversion?.unit ?? d.unit) || o.mode !== (step.carrier?.mode ?? d.mode)) continue;
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
    candidates.sort(compareCandidates);
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
