// 연결과 작업의 판정을 만들고 실제 사용한 배선·협상·경쟁 수요를 추론 단계에 연결한다.
import type { Scene, DomainPlugin, Direction } from "./contract.ts";
import { addReason, type Results, type Run } from "./results.ts";
import type { Flow, Share, Use } from "./allocate.ts";
import { bestOption, optionVerdict } from "./negotiate.ts";
import { portFacts, resourceFacts } from "./scene.ts";

function physicalReasons(scene: Scene, result: Results, outcome: number, connection: number, direction: Direction) {
  const parents: number[] = [];
  for (const s of result.physical.filter(p => p.connection === connection && p.direction === direction)) {
    const rule = s.kind === "mate" ? "커넥터 결합" : "부품의 변환 방향";
    const r = addReason(result, { outcome, stage: "physical", rule, targetKind: "connection", targetRow: connection }, s.inputs);
    for (const port of [s.entry, s.exit]) parents.push(addReason(result, { outcome, stage: "physical", rule, targetKind: "port", targetRow: port },
      [portFacts(scene, port).attachment], [r]));
    if (s.required && !result.needs.some(n => n.outcome === outcome && n.requiredCapability === s.required))
      result.needs.push({ outcome, requiredCapability: s.required });
  }
  return parents;
}
function linkReason(scene: Scene, result: Results, outcome: number, option: number) {
  const o = result.options[option]!;
  return addReason(result, { outcome, stage: "negotiate", rule: o.condition || o.rule, targetKind: "connection", targetRow: o.connection },
    o.inputs, physicalReasons(scene, result, outcome, o.connection, o.direction), o.domain, o.specs);
}
function noOptionReason(scene: Scene, result: Results, outcome: number, connection: number, direction: Direction, domain: string) {
  const link = result.linkResources.find(l => l.connection === connection && l.direction === direction && l.domain === domain);
  const declarations = link?.absentDomain ?? [];
  return addReason(result, { outcome, stage: "negotiate", rule: declarations.length ? "포트에 해당 영역 선언 없음" : "협상 근거 없음",
    targetKind: "connection", targetRow: connection }, [scene.connections[connection]!.evidence, ...declarations],
    physicalReasons(scene, result, outcome, connection, direction));
}

export function judgeConnections(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  scene.connections.forEach((_, connection) => {
    for (const direction of ["forward", "reverse"] as const) {
      const groups = new Map<string, number[]>();
      for (const link of result.linkResources) {
        if (link.connection === connection && link.direction === direction && !groups.has(link.domain)) groups.set(link.domain, []);
      }
      result.options.forEach((o, i) => {
        if (o.connection === connection && o.direction === direction) groups.get(o.domain)!.push(i);
      });
      if (!groups.size) groups.set("", []);
      for (const [domain, rows] of groups) {
        if (!rows.length) {
          const steps = result.physical.filter(s => s.connection === connection && s.direction === direction);
          const link = result.linkResources.find(l => l.connection === connection && l.direction === direction && l.domain === domain);
          const verdict = link?.absentDomain.length || steps.some(s => s.verdict === "impossible") ? "impossible" : "unknown";
          const outcome = result.outcomes.push({ subjectKind: "connection", subjectRow: connection, path: null, scenario: null, direction, domain, verdict, mode: "",
            label: verdict === "impossible" ? "연결 불가" : "협상할 영역 미확인" }) - 1;
          noOptionReason(scene, result, outcome, connection, direction, domain);
          continue;
        }
        const { row: option, option: o, verdict } = bestOption(result, rows);
        const outcome = result.outcomes.push({ subjectKind: "connection", subjectRow: connection, path: null, scenario: null, direction, domain, verdict, mode: o.mode,
          label: plugins.find(p => p.id === domain)!.explain(verdict, o.mode) }) - 1;
        if (o.unused !== undefined) result.metrics.push({ outcome, kind: "unused", unit: o.unit,
          value: o.unused, low: o.unused, high: o.unused, basis: "calculated" });
        linkReason(scene, result, outcome, option);
      }
    }
  });
}

function useReason(scene: Scene, result: Results, outcome: number, domain: string, use: Use, parents: number[]) {
  if (use.option !== undefined) {
    const link = result.options[use.option]!.linkResource;
    return addReason(result, { outcome, stage: "allocate", rule: use.rule, targetKind: "linkResource", targetRow: link },
      use.inputs, parents, domain, use.specs);
  }
  const r = resourceFacts(scene, use.resource);
  return addReason(result, { outcome, stage: "allocate", rule: use.rule, targetKind: "resource", targetRow: use.resource },
    [r.capacity, r.policy, ...use.inputs], parents, domain, use.specs);
}

