// 모드와 경로에 같은 선택 순서를 적용하고, 선택을 바꿀 수 있는 미확인 후보의 결과를 보존한다.
import type { DomainPlugin, Verdict } from "./contract.ts";
import type { Flow, Share } from "./allocate.ts";
import { addReason, type Results } from "./results.ts";
import type { RouteInputs } from "./path.ts";
import type { Candidate } from "./selection.ts";
import { verdictOrder } from "./negotiate.ts";
import { competingWorks } from "./unknown.ts";

export function compareCandidates(a: Candidate, b: Candidate, verdict = a.solo.verdict, amount = a.solo.value ?? 0) {
  return verdictOrder.indexOf(verdict) - verdictOrder.indexOf(b.solo.verdict) ||
    a.preference - b.preference || (b.solo.value ?? 0) - amount || a.length - b.length ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.flow.path ?? -1) - (b.flow.path ?? -1));
}

interface Pending { flow: Flow; low: number; high: number | null; possible: Verdict[] }
export function pendingChoices(result: Results, candidates: Candidate[], selected: Candidate, shared: boolean): Pending[] {
  const uncertain = (s: Share) => s.verdict === "unknown" || s.range?.low !== s.range?.high;
  const sr = selected.solo.range;
  const worst = sr?.possible.length ? sr.possible.reduce((a,b) => verdictOrder.indexOf(a) > verdictOrder.indexOf(b) ? a : b) : selected.solo.verdict;
  const incumbent = {...selected,solo:{...selected.solo,verdict:worst,value:sr?.low ?? selected.solo.value}};
  return candidates.flatMap(c => {
    if (c === selected || c.flow.path === null || !uncertain(c.solo) && !uncertain(selected.solo)) return [];
    const {flow,solo} = c, cap = flow.cap, high = solo.range?.high ?? solo.value ?? cap;
    const conditioned = result.paths[c.flow.path]!.conditioned;
    const alternatives: Verdict[] = solo.range?.possible ?? (solo.verdict !== "unknown" ? [solo.verdict]
      : conditioned ? ["conditional"] : flow.elastic ? ["ok","conditional"] : ["ok"]);
    // 연속 범위만 남으면 단독 장면에서는 실제 선택 순서로 경계를 계산한다.
    // 경쟁자가 있으면 동시 배분 전에 후보의 우열을 정할 수 없다.
    const possible = alternatives.filter(v => (v === "ok" || v === "conditional") &&
      (shared || compareCandidates(c,incumbent,v,high ?? Infinity) < 0));
    if (!possible.length) return [];
    const low = Math.min(...possible.map(v => {
      const floor = v === "ok" || !flow.elastic ? cap ?? 0 : solo.range?.low ?? solo.value ?? 0;
      // 판정과 선호가 같으면 이미 가능한 경로의 전달량 이상일 때만 이 경로가 선택된다.
      return !shared && v === worst && c.preference === selected.preference
        ? Math.max(floor,incumbent.solo.value ?? 0) : floor;
    }));
    return [{flow,possible,low,high}];
  });
}

export function uncertainPreferences(plugins: readonly DomainPlugin[], result: Results,
  members: number[], outcomes: number[], routes: RouteInputs[], chosen: readonly { flow: Flow; solo: Share; pending: Pending[] }[]) {
  const pending = members.map(w => chosen[w]!.pending);
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
    for (const c of own) for (const verdict of c.possible) possible.add(verdict);
    const claims = [...new Set(affecting.flatMap(j => [...routes[members[j]!]!.claims]))];
    addReason(result, { outcome: row, stage: "judge", rule: "선택될 모드 또는 경로 미확인", targetKind: "workload", targetRow: w },
      claims, [prior[i]!, ...affecting.map(j => prior[j]!)]);
    result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== row);
    for (const verdict of possible) result.possibleVerdicts.push({ outcome: row, verdict });
    o.verdict = possible.size === 1 ? [...possible][0]! : "unknown";
    if (own.length) {
      o.mode = "";
      o.possiblePaths = [...new Set([o.path,...own.map(c => c.flow.path)].filter(p => p !== null))];
    }
    o.label = plugins.find(p => p.id === o.domain)!.explain(o.verdict, o.mode);
    const affected = (run: string) => own.length > 0 || run !== "solo";
    const belongs = (b: { scenario: number; workload: number; run: string }) => b.scenario === o.scenario && b.workload === w && affected(b.run);
    for (const metric of result.metrics.filter(m => m.outcome === row && affected(m.kind))) {
      const performance = metric.kind === "solo" || metric.kind === "together";
      let low: number | null = performance ? 0 : null, high: number | null = null;
      if (performance) {
        const single = metric.kind === "solo" || group.size === 1;
        low = single ? Math.min(metric.low ?? 0, ...own.map(c => c.low)) : 0;
        const caps = [single ? metric.high : chosen[w]!.flow.cap, ...own.map(c => c.high)];
        if (caps.every(v => v !== null) && own.every(c => result.demands[result.paths[c.flow.path!]!.demand]!.unit === metric.unit)) high = Math.max(...caps);
        else low = 0;
      }
      Object.assign(metric, { value: low !== null && low === high ? low : null, basis: "calculated", range: "conservative", low, high });
    }
    for (const a of result.allocations.filter(belongs)) a.value = result.metrics.find(m => m.outcome === row && m.kind === a.run)!.value;
    result.bindings = result.bindings.filter(b => !belongs(b));
  }
}
