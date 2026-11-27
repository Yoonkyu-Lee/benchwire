// 양 끝과 부품의 협상 결과를 방향별로 모으고 연결 및 경로에 같은 옵션 선택 규칙을 적용한다.
import type { Demand, DomainPlugin, Option, Scene, Verdict } from "./contract.ts";
import { physicalSteps } from "./physical.ts";
import { checkedTrace, type Results } from "./results.ts";

export const verdictOrder: readonly Verdict[] = ["ok", "conditional", "unknown", "impossible"];

export function optionVerdict(o: Option, d?: Demand): Verdict {
  if (d && (o.mode !== d.mode || o.unit !== d.unit)) return "impossible";
  if (o.verdict === "impossible" || o.limit === 0) return "impossible";
  if (o.limit === null || o.verdict === "unknown") return "unknown";
  if (d?.requested != null && o.limit < d.requested)
    return d.elastic ? "conditional" : "impossible";
  return o.condition || d && d.preference > 0 ? "conditional" : o.verdict;
}

export function bestOption(result: Results, rows: number[], demand?: Demand) {
  return rows.map(row => ({ row, option: result.options[row]!, verdict: optionVerdict(result.options[row]!, demand) }))
    .sort((a, b) => verdictOrder.indexOf(a.verdict) - verdictOrder.indexOf(b.verdict) ||
      Number(!!demand && a.option.mode !== demand.mode) - Number(!!demand && b.option.mode !== demand.mode) ||
      Number(!!demand && a.option.unit !== demand.unit) - Number(!!demand && b.option.unit !== demand.unit) ||
      (b.option.limit ?? 0) - (a.option.limit ?? 0) || a.option.mode.localeCompare(b.option.mode) || a.option.rule.localeCompare(b.option.rule))[0]!;
}

export function negotiate(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  scene.connections.forEach((_, connection) => {
    for (const direction of ["forward", "reverse"] as const) {
      const physical = physicalSteps(scene, connection, direction);
      result.physical.push(...physical);
      const ports = physical.filter(s => s.kind === "mate").flatMap(s => [s.entry, s.exit]);
      const domains = new Set(scene.interfaces.filter(i => ports.includes(i.port)).map(i => i.domain));
      for (const plugin of plugins.filter(p => domains.has(p.id))) {
        const options = plugin.negotiate({ scene, connection, direction, ports });
        const position = { connection, domain: plugin.id, direction };
        const linkResource = result.linkResources.length;
        const absentDomain = ports.flatMap(port => {
          const declarations = scene.interfaces.filter(i => i.port === port);
          return declarations.some(i => i.domain === plugin.id) ? [] : declarations.map(i => i.evidence);
        });
        for (const option of options) {
          const o = checkedTrace(result, plugin.id, "negotiate", linkResource, option);
          const verdict = physical.some(s => s.verdict === "impossible") ? "impossible"
            : o.verdict !== "impossible" && physical.some(s => s.verdict === "unknown") ? "unknown" : o.verdict;
          result.options.push({ ...o, ...position, linkResource, verdict,
            inputs: verdict === "impossible" ? [...new Set([...o.inputs, ...absentDomain])] : o.inputs });
        }
        const viable = result.options.filter(o => o.linkResource === linkResource && o.verdict !== "impossible");
        const first = viable[0];
        const unit = first && viable.every(o => o.unit === first.unit) ? first.unit : null;
        const capacity = first && unit !== null && viable.every(o => o.limit === first.limit && (o.limit === 0 || o.verdict !== "unknown")) ? first.limit : null;
        result.linkResources.push({ ...position, unit, capacity, absentDomain });
      }
    }
  });
}