export function judgeWork(scene: Scene, result: Results, plugin: DomainPlugin, scenario: number, flow: Flow,
  solo: Share, together: Share, competitors: readonly Flow[], refused: readonly { flow: Flow; solo: Share }[]) {
  const path = flow.path === null ? null : result.paths[flow.path]!;
  const demand = path ? result.demands[path.demand]! : null;
  const steps = result.steps.filter(s => s.path === flow.path);
  const mode = demand?.mode ?? "";
  const verdict = together.verdict;
  const outcome = result.outcomes.push({ subjectKind: "workload", subjectRow: flow.workload, path: flow.path, direction: null, scenario, domain: plugin.id,
    verdict, mode, label: plugin.explain(verdict, mode) }) - 1;
  const unit = demand?.unit ?? "";
  function metric(kind: Results["metrics"][number]["kind"], value: number | null, metricUnit = unit) {
    result.metrics.push({ outcome, kind, value, unit: metricUnit, basis: "calculated", low: value, high: value });
  }
  function allocation(run: Run, share: Share) {
    result.allocations.push({ scenario, workload: flow.workload, run, value: share.value, unit });
    for (const row of share.bindings) {
      const link = row >= scene.resources.length;
      result.bindings.push({ scenario, workload: flow.workload, run, resourceKind: link ? "link" : "scene", resource: link ? row - scene.resources.length : row });
    }
    metric(run, share.value);
    if (share.range) {
      const m = result.metrics[result.metrics.length - 1]!;
      Object.assign(m, { low: share.range.low, high: share.range.high, range: "conservative" });
    }
  }
  for (const possible of together.range?.possible ?? []) result.possibleVerdicts.push({ outcome, verdict: possible });
  allocation("solo", solo);
  allocation("together", together);
  const drop = solo.value === null || together.value === null ? null : solo.value - together.value;
  metric("drop", drop);
  metric("dropPercent", drop === null || !solo.value ? null : 100 * drop / solo.value, "%");
  for (const s of steps) if (s.option !== null) {
    const o = result.options[s.option]!;
    if (o.unused !== undefined) metric("unused", o.unused, o.unit);
  }
  function cutReasons(path: Results["paths"][number] | null) {
    const reasons = (path?.disconnected ?? []).map(row => {
      const c = scene.connections[row]!;
      return addReason(result, { outcome, stage: "path", rule: "끊긴 경로 양쪽의 포트 부착점", targetKind: "connection", targetRow: row },
        [c.evidence, portFacts(scene, c.from).attachment, portFacts(scene, c.to).attachment]);
    });
    for (const row of path?.disconnectedEdges ?? []) {
      const edge = scene.edges[row]!;
      const rule = "끊긴 경로의 내부 간선 " + scene.nodes[edge.from]!.id + " → " + scene.nodes[edge.to]!.id;
      reasons.push(addReason(result, { outcome, stage: "path", rule, targetKind: "edge", targetRow: row }, [edge.evidence]));
    }
    return reasons;
  }
  const parents: number[] = [];
  for (const [run, share] of [["단독", solo], ["동시", together]] as const) for (const limit of share.policies ?? []) {
    const facts = resourceFacts(scene, limit.resource);
    parents.push(addReason(result, { outcome, stage: "allocate", rule: run + " " + limit.rule, targetKind: "resource", targetRow: limit.resource },
      [facts.policy, facts.capacity, ...limit.inputs], [], scene.resources[limit.resource]!.domain, limit.specs));
  }
  for (const candidate of refused) {
    const path = result.paths[candidate.flow.path!]!, prior = result.demands[path.demand]!;
    const limits = cutReasons(path);
    for (const s of result.steps.filter(s => s.path === candidate.flow.path && s.kind === "connection")) {
      if (s.option === null) limits.push(noOptionReason(scene, result, outcome, s.row, s.direction, plugin.id));
      else {
        const verdict = optionVerdict(result.options[s.option]!, prior);
        if (verdict === "impossible" || verdict === "unknown") limits.push(linkReason(scene, result, outcome, s.option));
      }
    }
    for (const limit of candidate.solo.policies ?? []) if (candidate.solo.bindings.includes(limit.resource))
      limits.push(addReason(result, { outcome, stage: "allocate", rule: limit.rule, targetKind: "resource", targetRow: limit.resource },
        [resourceFacts(scene, limit.resource).policy, ...limit.inputs], [], scene.resources[limit.resource]!.domain, limit.specs));
    const pending = candidate.solo.verdict === "unknown";
    for (const u of candidate.flow.uses) if (pending || candidate.solo.bindings.includes(u.resource))
      limits.push(useReason(scene, result, outcome, plugin.id, u, []));
    parents.push(addReason(result, { outcome, stage: path.verdict === "impossible" ? "path" : "allocate",
      rule: prior.rule + (pending ? " 미확인" : " 거절"), targetKind: "demand", targetRow: path.demand }, prior.inputs, limits, plugin.id, prior.specs));
  }
  for (const f of competitors) {
    const path = f.path === null ? null : result.paths[f.path]!;
    const d = path ? result.demands[path.demand]! : null;
    const trace = cutReasons(path);
    for (const s of result.steps.filter(s => s.path === f.path)) {
      if (s.option !== null) trace.push(linkReason(scene, result, outcome, s.option));
      if (s.kind === "connection" && s.option === null) {
        trace.push(noOptionReason(scene, result, outcome, s.row, s.direction, scene.workloads[f.workload]!.domain));
      }
      if (s.kind === "edge") trace.push(addReason(result, { outcome, stage: "path", rule: "유향 내부 경로", targetKind: "edge", targetRow: s.row },
        [scene.edges[s.row]!.evidence]));
    }
    const requestInputs = d?.inputs ?? scene.claims.flatMap((c, i) => c.ownerKind === "workload" && c.owner === f.workload ? [i] : []);
    const request = addReason(result, { outcome, stage: "path", rule: d?.rule ?? "가능한 요청 모드 없음", targetKind: "workload", targetRow: f.workload }, requestInputs, trace, scene.workloads[f.workload]!.domain, d?.specs);
    if (result.paths.some(p => p.workload === f.workload && p.truncated))
      parents.push(addReason(result, { outcome, stage: "path", rule: "경로 후보 열거 상한", targetKind: "workload", targetRow: f.workload }, [], [request]));
    else parents.push(request);
    for (const u of f.uses)
      parents.push(useReason(scene, result, outcome, scene.workloads[f.workload]!.domain, u, [request]));
  }
  addReason(result, { outcome, stage: "judge", rule: "요청과 단독·동시 성능 비교", targetKind: "workload", targetRow: flow.workload }, [], parents);
  return outcome;
}
