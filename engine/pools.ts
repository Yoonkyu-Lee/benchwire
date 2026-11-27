// 협상한 운반 서비스의 한도와 같은 물리 연결 위의 공용 예산을 별개 자원으로 연결한다.
import type { Option, Pool } from "./contract.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";

export function registerPool(result: Results, origin: number, raw: Pool) {
  const { connection, domain, direction } = result.linkResources[origin]!;
  const trace = checkedTrace(result, domain, "negotiate", origin, raw);
  const limit = checkedQuantity(result, domain, "negotiate", origin, "pool.limit", trace.limit);
  const pool = { ...trace, limit };
  if (pool.bounds) {
    const low = checkedQuantity(result, domain, "negotiate", origin, "pool.bounds.low", pool.bounds.low);
    const high = checkedQuantity(result, domain, "negotiate", origin, "pool.bounds.high", pool.bounds.high);
    if (limit !== null || low === null || high === null || low < 0 || low > high) delete pool.bounds;
  }
  const prior = result.linkResources.find(r => r.connection === connection && r.domain === domain &&
    r.pool?.id === pool.id && (r.direction === direction || r.pool.scope === "connection" || pool.scope === "connection"))?.pool;
  if (!prior) {
    result.linkResources.push({ connection, domain, direction, absentDomain: [], pool });
    return;
  }
  prior.inputs = [...new Set([...prior.inputs, ...pool.inputs])];
  prior.specs = [...new Set([...prior.specs, ...pool.specs])];
  if (prior.scope !== pool.scope || prior.unit !== pool.unit || prior.limit !== pool.limit ||
      prior.bounds?.low !== pool.bounds?.low || prior.bounds?.high !== pool.bounds?.high) {
    result.errors.push({ domain, stage: "negotiate", row: origin, field: "pool.conflict", spec: "" });
    prior.limit = null;
    delete prior.bounds;
  }
}

export function bindPools(result: Results) {
  const units = new Map<number, Set<string>>();
  for (const o of result.options) if (!o.pool) {
    const declared = units.get(o.linkResource) ?? new Set<string>();
    declared.add(o.unit);
    units.set(o.linkResource, declared);
  }
  for (const o of result.options) {
    if (!o.pool && units.get(o.linkResource)!.size === 1) continue;
    if (o.pool) {
      const { domain, id, perUnit } = o.pool;
      const pool = result.linkResources.findIndex(r => r.pool?.id === id && r.domain === domain && r.connection === o.connection &&
        (r.pool.scope === "connection" || r.direction === o.direction));
      if (pool < 0 || !Number.isFinite(perUnit) || perUnit <= 0) {
        const field = pool < 0 ? "pool.id" : "pool.perUnit";
        result.errors.push({ domain: o.domain, stage: "negotiate", row: o.linkResource, field, spec: "" });
        if (o.verdict !== "impossible") o.verdict = "unknown";
        delete o.bounds;
        continue;
      }
      o.poolResource = pool;
    }
    // 같은 영역이 서로 다른 단위의 터널을 발행해도 각 서비스의 협상 한도는 독립이다.
    const { connection, direction, unit } = o;
    const mode = o.pool ? o.mode : undefined;
    let service = result.linkResources.findIndex(r => r.connection === connection && r.direction === direction && r.domain === o.domain &&
      r.service?.unit === unit && r.service.mode === mode && r.service.poolResource === o.poolResource);
    if (service < 0) service = result.linkResources.push({ connection, direction, domain: o.domain, absentDomain: [],
      service: { unit, ...(mode === undefined ? {} : { mode }), ...(o.poolResource === undefined ? {} : { poolResource: o.poolResource }) } }) - 1;
    o.serviceResource = service;
  }
}

// 단일 작업이 이 옵션을 쓸 때도 공용 예산을 넘을 수 없다. 배분에는 원래의 두 한도를 각각 쓴다.
export function availableOption(result: Results, row: number): Option {
  const o = result.options[row]!;
  if (o.poolResource === undefined) return o;
  const pool = result.linkResources[o.poolResource]!.pool!, scale = o.pool!.perUnit;
  const serviceLow = o.verdict === "unknown" && !o.bounds ? 0 : o.limit ?? o.bounds?.low ?? 0;
  const low = Math.min(serviceLow, (pool.limit ?? pool.bounds?.low ?? 0) / scale);
  const high = Math.min(o.limit ?? o.bounds?.high ?? Infinity, (pool.limit ?? pool.bounds?.high ?? Infinity) / scale);
  if (low === high) return { ...o, limit: low };
  const effective = { ...o, limit: null };
  if (Number.isFinite(high)) effective.bounds = { low, high };
  return effective;
}
