// 설정이 고른 실제 공급 경로에서 상시 입력이 받은 양만 서비스·풀·내부 자원에 예약한다.
import type { Choice, Demand, DomainPlugin, FeedLoad, Scene } from "./contract.ts";
import { MAX_COMBINATIONS } from "./selection.ts";
import { candidatesFor } from "./candidates.ts";
import { callHook } from "./hook-reads.ts";
import { portFacts, readClaim, resourceFacts } from "./scene.ts";
import type { Results } from "./results.ts";

type Load = FeedLoad & { domain: string };
export type Supply = Pick<Results, "options" | "linkResources" | "standingLoads" | "feedRequirements" | "feedTotals">;
type Interval = { low: number; high: number };
type Cost = { resource: number; fixed: number; fixedHigh: number; coefficient: number; unknown: boolean; option?: number };
type Route = { costs: Cost[]; inputs: number[]; specs: string[]; optional: boolean; policyCap: number; inlets: number[] };
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
    for (const { flow, solo, truncated } of candidates[workload]!) {
      if (flow.path === null) continue;
      const path = local.paths[flow.path]!;
      if (path.verdict === "impossible") continue;
      const steps = local.steps.filter(s => s.path === flow.path);
      const links=steps.filter(s=>s.kind==="connection");
      const first=links[0];
      if (!first) continue;
      const outlet=scene.connections[first.row]!;
      if (source.outputPort!==undefined && source.outputPort!==(first.direction==="forward" ? outlet.from : outlet.to)) continue;
      const inlets=links.slice(0,-1).map(s=>{
        const link=scene.connections[s.row]!;
        return s.direction==="forward" ? link.to : link.from;
      });
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
      if (costs.size) found.push({ costs: [...costs.values()], inputs: [...inputs], specs: [...specs], optional, policyCap, inlets });
    }
  }
  return found;
}

type Pending = {load:Load; paths:Route[]};

// 같은 예산을 전혀 쓰지 않는 입력은 어느 순서로 예약해도 같다. 다른 순서들은 상류 제약 안에서 검산한다.
function supplyOrders(pending:Pending[]) {
  const predecessors=pending.map(({paths},i)=>new Set(pending.flatMap(({load},j)=>
    i!==j && paths.some(p=>p.inlets.includes(load.feed.inputPort)) ? [j] : [])));
  const resources=pending.map(({load,paths})=>new Set(load.amount===0 ? [] : paths.flatMap(p=>p.costs.map(c=>c.resource))));
  const orders:number[][]=[];
  function visit(left:number[], order:number[]):boolean {
    if (!left.length) { orders.push(order); return orders.length<=MAX_COMBINATIONS; }
    const ready=left.filter(i=>!left.some(j=>predecessors[i]!.has(j)));
    const independent=ready.find(i=>left.every(j=>i===j || resources[i]!.isDisjointFrom(resources[j]!)));
    const next=independent===undefined ? ready : [independent];
    return next.length>0 && next.every(i=>visit(left.filter(j=>i!==j),[...order,i]));
  }
  return visit(pending.map((_,i)=>i),[]) ? orders : [];
}

export function feedBudgets(scene: Scene, plugins: readonly DomainPlugin[], base: Results, choices: Choice[], feeds: Load[], connections?: Set<number>): Supply {
  const pending = feeds.map(load => ({ load, paths: callHook(scene,base,"standingLoads",-1,
    view => routes(view,plugins,base,choices,load)).value })).filter(f => f.paths.length);
  if (connections) for (const {paths} of pending) for (const path of paths) for (const cost of path.costs) {
    const link = base.linkResources[cost.resource-scene.resources.length];
    if (link) connections.add(link.connection);
  }
  const orders=supplyOrders(pending);
  // 순환 또는 조합 상한에서는 미검산 순서의 예약을 빠뜨리지 않도록 모든 후보의 0~최대 비용을 남긴다.
  if (!orders.length) return reserve(scene,base,choices,pending.map(({load,paths})=>
    ({load:{...load,rule:load.rule+" · 공급 순서를 모두 검산할 수 없어 보수적으로 예약"},paths:paths.map(p=>({...p,optional:true}))})));
  const cases=orders.map(order=>reserve(scene,base,choices,order.map(i=>pending[i]!)));
  return cases.length===1 ? cases[0]! : mergeOrders(cases,scene.resources.length);
}

