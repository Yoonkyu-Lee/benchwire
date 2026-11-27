// 판정이나 선택한 자원 근거에서 출발해 공유되는 선행 근거를 한 번씩 펼친다.
import type { Results, Run } from "./results.ts";

export function evidenceRows(result: Pick<Results, "reasons" | "reasonParents">,
  start: { outcome: number; run?: Run } | { reasons: readonly number[] }) {
  const run = "outcome" in start ? start.run : undefined;
  const included = (r: Results["reasons"][number]) => !run || !r.run || r.run === run;
  const parents = new Map<number, number[]>();
  const priorInOutcome = new Set<number>();
  for (const { reason, prior } of result.reasonParents) {
    if (!included(result.reasons[reason]!) || !included(result.reasons[prior]!)) continue;
    const list = parents.get(reason);
    if (list) list.push(prior);
    else parents.set(reason, [prior]);
    if ("outcome" in start && result.reasons[reason]!.outcome === start.outcome) priorInOutcome.add(prior);
  }
  const roots = "reasons" in start ? start.reasons : result.reasons.flatMap((r, i) =>
    r.outcome === start.outcome && included(r) && !priorInOutcome.has(i) ? [i] : []);
  const pending = roots.map(reason => ({ reason, depth: 0 })).reverse();
  const seen = new Set<number>();
  const rows: { reason: number; depth: number; reference: boolean }[] = [];
  while (pending.length) {
    const entry = pending.pop()!;
    const reference = seen.has(entry.reason);
    rows.push({ ...entry, reference });
    if (reference) continue;
    seen.add(entry.reason);
    const edges = parents.get(entry.reason) ?? [];
    for (let i = edges.length - 1; i >= 0; i--) pending.push({ reason: edges[i]!, depth: entry.depth + 1 });
  }
  return rows;
}
