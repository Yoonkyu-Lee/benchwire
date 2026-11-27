// 단독·동시 배분량의 범위를 작업 목표에 대조하고 전달량과 별개인 지표를 남긴다.
import { readClaim } from "./scene.ts";
import type { DomainPlugin, Interval, KnownVerdict, Measure, Scene } from "./contract.ts";
import { addReason, checkedQuantity, checkedTrace, type Results, type Run } from "./results.ts";
import { callHook } from "./hook-reads.ts";

function measureInputs({low,high,inputs}:Measure) {
  if (low===null && high===null || low!==null && !Number.isFinite(low) || high!==null && !Number.isFinite(high)) return [];
  return low===null || high===null || low<=high ? inputs ?? [] : [];
}

// 배분 하한을 모르면 0, 상한을 모르면 이 경로의 요청량까지를 훅에 건넨다.
export function assessmentInput(result: Results, outcome: number, run: Run, path: number): Interval {
  const delivered = result.metrics.find(m => m.outcome === outcome && m.kind === run)!;
  return {low: delivered.low ?? 0, high: delivered.high ?? result.demands[result.paths[path]!.demand]!.requested};
}

export function assessDelivery(scene: Scene, result: Results, assess: NonNullable<DomainPlugin["assess"]>,
  workload: number, pathRow: number, delivered: Interval, unresolvedMode = false) {
  const path = result.paths[pathRow]!, demand = result.demands[path.demand]!;
  const raw=callHook(scene,result,"assess",workload,
    view=>assess(view,workload,demand,result.steps.filter(s=>s.path===pathRow),delivered)).value;
  const possible = new Set<KnownVerdict>(raw.possible);
  if (!possible.size || unresolvedMode || path.truncated) {
    for (const v of ["ok","conditional","impossible"] as const) possible.add(v);
  } else if (path.verdict === "impossible") {
    possible.clear();
    possible.add("impossible");
  } else {
    const worst = path.worstCase ?? path.verdict;
    if ((worst === "unknown" || worst === "impossible") && !delivered.low) possible.add("impossible");
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
    const path = result.paths[pathRow]!;
    const { raw, possible, verdict } = assessDelivery(scene,result,plugin.assess,o.subjectRow,pathRow,assessmentInput(result,outcome,run,pathRow),!o.mode);
    const assessment = checkedTrace(result, plugin.id, "assess", o.subjectRow, raw);
    const evidence=new Set(assessment.inputs);
    for (const verdict of possible) result.assessments.push({ outcome, run, verdict });
    for (const m of assessment.metrics) {
      const bound = (side: "low" | "high") => checkedQuantity(result, plugin.id, "assess", o.subjectRow, m.kind + "." + side, m[side]);
      result.measures.push({ outcome, run, kind: m.kind, unit: m.unit, low: o.mode && !path.truncated ? bound("low") : null,
        high: o.mode && !path.truncated ? bound("high") : null });
      for (const claim of measureInputs(m)) {
        evidence.add(claim);
        if (m.low!==m.high && readClaim(scene,claim,"evidence")?.value===null &&
          !result.rangeInputs.some(x=>x.outcome===outcome && x.claim===claim)) result.rangeInputs.push({outcome,claim});
      }
    }
    addReason(result, { outcome, run, stage: "judge", rule: assessment.rule, targetKind: "workload", targetRow: o.subjectRow },
      [...evidence], prior < 0 ? [] : [prior], plugin.id, assessment.specs);
    if (run === "together") {
      o.verdict = verdict;
      o.label = plugin.explain(o.verdict, o.mode);
      result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== outcome);
      for (const verdict of possible) result.possibleVerdicts.push({ outcome, verdict });
    }
  }
}
