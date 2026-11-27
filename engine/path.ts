// 같은 모드가 이어지는 경로 후보를 모두 보존해 단독 배분과 미확인 배선 비교에 쓴다.
import type { Demand, DomainPlugin, Scene, Step, Verdict } from "./contract.ts";
import { bestOption, optionVerdict, verdictOrder } from "./negotiate.ts";
import { attachmentCandidates, portFacts } from "./scene.ts";
import { checkedQuantity, checkedTrace, type Results } from "./results.ts";
import { routes, MAX_PATHS, type Arc } from "./route.ts";

interface PathArc extends Arc { steps: Step[]; verdict: Verdict; bestCase?: Verdict; truncated: boolean }

function connectionArcs(scene: Scene, result: Results, domain: string, demand: Demand): PathArc[] {
  const arcs: PathArc[] = [];
  const pending = attachmentCandidates(scene, demand.via);
  result.linkResources.forEach((link, resource) => {
    if (link.domain !== domain) return;
    const { connection, direction } = link, c = scene.connections[connection]!;
    const rows = result.options.flatMap((o, i) => o.linkResource === resource ? [i] : []);
    const physical = result.physical.filter(s => s.connection === connection && s.direction === direction);
    const best = rows.length ? bestOption(result, rows, demand) : {
      row: null, verdict: link.absentDomain.length || physical.some(s => s.verdict === "impossible") ? "impossible" as const : "unknown" as const,
    };
    const o = best.row === null ? undefined : result.options[best.row];
    const bestCase = o?.bounds && o.limit === null ? optionVerdict({ ...o, limit: o.bounds.high,
      verdict: o.verdict === "unknown" ? "ok" : o.verdict }, demand) : best.verdict;
    const start = direction === "forward" ? c.from : c.to, end = direction === "forward" ? c.to : c.from;
    const a = portFacts(scene, start), b = portFacts(scene, end);
    let variants: number[][] = [[]], truncated = false;
    for (const part of physical.filter(s => s.kind === "part")) {
      if (!part.passages.length) continue;
      const next = variants.flatMap(prefix => part.passages.map(path => [...prefix, ...path]));
      truncated ||= part.truncated || next.length > MAX_PATHS;
      variants = next.slice(0, MAX_PATHS);
    }
    for (const edges of variants) {
      for (const from of pending.get(start) ?? [a.node!]) for (const to of pending.get(end) ?? [b.node!]) {
        const steps: Step[] = [{ kind: "connection", row: connection, from, to, direction, option: best.row },
          ...edges.map((row): Step => ({ kind: "edge", row, from: scene.edges[row]!.from, to: scene.edges[row]!.to, direction: "forward", option: null }))];
        const attachmentUnknown = a.node === null || b.node === null;
        const key = JSON.stringify([c.id, direction, scene.nodes[from]!.id, scene.nodes[to]!.id, edges.map(e => scene.edges[e]!.id)]);
        arcs.push({ from, to, steps, truncated, key,
          bestCase: attachmentUnknown && bestCase !== "impossible" ? "unknown" : bestCase,
          verdict: attachmentUnknown && best.verdict !== "impossible" ? "unknown" : best.verdict });
      }
    }
  });
  return arcs;
}

function reachable(arcs: PathArc[], start: number, reverse: boolean) {
  const adjacent = new Map<number, number[]>();
  for (const a of arcs) {
    const from = reverse ? a.to : a.from, to = reverse ? a.from : a.to;
    const next = adjacent.get(from);
    if (next) next.push(to); else adjacent.set(from, [to]);
  }
  const seen = new Set([start]);
  for (const node of seen) for (const next of adjacent.get(node) ?? []) seen.add(next);
  return seen;
}

