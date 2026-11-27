// 선택한 동시 계획의 실제 예약·계수 소비·상시 부하를 차감 전 자원 용량에 대응시킨다.
import type { Flow } from "./allocate.ts";
import type { Results } from "./results.ts";
import { readClaim, resourceFacts, type Scene } from "./scene.ts";

type Usage = Results["resourceUsage"][number];
export interface GrossLimits { options: (number | null)[]; pools: (number | null)[] }

export function recordUsage(scene: Scene, r: Results, scenario: number, flows: Flow[], outcomes: number[], gross: GrossLimits,
  chosen: readonly { pending: {flow: Flow}[] }[]) {
  const offset = scene.resources.length, budgets = new Map<number, Usage>();
  function add(row: number, unit: string, capacity: number | null) {
    const usage: Usage = { scenario, resourceKind: row < offset ? "scene" : "link", resource: row < offset ? row : row-offset,
      unit, capacity, used: 0, basis: "calculated", reasonRows: [] };
    budgets.set(row, usage);
    return usage;
  }
  scene.resources.forEach((resource, i) => {
    const capacityClaim = resourceFacts(scene,i).capacity;
    const cap = readClaim(scene,capacityClaim,"range").value;
    add(i, resource.unit, typeof cap === "number" ? cap : null).capacityClaim = capacityClaim;
  });
  r.linkResources.forEach((l,i) => { if (l.pool) add(offset+i, l.pool.unit, gross.pools[i]!); });

  // 사용 중인 서비스는 실제 경로의 옵션이 용량을 정한다. 쓰지 않는 서비스는 연결의 선택을 따른다.
  const activeLimits = new Set<number>();
  function service(option: number, active: boolean) {
    const o = r.options[option]!, row = offset + (o.serviceResource ?? o.linkResource);
    const capacity = gross.options[option]!;
    const usage = budgets.get(row) ?? add(row,o.unit,capacity);
    if (active && !activeLimits.has(row)) {
      usage.capacity = capacity;
      activeLimits.add(row);
    } else if (usage.capacity !== capacity) usage.capacity = null;
    return usage;
  }
  for (const o of r.outcomes) if (o.option !== undefined && (o.scenario === null || o.scenario === scenario)) service(o.option,false);
  for (const l of r.standingLoads) {
    const row = l.resource + (l.kind === "link" ? offset : 0);
    const usage = budgets.get(row) ?? add(row,l.unit,null);
    usage.used = usage.used === null || l.amount === null ? null : usage.used + l.amount;
  }

  for (const t of r.feedTotals ?? []) budgets.get(t.resource)!.used=t.low===t.high ? t.low : null;

  const uncertain = new Set<number>();
  flows.forEach((f,i) => {
    const outcome = outcomes[i]!, metric = r.metrics.find(m => m.outcome === outcome && m.kind === "together")!;
    const unresolved = chosen[f.workload]!.pending;
    for (const c of unresolved) for (const u of c.flow.uses) uncertain.add(u.resource);
    if (unresolved.length) for (const u of f.uses) uncertain.add(u.resource);
    for (const u of f.uses) {
      if (metric.value === 0) continue;
      const budget = u.option !== undefined && u.pool === undefined ? service(u.option,true) : budgets.get(u.resource)!;
      if (metric.value === null || u.unknown || u.fixedHigh!==undefined) budget.used = null;
      else if (budget.used !== null) {
        budget.used += u.fixed + u.coefficient * metric.value;
        if (metric.basis === "assumed") budget.basis = "assumed";
      }
    }
  });
  for (const row of uncertain) {
    const budget = budgets.get(row);
    if (budget) budget.used = null;
  }
  for (const [reason, step] of r.reasons.entries()) {
    const o = r.outcomes[step.outcome]!;
    if (o.scenario !== null && o.scenario !== scenario || step.run === "solo") continue;
    if (step.targetKind === "resource" || step.targetKind === "linkResource") {
      const row = step.targetRow + (step.targetKind === "resource" ? 0 : offset);
      budgets.get(row)?.reasonRows.push(reason);
    } else if (o.option !== undefined && step.targetKind === "connection" && step.stage === "negotiate") {
      const option = r.options[o.option]!;
      budgets.get(offset + (option.serviceResource ?? option.linkResource))?.reasonRows.push(reason);
    }
  }
  for (const usage of budgets.values()) {
    if (usage.used === null) usage.basis = "calculated";
    r.resourceUsage.push(usage);
  }
}
