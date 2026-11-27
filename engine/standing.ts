// 장치가 연결돼 있는 동안 쓰는 양을 실물별로 한 번씩 해당 입력 링크와 상위 자원에서 덜어낸다.
import type { DomainPlugin, Scene } from "./contract.ts";
import { resourceFacts } from "./scene.ts";
import type { Results } from "./results.ts";

function remaining(limit: number | null, amount: number | null) {
  if (limit === 0) return 0;
  return amount === null || limit === null ? null : Math.max(0, limit - amount);
}

export function resourceCapacity(scene: Scene, result: Results, resource: number) {
  const value = scene.claims[resourceFacts(scene, resource).capacity]!.value;
  let capacity = typeof value === "number" ? value : null;
  for (const load of result.standingLoads) if (load.kind === "scene" && load.resource === resource)
    capacity = remaining(capacity, load.amount);
  return capacity;
}

export function reserveStanding(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  for (const plugin of plugins) for (const load of plugin.standingLoads?.(scene) ?? []) {
    const { item, id, unit, rule, inputs } = load;
    const issue = (field: string) => result.standingErrors.push({ domain: plugin.id, item, id, field });
    if (!scene.items[item]) { issue("item"); continue; }
    const specs = load.specs.filter(spec => result.specSources.some(s => s.domain === plugin.id && s.id === spec));
    for (const spec of load.specs) if (!specs.includes(spec)) issue("spec:" + spec);
    const amount = load.amount !== null && Number.isFinite(load.amount) && load.amount >= 0 ? load.amount : null;
    if (amount === null && load.amount !== null) issue("amount");
    const trace = { item, id, unit, rule, inputs, specs, domain: plugin.id, amount };
    const record = (kind: "scene" | "link", resource: number, cost: number | null, budgetUnit = unit) => {
      if (result.standingLoads.some(r => r.domain === plugin.id && r.item === item && r.id === id && r.kind === kind &&
          r.resource === resource)) return false;
      result.standingLoads.push({ ...trace, kind, resource, amount: cost, unit: budgetUnit });
      return true;
    };
    function charge(cap: { limit: number | null; bounds?: { low: number; high: number } }, cost: number | null) {
      const low = cap.limit ?? cap.bounds?.low ?? 0, high = cap.limit ?? cap.bounds?.high;
      cap.limit = remaining(cap.limit, cost);
      if (cap.limit === null && high !== undefined) {
        cap.bounds = { low: remaining(low,cost) ?? 0, high: Math.max(0,high - (cost ?? 0)) };
        if (cap.bounds.low === cap.bounds.high) cap.limit = cap.bounds.low;
      }
      if (cap.limit !== null) delete cap.bounds;
    }
    for (const target of load.targets) {
      if ("resource" in target) {
        if (!scene.resources[target.resource]) issue("resource");
        else if (scene.resources[target.resource]!.unit !== unit) { issue("unit"); record("scene",target.resource,null); }
        else record("scene",target.resource,amount);
        continue;
      }
      let found = false;
      for (const o of result.options) {
        if (o.connection !== target.connection || o.direction !== target.direction || o.domain !== target.domain ||
            o.mode !== target.mode || o.unit !== unit) continue;
        found = true;
        const budget = o.serviceResource ?? o.linkResource;
        if (record("link",budget,amount)) for (const service of result.options)
          if ((service.serviceResource ?? service.linkResource) === budget) charge(service,amount);
        if (o.poolResource !== undefined) {
          const cost = amount === null ? null : amount * o.pool!.perUnit;
          const pool = result.linkResources[o.poolResource]!.pool!;
          if (record("link",o.poolResource,cost,pool.unit)) charge(pool,cost);
        }
      }
      if (!found) issue("connection");
    }
  }
}
