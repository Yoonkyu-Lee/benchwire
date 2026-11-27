// 고정 예약과 반복 소비를 한 예산에 모으고 실제 처리량을 낼 수 있는 작업끼리 max-min으로 배분한다.
import { compareQuantity, type Carrier, type Consumption, type PolicyLimit, type Scene, type Verdict } from "./contract.ts";
import type { Results } from "./results.ts";
import { resourceCapacity } from "./standing.ts";
import { readClaim, resourceFacts } from "./scene.ts";

// 배분 안에서만 장면 자원 뒤에 링크 자원의 번호를 이어 붙인다.
export interface Use extends Consumption { option?: number; pool?: number; conversion?: Carrier["conversion"]; unknown?: boolean }
function linkLimit(result: Results, u: Use) {
  return u.pool === undefined ? result.options[u.option!]! : result.linkResources[u.pool]!.pool!;
}
export interface Flow { workload: number; path: number | null; cap: number | null; elastic: boolean; verdict: Verdict; bestCase?: Verdict; uses: Use[]; priority?: number }
export interface Share { workload: number; value: number | null; verdict: Verdict; range?: { low: number; high: number | null; possible: Verdict[]; inputs?: number[] }; bindings: number[]; contested?: boolean; policyReads?: number[]; unresolvedPolicies?: number[]; policies?: (PolicyLimit & {resource: number})[] }

// 경로가 실제로 소비하는 예산과 같은 예산에 잡힌 상시 예약의 근거다.
export function allocationInputs(scene: Scene, result: Results, flows: readonly Flow[], share: Share, purpose: "score" | "evidence") {
  const claims = new Set(purpose==="evidence" ? share.policies?.flatMap(p => p.inputs) : []);
  for (const id of share.policyReads ?? []) claims.add(id);
  const resources = new Set<number>();
  for (const flow of flows) for (const u of flow.uses) {
    resources.add(u.resource);
    if (purpose==="evidence") for (const id of u.inputs) claims.add(id);
    if (u.option === undefined) {
      const facts = resourceFacts(scene,u.resource);
      claims.add(facts.capacity);
      claims.add(facts.policy);
    }
  }
  for (const load of result.standingLoads) if (purpose==="evidence" && resources.has(load.resource + (load.kind === "link" ? scene.resources.length : 0)))
    for (const id of load.inputs) claims.add(id);
  for (const r of result.hookReads ?? []) if (r.hook==="consume" && flows.some(f=>f.path===r.row))
    for (const id of r.claims) claims.add(id);
  return claims;
}

// 경쟁자가 자원을 전부 양보했을 때도 넘을 수 없는 작업률이다.
export function throughputUpper(scene: Scene, result: Results, flow: Flow, policies: NonNullable<Share["policies"]> = []) {
  let upper = flow.cap;
  for (const row of new Set(flow.uses.map(u => u.resource))) {
    const uses = flow.uses.filter(u => u.resource === row), first = uses[0]!;
    const capacity = first.option === undefined ? resourceCapacity(scene, result, row) : linkLimit(result, first).limit ?? linkLimit(result, first).bounds?.high;
    const limit = policies.find(p => p.workload === flow.workload && p.resource === row)?.limit;
    if (typeof capacity !== "number" && limit == null) continue;
    const budget = Math.min(typeof capacity === "number" ? capacity : Infinity, limit ?? Infinity);
    const fixed = uses.reduce((n, u) => n + u.fixed, 0), slope = uses.reduce((n, u) => n + u.coefficient, 0);
    if (budget === 0 && fixed > 0 || compareQuantity(fixed,budget) > 0) upper = 0;
    else if (slope > 0) upper = Math.min(upper ?? Infinity, Math.max(0,budget - fixed) / slope);
  }
  return upper;
}

