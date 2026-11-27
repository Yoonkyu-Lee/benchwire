// 같은 모드가 이어지는 경로 후보를 모두 보존해 단독 배분과 미확인 배선 비교에 쓴다.
import type { Demand, DomainPlugin, Scene, Step, Verdict } from "./contract.ts";
import { bestOption, verdictOrder } from "./negotiate.ts";
import { portFacts } from "./scene.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";
import { routes, MAX_PATHS, type Arc } from "./route.ts";

interface PathArc extends Arc { steps: Step[]; verdict: Verdict; truncated: boolean }

function connectionArcs(scene: Scene, result: Results, domain: string, demand: Demand): PathArc[] {
  const arcs: PathArc[] = [];
  result.linkResources.forEach((link, resource) => {
    if (link.domain !== domain) return;
    const { connection, direction } = link, c = scene.connections[connection]!;
    const rows = result.options.flatMap((o, i) => o.linkResource === resource ? [i] : []);
    const physical = result.physical.filter(s => s.connection === connection && s.direction === direction);
    const best = rows.length ? bestOption(result, rows, demand) : {
      row: null, verdict: link.absentDomain.length || physical.some(s => s.verdict === "impossible") ? "impossible" as const : "unknown" as const,
    };
    const a = portFacts(scene, direction === "forward" ? c.from : c.to), b = portFacts(scene, direction === "forward" ? c.to : c.from);
    const candidates = (p: typeof a) => p.node === null ? scene.nodes.flatMap((n, i) => n.item === p.item ? [i] : []) : [p.node];
    let variants: number[][] = [[]], truncated = false;
    for (const part of physical.filter(s => s.kind === "part")) {
      if (!part.passages.length) continue;
      const next = variants.flatMap(prefix => part.passages.map(path => [...prefix, ...path]));
      truncated ||= part.truncated || next.length > MAX_PATHS;
      variants = next.slice(0, MAX_PATHS);
    }
    for (const edges of variants) {
      for (const from of candidates(a)) for (const to of candidates(b)) {
        const steps: Step[] = [{ kind: "connection", row: connection, from, to, direction, option: best.row },
          ...edges.map((row): Step => ({ kind: "edge", row, from: scene.edges[row]!.from, to: scene.edges[row]!.to, direction: "forward", option: null }))];
        arcs.push({ from, to, steps, truncated, key: JSON.stringify([c.id, direction, scene.nodes[from]!.id, scene.nodes[to]!.id, edges.map(e => scene.edges[e]!.id)]),
          verdict: best.verdict !== "impossible" && (a.node === null || b.node === null) ? "unknown" : best.verdict });
      }
    }
  });
  return arcs;
}

function through(arcs: PathArc[], stops: number[]) {
  const possible = arcs.filter(a => a.verdict !== "impossible");
  const sections = stops.slice(1).map((end, i) => routes(possible, stops[i]!, end));
  if (sections.some(s => !s.found.length)) {
    // 성립 후보가 없을 때만 거절 이유를 보여 줄 통로 하나를 되짚는다.
    const witness = sections.map((s, i) => s.found[0] ?? routes(arcs, stops[i]!, stops[i + 1]!, 1).found[0]);
    return { found: witness.every(s => s !== undefined) ? [witness.flat()] : [], truncated: false };
  }
  let found: PathArc[][] = [[]], truncated = sections.some(s => s.truncated);
  for (const section of sections) {
    const next: PathArc[][] = [];
    truncated ||= found.length * section.found.length > MAX_PATHS;
    for (const prefix of found) {
      for (const suffix of section.found) {
        next.push(prefix.concat(suffix));
        if (next.length === MAX_PATHS) break;
      }
      if (next.length === MAX_PATHS) break;
    }
    found = next;
  }
  return { found, truncated };
}

export function paths(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  const internal: PathArc[] = scene.edges.map((e, row) => ({ from: e.from, to: e.to,
    key: JSON.stringify(["edge", scene.items[e.item]!.id, e.id]), verdict: "ok", truncated: false,
    steps: [{ kind: "edge", row, from: e.from, to: e.to, option: null, direction: "forward" }] }));
  scene.workloads.forEach((w, workload) => {
    const plugin = plugins.find(p => p.id === w.domain)!;
    for (const raw of plugin.demand(scene, workload)) {
      const trace = checkedTrace(result, plugin.id, "demand", workload, raw);
      const requested = checkedQuantity(result, plugin.id, "demand", workload, "requested", trace.requested);
      const d = { ...trace, requested };
      const demand = result.demands.push({ ...d, workload }) - 1;
      const arcs = [...internal, ...connectionArcs(scene, result, w.domain, d)];
      const { found, truncated } = through(arcs, [w.from, ...d.via, w.to]);
      for (const selected of found.length ? found : [[]]) {
        const status = Math.max(0, ...selected.map(a => verdictOrder.indexOf(a.verdict)));
        let verdict = found.length ? verdictOrder[status]! : "impossible";
        if (verdict !== "impossible" && d.requested === null) verdict = "unknown";
        if (verdict === "ok" && d.preference > 0) verdict = "conditional";
        const key = JSON.stringify(selected.map(a => a.key));
        const path = result.paths.push({ workload, demand, verdict, key, truncated: verdict !== "impossible" && (truncated || selected.some(a => a.truncated)) }) - 1;
        selected.flatMap(a => a.steps).forEach((s, order) => result.steps.push({ ...s, path, order }));
      }
    }
  });
}
