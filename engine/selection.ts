// 연결 단위의 설정과 시나리오의 동시 모드 조합을 실제 배분 결과로 비교한다.
import type { Choice, DomainPlugin, Scene } from "./contract.ts";
import type { Flow, Share } from "./allocate.ts";
import type { Results } from "./results.ts";
import { optionVerdict } from "./negotiate.ts";
import { availableOption } from "./pools.ts";
import { assessDelivery } from "./assess.ts";
import { policyAllocation } from "./policy.ts";

// 시나리오마다 같은 배선 위에서 실제 배분까지 검산하는 조합 수의 상한이다.
export const MAX_COMBINATIONS = 128;
// 탄력 수요 달성률 합의 부동소수점 반올림은 같은 점수로 본다.
const SCORE_EPSILON = 1e-12;
export interface Candidate { flow: Flow; solo: Share; preference: number; length: number; key: string; truncated: boolean }
export interface WorkloadSelection {
  modes: { workload: number; mode: string; preference: number }[];
  advances?: number[];
}
export interface Plan {
  workloads: WorkloadSelection;
  choices: Choice[]; active: Flow[]; together: Share[]; picked: Candidate[]; candidates: Candidate[][];
  score: number[]; key: string; signature: string; confirmed: boolean;
}

export function* combinations<T>(groups: readonly T[][]): Generator<T[]> {
  const indices = groups.map(() => 0);
  if (groups.some(g => !g.length)) return;
  while (true) {
    yield groups.map((g,i) => g[indices[i]!]!);
    let i = indices.length - 1;
    for (; i >= 0; i--) {
      indices[i] = indices[i]! + 1;
      if (indices[i]! < groups[i]!.length) break;
      indices[i] = 0;
    }
    if (i < 0) return;
  }
}

export function profileGroups(scene: Scene, r: Results, connections: Set<number>) {
  const groups = [];
  for (const connection of [...connections].sort((a,b) => scene.connections[a]!.id.localeCompare(scene.connections[b]!.id))) {
    const tagged = r.options.flatMap((o,i) => o.connection === connection && o.profile ? [{ o, verdict: optionVerdict(availableOption(r,i)) }] : []);
    const names = [...new Set(tagged.map(x => x.o.profile!))].sort();
    const choices = names.flatMap(profile => {
      const witnesses = tagged.filter(x => x.o.profile === profile && x.verdict !== "impossible").sort((a,b) =>
        Number(a.verdict === "unknown") - Number(b.verdict === "unknown") || a.o.domain.localeCompare(b.o.domain) || a.o.rule.localeCompare(b.o.rule));
      const first = witnesses[0];
      if (!first) return [];
      const choice: Choice = { connection, profile, domain: first.o.domain, rule: first.o.rule,
        inputs: [...new Set(witnesses.flatMap(x => x.o.inputs))], specs: first.o.specs };
      return [{ choice, confirmed: first.verdict !== "unknown" }];
    });
    if (choices.length) groups.push(choices);
  }
  return groups;
}

// 양수는 첫 조합의 목표 달성도가 더 높다는 뜻이다.
export function compareScores(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > SCORE_EPSILON) return a[i]! - b[i]!;
  return 0;
}

