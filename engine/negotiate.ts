// 양 끝과 부품의 협상 결과를 방향별로 모으고 연결 및 경로에 같은 옵션 선택 규칙을 적용한다.
import { compareQuantity, type Demand, type DomainPlugin, type Link, type Option, type Scene, type Verdict } from "./contract.ts";
import { availableOption, bindPools, registerPool } from "./pools.ts";
import { physicalSteps } from "./physical.ts";
import { callHook } from "./hook-reads.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";

export const verdictOrder: readonly Verdict[] = ["ok", "conditional", "unknown", "impossible"];

export function optionVerdict(o: Option, d?: Demand): Verdict {
  if (d && (o.mode !== d.mode || o.unit !== d.unit)) return "impossible";
  if (o.verdict === "impossible" || o.limit === 0) return "impossible";
  if (o.limit === null && o.bounds) {
    const { low, high } = o.bounds;
    if (high === 0 || d && !d.elastic && d.requested !== null && compareQuantity(d.requested,high) > 0) return "impossible";
    if (!low || d?.requested != null && compareQuantity(d.requested,low) > 0) {
      if (low > 0 && d?.elastic && d.requested !== null && compareQuantity(d.requested,high) > 0) return "conditional";
      return "unknown";
    }
    return o.condition || o.verdict === "conditional" || d && d.preference > 0 ? "conditional" : "ok";
  }
  if (o.limit === null || o.verdict === "unknown") return "unknown";
  if (d?.requested != null && compareQuantity(o.limit,d.requested) < 0)
    return d.elastic ? "conditional" : "impossible";
  return o.condition || d && d.preference > 0 ? "conditional" : o.verdict;
}

export function optionChoices(result: Results, rows: number[], demand?: Demand,
  matches?: ReadonlyMap<number, { verdict: Verdict }>) {
  function rated(row: number, option: Option) {
    const verdict = optionVerdict(option, demand);
    const matched = matches?.get(row)?.verdict;
    return { row, option, verdict: matched && verdictOrder.indexOf(matched) > verdictOrder.indexOf(verdict) ? matched : verdict };
  }
  type Rated = ReturnType<typeof rated>;
  const compare = (a: Rated, b: Rated) => verdictOrder.indexOf(a.verdict) - verdictOrder.indexOf(b.verdict) ||
      Number(!!demand && a.option.mode !== demand.mode) - Number(!!demand && b.option.mode !== demand.mode) ||
      Number(!!demand && a.option.unit !== demand.unit) - Number(!!demand && b.option.unit !== demand.unit) ||
      (b.option.limit ?? 0) - (a.option.limit ?? 0) || a.option.mode.localeCompare(b.option.mode) || a.option.rule.localeCompare(b.option.rule) || a.row - b.row;
  const ranked = rows.map(row => rated(row, availableOption(result, row))).sort(compare);
  const first = ranked[0]!;
  if (ranked.length === 1 || !ranked.some(c => c.verdict !== "impossible" && c.option.limit === null && c.option.bounds))
    return { offers: [first], floor: first, ceiling: first };
  // 협상 결과의 범위는 원시 주장의 단위와 다를 수 있다. 비교에만 양 끝을 쓰고 경로에는 원래 옵션을 넘긴다.
  function bound(c: Rated, end: "low" | "high") {
    if (c.verdict === "impossible" || c.option.limit !== null) return c;
    const limit = c.option.bounds?.[end] ?? (end === "low" ? 0 : Infinity);
    return rated(c.row, { ...c.option, limit, verdict: c.option.verdict === "unknown" ? "ok" : c.option.verdict });
  }
  const floor = ranked.map(c => bound(c, "low")).sort(compare)[0]!;
  const ceiling = ranked.map(c => bound(c, "high")).sort(compare)[0]!;
  const offers = ranked.filter(c => c.row === floor.row || c.verdict !== "impossible" && compare(bound(c, "high"), floor) <= 0);
  return { offers, floor, ceiling };
}

