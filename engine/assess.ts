// 단독·동시 배분량의 범위를 작업 목표에 대조하고 전달량과 별개인 지표를 남긴다.
import type { DomainPlugin, Interval, KnownVerdict, Scene } from "./contract.ts";
import { addReason, checkedQuantity, checkedTrace, type Results } from "./results.ts";

export function assessDelivery(scene: Scene, result: Results, assess: NonNullable<DomainPlugin["assess"]>,
  workload: number, pathRow: number, delivered: Interval, unresolvedMode = false) {
  const path = result.paths[pathRow]!, demand = result.demands[path.demand]!;
  const raw = assess(scene,workload,demand,result.steps.filter(s => s.path === pathRow),delivered);
  const possible = new Set<KnownVerdict>(raw.possible);
  if (!possible.size || unresolvedMode || path.truncated) {
    for (const v of ["ok","conditional","impossible"] as const) possible.add(v);
  } else if (path.verdict === "impossible") {
    possible.clear();
    possible.add("impossible");
  } else {
    if (path.bestCase === "unknown" && !delivered.low) possible.add("impossible");
    if (path.conditioned && possible.delete("ok")) possible.add("conditional");
  }
  return { raw, possible, verdict: possible.size === 1 ? [...possible][0]! : "unknown" as const };
}

export function assessWork(scene: Scene, plugin: DomainPlugin, result: Results, outcome: number) {
  const o = result.outcomes[outcome]!;
  if (!plugin.assess || o.path === null) return;
  const prior = result.reasons.findLastIndex(r => r.outcome === outcome && r.stage === "judge");
  for (const run of ["solo","together"] as const) {
    const pathRow = run === "solo" ? o.soloPath ?? o.path : o.path;
    const path = result.paths[pathRow]!, demand = result.demands[path.demand]!;
    const delivered = result.metrics.find(m => m.outcome === outcome && m.kind === run)!;
    const low = delivered.low ?? 0, high = delivered.high ?? demand.requested;
    const { raw, possible, verdict } = assessDelivery(scene,result,plugin.assess,o.subjectRow,pathRow,{ low, high },!o.mode);
    const assessment = checkedTrace(result, plugin.id, "assess", o.subjectRow, raw);
    for (const verdict of possible) result.assessments.push({ outcome, run, verdict });
    for (const m of assessment.metrics) {
      const bound = (side: "low" | "high") => checkedQuantity(result, plugin.id, "assess", o.subjectRow, m.kind + "." + side, m[side]);
      result.measures.push({ outcome, run, kind: m.kind, unit: m.unit, low: o.mode && !path.truncated ? bound("low") : null,
        high: o.mode && !path.truncated ? bound("high") : null });
    }
    if (assessment.metrics.some(m => m.low !== m.high)) for (const claim of assessment.inputs)
      if (scene.claims[claim]?.value === null && !result.rangeInputs.some(x => x.outcome === outcome && x.claim === claim))
        result.rangeInputs.push({ outcome, claim });
    addReason(result, { outcome, run, stage: "judge", rule: assessment.rule, targetKind: "workload", targetRow: o.subjectRow },
      assessment.inputs, prior < 0 ? [] : [prior], plugin.id, assessment.specs);
    if (run === "together") {
      o.verdict = verdict;
      o.label = plugin.explain(o.verdict, o.mode);
      result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== outcome);
      for (const verdict of possible) result.possibleVerdicts.push({ outcome, verdict });
    }
  }
}