export function deliveryRange(scene: Scene, result: Results, flow: Flow, share: Share) {
  return share.range ?? { low: share.value ?? 0, high: share.value ?? throughputUpper(scene,result,flow,share.policies) };
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

// 같은 예산에서만 작업률을 비교한다. 공용 예산의 오버헤드와 구간을 여러 번 지나는 비용은 소비 계수에 남긴다.
function sharingWeights(result: Results, flows: readonly Flow[], resource: number, resourceUnit: string, users: number[]) {
  const services = users.map(i => {
    const flow = flows[i]!;
    const request = flow.path === null ? "" : result.demands[result.paths[flow.path]!.demand]!.unit;
    const uses = flow.uses.filter(u => u.resource === resource && u.coefficient > 0);
    const unit = uses[0]?.conversion?.unit ?? request;
    if (!uses.every(u => (u.conversion?.unit ?? request) === unit)) return { request, unit: request, rate: 1 };
    const rate = uses.reduce((sum, u) => sum + (u.conversion?.perUnit ?? 1) / uses.length, 0);
    return { request, unit, rate };
  });
  const first = services[0];
  if (!first) return new Map<number, number>();
  // 직결 작업의 요청 단위가 이웃 작업의 운반 단위일 수도 있다.
  const common = [...new Set([first.unit, first.request])].filter(unit => services.every(s => s.unit === unit || s.request === unit));
  const unit = services.every(s => s.unit === first.unit) ? first.unit
    : common.includes(resourceUnit) ? resourceUnit : common.length === 1 ? common[0] : undefined;
  if (unit === undefined) return null;
  return new Map(users.map((i, j) => [i, services[j]!.unit === unit ? 1 / services[j]!.rate : 1]));
}

function fill(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number>) {
  const shares = flows.map((f): Share => ({ workload: f.workload, value: 0, verdict: f.verdict, bindings: [] }));
  const active = new Set<number>(), uncertain = new Set<number>(), overbooked = new Set<number>();
  const pools = new Map<number, { capacity: number | null; policy: unknown; unit: string; reserved: number;
    coefficients: Map<number, number>; weights: Map<number, number>; fixed: Map<number, number> }>();
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
          policy: facts ? readClaim(scene,facts.policy).value : "max-min",
          unit: option?.unit ?? scene.resources[u.resource]!.unit, reserved: 0, coefficients: new Map(), weights: new Map(), fixed: new Map() };
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
      if (p.capacity === 0 || compareQuantity(fixed,p.capacity) > 0) {
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
    const weighted = [...p.coefficients.keys()];
    const weights = sharingWeights(result, flows, row, p.unit, weighted);
    if (weights) p.weights = weights;
    else for (const i of weighted) {
      uncertain.add(i);
      const workload = flows[i]!.workload, field = "pool.elasticUnit";
      if (!result.errors.some(e => e.entryPoint === null && e.targetKind === "workload" && e.row === workload && e.field === field))
        result.errors.push({ domain: scene.workloads[workload]!.domain, entryPoint: null, targetKind: "workload", row: workload, spec: "", field });
    }
    p.reserved = [...p.fixed.values()].reduce((sum, x) => sum + x, 0);
    if (p.capacity !== null && compareQuantity(p.reserved,p.capacity) > 0) {
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
    // 각 예산이 자기 구간 단위로 제안하는 공정 몫 중 작업이 실제로 받을 수 있는 가장 작은 양이다.
    const offers = new Map([...active].map(i => [i, flows[i]!.cap!]));
    const budgets = [];
    for (const [row, p] of pools) {
      let remaining = (p.capacity ?? 0) - p.reserved, slope = 0;
      const users = [];
      for (const [i, coefficient] of p.coefficients) {
        if (active.has(i)) {
          slope += coefficient * p.weights.get(i)!;
          users.push(i);
        } else remaining -= coefficient * (shares[i]!.value ?? 0);
      }
      if (!users.length) continue;
      remaining = Math.max(0, remaining);
      for (const i of users) {
        const weight = p.weights.get(i)!;
        const cost = slope / weight;
        const share = Number.isFinite(cost) && cost > 0 ? remaining / cost : remaining / slope * weight;
        offers.set(i, Math.min(offers.get(i)!, share));
      }
      budgets.push({ row, remaining, users, coefficients: p.coefficients });
    }
    // 구간별 환산이 서로 달라도 실제 수요나 예산이 처음 포화되는 지점까지만 함께 늘린다.
    const demandEvents = [...offers].map(([i, offer]) => ({ i, scale: flows[i]!.cap! / offer }));
    const capacityEvents = budgets.map(({row, remaining, users, coefficients}) => {
      if (remaining === 0) return { row, users, scale: 1 };
      const fraction = users.reduce((sum, i) => {
        const offer = offers.get(i)!, coefficient = coefficients.get(i)!;
        const relative = offer / remaining;
        return sum + (Number.isFinite(relative) ? relative * coefficient : offer * coefficient / remaining);
      }, 0);
      return { row, users, scale: 1 / fraction };
    });
    const scale = Math.min(...demandEvents.map(e => e.scale), ...capacityEvents.map(e => e.scale));
    // 양수인 공정 몫이 표현 범위 밖이면 포화 시점을 확정할 수 없다.
    if (!Number.isFinite(scale)) {
      for (const i of active) { shares[i]!.value = null; shares[i]!.verdict = "unknown"; }
      break;
    }
    for (const e of capacityEvents) if (compareQuantity(e.scale,scale) === 0) for (const i of e.users) {
      shares[i]!.value = Math.min(flows[i]!.cap!, offers.get(i)! * scale);
      shares[i]!.bindings.push(e.row);
      active.delete(i);
    }
    for (const e of demandEvents) if (compareQuantity(e.scale,scale) === 0) {
      shares[e.i]!.value = flows[e.i]!.cap;
      active.delete(e.i);
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
      if (f.verdict === "impossible" || share.value === null || f.cap === null || f.cap === 0 || compareQuantity(share.value,f.cap) >= 0) return;
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
            return left != null && compareQuantity(fixed,left) > 0 ? [r] : [];
          });
          if (blocked.length) rejected.set(participants[i]!.workload, { ...shares[i]!, value: 0, verdict: "impossible", bindings: blocked });
        }
        if (members.some(i => rejected.has(participants[i]!.workload))) break;
        const fitting = new Set<number>();
        for (const [r,p] of pools) {
          const left = remaining.get(r);
          if (left == null) continue;
          const sum = members.reduce((n,i) => n + (p.fixed.get(i) ?? 0), 0);
          if (compareQuantity(sum,left) <= 0) fitting.add(r);
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
  const index = group.indexOf(flow);
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
      if (typeof available !== "number" || readClaim(scene,facts.policy).value !== "max-min" && !fair.has(row)) return 0;
      capacity = available;
    }
    const remaining = capacity - uses.reduce((n,u) => n + (u.fixedHigh ?? u.fixed), 0);
    if (remaining < 0) return 0;
    if (flow.uses.some(u => u.resource === row && u.coefficient > 0)) {
      const slopes = group.map(f => f.uses.filter(u => u.resource === row).reduce((sum,u) => sum + u.coefficient,0));
      const unit = option === undefined ? scene.resources[row]!.unit : linkLimit(lower, uses[0]!).unit;
      const weights = sharingWeights(lower, group, row, unit, slopes.flatMap((s,i) => s > 0 ? [i] : []));
      if (!weights) return 0;
      const slope = [...weights].reduce((sum,[i,w]) => sum + slopes[i]! * w,0);
      rate = Math.min(rate,remaining / slope * weights.get(index)!);
    }
  }
  return flow.elastic || flow.cap !== null && compareQuantity(rate,flow.cap) === 0 ? rate : 0;
}