export function negotiate(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  scene.connections.forEach((_, connection) => {
    for (const direction of ["forward", "reverse"] as const) {
      const physical = physicalSteps(scene, connection, direction);
      result.physical.push(...physical);
      const ports = physical.filter(s => s.kind === "mate").flatMap(s => [s.entry, s.exit]);
      const domains = new Set(scene.interfaces.filter(i => ports.includes(i.port)).map(i => i.domain));
      const active = plugins.filter(p => domains.has(p.id));
      const link: Link = { scene, connection, direction, ports };
      const providers = active.toSorted((a, b) => a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
      const profiles = providers.flatMap(p => p.laneProfiles ? callHook(scene,result,"laneProfiles",connection,
        view=>p.laneProfiles!({...link,scene:view})).value : []);
      if (profiles.length) {
        const settings = Map.groupBy(profiles, row => JSON.stringify([row.domain, row.mode, row.profile]));
        link.laneProfiles = [...settings.values()].flatMap(rows => {
          if (rows.length === 1) return rows;
          const inputs = [...new Set(rows.flatMap(row => row.inputs))];
          return rows.map(row => ({ ...row, inputs }));
        });
      }
      for (const plugin of active) {
        const position = { connection, domain: plugin.id, direction };
        const linkResource = result.linkResources.length;
        const options = callHook(scene,result,"negotiate",linkResource,view=>plugin.negotiate({...link,scene:view})).value;
        const declarationClaimsOnPortsWithoutDomain = ports.flatMap(port => {
          const declarations = scene.interfaces.filter(i => i.port === port);
          return declarations.some(i => i.domain === plugin.id) ? [] : declarations.map(i => i.evidence);
        });
        for (const option of options) {
          const trace = checkedTrace(result, plugin.id, "negotiate", linkResource, option);
          const limit = checkedQuantity(result, plugin.id, "negotiate", linkResource, "limit", trace.limit);
          const o = { ...trace, limit };
          if (o.unused !== undefined && checkedQuantity(result, plugin.id, "negotiate", linkResource, "unused", o.unused) === null) delete o.unused;
          if (o.bounds) {
            const low = checkedQuantity(result, plugin.id, "negotiate", linkResource, "bounds.low", o.bounds.low);
            const high = checkedQuantity(result, plugin.id, "negotiate", linkResource, "bounds.high", o.bounds.high);
            if (limit !== null || low === null || high === null || low < 0 || high < low) delete o.bounds;
            else if (physical.some(s => s.verdict === "unknown")) o.bounds = { low: 0, high };
          }
          const verdict = physical.some(s => s.verdict === "impossible") ? "impossible"
            : o.verdict !== "impossible" && physical.some(s => s.verdict === "unknown") ? "unknown" : o.verdict;
          result.options.push({ ...o, ...position, linkResource, verdict,
            inputs: verdict === "impossible" ? [...new Set([...o.inputs, ...declarationClaimsOnPortsWithoutDomain])] : o.inputs });
        }
        result.linkResources.push({ ...position, declarationClaimsOnPortsWithoutDomain });
        if (plugin.pools) for (const pool of callHook(scene,result,"pools",linkResource,
          view=>plugin.pools!({...link,scene:view})).value) registerPool(result, linkResource, pool);
      }
    }
  });
  // 같은 실측 서비스의 설정은 합집합, 서로 다른 실측 서비스의 제약은 교집합이다.
  const observed = Map.groupBy(result.options.filter(o=>o.observation !== undefined),o=>o.observation!);
  for (const [claim,services] of observed) {
    if (services.some(o=>!o.profile)) continue;
    const profiles = new Set(services.map(o=>o.profile));
    for (const option of result.options) {
      if (option.connection !== services[0]!.connection || !option.profile) continue;
      if (!option.inputs.includes(claim)) option.inputs = [...option.inputs,claim];
      if (!profiles.has(option.profile)) {
        option.verdict = "impossible";
        option.limit = 0;
        delete option.bounds;
        delete option.unused;
        option.condition = "";
        option.rule = "현재 연결에서 관측한 서비스와 양립하지 않는 설정 " + option.profile;
      }
    }
  }
  bindPools(result);
}