export function planModes(scene: Scene, plugins: readonly DomainPlugin[], r: Results, members: Scene["members"],
  candidates: Candidate[][], choices: Choice[], confirmed: boolean, budget: { examined: number; truncated: boolean }, selectedWorkloads?: WorkloadSelection) {
  const ranks = [...new Set(members.flatMap(m => m.priority === undefined ? [] : [m.priority]))].sort((a,b) => a-b);
  const used = members.map(m => new Set(candidates[m.workload]!.flatMap(c => c.flow.uses.map(u => u.resource))));
  const menus = members.map((m,i) => {
    const list = candidates[m.workload]!, first = list[0]!;
    const wanted = selectedWorkloads?.modes.find(mode => mode.workload === m.workload);
    if (wanted) {
      const matching = list.find(c => c.flow.path !== null && c.preference === wanted.preference &&
        r.demands[r.paths[c.flow.path]!.demand]!.mode === wanted.mode);
      if (matching) return [matching];
    }
    const shared = used.some((resources,j) => j !== i && [...resources].some(r => used[i]!.has(r)));
    if (!shared || first.truncated) return [first];
    const seen = new Set([first.flow.path === null ? -1 : r.paths[first.flow.path]!.demand]);
    return [first, ...list.slice(1).filter(c => {
      if (c.flow.path === null || c.solo.verdict === "unknown" || c.solo.verdict === "impossible") return false;
      const demand = r.paths[c.flow.path]!.demand;
      if (seen.has(demand)) return false;
      seen.add(demand);
      return true;
    })];
  });
  const best: Plan[] = [];
  for (const picked of combinations(menus)) {
    if (budget.examined >= MAX_COMBINATIONS) { budget.truncated = true; break; }
    budget.examined++;
    const active = picked.map((c,i) => ({ ...c.flow, ...(members[i]!.priority === undefined ? {} : { priority: members[i]!.priority }) }));
    if (selectedWorkloads?.advances) {
      const tiers = [...new Set(active.map(f => f.priority ?? Infinity))].sort((a,b) => a-b);
      for (const flow of active) flow.priority = 2*tiers.indexOf(flow.priority ?? Infinity) + (selectedWorkloads.advances.includes(flow.workload) ? 0 : 1);
    }
    const together = policyAllocation(scene,plugins,r,active);
    const goals = together.map((share,i) => {
      const f = active[i]!, assess = plugins.find(p => p.id === scene.workloads[f.workload]!.domain)?.assess;
      if (!assess || f.path === null) return share;
      const delivered = { low: share.range?.low ?? share.value ?? 0, high: share.range?.high ?? share.value ?? f.cap };
      return { ...share, verdict: assessDelivery(scene,r,assess,f.workload,f.path,delivered).verdict };
    });
    const score: number[] = [];
    const success = (s: Share) => s.verdict === "ok" || s.verdict === "conditional";
    function scoreTier(indices: number[]) {
      const served = indices.filter(i => success(goals[i]!));
      score.push(served.length, -served.reduce((sum,i) => sum + picked[i]!.preference,0),
        served.filter(i => goals[i]!.verdict === "ok").length);
    }
    for (const rank of ranks) scoreTier(members.flatMap((m,i) => m.priority === rank ? [i] : []));
    scoreTier(active.flatMap((f,i) => f.elastic ? [] : [i]));
    score.push(goals.filter(success).length, goals.filter(s => s.verdict === "ok").length,
      -picked.reduce((n,c) => n + c.preference,0), goals.filter(s => s.verdict === "unknown").length,
      together.reduce((n,s,i) => n + (active[i]!.elastic && active[i]!.cap ? (s.value ?? 0) / active[i]!.cap! : 0),0));
    const comparison = best.length ? compareScores(score,best[0]!.score) : 1;
    if (comparison < 0) continue;
    if (comparison > 0) best.length = 0;
    const modes = picked.map((c,i) => {
      const path = c.flow.path === null ? null : r.paths[c.flow.path]!;
      return [scene.workloads[c.flow.workload]!.id, path && r.demands[path.demand]!.mode, c.preference, c.flow.cap, together[i]!.verdict, together[i]!.value];
    });
    const signature = JSON.stringify(modes);
    if (best.some(p => p.signature === signature)) continue;
    const key = JSON.stringify([choices.map(c => [scene.connections[c.connection]!.id,c.profile]),
      picked.map((c,i) => [modes[i]!.slice(0,4),c.key])]);
    const workloads: WorkloadSelection = { modes: picked.map(c => ({ workload: c.flow.workload, preference: c.preference,
      mode: c.flow.path === null ? "" : r.demands[r.paths[c.flow.path]!.demand]!.mode })) };
    if (selectedWorkloads?.advances) workloads.advances = selectedWorkloads.advances;
    best.push({ active, together, picked, candidates, choices, confirmed, score, key, signature, workloads });
  }
  return best;
}

// 동순위의 예약이 넘칠 때 실제 정책의 미확인 결과와 사용자가 순서를 정할 수 있는 대안을 구별한다.
export function reservationAlternatives(scene: Scene, plugins: readonly DomainPlugin[], result: Results, plan: Plan,
  budget: { examined: number; truncated: boolean }) {
  const tied = plan.together.flatMap((s,i) => s.contested && !plan.active[i]!.elastic ? [i] : []);
  if (tied.length < 2) return [];
  const ranks = [...new Set(plan.active.map(f => f.priority ?? Infinity))].sort((a,b) => a-b);
  const alternatives: Plan[] = [];
  for (const flags of combinations(tied.map(() => [false,true]))) {
    if (!flags.some(Boolean) || flags.every(Boolean)) continue;
    if (budget.examined >= MAX_COMBINATIONS) { budget.truncated = true; break; }
    budget.examined++;
    const first = tied.filter((_,j) => flags[j]);
    const flows = plan.active.map((f,i) => ({ ...f, priority: 2*ranks.indexOf(f.priority ?? Infinity) + (first.includes(i) ? 0 : 1) }));
    const together = policyAllocation(scene,plugins,result,flows);
    if (tied.some(i => together[i]!.value === null)) continue;
    const signature = JSON.stringify(together.map(s => [s.verdict,s.value]));
    if (alternatives.some(p => p.signature === signature)) continue;
    const advances = first.map(i => flows[i]!.workload);
    alternatives.push({ ...plan, active: flows, together, signature, workloads: { ...plan.workloads, advances } });
  }
  return alternatives;
}