// 링크 용량이 구간이면 같은 작업·예약을 양 경계에 배분한다. 다른 링크를 쓰는 경쟁자가 있으면 상한은 독점 시의 값이다.
export function allocate(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number> = new Set(),
  policies: NonNullable<Share["policies"]> = []): Share[] {
  // 경계가 없는 공용 예산도 활성 작업이 전부 요청한 양 이상에서는 배분이 달라지지 않는다.
  const requested = new Map<number, number>();
  for (const f of flows) for (const u of f.uses) {
    if (u.pool === undefined) continue;
    const pool = result.linkResources[u.pool]!.pool!;
    if (pool.limit !== null || pool.bounds) continue;
    const use = f.cap === null ? Infinity : (u.fixedHigh ?? u.fixed) + u.coefficient * f.cap;
    requested.set(u.pool, (requested.get(u.pool) ?? 0) + use);
  }
  if (requested.size) result = { ...result, linkResources: result.linkResources.map((r,i) => {
    const high = requested.get(i);
    return high !== undefined && Number.isFinite(high) ? { ...r, pool: { ...r.pool!, bounds: { low: 0, high } } } : r;
  }) };
  const reserved = new Map<number,number>();
  for (const load of result.standingLoads) if (load.kind === "scene" && load.amount === null) {
    const capacity = readClaim(scene,resourceFacts(scene,load.resource).capacity,"range").value;
    if (typeof capacity === "number") reserved.set(load.resource,capacity);
  }
  if (!flows.some(f => f.uses.some(u => u.fixedHigh!==undefined || reserved.has(u.resource) || u.option !== undefined && linkLimit(result, u).bounds)))
    return allocateKnown(scene, result, flows, fair);
  const at = (side: "low" | "high"): Results => ({ ...result,
    standingLoads: result.standingLoads.map(l => l.kind === "scene" && l.amount === null && reserved.has(l.resource)
      ? { ...l, amount: side === "low" ? l.bounds?.high ?? reserved.get(l.resource)! : l.bounds?.low ?? 0 } : l),
    options: result.options.map(o => o.bounds ? { ...o, limit: o.bounds[side] } : o),
    linkResources: result.linkResources.map(r => r.pool?.bounds ? { ...r, pool: { ...r.pool, limit: r.pool.bounds[side] } } : r) });
  const lower = at("low"), upper = at("high");
  const optimistic = flows.map(f => ({ ...f, verdict: f.verdict === "unknown" ? f.bestCase ?? f.verdict : f.verdict }));
  const pessimistic = flows.map((f,i) => {
    const path = f.path === null ? undefined : result.paths[f.path];
    const verdict=f.verdict === "unknown" && optimistic[i]!.verdict !== "unknown" && path?.worstCase
      ? path.worstCase : optimistic[i]!.verdict;
    const worst={...f,verdict,uses:f.uses.map(u=>u.fixedHigh===undefined ? u : {...u,fixed:u.fixedHigh})};
    if (policies.length && f.uses.some(u=>u.fixedHigh!==undefined)) {
      const cap=throughputUpper(scene,lower,worst,policies);
      if (cap!==null && (f.cap===null || compareQuantity(cap,f.cap)<0)) {
        worst.cap=cap;
        if (!f.elastic || cap===0) worst.verdict="impossible";
        else if (worst.verdict==="ok") worst.verdict="conditional";
      }
    }
    return worst;
  });
  const lowShares = allocateKnown(scene, lower, pessimistic, fair);
  const highShares = allocateKnown(scene, upper, optimistic, fair);
  return flows.map((flow, i) => {
    const group = allocationGroup(flows, flow);
    const varying = new Set(group.flatMap(f => f.uses.filter(u => u.fixedHigh!==undefined || reserved.has(u.resource) || u.option !== undefined &&
      linkLimit(result, u).bounds && linkLimit(lower, u).limit !== linkLimit(upper, u).limit).map(u => u.resource)));
    const canBind = [...varying].filter(row => {
      let used = 0, guaranteed = Infinity;
      for (const f of group) for (const u of f.uses.filter(u => u.resource === row)) {
        used += (u.fixedHigh ?? u.fixed) + (u.coefficient ? u.coefficient * (f.cap ?? Infinity) : 0);
        const capacity = u.option === undefined ? resourceCapacity(scene,lower,u.resource) : linkLimit(lower,u).limit;
        const limit=u.fixedHigh===undefined ? null : policies.find(p=>p.resource===row && p.workload===f.workload)?.limit;
        guaranteed = Math.min(guaranteed,capacity ?? 0,limit ?? Infinity);
      }
      return compareQuantity(used,guaranteed) > 0;
    });
    const lo = lowShares[i]!, hi = highShares[i]!;
    if (flow.verdict === "impossible" || !canBind.length && lo.verdict === hi.verdict) return lo;
    const shared = canBind.length === 1 && group.every(f => f.elastic && f.uses.every(u => !(u.fixedHigh ?? u.fixed)) && f.uses.some(u => u.resource === canBind[0]));
    const monotone = group.length === 1 || shared;
    const low = monotone ? lo.value ?? 0 : Math.min(pessimistic[i]!.cap ?? Infinity,guaranteedFloor(scene, lower, flow, group, fair));
    const high = (monotone ? hi.value : null) ?? throughputUpper(scene, upper, optimistic[i]!);
    const possible = new Set([lo.verdict,hi.verdict].filter(v => v !== "unknown"));
    if (low === 0 && flow.cap !== 0) possible.add("impossible");
    const conditional = (flow.path !== null && result.paths[flow.path]!.conditioned) || flow.bestCase === "conditional" || flow.verdict === "conditional";
    if (high === null || high > 0) {
      if (conditional || flow.elastic && (flow.cap === null || compareQuantity(low,flow.cap) < 0)) possible.add("conditional");
      if (!conditional && (flow.cap === null || high === null || compareQuantity(high,flow.cap) >= 0)) possible.add("ok");
    }
    const verdict = possible.size === 1 ? [...possible][0]! : "unknown";
    const bindings = monotone ? lo.bindings.filter(b => hi.bindings.includes(b)) : [];
    const loadInputs = result.standingLoads.filter(l => l.amount === null &&
      canBind.includes(l.resource + (l.kind === "link" ? scene.resources.length : 0))).flatMap(l => l.inputs);
    const inputs = [...new Set([...loadInputs,...group.flatMap(f => f.uses.filter(u => canBind.includes(u.resource)).flatMap(u => u.inputs))])];
    return { workload: flow.workload, verdict, value: low === high ? low : null, bindings, range: { low, high, possible:[...possible], inputs } };
  });
}
