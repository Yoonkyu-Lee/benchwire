// 모르는 분배 정책의 수치 경계와 max-min 가정값을 같은 배선의 단독·동시 결과에 연결한다.
import type { DomainPlugin, Scene, Verdict } from "./contract.ts";
import { allocationGroup, throughputUpper, type Flow, type Share } from "./allocate.ts";
import { addReason, type Results } from "./results.ts";
import { resourceFacts } from "./scene.ts";
import { policyAllocation } from "./policy.ts";

export function uncertainPolicies(scene: Scene, plugins: readonly DomainPlugin[], result: Results, active: Flow[], shares: Share[], solo: Share[], outcomes: number[]) {
  const unknown = scene.resources.flatMap((_, i) => {
    const users = active.filter(f => f.cap !== 0 && f.verdict !== "impossible" && f.uses.some(u => u.resource === i));
    const unresolved = scene.claims[resourceFacts(scene, i).policy]!.value === null || shares.some(s => s.unresolvedPolicies?.includes(i));
    return users.length > 1 && unresolved ? [i] : [];
  });
  if (!unknown.length) return;
  const fair = policyAllocation(scene, plugins, result, active, unknown);
  active.forEach((flow, i) => {
    if (shares[i]!.verdict !== "unknown" || flow.path === null) return;
    const peers = allocationGroup(active, flow);
    const policies = unknown.filter(r => peers.some(f => f.uses.some(u => u.resource === r))).map(r => resourceFacts(scene, r).policy);
    if (!policies.length) return;
    const outcome = outcomes[i]!, o = result.outcomes[outcome]!, plugin = plugins.find(p => p.id === o.domain)!;
    const demand = result.demands[result.paths[flow.path]!.demand]!;
    // 다른 작업 몫을 0으로 놓아도 자기 수요·물리 용량을 넘을 수 없다. 동시 전용 정책은 단독값과 다를 수 있다.
    const upper = throughputUpper(scene, result, flow, shares[i]!.policies);
    const alone = solo[i]!.value, estimate = fair[i]!.value;
    for (const m of result.metrics.filter(m => m.outcome === outcome)) {
      if (m.kind !== "together" && m.kind !== "drop" && m.kind !== "dropPercent") continue;
      m.range = "conservative";
      m.basis = estimate === null ? "calculated" : "assumed";
      if (m.kind === "together") { m.low = 0; m.high = upper; m.value = estimate; }
      else {
        const factor = m.kind === "drop" ? 1 : alone ? 100 / alone : null;
        m.low = alone === null || upper === null || factor === null ? null : (alone - upper) * factor;
        m.high = alone === null || factor === null ? null : alone * factor;
        m.value = alone === null || estimate === null || factor === null ? null : (alone - estimate) * factor;
      }
    }
    const possible = new Set<Verdict>(["impossible"]);
    if (upper === null || upper > 0) {
      if (demand.elastic || flow.verdict === "conditional" || flow.verdict === "unknown") possible.add("conditional");
      if (flow.verdict !== "conditional" && (upper === null || demand.requested === null || upper >= demand.requested)) possible.add("ok");
    }
    o.verdict = possible.size === 1 ? [...possible][0]! : "unknown";
    o.label = plugin.explain(o.verdict, o.mode);
    for (const verdict of possible) result.possibleVerdicts.push({ outcome, verdict });
    const prior = result.reasons.findIndex(r => r.outcome === outcome && r.stage === "judge");
    addReason(result, { outcome, stage: "judge", rule: "정책 미확인의 용량 경계와 균등 분배 가정", targetKind: "workload", targetRow: flow.workload },
      policies, prior < 0 ? [] : [prior]);
    for (const claim of policies) {
      const resource = scene.resources[scene.claims[claim]!.owner]!;
      const owner = plugins.find(p => p.id === resource.domain)!;
      result.quests.push({ outcome, claim, instruction: owner.quest("policy") });
    }
  });
}