function reserve(scene:Scene, base:Results, choices:Choice[], pending:Pending[]):Supply {
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
  for (const {load,paths} of pending) {
    const { item, id, domain, rule, amount } = load;
    const offers = paths.map(path => ({path, low:path.optional ? 0 : deliver(path,amount??0,"low"), high:deliver(path,amount??Infinity,"high")}));
    const guaranteed=Math.max(...offers.map(o=>o.low));
    // 같은 양을 공급할 수 있는 서로 다른 전원에는 확인된 우선순위가 없다.
    const possible=offers.filter(o=>o.high>=guaranteed), best=possible[0]!;
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

// 행별 예약과 예산별 총예약을 각각 같은 순서에서 합산해야 서로 배타적인 최댓값이 중복되지 않는다.
function mergeOrders(cases:Supply[],offset:number):Supply {
  const first=cases[0]!;
  type Bound = {limit:number|null; bounds?:Interval};
  function enclose(caps:Bound[]) {
    const cap=caps[0]!;
    if (caps.every(c=>c.limit===cap.limit && c.bounds?.low===cap.bounds?.low && c.bounds?.high===cap.bounds?.high)) return;
    const low=Math.min(...caps.map(c=>c.limit??c.bounds?.low??0));
    const high=Math.max(...caps.map(c=>c.limit??c.bounds?.high??Infinity));
    cap.limit=low===high ? low : null;
    if (low!==high && Number.isFinite(high)) cap.bounds={low,high}; else delete cap.bounds;
  }
  first.options.forEach((_,i)=>enclose(cases.map(c=>c.options[i]!)));
  first.linkResources.forEach((l,i)=>{if (l.pool) enclose(cases.map(c=>c.linkResources[i]!.pool!));});
  const rows=new Map<string,{row:Results["standingLoads"][number]; min:number; max:number; count:number}>();
  const totals=new Map<number,{min:number;max:number;count:number}>();
  for (const c of cases) {
    const sums=new Map<number,Interval>();
    for (const l of c.standingLoads) {
      const resource=l.resource+(l.kind==="link" ? offset : 0);
      const key=JSON.stringify([l.domain,l.item,l.id,resource]);
      const low=l.amount??l.bounds?.low??0, high=l.amount??l.bounds?.high??Infinity;
      const sum=sums.get(resource)??{low:0,high:0};
      sums.set(resource,{low:sum.low+low,high:sum.high+high});
      const entry=rows.get(key);
      if (!entry) { rows.set(key,{row:{...l},min:low,max:high,count:1}); continue; }
      entry.min=Math.min(entry.min,low); entry.max=Math.max(entry.max,high); entry.count++;
      entry.row.inputs=[...new Set([...entry.row.inputs,...l.inputs])];
      entry.row.specs=[...new Set([...entry.row.specs,...l.specs])];
    }
    for (const [resource,{low,high}] of sums) {
      const current=totals.get(resource);
      if (!current) totals.set(resource,{min:low,max:high,count:1});
      else {current.min=Math.min(current.min,low); current.max=Math.max(current.max,high); current.count++;}
    }
  }
  first.standingLoads=Array.from(rows.values(),({row,min,max,count})=>{
    const low=count===cases.length ? min : 0;
    row.amount=low===max ? low : null;
    if (low!==max && Number.isFinite(max)) row.bounds={low,high:max}; else delete row.bounds;
    return row;
  });
  first.feedTotals=Array.from(totals,([resource,{min,max,count}])=>({resource,low:count===cases.length ? min : 0,high:Number.isFinite(max) ? max : null}));
  // 한 순서에서만 필수인 경로를 모든 순서의 상한으로 쓸 수 없다.
  first.feedRequirements=[];
  return first;
}
