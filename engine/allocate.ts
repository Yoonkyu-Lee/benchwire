// 고정 예약과 반복 소비를 한 예산에 모으고 실제 처리량을 낼 수 있는 작업끼리 max-min으로 배분한다.
import type { Consumption, PolicyLimit, Scene, Verdict } from "./contract.ts";
import type { Results } from "./results.ts";
import { resourceFacts } from "./scene.ts";

// 0.3 / 3과 0.1처럼 같은 포화 시점이 연산 반올림으로 갈라지는 것을 막는다.
const RELATIVE_TOLERANCE = 16 * Number.EPSILON;
function tied(a: number, b: number) {
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

// 배분 안에서만 장면 자원 뒤에 링크 자원의 번호를 이어 붙인다.
export interface Use extends Consumption { option?: number }
export interface Flow { workload: number; path: number | null; cap: number | null; elastic: boolean; verdict: Verdict; uses: Use[] }
export interface Share { workload: number; value: number | null; verdict: Verdict; bindings: number[]; unresolvedPolicies?: number[]; policies?: (PolicyLimit & {resource: number})[] }

// 경쟁자가 자원을 전부 양보했을 때도 넘을 수 없는 작업률이다.
export function throughputUpper(scene: Scene, result: Results, flow: Flow, policies: NonNullable<Share["policies"]> = []) {
  let upper = flow.cap;
  for (const row of new Set(flow.uses.map(u => u.resource))) {
    const uses = flow.uses.filter(u => u.resource === row), first = uses[0]!;
    const capacity = first.option === undefined ? scene.claims[resourceFacts(scene, row).capacity]!.value : result.options[first.option]!.limit;
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

function fill(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number>) {
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
      const option = u.option === undefined ? null : result.options[u.option]!;
      if (!pool) {
        const facts = option ? null : resourceFacts(scene, u.resource);
        const capacity = facts ? scene.claims[facts.capacity]!.value : option!.limit;
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
    const demandEvents = [...active].map(i => ({ i, delta: Math.max(0, flows[i]!.cap! - shares[i]!.value!) }));
    const capacityEvents: { row: number; delta: number; users: number[] }[] = [];
    for (const [row, p] of pools) {
      let remaining = (p.capacity ?? 0) - p.reserved, slope = 0;
      const users: number[] = [];
      for (const [i, coefficient] of p.coefficients) {
        remaining -= coefficient * (shares[i]!.value ?? 0);
        if (active.has(i)) { slope += coefficient; users.push(i); }
      }
      if (slope > 0) capacityEvents.push({ row, delta: Math.max(0, remaining / slope), users });
    }
    const delta = Math.min(...demandEvents.map(e => e.delta), ...capacityEvents.map(e => e.delta));
    for (const i of active) shares[i]!.value = Math.min(flows[i]!.cap!, shares[i]!.value! + delta);
    for (const event of capacityEvents) if (tied(event.delta, delta)) for (const i of event.users) {
      shares[i]!.bindings.push(event.row);
      active.delete(i);
    }
    for (const event of demandEvents) if (tied(event.delta, delta)) {
      shares[event.i]!.value = flows[event.i]!.cap;
      active.delete(event.i);
    }
  }
  return { shares, overbooked };
}

export function allocate(scene: Scene, result: Results, flows: readonly Flow[], fair: ReadonlySet<number> = new Set()): Share[] {
  const rejected = new Map<number, Share>();
  while (true) {
    const participants = flows.filter(f => !rejected.has(f.workload));
    const { shares, overbooked } = fill(scene, result, participants, fair);
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
    // 회수할 예약이 더 없을 때 남은 예약 초과와 순환만 미확인으로 전파한다.
    for (const i of unconfirmed) for (const f of allocationGroup(participants, participants[i]!)) {
      const share = shares[participants.indexOf(f)]!;
      share.verdict = "unknown";
      share.value = null;
    }
    const byWork = new Map(shares.map(s => [s.workload, s]));
    return flows.map(f => rejected.get(f.workload) ?? byWork.get(f.workload)!);
  }
}
