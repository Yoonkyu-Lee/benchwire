// 단독·동시 배분량의 범위를 작업 목표에 대조하고 전달량과 별개인 지표를 남긴다.
import type { DomainPlugin, KnownVerdict, Scene } from "./contract.ts";
import { addReason, checkedQuantity, checkedTrace, type Results } from "./results.ts";

export function assessWork(scene: Scene, plugin: DomainPlugin, result: Results, outcome: number) {
  const o = result.outcomes[outcome]!;
  if (!plugin.assess || o.path === null) return;
  const path = result.paths[o.path]!, demand = result.demands[path.demand]!;
  const steps = result.steps.filter(s => s.path === o.path);
  const prior = result.reasons.findLastIndex(r => r.outcome === outcome && r.stage === "judge");
  for (const run of ["solo","together"] as const) {
    const delivered = result.metrics.find(m => m.outcome === outcome && m.kind === run)!;
    const low = delivered.low ?? 0, high = delivered.high ?? demand.requested;
    const raw = plugin.assess(scene, o.subjectRow, demand, steps, { low, high });
    const assessment = checkedTrace(result, plugin.id, "demand", o.subjectRow, raw);
    const possible = new Set<KnownVerdict>(assessment.possible);
    if (!possible.size || !o.mode || path.truncated) {
      for (const v of ["ok","conditional","impossible"] as const) possible.add(v);
    } else if (path.verdict === "impossible") {
      possible.clear();
      possible.add("impossible");
    } else {
      if (path.bestCase === "unknown" && !low) possible.add("impossible");
      const conditioned = demand.preference > 0 || steps.some(s => result.matches.some(m =>
        m.demand === path.demand && m.option === s.option && m.verdict === "conditional") || s.option !== null && (result.options[s.option]!.condition || result.options[s.option]!.verdict === "conditional"));
      if (conditioned && possible.delete("ok")) possible.add("conditional");
    }
    for (const verdict of possible) result.assessments.push({ outcome, run, verdict });
    for (const m of assessment.metrics) {
      const bound = (side: "low" | "high") => checkedQuantity(result, plugin.id, "demand", o.subjectRow, m.kind + "." + side, m[side]);
      result.measures.push({ outcome, run, kind: m.kind, unit: m.unit, low: o.mode && !path.truncated ? bound("low") : null,
        high: o.mode && !path.truncated ? bound("high") : null });
    }
    addReason(result, { outcome, run, stage: "judge", rule: assessment.rule, targetKind: "workload", targetRow: o.subjectRow },
      assessment.inputs, prior < 0 ? [] : [prior], plugin.id, assessment.specs);
    if (run === "together") {
      o.verdict = possible.size === 1 ? [...possible][0]! : "unknown";
      o.label = plugin.explain(o.verdict, o.mode);
      result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== outcome);
      for (const verdict of possible) result.possibleVerdicts.push({ outcome, verdict });
    }
  }
}
