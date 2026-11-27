// 고정 예약과 반복 소비를 한 예산에 모으고 실제 처리량을 낼 수 있는 작업끼리 max-min으로 배분한다.
import type { Consumption, PolicyLimit, Scene, Verdict } from "./contract.ts";
import type { Results } from "./results.ts";
import { resourceCapacity } from "./standing.ts";
import { resourceFacts } from "./scene.ts";

// 0.3 / 3과 0.1처럼 같은 포화 시점이 연산 반올림으로 갈라지는 것을 막는다.
const RELATIVE_TOLERANCE = 16 * Number.EPSILON;
function tied(a: number, b: number) {
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

// 배분 안에서만 장면 자원 뒤에 링크 자원의 번호를 이어 붙인다.
export interface Use extends Consumption { option?: number; pool?: number; unknown?: boolean }
function linkLimit(result: Results, u: Use) {
  return u.pool === undefined ? result.options[u.option!]! : result.linkResources[u.pool]!.pool!;
}
export interface Flow { workload: number; path: number | null; cap: number | null; elastic: boolean; verdict: Verdict; bestCase?: Verdict; uses: Use[]; priority?: number }
export interface Share { workload: number; value: number | null; verdict: Verdict; range?: { low: number; high: number | null; possible: Verdict[]; inputs?: number[] }; bindings: number[]; contested?: boolean; unresolvedPolicies?: number[]; policies?: (PolicyLimit & {resource: number})[] }

// 경쟁자가 자원을 전부 양보했을 때도 넘을 수 없는 작업률이다.
export function throughputUpper(scene: Scene, result: Results, flow: Flow, policies: NonNullable<Share["policies"]> = []) {
  let upper = flow.cap;
  for (const row of new Set(flow.uses.map(u => u.resource))) {
    const uses = flow.uses.filter(u => u.resource === row), first = uses[0]!;
    const capacity = first.option === undefined ? resourceCapacity(scene, result, row) : linkLimit(result, first).limit ?? linkLimit(result, first).bounds?.high;
    const limit = policies.find(p => p.workload === flow.workload && p.resource === row)?.limit;
    if (typeof capacity !== "number" && limit === undefined) continue;
    const budget = Math.min(typeof capacity === "number" ? capacity : Infinity, limit ?? Infinity);
    const fixed = uses.reduce((n, u) => n + u.fixed, 0), slope = uses.reduce((n, u) => n + u.coefficient, 0);
    if (fixed > budget) upper = 0;
    else if (slope > 0) upper = Math.min(upper ?? Infinity, (budget - fixed) / slope);
  }
  return upper;
}

export function allocationGroup(flows: readonly Flow[], start: Flow): Flow[] {
  const group = new Set([start]), resources = new Set<number>();
  if (start.cap === 0) return [start];
  for (const current of group) for (const u of current.uses) {
    if (resources.has(u.resource)) continue;
    resources.add(u.resource);
    for (const peer of flows) if (peer.cap !== 0 && peer.verdict !== "impossible" && peer.uses.some(v => v.resource === u.resource)) group.add(peer);
  }
  return [...group];
}

// 같은 단위의 실제 처리량이 같은 속도로 자라도록 선택 경로가 선언한 단위 환산을 잇는다.
function rateUnits(result: Results, flows: readonly Flow[]) {
  const links = new Map<string, { unit: string; factor: number }[]>();
  function link(from: string, unit: string, factor: number) {
    const next = links.get(from) ?? [];
    next.push({unit, factor});
    links.set(from,next);
  }
  const units = flows.map(f => f.path === null ? "" : result.demands[result.paths[f.path]!.demand]!.unit);
  for (const [i, f] of flows.entries()) {
    if (!f.elastic || f.path === null) continue;
    for (const s of result.steps) {
      const c = s.carrier?.conversion;
      if (s.path !== f.path || !c) continue;
      link(units[i]!,c.unit,c.perUnit);
      link(c.unit,units[i]!,1 / c.perUnit);
    }
  }
  const scale = new Map<string,{base:string; weight:number}>();
  for (const base of units) {
    if (scale.has(base)) continue;
    const pending = new Set([base]);
    scale.set(base,{base,weight:1});
    for (const unit of pending) for (const edge of links.get(unit) ?? []) {
      if (scale.has(edge.unit)) continue;
      scale.set(edge.unit,{base,weight:scale.get(unit)!.weight * edge.factor});
      pending.add(edge.unit);
    }
  }
  return units.map(unit => scale.get(unit)!);
}

function fill(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number>) {
  const rates = rateUnits(result,flows);
  const shares = flows.map((f): Share => ({ workload: f.workload, value: 0, verdict: f.verdict, bindings: [] }));
  const active = new Set<number>(), uncertain = new Set<number>(), overbooked = new Set<number>();
  const pools = new Map<number, { capacity: number | null; policy: unknown; unit: string; reserved: number;
    coefficients: Map<number, number>; fixed: Map<number, number> }>();
  flows.forEach((f, i) => {
    if (f.verdict === "impossible" || f.cap === 0) return;
    if (f.cap === null || f.verdict === "unknown") uncertain.add(i);
    active.add(i);
    for (const u of f.uses) {
      let pool = pools.get(u.resource);
      const option = u.option === undefined ? null : linkLimit(result, u);
      if (!pool) {
        const facts = option ? null : resourceFacts(scene, u.resource);
        const capacity = facts ? resourceCapacity(scene, result, u.resource) : option!.limit;
        pool = { capacity: typeof capacity === "number" ? capacity : null,
          policy: facts ? scene.claims[facts.policy]!.value : "max-min",
          unit: option?.unit ?? scene.resources[u.resource]!.unit, reserved: 0, coefficients: new Map(), fixed: new Map() };
        pools.set(u.resource, pool);
      }
      // 같은 링크에서 서로 다른 실효 한도를 협상하면 동시 모드 근거가 있어야 용량을 정할 수 있다.
      if (option && (option.unit !== pool.unit || pool.capacity !== option.limit)) pool.capacity = null;
      if (u.coefficient) pool.coefficients.set(i, (pool.coefficients.get(i) ?? 0) + u.coefficient);
      if (u.fixed) pool.fixed.set(i, (pool.fixed.get(i) ?? 0) + u.fixed);
    }
  });
  for (const [row, p] of pools) {
    const users = new Set([...p.fixed.keys(), ...p.coefficients.keys()]);
    if (p.capacity !== null) for (const i of users) {
      const fixed = p.fixed.get(i) ?? 0;
      if ((p.capacity === 0 && p.coefficients.has(i)) || (fixed > p.capacity && !tied(fixed, p.capacity))) {
        shares[i]!.verdict = "impossible";
        shares[i]!.bindings.push(row);
        active.delete(i);
        uncertain.delete(i);
      }
    }
  }
  for (const [row, p] of pools) {
    for (const i of p.fixed.keys()) if (!active.has(i)) p.fixed.delete(i);
    for (const i of p.coefficients.keys()) if (!active.has(i)) p.coefficients.delete(i);
    const users = new Set([...p.fixed.keys(), ...p.coefficients.keys()]);
    if (result.linkResources[row - scene.resources.length]?.pool && p.coefficients.size > 1) {
      const units = new Set([...p.coefficients.keys()].map(i => rates[i]!.base));
      if (units.size > 1) {
        for (const i of p.coefficients.keys()) {
          uncertain.add(i);
          const workload = flows[i]!.workload, field = "pool.elasticUnit";
          if (!result.errors.some(e => e.stage === "demand" && e.row === workload && e.field === field))
            result.errors.push({ domain: scene.workloads[workload]!.domain, stage: "demand", row: workload, spec: "", field });
        }
      }
    }
    p.reserved = [...p.fixed.values()].reduce((sum, x) => sum + x, 0);
    if (p.capacity !== null && p.reserved > p.capacity && !tied(p.reserved, p.capacity)) {
      for (const i of p.fixed.keys()) overbooked.add(i);
    } else if (p.capacity === null || users.size > 1 && p.policy !== "max-min" && !fair.has(row)) {
      for (const i of users) if (active.has(i)) uncertain.add(i);
    }
  }
  const candidates = flows.filter((_, i) => active.has(i));
  for (const i of uncertain) {
    if (shares[i]!.verdict === "impossible") continue;
    for (const f of allocationGroup(candidates, flows[i]!)) {
      const j = flows.indexOf(f);
      shares[j]!.value = null;
      shares[j]!.verdict = "unknown";
      active.delete(j);
    }
  }
  while (active.size) {
    const demandEvents = [...active].map(i => ({ i, delta: Math.max(0, flows[i]!.cap! - shares[i]!.value!) / rates[i]!.weight }));
    const capacityEvents: { row: number; delta: number; users: number[] }[] = [];
    for (const [row, p] of pools) {
      let remaining = (p.capacity ?? 0) - p.reserved, slope = 0;
      const users: number[] = [];
      for (const [i, coefficient] of p.coefficients) {
        remaining -= coefficient * (shares[i]!.value ?? 0);
        if (active.has(i)) { slope += coefficient * rates[i]!.weight; users.push(i); }
      }
      if (slope > 0) capacityEvents.push({ row, delta: Math.max(0, remaining / slope), users });
    }
    const delta = Math.min(...demandEvents.map(e => e.delta), ...capacityEvents.map(e => e.delta));
    for (const i of active) shares[i]!.value = Math.min(flows[i]!.cap!, shares[i]!.value! + delta * rates[i]!.weight);
    for (const event of capacityEvents) if (tied(event.delta, delta)) for (const i of event.users) {
      shares[i]!.bindings.push(event.row);
      active.delete(i);
    }
    for (const event of demandEvents) if (tied(event.delta, delta)) {
      shares[event.i]!.value = flows[event.i]!.cap;
      active.delete(event.i);
    }
  }
  return { shares, overbooked, pools };
}

function allocateKnown(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number>): Share[] {
  const rejected = new Map<number, Share>();
  while (true) {
    const participants = flows.filter(f => !rejected.has(f.workload));
    const { shares, overbooked, pools } = fill(scene, result, participants, fair);
    const failed: number[] = [];
    participants.forEach((f, i) => {
      const share = shares[i]!;
      if (f.verdict === "impossible" || share.value === null || f.cap === null || f.cap === 0 || share.value >= f.cap) return;
      share.verdict = share.value === 0 || !f.elastic ? "impossible" : "conditional";
      if (share.verdict !== "impossible") return;
      const occupied = f.uses.some(u => u.fixed > 0) || share.value > 0;
      share.value = 0;
      if (occupied) failed.push(i);
    });
    // 다른 실패 작업의 예약이 풀려도 막혀 있을 병목이 하나라도 있으면 먼저 회수한다.
    const unconfirmed = new Set([...failed, ...overbooked]);
    const release = failed.filter(i => shares[i]!.bindings.some(resource =>
      !participants.some((peer, j) => i !== j && unconfirmed.has(j) && peer.uses.some(u => u.resource === resource && u.fixed > 0))));
    if (release.length) {
      for (const i of release) rejected.set(participants[i]!.workload, shares[i]!);
      continue;
    }
    const admitted = new Set<number>();
    if (overbooked.size && participants.some(f => f.priority !== undefined)) {
      const remaining = new Map([...pools].map(([r,p]) => [r,p.capacity]));
      const tiers = [...new Set(participants.map(f => f.priority ?? Infinity))].sort((a,b) => a-b);
      for (const tier of tiers) {
        const members = participants.flatMap((f,i) => (f.priority ?? Infinity) === tier ? [i] : []);
        for (const i of members) {
          const blocked = [...pools].flatMap(([r,p]) => {
            const left = remaining.get(r), fixed = p.fixed.get(i) ?? 0;
            return left != null && fixed > left && !tied(fixed,left) ? [r] : [];
          });
          if (blocked.length) rejected.set(participants[i]!.workload, { ...shares[i]!, value: 0, verdict: "impossible", bindings: blocked });
        }
        if (members.some(i => rejected.has(participants[i]!.workload))) break;
        const fitting = new Set<number>();
        for (const [r,p] of pools) {
          const left = remaining.get(r);
          if (left == null) continue;
          const sum = members.reduce((n,i) => n + (p.fixed.get(i) ?? 0), 0);
          if (sum < left || tied(sum,left)) fitting.add(r);
          remaining.set(r, fitting.has(r) ? Math.max(0,left-sum) : null);
        }
        for (const i of members) {
          const f = participants[i]!;
          if (shares[i]!.value === null || shares[i]!.verdict === "unknown" || f.uses.some(u => !fitting.has(u.resource))) {
            // 이 작업의 다른 예약이 풀릴 수 있으므로 그 몫으로 후순위를 확정 탈락시킬 수 없다.
            for (const u of f.uses) if (u.fixed) remaining.set(u.resource,null);
          } else if (!f.elastic && f.cap === shares[i]!.value && f.uses.every(u => !u.coefficient)) admitted.add(i);
        }
      }
      if (participants.some(f => rejected.has(f.workload))) continue;
    }
    // 회수할 예약이 더 없을 때 남은 예약 초과와 순환만 미확인으로 전파한다.
    for (const i of unconfirmed) for (const f of allocationGroup(participants, participants[i]!)) {
      const index = participants.indexOf(f);
      if (admitted.has(index)) continue;
      const share = shares[index]!;
      if (overbooked.has(index)) share.contested = true;
      share.verdict = "unknown";
      share.value = null;
    }
    const byWork = new Map(shares.map(s => [s.workload, s]));
    return flows.map(f => rejected.get(f.workload) ?? byWork.get(f.workload)!);
  }
}

// 다른 작업이 먼저 멈추지 않아도 자기 자원들 중 첫 포화 시점까지는 모두 같은 처리량으로 자란다.
function guaranteedFloor(scene: Scene, lower: Results, flow: Flow, group: Flow[], fair: ReadonlySet<number>) {
  if (group.some(f => (f.bestCase ?? f.verdict) === "unknown" || f.cap === null)) return 0;
  const rates = rateUnits(lower,group), weight = rates[group.findIndex(f => f.workload === flow.workload)]!.weight;
  let rate = flow.cap ?? 0;
  for (const row of new Set(flow.uses.map(u => u.resource))) {
    const uses = group.flatMap(f => f.uses.filter(u => u.resource === row));
    const option = uses[0]!.option;
    let capacity: number;
    if (option !== undefined) {
      const link = linkLimit(lower, uses[0]!);
      if (link.limit === null || uses.some(u => linkLimit(lower, u).limit !== link.limit || linkLimit(lower, u).unit !== link.unit)) return 0;
      capacity = link.limit;
    } else {
      const facts = resourceFacts(scene, row), available = resourceCapacity(scene, lower, row);
      if (typeof available !== "number" || scene.claims[facts.policy]!.value !== "max-min" && !fair.has(row)) return 0;
      capacity = available;
    }
    const remaining = capacity - uses.reduce((n,u) => n + u.fixed, 0);
    if (remaining < 0) return 0;
    if (flow.uses.some(u => u.resource === row && u.coefficient > 0)) {
      const slope = group.reduce((sum,f,i) => sum + f.uses.filter(u => u.resource === row)
        .reduce((n,u) => n + u.coefficient * rates[i]!.weight,0),0);
      rate = Math.min(rate,remaining * weight / slope);
    }
  }
  return flow.elastic || rate === flow.cap ? rate : 0;
}

// 링크 용량이 구간이면 같은 작업·예약을 양 경계에 배분한다. 다른 링크를 쓰는 경쟁자가 있으면 상한은 독점 시의 값이다.
export function allocate(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number> = new Set()): Share[] {
  // 경계가 없는 공용 예산도 활성 작업이 전부 요청한 양 이상에서는 배분이 달라지지 않는다.
  const requested = new Map<number, number>();
  for (const f of flows) for (const u of f.uses) {
    if (u.pool === undefined) continue;
    const pool = result.linkResources[u.pool]!.pool!;
    if (pool.limit !== null || pool.bounds) continue;
    const use = f.cap === null ? Infinity : u.fixed + u.coefficient * f.cap;
    requested.set(u.pool, (requested.get(u.pool) ?? 0) + use);
  }
  if (requested.size) result = { ...result, linkResources: result.linkResources.map((r,i) => {
    const high = requested.get(i);
    return high !== undefined && Number.isFinite(high) ? { ...r, pool: { ...r.pool!, bounds: { low: 0, high } } } : r;
  }) };
  const reserved = new Map<number,number>();
  for (const load of result.standingLoads) if (load.kind === "scene" && load.amount === null) {
    const capacity = scene.claims[resourceFacts(scene,load.resource).capacity]!.value;
    if (typeof capacity === "number") reserved.set(load.resource,capacity);
  }
  if (!flows.some(f => f.uses.some(u => reserved.has(u.resource) || u.option !== undefined && linkLimit(result, u).bounds)))
    return allocateKnown(scene, result, flows, fair);
  const at = (side: "low" | "high"): Results => ({ ...result,
    standingLoads: result.standingLoads.map(l => l.kind === "scene" && l.amount === null && reserved.has(l.resource)
      ? { ...l, amount: side === "low" ? l.bounds?.high ?? reserved.get(l.resource)! : l.bounds?.low ?? 0 } : l),
    options: result.options.map(o => o.bounds ? { ...o, limit: o.bounds[side] } : o),
    linkResources: result.linkResources.map(r => r.pool?.bounds ? { ...r, pool: { ...r.pool, limit: r.pool.bounds[side] } } : r) });
  const lower = at("low"), upper = at("high");
  const optimistic = flows.map(f => ({ ...f, verdict: f.verdict === "unknown" ? f.bestCase ?? f.verdict : f.verdict }));
  const lowShares = allocateKnown(scene, lower, optimistic, fair);
  const highShares = allocateKnown(scene, upper, optimistic, fair);
  return flows.map((flow, i) => {
    const group = allocationGroup(flows, flow);
    const varying = new Set(group.flatMap(f => f.uses.filter(u => reserved.has(u.resource) || u.option !== undefined &&
      linkLimit(result, u).bounds && linkLimit(lower, u).limit !== linkLimit(upper, u).limit).map(u => u.resource)));
    const canBind = [...varying].filter(row => {
      let used = 0, guaranteed = Infinity;
      for (const f of group) for (const u of f.uses.filter(u => u.resource === row)) {
        used += u.fixed + (u.coefficient ? u.coefficient * (f.cap ?? Infinity) : 0);
        const capacity = u.option === undefined ? resourceCapacity(scene,lower,u.resource) : linkLimit(lower,u).limit;
        guaranteed = Math.min(guaranteed,capacity ?? 0);
      }
      return used > guaranteed;
    });
    const lo = lowShares[i]!, hi = highShares[i]!;
    if (!canBind.length || flow.verdict === "impossible") return lo;
    const shared = canBind.length === 1 && group.every(f => f.elastic && f.uses.every(u => !u.fixed) && f.uses.some(u => u.resource === canBind[0]));
    const monotone = group.length === 1 || shared;
    const low = monotone ? lo.value ?? 0 : guaranteedFloor(scene, lower, flow, group, fair);
    const high = (monotone ? hi.value : null) ?? throughputUpper(scene, upper, optimistic[i]!);
    const possible: Verdict[] = [];
    if (low === 0) possible.push("impossible");
    const conditional = (flow.path !== null && result.paths[flow.path]!.conditioned) || flow.bestCase === "conditional" || flow.verdict === "conditional";
    if (high === null || high > 0) {
      if (conditional || flow.elastic && (flow.cap === null || low < flow.cap)) possible.push("conditional");
      if (!conditional && (flow.cap === null || high === null || high >= flow.cap)) possible.push("ok");
    }
    const verdict = possible.length === 1 ? possible[0]! : "unknown";
    const bindings = monotone ? lo.bindings.filter(b => hi.bindings.includes(b)) : [];
    const loadInputs = result.standingLoads.filter(l => l.amount === null &&
      canBind.includes(l.resource + (l.kind === "link" ? scene.resources.length : 0))).flatMap(l => l.inputs);
    const inputs = [...new Set([...loadInputs,...group.flatMap(f => f.uses.filter(u => canBind.includes(u.resource)).flatMap(u => u.inputs))])];
    return { workload: flow.workload, verdict, value: low === high ? low : null, bindings, range: { low, high, possible, inputs } };
  });
}
