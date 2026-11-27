// 설정이 고른 실제 공급 경로에서 상시 입력이 받은 양만 서비스·풀·내부 자원에 예약한다.
import type { Choice, Demand, DomainPlugin, FeedLoad, Scene } from "./contract.ts";
import { candidatesFor } from "./candidates.ts";
import { callHook } from "./hook-reads.ts";
import { portFacts, readClaim, resourceFacts } from "./scene.ts";
import type { Results } from "./results.ts";

type Load = FeedLoad & { domain: string };
export type Supply = Pick<Results, "options" | "linkResources" | "standingLoads" | "feedRequirements">;
type Interval = { low: number; high: number };
type Cost = { resource: number; fixed: number; fixedHigh: number; coefficient: number; unknown: boolean; option?: number };
type Route = { costs: Cost[]; inputs: number[]; specs: string[]; optional: boolean; policyCap: number; length: number; key: string };
const unlimited = { low: 0, high: Infinity };

function routes(scene: Scene, plugins: readonly DomainPlugin[], base: Results, choices: Choice[], load: Load) {
  const { inputPort, mode, sources } = load.feed;
  const port = portFacts(scene, inputPort);
  const ends = port.node === null ? scene.nodes.flatMap((n,i) => n.item === load.item ? [i] : []) : [port.node];
  const demand: Demand = { inputs: load.inputs, specs: load.specs, rule: load.rule, unit: load.unit,
    requested: load.amount, mode, elastic: true, via: [], preference: 0 };
  const found: Route[] = [];
  for (const source of sources) for (const to of ends) {
    // 실제 작업 행 번호는 보존한다. 내부 작업과 그 경로는 결과 표에 내보내지 않는다.
    const work = { from: source.node, to, id: load.id, kind: mode, domain: load.domain };
    const local: Results = { ...base, demands: [], paths: [], steps: [], matches: [] };
    delete local.readClaims;
    delete local.hookReads;
    const workload = scene.workloads.length;
    const candidates = candidatesFor({ ...scene, workloads: [...scene.workloads,work] }, plugins, local, [], choices, {inputPort,demand,workload});
    for (const { flow, solo, length, key, truncated } of candidates[workload]!) {
      if (flow.path === null) continue;
      const path = local.paths[flow.path]!;
      if (path.verdict === "impossible") continue;
      const steps = local.steps.filter(s => s.path === flow.path);
      if (!steps.some(s => s.kind === "connection")) continue;
      const inputs = new Set([...load.inputs,...source.inputs,port.attachment]);
      const specs = new Set([...load.specs,...source.specs]);
      let optional = truncated || source.possible === true || port.node === null;
      for (const step of steps) {
        if (step.kind === "edge") {
          inputs.add(scene.edges[step.row]!.evidence);
          continue;
        }
        const link = scene.connections[step.row]!;
        for (const end of [link.from,link.to]) {
          const facts = portFacts(scene,end);
          inputs.add(facts.attachment);
          optional ||= facts.node === null;
        }
        for (const physical of base.physical) if (physical.connection === step.row && physical.direction === step.direction) {
          for (const claim of physical.inputs) inputs.add(claim);
          optional ||= physical.verdict === "unknown";
        }
        if (step.option === null) { optional = true; continue; }
        const option = base.options[step.option]!;
        optional ||= option.verdict === "unknown" && !option.bounds;
        const match = local.matches.find(m => m.demand === path.demand && m.option === step.option);
        if (match) {
          optional ||= match.verdict === "unknown";
          for (const claim of match.inputs) inputs.add(claim);
          for (const spec of match.specs) specs.add(spec);
        }
      }
      const costs = new Map<number,Cost>();
      for (const use of flow.uses) {
        const cost = costs.get(use.resource) ?? { resource: use.resource, fixed: 0, fixedHigh: 0, coefficient: 0,
          unknown: false, ...(use.option !== undefined && {option:use.option}) };
        cost.fixed += use.fixed;
        cost.fixedHigh += use.fixedHigh ?? use.fixed;
        cost.coefficient += use.coefficient;
        cost.unknown ||= use.unknown === true;
        optional ||= cost.unknown;
        costs.set(use.resource,cost);
        for (const claim of use.inputs) inputs.add(claim);
        if (use.pool === undefined || base.linkResources[use.pool]!.domain === load.domain)
          for (const spec of use.specs) specs.add(spec);
        if (use.option === undefined) inputs.add(resourceFacts(scene,use.resource).capacity);
      }
      let policyCap = Infinity;
      for (const claim of solo.policyReads ?? []) { readClaim(scene,claim); inputs.add(claim); }
      for (const policy of solo.policies ?? []) {
        for (const claim of policy.inputs) inputs.add(claim);
        if (scene.resources[policy.resource]!.domain === load.domain) for (const spec of policy.specs) specs.add(spec);
        const cost = costs.get(policy.resource)!;
        if (policy.limit === null) optional = true;
        else if (policy.limit < cost.fixed) policyCap = 0;
        else if (cost.coefficient > 0) policyCap = Math.min(policyCap,(policy.limit-cost.fixed)/cost.coefficient);
        if (policy.limit !== null && cost.fixedHigh > cost.fixed) optional = true;
      }
      if (costs.size) found.push({ costs: [...costs.values()], inputs: [...inputs], specs: [...specs], optional, policyCap, length, key });
    }
  }
  return found;
}

