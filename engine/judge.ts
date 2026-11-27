// 연결과 작업의 판정을 만들고 실제 사용한 배선·협상·경쟁 수요를 추론 단계에 연결한다.
import type { Scene, DomainPlugin, Direction, Choice } from "./contract.ts";
import { addReason, type Results, type Run } from "./results.ts";
import type { Flow, Share, Use } from "./allocate.ts";
import { bestOption } from "./negotiate.ts";
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
  const parents = physicalReasons(scene, result, outcome, o.connection, o.direction);
  for (const l of result.standingLoads) {
    if (l.kind !== "link" || l.resource !== (o.serviceResource ?? o.linkResource) && l.resource !== o.poolResource) continue;
    const reason = addReason(result,{ outcome, stage: "allocate", rule: l.rule, targetKind: "linkResource", targetRow: l.resource },
      l.inputs, parents, l.domain, l.specs);
    parents.push(reason);
    for (const source of result.standingLoads) {
      if (source.kind !== "scene" || source.item !== l.item || source.id !== l.id || source.domain !== l.domain) continue;
      parents.push(addReason(result,{outcome, stage:"allocate", rule:source.rule, targetKind:"resource", targetRow:source.resource},
        [resourceFacts(scene,source.resource).capacity,...source.inputs], [reason], source.domain, source.specs));
    }
  }
  if (o.poolResource !== undefined) {
    const { domain, pool } = result.linkResources[o.poolResource]!;
    parents.push(addReason(result, { outcome, stage: "negotiate", rule: pool!.rule, targetKind: "linkResource", targetRow: o.poolResource },
      pool!.inputs, [], domain, pool!.specs));
  }
  return addReason(result, { outcome, stage: "negotiate", rule: o.condition || o.rule, targetKind: "connection", targetRow: o.connection },
    o.inputs, parents, o.domain, o.specs);
}
function noOptionReason(scene: Scene, result: Results, outcome: number, connection: number, direction: Direction, domain: string) {
  const link = result.linkResources.find(l => l.connection === connection && l.direction === direction && l.domain === domain);
  const declarations = link?.absentDomain ?? [];
  return addReason(result, { outcome, stage: "negotiate", rule: declarations.length ? "포트에 해당 영역 선언 없음" : "협상 근거 없음",
    targetKind: "connection", targetRow: connection }, [scene.connections[connection]!.evidence, ...declarations],
    physicalReasons(scene, result, outcome, connection, direction));
}

