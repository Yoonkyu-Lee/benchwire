// 접속 배선과 활성 작업에 맞는 영역 정책 한도를 적용한 뒤 공유 자원을 배분한다.
import { compareQuantity, type DomainPlugin, type PolicyLimit, type Scene } from "./contract.ts";
import { allocate, allocationGroup, throughputUpper, type Flow } from "./allocate.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";
import { resourceCapacity } from "./standing.ts";
import { readClaim, resourceFacts } from "./scene.ts";
import { callHook } from "./hook-reads.ts";

export function policyAllocation(scene: Scene, plugins: readonly DomainPlugin[], result: Results, flows: readonly Flow[], assumed: readonly number[] = []) {
  const fair = new Set(assumed);
  const policies: (PolicyLimit & {resource: number})[] = [];
  const readsByResource=new Map<number,number[]>();
  const connectedPorts = [...new Set([...scene.connections.flatMap(c => [c.from, c.to]), ...scene.parts.flatMap(p => [p.entry, p.exit])])];
  const activeWorkloads = flows.map(f => f.workload);
  const used = new Set(flows.flatMap(f => f.uses.filter(u => u.option === undefined).map(u => u.resource)));
  const named = new Set<number>();
  for (const resource of used) {
    const policy = readClaim(scene,resourceFacts(scene, resource).policy).value;
    if (policy === null || policy === "max-min") continue;
    named.add(resource);
    const domain = scene.resources[resource]!.domain;
    const plugin=plugins.find(p=>p.id===domain);
    if (!plugin?.policy) continue;
    const {value,claims}=callHook(scene,result,"policy",resource,
      view=>plugin.policy!({scene:view,resource,activeWorkloads,connectedPorts}));
    readsByResource.set(resource,claims);
    const limits=(value ?? []).concat(flows.filter(f=>f.uses.some(u=>u.resource===resource) && !value?.some(p=>p.workload===f.workload))
      .map(f=>({workload:f.workload,limit:null,inputs:claims,specs:[],rule:"정책표의 한도 미확인"})));
    for (const p of limits) {
      const path = flows.find(f => f.workload === p.workload)?.path;
      if (path == null) continue;
      const trace = checkedTrace(result, domain, "policy", path, p, resource);
      policies.push({ ...trace, limit:checkedQuantity(result, domain, "policy", path, "limit", p.limit, resource), resource });
    }
  }
  if (!named.size && !fair.size) return allocate(scene, result, flows);

  const restricted = flows.map(f => {
    let cap = f.cap, verdict = f.verdict, bestCase = f.bestCase ?? f.verdict;
    const bounds: { resource: number; cap: number }[] = [];
    for (const resource of used) {
      const uses = f.uses.filter(u => u.option === undefined && u.resource === resource);
      if (!uses.length || verdict === "impossible") continue;
      const limit = policies.find(p => p.resource === resource && p.workload === f.workload);
      if (limit?.limit == null) {
        if (named.has(resource)) verdict = bestCase = "unknown";
        continue;
      }
      const fixed = uses.reduce((n, u) => n + u.fixed, 0), coefficient = uses.reduce((n, u) => n + u.coefficient, 0);
      if (limit.limit === 0 && fixed > 0 || compareQuantity(fixed,limit.limit) > 0) {
        verdict = "impossible"; bounds.push({ resource, cap: 0 }); continue;
      }
      if (coefficient > 0 && cap !== null) {
        const bound = Math.max(0,limit.limit - fixed) / coefficient;
        bounds.push({ resource, cap: bound });
        cap = Math.min(cap, bound);
        if (bound === 0 && f.cap !== 0) verdict = "impossible";
      }
    }
    if (cap !== null && f.cap !== null && compareQuantity(cap,f.cap) < 0 && verdict !== "unknown")
      verdict = cap === 0 || !f.elastic || verdict === "impossible" ? "impossible" : "conditional";
    return { ...f, cap, verdict, bestCase: verdict === "unknown" ? bestCase : verdict, bounds };
  });
  const unresolved: number[] = [];
  for (const resource of named) {
    const capacity = resourceCapacity(scene, result, resource);
    if (typeof capacity !== "number") continue;
    let required = 0;
    for (const flow of restricted) {
      const uses = flow.uses.filter(u => u.resource === resource);
      if (!uses.length || flow.verdict === "impossible" || flow.cap === 0) continue;
      const upper = throughputUpper(scene, result, flow, policies);
      for (const u of uses) required += (u.fixedHigh ?? u.fixed) + (u.coefficient ? (upper ?? Infinity) * u.coefficient : 0);
    }
    if (compareQuantity(required,capacity) <= 0) fair.add(resource);
    else if (policies.some(p => p.resource === resource && p.limit!==null)) unresolved.push(resource);
  }
  const shares = allocate(scene, result, restricted, fair, policies);
  shares.forEach((s, i) => {
    const f = restricted[i]!;
    for (const b of f.bounds) if (s.value !== null && compareQuantity(b.cap,s.value) === 0 && !s.bindings.includes(b.resource)) s.bindings.push(b.resource);
    const group=allocationGroup(flows,flows[i]!);
    const peers=group.map(p=>p.workload);
    const resources=new Set(group.flatMap(peer=>peer.uses.map(u=>u.resource)));
    s.policyReads=[...new Set([...resources].flatMap(row=>readsByResource.get(row) ?? []))];
    s.unresolvedPolicies = unresolved;
    s.policies = policies.filter(p => peers.includes(p.workload));
  });
  return shares;
}