export function feedBudgets(scene: Scene, plugins: readonly DomainPlugin[], base: Results, choices: Choice[], feeds: Load[], connections?: Set<number>): Supply {
  const options = base.options.map(o => ({...o}));
  const linkResources = base.linkResources.map(r => r.pool ? {...r,pool:{...r.pool}} : r);
  const standingLoads = base.standingLoads.slice(), offset = scene.resources.length;
  const requirements: NonNullable<Results["feedRequirements"]> = [];
  const remaining = new Map<number,Interval>();
  function budget(cost: Cost, original = false): Interval {
    if (cost.resource < offset) {
      const prior = remaining.get(cost.resource);
      if (prior && !original) return prior;
      const raw = readClaim(scene,resourceFacts(scene,cost.resource).capacity).value;
      if (typeof raw !== "number") return unlimited;
      const used = base.standingLoads.filter(l => l.kind === "scene" && l.resource === cost.resource);
      return { low: Math.max(0,raw-used.reduce((n,l) => n+(l.amount??l.bounds?.high??Infinity),0)),
        high: Math.max(0,raw-used.reduce((n,l) => n+(l.amount??l.bounds?.low??0),0)) };
    }
    const cap = original ? base.linkResources[cost.resource-offset]!.pool ?? base.options[cost.option!]!
      : linkResources[cost.resource-offset]!.pool ?? options[cost.option!]!;
    return cap.limit === null ? cap.bounds ?? unlimited : {low:cap.limit,high:cap.limit};
  }
  function deliver(route: Route, requested: number, side: keyof Interval, own?: number) {
    let amount = Math.min(requested,route.policyCap);
    for (const cost of route.costs) {
      const other = side === "low" ? "high" : "low";
      const limit = budget(cost)[cost.resource === own ? other : side];
      const fixed = side === "low" ? cost.fixedHigh : cost.fixed;
      if (limit < fixed) return 0;
      if (cost.coefficient) amount = Math.min(amount,(limit-fixed)/cost.coefficient);
    }
    return Math.max(0,amount);
  }
  const pending = feeds.map(load => ({ load, paths: callHook(scene,base,"standingLoads",-1,
    view => routes(view,plugins,base,choices,load)).value })).filter(f => f.paths.length);
  if (connections) for (const {paths} of pending) for (const path of paths) for (const cost of path.costs) {
    const link = linkResources[cost.resource-offset];
    if (link) connections.add(link.connection);
  }
  // 상류 입력에서 먼저 소비한 뒤 하류 입력에 남은 공급을 보낸다. 실물의 저장 순서는 영향을 주지 않는다.
  const distance = (paths: Route[]) => Math.min(...paths.map(p => p.length));
  pending.sort((a,b) => distance(a.paths)-distance(b.paths) || scene.items[a.load.item]!.id.localeCompare(scene.items[b.load.item]!.id) || a.load.id.localeCompare(b.load.id));
  for (const {load,paths} of pending) {
    const { item, id, domain, rule, amount } = load;
    const ranked = paths.map(path => ({path, low:path.optional ? 0 : deliver(path,amount??0,"low"), high:deliver(path,amount??Infinity,"high")}))
      .sort((a,b) => b.low-a.low || b.high-a.high || a.path.length-b.path.length || a.path.key.localeCompare(b.path.key));
    const best = ranked[0]!;
    const possible = ranked.filter((r,i) => i===0 || r.high > best.low || r.high === best.low &&
      (r.path.length < best.path.length || r.path.length === best.path.length && r.path.key.localeCompare(best.path.key)<0));
    const inputs = [...new Set(possible.flatMap(r => r.path.inputs))], specs = [...new Set(possible.flatMap(r => r.path.specs))];
    const resources = new Set(possible.flatMap(r => r.path.costs.map(c => c.resource)));
    const changes = [];
    for (const resource of resources) {
      let low = Infinity, high = 0, left = Infinity, right = 0;
      const cost = possible.flatMap(r => r.path.costs).find(c => c.resource === resource)!;
      const cap = budget(cost);
      for (const r of possible) {
        const c = r.path.costs.find(u => u.resource === resource);
        const use = (rate: number, worst: boolean) => {
          if (!c || rate === 0) return 0;
          if (c.unknown && worst) return cap.high;
          return (worst ? c.fixedHigh : c.fixed) + (c.coefficient ? c.coefficient*rate : 0);
        };
        low = Math.min(low,use(r.low,false));
        high = Math.max(high,Math.min(cap.high,use(r.high,true)));
        // 이 예산의 용량은 고정하고 다른 입력의 양 끝을 대입한다. 같은 세계의 공급과 예약을 뺀다.
        left = Math.min(left,Math.max(0,cap.low-use(deliver(r.path,amount??Infinity,"high",resource),true)));
        right = Math.max(right,cap.high===Infinity ? Infinity : Math.max(0,cap.high-use(r.path.optional ? 0 : deliver(r.path,amount??0,"low",resource),false)));
      }
      changes.push({resource,low,high,left,right});
    }
    if (amount !== null && amount > 0 && possible.length === 1 && !best.path.optional && best.path.costs.every(c=>c.fixed===c.fixedHigh)) {
      const full = Math.min(amount,best.path.policyCap);
      if (full>0) requirements.push(best.path.costs.map(c => ({resource:c.resource,
        ...(c.option !== undefined && !linkResources[c.resource-offset]?.pool && {option:c.option}),
        amount:c.fixed+c.coefficient*full, capacity:budget(c,true).high})));
    }
    for (const {resource,low,high,left,right} of changes) {
      const link = resource-offset, kind = link<0 ? "scene" : "link";
      const unit = link<0 ? scene.resources[resource]!.unit : linkResources[link]!.pool?.unit ?? linkResources[link]!.service?.unit ?? load.unit;
      standingLoads.push({ item,id,domain,rule,inputs,specs,unit,kind, resource:link<0 ? resource : link,
        amount:low===high ? low : null, ...(low!==high && Number.isFinite(high) && {bounds:{low,high}}) });
      remaining.set(resource,{low:left,high:right});
      if (link<0) continue;
      const pool = linkResources[link]!.pool;
      const caps = pool ? [pool] : options.filter(o => (o.serviceResource??o.linkResource)===link &&
        (!o.profile || !choices.some(c => c.connection===o.connection && c.profile!==o.profile)));
      for (const cap of caps) {
        const selected = !!pool || possible.every(r => r.path.costs.some(c => c.resource===resource && cap===options[c.option!]));
        const min = selected ? left : Math.max(0,(cap.limit??cap.bounds?.low??0)-high);
        const max = selected ? right : Math.max(0,(cap.limit??cap.bounds?.high??Infinity)-low);
        cap.limit = min===max ? min : null;
        if (min!==max && Number.isFinite(max)) cap.bounds = {low:min,high:max};
        else delete cap.bounds;
      }
    }
  }
  return { options,linkResources,standingLoads,feedRequirements:requirements };
}

