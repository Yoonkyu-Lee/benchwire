// 장치가 연결돼 있는 동안 쓰는 양을 실물별로 한 번씩 해당 입력 링크와 상위 자원에서 덜어낸다.
import { compareQuantity, type DomainPlugin, type FeedLoad, type Scene } from "./contract.ts";
import { availableOption } from "./pools.ts";
import { readClaim, resourceFacts } from "./scene.ts";
import type { Results } from "./results.ts";
import { callHook } from "./hook-reads.ts";

function remaining(limit: number | null, amount: number | null) {
  if (amount === 0) return limit;
  if (limit === 0) return 0;
  if (amount === null || limit === null) return null;
  return compareQuantity(limit,amount) > 0 ? limit - amount : 0;
}

export function resourceCapacity(scene: Scene, result: Results, resource: number) {
  const value = readClaim(scene,resourceFacts(scene, resource).capacity,"range").value;
  let capacity = typeof value === "number" ? value : null;
  const total=result.feedTotals?.find(t=>t.resource===resource);
  if (total) return remaining(capacity,total.low===total.high ? total.low : null);
  for (const load of result.standingLoads) if (load.kind === "scene" && load.resource === resource)
    capacity = remaining(capacity, load.amount);
  return capacity;
}

export function reserveStanding(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  const feeds: (FeedLoad & {domain:string})[] = [];
  for (const plugin of plugins) for (const load of plugin.standingLoads ? callHook(scene,result,"standingLoads",-1,
    view=>plugin.standingLoads!(view)).value : []) {
    const { item, id, unit, rule, inputs } = load;
    const issue = (field: string) => result.standingErrors.push({ domain: plugin.id, item, id, field });
    if (!scene.items[item]) { issue("item"); continue; }
    if ("feed" in load) {
      if (scene.ports[load.feed.inputPort]?.item !== item) { issue("feed.inputPort"); continue; }
      if (load.feed.sources.some(s=>!scene.nodes[s.node] || s.outputPort!==undefined && scene.ports[s.outputPort]?.item!==scene.nodes[s.node]!.item)) { issue("feed.sources"); continue; }
      const amount=load.amount===null || Number.isFinite(load.amount) && load.amount>=0 ? load.amount : null;
      if (amount!==load.amount) issue("amount");
      const checkedSpecs=(specs:string[])=>specs.filter(spec=>{
        if (result.specSources.some(s=>s.domain===plugin.id && s.id===spec)) return true;
        issue("spec:"+spec);
        return false;
      });
      if (!feeds.some(f=>f.domain===plugin.id && f.item===item && f.id===id)) {
        const sources=load.feed.sources.map(s=>({...s,specs:checkedSpecs(s.specs)}));
        feeds.push({...load,amount,specs:checkedSpecs(load.specs),feed:{...load.feed,sources},domain:plugin.id});
      }
      continue;
    }
    // 입력이 끊기면 같은 실물 부하에 딸린 입력·상위 자원 예약이 함께 사라진다.
    if (load.targets.some(t => "connection" in t && result.physical.some(p =>
      p.connection === t.connection && p.direction === t.direction && p.verdict === "impossible"))) continue;
    const specs = load.specs.filter(spec => result.specSources.some(s => s.domain === plugin.id && s.id === spec));
    for (const spec of load.specs) if (!specs.includes(spec)) issue("spec:" + spec);
    const requested = load.amount !== null && Number.isFinite(load.amount) && load.amount >= 0 ? load.amount : null;
    if (requested === null && load.amount !== null) issue("amount");
    const evidence = new Set(inputs);
    const linkRows = (t: Exclude<typeof load.targets[number], { resource: number }>) => result.options.flatMap((o,i) =>
      o.connection === t.connection && o.direction === t.direction && o.domain === t.domain && o.mode === t.mode && o.unit === unit ? [i] : []);
    const links = load.targets.filter(t => "connection" in t);
    let low = requested ?? 0, high = requested ?? Infinity;
    for (const target of links) {
      const rows = linkRows(target);
      if (!rows.length) { low = 0; continue; }
      for (const p of result.physical) if (p.connection === target.connection && p.direction === target.direction)
        for (const id of p.inputs) evidence.add(id);
      for (const row of rows) {
        const o = result.options[row]!;
        for (const id of o.inputs) evidence.add(id);
        if (o.poolResource !== undefined) for (const id of result.linkResources[o.poolResource]!.pool!.inputs) evidence.add(id);
      }
      const options = rows.map(i => availableOption(result,i)).filter(o => o.verdict !== "impossible");
      const floors = options.map(o => o.bounds?.low ?? (o.verdict === "unknown" ? 0 : o.limit ?? 0));
      const ceilings = options.map(o => o.limit ?? o.bounds?.high ?? Infinity);
      low = Math.min(low, Math.max(0, ...floors));
      high = Math.min(high, Math.max(0, ...ceilings));
    }
    const trace = { item, id, unit, rule, inputs: [...evidence], specs, domain: plugin.id };
    function record(kind: "scene" | "link", resource: number, min: number, max: number, budgetUnit = unit) {
      if (result.standingLoads.some(r => r.domain === plugin.id && r.item === item && r.id === id && r.kind === kind &&
          r.resource === resource)) return false;
      result.standingLoads.push({ ...trace, kind, resource, amount: min === max ? min : null, unit: budgetUnit,
        ...(min !== max && Number.isFinite(max) ? { bounds: {low: min, high: max} } : {}) });
      return true;
    }
    function charge(cap: { limit: number | null; bounds?: { low: number; high: number } }, min: number, max: number) {
      const floor = cap.limit ?? cap.bounds?.low ?? 0, ceiling = cap.limit ?? cap.bounds?.high;
      const left = remaining(floor,max)!, right = remaining(ceiling ?? null,min);
      cap.limit = left === right ? left : null;
      if (cap.limit === null && right !== null) cap.bounds = {low: left, high: right};
      else delete cap.bounds;
    }
    for (const target of load.targets) {
      if ("resource" in target) {
        if (!scene.resources[target.resource]) issue("resource");
        else if (scene.resources[target.resource]!.unit !== unit) { issue("unit"); record("scene",target.resource,0,Infinity); }
        else record("scene",target.resource,target.possible ? 0 : low,high);
        continue;
      }
      const rows = linkRows(target);
      if (!rows.length) issue("connection");
      for (const i of rows) {
        const o = result.options[i]!;
        const budget = o.serviceResource ?? o.linkResource;
        if (record("link",budget,low,high)) for (const service of result.options) {
          if ((service.serviceResource ?? service.linkResource) !== budget) continue;
          // 같은 입력의 잔여 한도는 양 경계에서 각각 그때 공급할 수 있는 만큼 차감한다.
          if (service === o && links.length === 1 && rows.length === 1 && o.poolResource === undefined)
            charge(service,requested ?? 0,requested ?? Infinity);
          else charge(service,low,high);
        }
        if (o.poolResource !== undefined) {
          const scale = o.pool!.perUnit;
          const pool = result.linkResources[o.poolResource]!.pool!;
          if (record("link",o.poolResource,low * scale,high * scale,pool.unit)) charge(pool,low * scale,high * scale);
        }
      }
    }
  }
  return feeds;
}