function through(scene: Scene, arcs: PathArc[], stops: number[]) {
  const possible = arcs.filter(a => a.verdict !== "impossible");
  const sections = stops.slice(1).map((end, i) => routes(possible, stops[i]!, end));
  if (sections.some(s => !s.found.length)) {
    // 성립 후보가 없을 때만 거절 이유를 보여 줄 통로 하나를 되짚는다.
    const witness = sections.map((s, i) => s.found[0] ?? routes(arcs, stops[i]!, stops[i + 1]!, 1).found[0]);
    if (witness.every(s => s !== undefined)) return { found: [witness.flat()], truncated: false };
    const disconnected = new Set<number>();
    for (const [i, route] of witness.entries()) {
      if (route) continue;
      // 단절 양쪽에서 실제로 닿는 노드에 접한 연결이 마지막으로 고려한 배선이다.
      const start = stops[i]!, end = stops[i + 1]!;
      const terminalItems = [scene.nodes[start]!.item, scene.nodes[end]!.item];
      scene.connections.forEach((c, row) => {
        if ([c.from, c.to].some(port => terminalItems.includes(scene.ports[port]!.item))) disconnected.add(row);
      });
      const forward = reachable(arcs, start, false), backward = reachable(arcs, end, true);
      for (const a of arcs) if (forward.has(a.from) || backward.has(a.to))
        for (const step of a.steps) if (step.kind === "connection") disconnected.add(step.row);
    }
    return { found: [], truncated: false, disconnected: [...disconnected] };
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

export interface RouteInputs { claims: Set<number>; resources: Set<number> }
export function paths(scene: Scene, plugins: readonly DomainPlugin[], result: Results, routeInputs: RouteInputs[] = []) {
  const internal: PathArc[] = scene.edges.map((e, row) => ({ from: e.from, to: e.to,
    key: JSON.stringify(["edge", scene.items[e.item]!.id, e.id]), verdict: "ok", truncated: false,
    steps: [{ kind: "edge", row, from: e.from, to: e.to, option: null, direction: "forward" }] }));
  scene.workloads.forEach((w, workload) => {
    const inputs: RouteInputs = { claims: new Set(), resources: new Set() };
    routeInputs[workload] = inputs;
    const plugin = plugins.find(p => p.id === w.domain)!;
    for (const raw of plugin.demand(scene, workload)) {
      const trace = checkedTrace(result, plugin.id, "demand", workload, raw);
      const requested = checkedQuantity(result, plugin.id, "demand", workload, "requested", trace.requested);
      const d = { ...trace, requested };
      const demand = result.demands.push({ ...d, workload }) - 1;
      const arcs = [...internal, ...connectionArcs(scene, result, w.domain, d)];
      const stops = [w.from, ...d.via, w.to];
      const { found, truncated, disconnected } = through(scene, arcs, stops);
      const relevant = new Set(found.filter(route => route.every(a => a.verdict !== "impossible")).flat());
      if (truncated) {
        // 열거에서 잘린 후보도 이 구간의 출발점에서 닿고 도착점까지 이어지는 호에만 의존한다.
        const viable = arcs.filter(a => a.verdict !== "impossible");
        for (const [i, end] of stops.slice(1).entries()) {
          const forward = reachable(viable, stops[i]!, false), backward = reachable(viable, end, true);
          for (const a of viable) if (forward.has(a.from) && backward.has(a.to)) relevant.add(a);
        }
      }
      for (const a of relevant) for (const step of a.steps) {
        if (step.kind === "edge") {
          if (truncated) for (const u of scene.resourceUses) if (u.edge === step.row) inputs.resources.add(u.resource);
          continue;
        }
        const c = scene.connections[step.row]!;
        for (const port of [c.from,c.to]) inputs.claims.add(portFacts(scene,port).attachment);
        if (step.option !== null) inputs.resources.add(scene.resources.length + result.options[step.option]!.linkResource);
        for (const part of scene.parts.filter(p => p.connection === step.row)) {
          for (const port of [part.entry,part.exit]) inputs.claims.add(portFacts(scene,port).attachment);
          for (const u of scene.resourceUses) if (scene.edges[u.edge]!.item === part.item) inputs.resources.add(u.resource);
        }
      }
      for (const selected of found.length ? found : [[]]) {
        const status = Math.max(0, ...selected.map(a => verdictOrder.indexOf(a.verdict)));
        let verdict = found.length ? verdictOrder[status]! : "impossible";
        if (verdict !== "impossible" && d.requested === null) verdict = "unknown";
        if (verdict === "ok" && d.preference > 0) verdict = "conditional";
        const key = JSON.stringify(selected.map(a => a.key));
        const highest = verdictOrder[Math.max(0, ...selected.map(a => verdictOrder.indexOf(a.bestCase ?? a.verdict)))]!;
        const bestCase = verdict === "unknown" && d.requested !== null ? (highest === "ok" && d.preference > 0 ? "conditional" : highest) : verdict;
        const path = result.paths.push({ workload, demand, verdict, key, bestCase,
          ...(disconnected?.length ? { disconnected } : {}),
          truncated: verdict !== "impossible" && (truncated || selected.some(a => a.truncated)) }) - 1;
        selected.flatMap(a => a.steps).forEach((s, order) => result.steps.push({ ...s, path, order }));
      }
    }
  });
}
