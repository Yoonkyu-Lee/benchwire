// 접속 배선과 활성 작업에 맞는 영역 정책 한도를 적용한 뒤 공유 자원을 배분한다.
import type { DomainPlugin, PolicyLimit, Scene } from "./contract.ts";
import { allocate, allocationGroup, throughputUpper, type Flow } from "./allocate.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";
import { resourceFacts } from "./scene.ts";

export function policyAllocation(scene: Scene, plugins: readonly DomainPlugin[], result: Results, flows: readonly Flow[], assumed: readonly number[] = []) {
  const fair = new Set(assumed);
  const policies: (PolicyLimit & {resource: number})[] = [];
  const connectedPorts = [...new Set([...scene.connections.flatMap(c => [c.from, c.to]), ...scene.parts.flatMap(p => [p.entry, p.exit])])];
  const activeWorkloads = flows.map(f => f.workload);
  const used = new Set(flows.flatMap(f => f.uses.filter(u => u.option === undefined).map(u => u.resource)));
  const named = new Set<number>();
  for (const resource of used) {
    const policy = scene.claims[resourceFacts(scene, resource).policy]!.value;
    if (policy === null || policy === "max-min") continue;
    named.add(resource);
    const domain = scene.resources[resource]!.domain;
    const limits = plugins.find(p => p.id === domain)?.policy?.({ scene, resource, activeWorkloads, connectedPorts });
    if (!limits) continue;
    for (const p of limits) {
      const path = flows.find(f => f.workload === p.workload)?.path;
      if (path == null) continue;
      const trace = checkedTrace(result, domain, "consume", path, p, resource);
      if (checkedQuantity(result, domain, "consume", path, "limit", p.limit, resource) !== null) policies.push({ ...trace, resource });
    }
  }
  if (!named.size && !fair.size) return allocate(scene, result, flows);

  const restricted = flows.map(f => {
    let cap = f.cap, verdict = f.verdict;
    const bounds: { resource: number; cap: number }[] = [];
    for (const resource of used) {
      const uses = f.uses.filter(u => u.option === undefined && u.resource === resource);
      if (!uses.length || verdict === "impossible") continue;
      const limit = policies.find(p => p.resource === resource && p.workload === f.workload);
      if (!limit) {
        if (named.has(resource)) verdict = "unknown";
        continue;
      }
      const fixed = uses.reduce((n, u) => n + u.fixed, 0), coefficient = uses.reduce((n, u) => n + u.coefficient, 0);
      if (fixed > limit.limit) { verdict = "impossible"; bounds.push({ resource, cap: 0 }); continue; }
      if (coefficient > 0 && cap !== null) {
        const bound = (limit.limit - fixed) / coefficient;
        bounds.push({ resource, cap: bound });
        cap = Math.min(cap, bound);
        if (bound === 0 && f.cap !== 0) verdict = "impossible";
      }
    }
    if (cap !== null && f.cap !== null && cap < f.cap && verdict !== "unknown")
      verdict = cap === 0 || !f.elastic || verdict === "impossible" ? "impossible" : "conditional";
    return { ...f, cap, verdict, bounds };
  });
  const unresolved: number[] = [];
  for (const resource of named) {
    const capacity = scene.claims[resourceFacts(scene, resource).capacity]!.value;
    if (typeof capacity !== "number") continue;
    let required = 0;
    for (const flow of restricted) {
      const uses = flow.uses.filter(u => u.resource === resource);
      if (!uses.length || flow.verdict === "impossible" || flow.cap === 0) continue;
      const upper = throughputUpper(scene, result, flow, policies);
      for (const u of uses) required += u.fixed + (u.coefficient ? (upper ?? Infinity) * u.coefficient : 0);
    }
    if (required <= capacity) fair.add(resource);
    else if (policies.some(p => p.resource === resource)) unresolved.push(resource);
  }
  const shares = allocate(scene, result, restricted, fair);
  shares.forEach((s, i) => {
    const f = restricted[i]!;
    for (const b of f.bounds) if (b.cap === s.value && !s.bindings.includes(b.resource)) s.bindings.push(b.resource);
    const peers = allocationGroup(flows, flows[i]!).map(p => p.workload);
    s.unresolvedPolicies = unresolved;
    s.policies = policies.filter(p => peers.includes(p.workload));
  });
  return shares;
}
