// 후보를 합치기 전 한 세계의 선택 경로와 수치 경계로 기술 목표와 근거 표를 만든다.
import { readClaim, type Goal, type Scene } from "./scene.ts";
import { compareQuantity } from "./contract.ts";
import { assessmentInput } from "./assess.ts";
import type { GoalVerdict, Results } from "./results.ts";

type Evidence = Results["goalEvidence"][number];

function every(verdicts: GoalVerdict[]): GoalVerdict {
  if (verdicts.includes("impossible")) return "impossible";
  return verdicts.length && verdicts.every(v => v === "ok") ? "ok" : "unknown";
}

export function goalReasons(goal: Goal, result: Results, outcome: number) {
  return result.reasons.flatMap((r,i) => r.outcome === outcome &&
    (goal.kind !== "metric" || !r.run || r.run === goal.run) ? [i] : []);
}

export function judgeGoals(scene: Scene, result: Results) {
  const goals: Results["goals"] = [], goalEvidence: Evidence[] = [];
  for (const [goal,g] of (scene.goals ?? []).entries()) {
    const checks: Evidence[] = [];
    const portChoices: Set<number>[] = [];
    const scenarioCapped = result.searches.some(s => s.scenario === g.scenario && s.truncated);
    let incomplete = scenarioCapped, combinationLimit = scenarioCapped;
    const openClaims = new Set<number>();
    const workloads = g.kind === "scenario" ? scene.members.filter(m => m.scenario === g.scenario).map(m => m.workload)
      : g.kind === "workload" ? [g.workload] : g.workloads;
    for (const workload of workloads) {
      const outcome = result.outcomes.findIndex(o => o.scenario === g.scenario && o.subjectKind === "workload" && o.subjectRow === workload);
      const o = result.outcomes[outcome];
      const check: Evidence = {goal,workload,outcome,verdict:"unknown",low:null,high:null,connections:[],reasons:[],claims:[]};
      checks.push(check);
      if (!scene.members.some(m => m.scenario === g.scenario && m.workload === workload)) {
        check.issue = "notMember"; continue;
      }
      if (!o) continue;
      check.reasons = goalReasons(g,result,outcome);
      const reasons = new Set(check.reasons);
      check.claims = [...new Set(result.reasonInputs.filter(i => reasons.has(i.reason)).map(i => i.claim))];
      const run = g.kind === "metric" ? g.run : "together";
      const path = run === "solo" ? o.soloPath ?? o.path : o.path;
      if (scenarioCapped || path !== null && result.paths[path]!.truncated) { combinationLimit = incomplete = true; continue; }
      const deliveryGoal = g.kind === "metric" && g.metric === "delivery";
      // 한 세계에서 플러그인 판정과 지표는 실제 전달량 한 점으로 평가했을 때만 목표의 근거가 된다.
      if (!deliveryGoal && path !== null && result.assessments.some(a => a.outcome === outcome && a.run === run)) {
        const input = assessmentInput(result,outcome,run,path);
        if (input.low !== input.high) {
          incomplete = true;
          for (const r of result.rangeInputs) if (r.outcome===outcome && r.deliveryRuns?.includes(run)) {
            const c=readClaim(scene,r.claim,"evidence");
            if (c.openDomain && !c.discrete && c.conflictGroup===undefined) openClaims.add(r.claim);
          }
          continue;
        }
      }
      const possible = result.possibleVerdicts.filter(v => v.outcome === outcome);
      if (g.kind === "metric") {
        if (g.metricDomain !== undefined && o.domain !== g.metricDomain) continue;
        const m = deliveryGoal ? result.metrics.find(m => m.outcome === outcome && m.kind === g.run &&
          (m.unit === g.unit || !m.unit && o.path === null && m.low === 0 && m.high === 0))
          : result.measures.find(m => m.outcome === outcome && m.run === g.run && m.kind === g.metric && m.unit === g.unit);
        check.low = m?.low ?? null;
        check.high = m?.high ?? null;
        if (check.low !== null && compareQuantity(check.low,g.minimum) >= 0) check.verdict = "ok";
        else if (check.high !== null && compareQuantity(check.high,g.minimum) < 0) check.verdict = "impossible";
      } else if (g.kind === "port") {
        const paths = o.possiblePaths ?? (o.path === null ? [] : [o.path]);
        if (paths.some(p => result.paths[p]!.truncated)) { combinationLimit = incomplete = true; continue; }
        const choices = new Set<number>();
        let validPaths = 0;
        const visits: NonNullable<Evidence["portVisits"]> = [];
        check.portVisits = visits;
        for (const p of paths) {
          const ports = new Set<number>(), links = new Set<number>();
          for (const step of result.steps) {
            if (step.path !== p || step.kind !== "connection") continue;
            const mates = result.physical.filter(s => s.kind === "mate" && s.connection === step.row && s.direction === step.direction);
            for (const port of mates.flatMap(s => [s.entry,s.exit])) if (scene.ports[port]!.item === g.item) {
              ports.add(port); links.add(step.row);
              if (!check.connections.includes(step.row)) check.connections.push(step.row);
              if (!visits.some(v => v.connection === step.row && v.port === port)) visits.push({connection:step.row,port});
            }
          }
          if (ports.size === 1 && links.size === 1 && (g.port === undefined || ports.has(g.port))) {
            validPaths++; for (const link of links) choices.add(link);
          }
        }
        if (choices.size) portChoices.push(choices);
        const works = o.verdict !== "unknown" || possible.length > 0 && possible.every(v => v.verdict === "ok" || v.verdict === "conditional");
        if (o.verdict === "impossible" || paths.length && !validPaths) check.verdict = "impossible";
        else if (works && validPaths && validPaths === paths.length) check.verdict = "ok";
      } else {
        if (o.verdict === "ok") check.verdict = "ok";
        else if (o.verdict !== "unknown" || possible.length && possible.every(v => v.verdict !== "ok" && v.verdict !== "unknown"))
          check.verdict = "impossible";
      }
    }
    let verdict = every(checks.map(c => c.verdict));
    if (portChoices.length > 1) {
      const shared = [...portChoices[0]!].some(link => portChoices.every(choices => choices.has(link)));
      if (!shared) verdict = "impossible";
      else if (verdict === "ok" && portChoices.some(choices => choices.size > 1)) verdict = "unknown";
    }
    if (incomplete || checks.some(c => c.issue)) verdict = "unknown";
    goals.push({id:g.id,scenario:g.scenario,combined:false,truncated:incomplete,verdict,
      ...(combinationLimit && {limitClaims:[]}),...(openClaims.size && {openClaims:[...openClaims]})});
    goalEvidence.push(...checks);
  }
  return {goals,goalEvidence};
}