export function judgeConnections(scene: Scene, plugins: readonly DomainPlugin[], result: Results, include: (row: number) => boolean,
  choices: readonly Choice[] = [], scenario: number | null = null) {
  scene.connections.forEach((_, connection) => {
    if (!include(connection)) return;
    const profile = choices.find(c => c.connection === connection)?.profile;
    for (const direction of ["forward", "reverse"] as const) {
      // 같은 영역에서도 독립인 단위와 물리 예산마다 연결 판정을 하나씩 낸다.
      const groups: { domain: string; rows: number[] }[] = [];
      result.linkResources.forEach((link, resource) => {
        if (link.service || link.pool || link.connection !== connection || link.direction !== direction) return;
        const budgets = new Map<string, number[]>();
        result.options.forEach((o, i) => {
          if (o.linkResource !== resource) return;
          const key = JSON.stringify([o.unit, o.pool?.domain, o.pool?.id]);
          const rows = budgets.get(key) ?? [];
          rows.push(i);
          budgets.set(key, rows);
        });
        if (!budgets.size) groups.push({ domain: link.domain, rows: [] });
        for (const key of [...budgets.keys()].sort()) groups.push({ domain: link.domain, rows: budgets.get(key)! });
      });
      if (!groups.length) groups.push({ domain: "", rows: [] });
      for (const { domain, rows } of groups) {
        const eligible = rows.filter(i => !profile || !result.options[i]!.profile || result.options[i]!.profile === profile);
        if (!profile && rows.some(i => result.options[i]!.profile && result.options[i]!.verdict !== "impossible")) {
          const first = result.options[rows[0]!]!;
          const outcome = result.outcomes.push({ subjectKind:"connection", subjectRow:connection, scenario, direction, domain,
            path:null, verdict:"unknown", mode:"", unit:first.unit, label:"연결 설정 미정",
            ...(first.pool ? {pool:{domain:first.pool.domain,id:first.pool.id}} : {}) }) - 1;
          const parents = rows.map(i => linkReason(scene,result,outcome,i));
          addReason(result,{outcome,stage:"negotiate",rule:"활성 요청에서 연결 설정을 정하지 않음",targetKind:"connection",targetRow:connection},[],parents);
          continue;
        }
        if (!eligible.length) {
          const steps = result.physical.filter(s => s.connection === connection && s.direction === direction);
          const link = result.linkResources.find(l => l.connection === connection && l.direction === direction && l.domain === domain);
          const verdict = rows.length || link?.absentDomain.length || steps.some(s => s.verdict === "impossible") ? "impossible" : "unknown";
          const outcome = result.outcomes.push({ subjectKind: "connection", subjectRow: connection, path: null, scenario, direction, domain, verdict, mode: "",
            ...(rows.length ? { unit: result.options[rows[0]!]!.unit } : {}),
            label: verdict === "impossible" ? "연결 불가" : "협상할 영역 미확인" }) - 1;
          if (rows.length && profile) {
            const parents = rows.map(r => linkReason(scene,result,outcome,r));
            const c = choices.find(c => c.connection === connection)!;
            addReason(result,{outcome,stage:"negotiate",rule:"선택한 설정에서 서비스 미지원: " + profile,profile,targetKind:"connection",targetRow:connection},
              c.inputs,parents,c.domain,c.specs);
          } else noOptionReason(scene, result, outcome, connection, direction, domain);
          continue;
        }
        const { row: option, option: o, verdict } = bestOption(result, eligible);
        const outcome = result.outcomes.push({ subjectKind: "connection", subjectRow: connection, path: null, scenario, direction, domain, verdict, mode: o.mode, unit: o.unit, option,
          ...(o.pool ? { pool: { domain: o.pool.domain, id: o.pool.id } } : {}),
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
    const link = use.resource - scene.resources.length;
    return addReason(result, { outcome, stage: "allocate", rule: use.rule, targetKind: "linkResource", targetRow: link },
      use.inputs, parents, result.linkResources[link]!.domain, use.specs);
  }
  const r = resourceFacts(scene, use.resource);
  const loads = result.standingLoads.filter(l => l.kind === "scene" && l.resource === use.resource);
  parents = [...parents, ...loads.map(l => addReason(result,{ outcome, stage: "allocate", rule: l.rule, targetKind: "resource", targetRow: use.resource },
    l.inputs, parents, l.domain, l.specs))];
  return addReason(result, { outcome, stage: "allocate", rule: use.rule, targetKind: "resource", targetRow: use.resource },
    [r.capacity, r.policy, ...use.inputs], parents, domain, use.specs);
}

export function judgeWork(scene: Scene, result: Results, plugin: DomainPlugin, scenario: number, flow: Flow,
  solo: Share, together: Share, competitors: readonly Flow[], refused: readonly { flow: Flow; solo: Share }[], soloPath: number | null) {
  const path = flow.path === null ? null : result.paths[flow.path]!;
  const demand = path ? result.demands[path.demand]! : null;
  const steps = result.steps.filter(s => s.path === flow.path);
  const mode = demand?.mode ?? "";
  const verdict = together.verdict;
  const outcome = result.outcomes.push({ subjectKind: "workload", subjectRow: flow.workload, path: flow.path, direction: null, scenario, domain: plugin.id,
    ...(soloPath !== null && soloPath !== flow.path ? { soloPath } : {}), verdict, mode, label: plugin.explain(verdict, mode) }) - 1;
  const unit = demand?.unit ?? "";
  const soloUnit = soloPath === null ? unit : result.demands[result.paths[soloPath]!.demand]!.unit;
  function metric(kind: Results["metrics"][number]["kind"], value: number | null, metricUnit = unit) {
    result.metrics.push({ outcome, kind, value, unit: metricUnit, basis: "calculated", low: value, high: value });
  }
  function allocation(run: Run, share: Share) {
    result.allocations.push({ scenario, workload: flow.workload, run, value: share.value, unit: run === "solo" ? soloUnit : unit });
    for (const row of share.bindings) {
      const link = row >= scene.resources.length;
      result.bindings.push({ scenario, workload: flow.workload, run, resourceKind: link ? "link" : "scene", resource: link ? row - scene.resources.length : row });
    }
    metric(run, share.value, run === "solo" ? soloUnit : unit);
    if (share.range) {
      const m = result.metrics[result.metrics.length - 1]!;
      if (share.range.low !== share.range.high) for (const claim of share.range.inputs ?? [])
        if (scene.claims[claim]?.value === null && !result.rangeInputs.some(x => x.outcome === outcome && x.claim === claim))
          result.rangeInputs.push({ outcome, claim });
      Object.assign(m, { low: share.range.low, high: share.range.high, range: "conservative" });
    }
  }
  for (const possible of together.range?.possible ?? []) result.possibleVerdicts.push({ outcome, verdict: possible });
  allocation("solo", solo);
  allocation("together", together);
  const drop = soloUnit !== unit || solo.value === null || together.value === null ? null : solo.value - together.value;
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
  function connectionProof(step: Results["steps"][number], workDomain: string) {
    if (step.option === null) return [noOptionReason(scene, result, outcome, step.row, step.direction, step.carrier?.domain ?? workDomain)];
    const option = result.options[step.option]!, demand = result.paths[step.path]!.demand;
    const reasons: number[] = [];
    for (const match of result.matches) {
      if (match.demand !== demand) continue;
      const other = result.options[match.option]!;
      if (other.linkResource !== option.linkResource || other.mode !== option.mode || other.unit !== option.unit) continue;
      if (match.option !== step.option && match.verdict !== "impossible") continue;
      const prior = linkReason(scene, result, outcome, match.option);
      reasons.push(addReason(result, { outcome, stage: "path", rule: match.rule, targetKind: "connection", targetRow: step.row },
        match.inputs, [prior], workDomain, match.specs));
    }
    if (!result.matches.some(m => m.demand === demand && m.option === step.option))
      reasons.push(linkReason(scene, result, outcome, step.option));
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
      limits.push(...connectionProof(s, plugin.id));
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
      if (s.kind === "connection") trace.push(...connectionProof(s, scene.workloads[f.workload]!.domain));
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
