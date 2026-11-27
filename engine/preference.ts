// 상위 모드의 성립이 열려 있으면 확인된 대안과 그 자원을 공유하는 작업의 결과를 함께 보존한다.
import type { DomainPlugin, Verdict } from "./contract.ts";
import type { Flow, Share } from "./allocate.ts";
import { addReason, type Results } from "./results.ts";
import type { RouteInputs } from "./path.ts";
import { competingWorks } from "./unknown.ts";

interface Candidate { flow: Flow; solo: Share; preference: number }
export function uncertainPreferences(plugins: readonly DomainPlugin[], result: Results,
  members: number[], outcomes: number[], routes: RouteInputs[], chosen: readonly { flow: Flow; solo: Share; refused: Candidate[] }[]) {
  const pending = members.map(w => chosen[w]!.refused.filter(c => c.solo.verdict === "unknown"));
  if (pending.every(list => !list.length)) return;
  const original = outcomes.map(row => result.outcomes[row]!.verdict);
  const prior = outcomes.map(row => result.reasons.findLastIndex(r => r.outcome === row && r.stage === "judge"));
  for (const [i, w] of members.entries()) {
    const group = competingWorks(w, members, routes);
    const affecting = members.flatMap((p,j) => group.has(p) && pending[j]!.length ? [j] : []);
    if (!affecting.length) continue;
    const row = outcomes[i]!, o = result.outcomes[row]!, own = pending[i]!;
    const possible = new Set<Verdict>(result.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict));
    if (original[i] !== "unknown") possible.add(original[i]!);
    if (affecting.some(j => j !== i) || !possible.size) {
      possible.add("impossible");
      for (const candidate of [chosen[w]!, ...own]) {
        if (candidate.flow.path === null) continue;
        const path = result.paths[candidate.flow.path]!;
        if (!path.conditioned) possible.add("ok");
        if (path.conditioned || candidate.flow.elastic) possible.add("conditional");
      }
    }
    for (const c of own) {
      // 상위 모드만 실패하면 이미 성립한 폴백이 선택된다.
      const conditioned = c.preference > 0 || c.flow.path !== null && result.paths[c.flow.path]!.conditioned;
      const alternatives = c.solo.range?.possible ?? (conditioned ? ["conditional"] as const
        : c.flow.elastic ? ["ok","conditional"] as const : ["ok"] as const);
      for (const v of alternatives) if (v !== "impossible") possible.add(v);
    }
    const claims = [...new Set(affecting.flatMap(j => [...routes[members[j]!]!.claims]))];
    addReason(result, { outcome: row, stage: "judge", rule: "더 높은 선호 모드의 성립 미확인", targetKind: "workload", targetRow: w },
      claims, [prior[i]!, ...affecting.map(j => prior[j]!)]);
    result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== row);
    for (const verdict of possible) result.possibleVerdicts.push({ outcome: row, verdict });
    o.verdict = possible.size === 1 ? [...possible][0]! : "unknown";
    if (own.length) o.mode = "";
    o.label = plugins.find(p => p.id === o.domain)!.explain(o.verdict, o.mode);
    const affected = (run: string) => own.length > 0 || run !== "solo";
    const belongs = (b: { scenario: number; workload: number; run: string }) => b.scenario === o.scenario && b.workload === w && affected(b.run);
    for (const metric of result.metrics.filter(m => m.outcome === row && affected(m.kind))) {
      const performance = metric.kind === "solo" || metric.kind === "together";
      let low: number | null = performance ? 0 : null, high: number | null = null;
      if (performance) {
        const single = metric.kind === "solo" || members.length === 1;
        low = single ? Math.min(metric.low ?? 0, ...own.map(c => c.flow.elastic ? c.solo.range?.low ?? 0 : c.flow.cap ?? 0)) : 0;
        const caps = [single ? metric.high : chosen[w]!.flow.cap, ...own.map(c => c.solo.range?.high ?? c.flow.cap)];
        if (caps.every(v => v !== null) && own.every(c => result.demands[result.paths[c.flow.path!]!.demand]!.unit === metric.unit)) high = Math.max(...caps);
        else low = 0;
      }
      Object.assign(metric, { value: low !== null && low === high ? low : null, basis: "calculated", range: "conservative", low, high });
    }
    for (const a of result.allocations.filter(belongs)) a.value = result.metrics.find(m => m.outcome === row && m.kind === a.run)!.value;
    result.bindings = result.bindings.filter(b => !belongs(b));
  }
}
