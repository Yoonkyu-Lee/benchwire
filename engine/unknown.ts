// 미확인 부착점과 연결 설정을 장면 전체에서 일관되게 고정하고 후보별 판정·범위·출처를 합친다.
import type { DomainPlugin, Scene } from "./contract.ts";
import type { RouteInputs } from "./path.ts";
import { attachmentCandidates, effectiveClaim, portFacts } from "./scene.ts";
import { availableOption } from "./pools.ts";
import { addReason, type Results } from "./results.ts";

// 연결된 장비의 후보 곱이 커지면 일부 표본 대신 물리 상한을 쓴다.
const MAX_WIRINGS = 64;
// 두 끝의 기본 핀(각 6종)과 대안 지원 여부(각 2종)의 144개 조합도 함께 검산한다.
const MAX_PROFILE_WORLDS = 256;
type SourceCandidate = NonNullable<Scene["claimSources"][number]["candidate"]>;
// 한 값을 여러 출처가 지지하면 세계의 대표 신뢰도는 가장 높은 것을 쓰고 인용은 모두 남긴다.
const confidenceOrder: readonly SourceCandidate["confidence"][] = ["user_verified", "official", "review", "community", "inferred", "unknown"];
type Metric = Results["metrics"][number];
type Variable = { claim: number; samples: { value: string | number | boolean; node?: number; reference?: number }[] };


// 시나리오 안에서 가능한 경로가 자원을 직접 또는 다른 작업을 통해 함께 쓰는지 본다.
export function competingWorks(start: number, members: readonly number[], routes: readonly RouteInputs[]) {
  const group = new Set([start]), seen = new Set<number>();
  for (const work of group) for (const resource of routes[work]!.resources) {
    if (seen.has(resource)) continue;
    seen.add(resource);
    for (const peer of members) if (routes[peer]!.resources.has(resource)) group.add(peer);
  }
  return group;
}
function inputs(result: Results, outcome: number) {
  return [...new Set(result.reasonInputs.filter(i => result.reasons[i.reason]!.outcome === outcome).map(i => i.claim))];
}

function ask(scene: Scene, plugins: readonly DomainPlugin[], result: Results, row: number, claim: number,
  impact: "verdict" | "range" = result.outcomes[row]!.verdict === "unknown" ? "verdict" : "range") {
  const prior = result.quests.find(q => q.outcome === row && q.claim === claim);
  if (prior) { if (impact === "verdict") prior.impact = impact; return; }
  const c = scene.claims[claim]!, o = result.outcomes[row]!;
  const plugin = plugins.find(p => p.id === (c.domain || o.domain));
  result.quests.push({ outcome: row, claim, impact, instruction: plugin?.quest(c.field) ?? (c.field + " 값을 확인하세요.") });
}

function conservative(result: Results, row: number, disputed: boolean) {
  const o = result.outcomes[row]!;
  if (o.subjectKind !== "workload") {
    for (const m of result.metrics.filter(m => m.outcome === row))
      Object.assign(m, {value:null,low:0,high:null,basis:"calculated",range:"conservative"});
    return;
  }
  const demands = result.demands.filter(d => d.workload === o.subjectRow);
  for (const m of result.metrics.filter(m => m.outcome === row)) {
    const matching = demands.filter(d => d.unit === m.unit);
    const upper = !disputed && matching.length && matching.every(d => d.requested !== null) ? Math.max(...matching.map(d => d.requested!)) : null;
    m.value = null; m.basis = "calculated"; m.range = "conservative";
    delete m.lowWorld; delete m.highWorld;
    if (m.kind === "solo" || m.kind === "together") { m.low = 0; m.high = upper; }
    else if (m.kind === "drop") { m.low = upper === null ? null : -upper; m.high = upper; }
    else { m.low = null; m.high = null; }
  }
}

// 값의 일부만 모르는 기존 결과에는 이미 계산된 값과 정책 가정을 보존한다.
function completeUnknowns(scene: Scene, plugins: readonly DomainPlugin[], result: Results) {
  result.outcomes.forEach((o, row) => {
    if (o.verdict !== "unknown") for (const q of result.quests.filter(q => q.outcome === row)) q.impact = "range";
    for (const input of result.rangeInputs) if (input.outcome === row) ask(scene,plugins,result,row,input.claim);
    if (o.verdict === "unknown") {
      for (const id of inputs(result, row)) if (scene.claims[id]!.value === null) ask(scene, plugins, result, row, id);
      if (!result.possibleVerdicts.some(v => v.outcome === row)) {
        const path = o.path === null ? null : result.paths[o.path]!;
        const possible = path?.conditioned ? ["conditional","impossible"] as const
          : path && !result.demands[path.demand]!.elastic ? ["ok","impossible"] as const : ["ok","conditional","impossible"] as const;
        for (const verdict of possible) result.possibleVerdicts.push({ outcome: row, verdict });
        const demand = o.path === null ? null : result.demands[result.paths[o.path]!.demand]!;
        for (const m of result.metrics.filter(m => m.outcome === row && m.value === null && !m.range)) {
          m.range = "conservative";
          if (m.kind === "together" || m.kind === "solo") {
            m.low = 0; m.high = demand?.unit === m.unit ? demand.requested : null;
          }
        }
      }
    } else if (!result.possibleVerdicts.some(v => v.outcome === row)) result.possibleVerdicts.push({ outcome: row, verdict: o.verdict });
  });
}

function range(metric: Metric, samples: (Metric | undefined)[], worlds: number[]) {
  const lows = samples.map(m => m?.low ?? null), highs = samples.map(m => m?.high ?? null);
  const low = lows.every(x => x !== null) ? Math.min(...lows) : null;
  const high = highs.every(x => x !== null) ? Math.max(...highs) : null;
  const exact = low !== null && high !== null && samples.every(m => m && m.range !== "conservative");
  metric.low = low; metric.high = high; metric.range = exact ? "witnessed" : "conservative";
  if (exact) { metric.lowWorld = worlds[lows.indexOf(low)]!; metric.highWorld = worlds[highs.indexOf(high)]!; }
  const estimate = samples[0]?.value ?? null;
  const common = estimate !== null && samples.every(m => m?.value === estimate);
  metric.value = common ? estimate : null;
  metric.basis = common && samples.some(m => m?.basis === "assumed") ? "assumed" : "calculated";
}

function linkKey(r: Results, row: number) {
  const link = r.linkResources[row]!, service = link.service;
  const owner = service?.poolResource === undefined ? undefined : r.linkResources[service.poolResource];
  return JSON.stringify([link.connection, link.domain, link.pool?.scope === "connection" ? null : link.direction,
    link.pool?.id, link.pool?.scope, service?.mode, service?.unit, owner?.domain, owner?.pool?.id]);
}

function snapshot(r: Results, row: number, base = r, links?: number[]) {
  const o = r.outcomes[row]!;
  const metrics = r.metrics.filter(m => m.outcome === row);
  const possible = r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort();
  const option = o.option === undefined ? null : availableOption(r,o.option);
  if (o.subjectKind === "connection" && o.unit && (option || o.verdict === "impossible") && !metrics.some(m => m.kind === "limit")) {
    const value = o.verdict === "impossible" ? 0 : option!.limit;
    const low = value ?? option?.bounds?.low ?? null, high = value ?? option?.bounds?.high ?? null;
    metrics.push({outcome:row, kind:"limit", unit:o.unit, value, low, high, basis:"calculated",
      ...(value === null ? {range:"conservative" as const} : {})});
  }
  const selected = option && JSON.stringify([option.mode, option.profile, option.verdict, option.limit,
    option.bounds, option.unit, option.condition, option.unused, option.pool]);
  const raw = o.option === undefined ? undefined : r.options[o.option];
  const concreteOption = raw && option ? { ...raw, ...option,
    linkResource:links?.[raw.linkResource] ?? raw.linkResource,
    ...(raw.serviceResource === undefined ? {} : {serviceResource:links?.[raw.serviceResource] ?? raw.serviceResource}),
    ...(raw.poolResource === undefined ? {} : {poolResource:links?.[raw.poolResource] ?? raw.poolResource}) } : undefined;
  return { o, selected, concreteOption, metrics, possible, inputs: inputs(r, row),
    measures: r.measures.filter(m => m.outcome === row), assessments: r.assessments.filter(a => a.outcome === row),
    specs: r.reasonSpecs.filter(s => r.reasons[s.reason]!.outcome === row).map(s => s.source),
    quests: r.quests.filter(q => q.outcome === row),
    bindings: r.bindings.filter(b => o.subjectKind === "workload" && b.scenario === o.scenario && b.workload === o.subjectRow).flatMap(b => {
      if (r === base || b.resourceKind === "scene") return [b];
      const key = linkKey(r, b.resource), resource = base.linkResources.findIndex((_,i) => linkKey(base, i) === key);
      return resource < 0 ? [] : [{ ...b, resource }];
    }),
    needs: r.needs.filter(n => n.outcome === row).map(n => n.requiredCapability) };
}

type Observation = ReturnType<typeof snapshot>;
type Outcome = Results["outcomes"][number];
function sameBudget(a: Outcome, b: Outcome) {
  return a.unit === b.unit && a.pool?.domain === b.pool?.domain && a.pool?.id === b.pool?.id;
}

function budgetObservation(result: Results, row: number, available: Observation[]): Observation {
  const base = result.outcomes[row]!;
  const match = available.find(s => sameBudget(s.o,base)) ?? available.find(s => s.o.unit === undefined);
  if (match) return match;
  const sample = available[0];
  // 같은 영역이 다른 예산만 선언한 세계에서는 이 예산으로 보낼 수 있는 양은 0이다.
  if (base.unit && sample) return { ...sample, selected:null, o:{...base, verdict:"impossible", mode:"", label:"연결 불가"},
    possible:["impossible"], metrics:[{outcome:row, kind:"limit", unit:base.unit, value:0, low:0, high:0, basis:"calculated"}],
    inputs:available.flatMap(s => s.inputs), specs:available.flatMap(s => s.specs), quests:[], needs:[] };
  return { ...snapshot(result,row), selected:null, o:{ ...base, verdict:"unknown", mode:"" },
    possible:[], metrics:[], measures:[], assessments:[], bindings:[], needs:[] };
}

function sameVerdicts(a: Observation, b: Observation) {
  return a.possible.length === b.possible.length && a.possible.every((v,i) => v === b.possible[i]) &&
    a.assessments.length === b.assessments.length && a.assessments.every(x => b.assessments.some(y => y.run === x.run && y.verdict === x.verdict));
}
function samePerformance(a: Observation, b: Observation) {
  return a.o.mode === b.o.mode && a.measures.length === b.measures.length && a.measures.every(x => b.measures.some(y =>
      y.run === x.run && y.kind === x.kind && y.unit === x.unit && y.low === x.low && y.high === x.high)) &&
    a.metrics.length === b.metrics.length && a.metrics.every((m, i) => {
      const n = b.metrics[i]!;
      return m.kind === n.kind && m.unit === n.unit && m.value === n.value && m.low === n.low && m.high === n.high && m.basis === n.basis;
    });
}

function merge(scene: Scene, plugins: readonly DomainPlugin[], r: Results, row: number, variables: Variable[],
  samples: ReturnType<typeof snapshot>[], worlds: number[], strides: number[]) {
  const o = r.outcomes[row]!, priorVerdict = o.verdict;
  if (o.subjectKind === "connection") {
    const first = samples[0]!;
    if (!first.selected || !samples.every(s => s.selected === first.selected)) delete o.option;
    else if (snapshot(r,row).selected !== first.selected) {
      const options = samples.map(s => s.concreteOption!);
      o.option = r.options.push({ ...options[0]!, effective:true,
        rule:options.every(v => v.rule === options[0]!.rule) ? options[0]!.rule : "모든 후보 세계에서 같은 협상 결과",
        inputs:[...new Set(options.flatMap(v => v.inputs))], specs:[...new Set(options.flatMap(v => v.specs))] }) - 1;
    }
  }
  const possible = new Set(samples.flatMap(s => s.possible));
  const first = samples[0]!;
  o.verdict = possible.size === 1 && samples.every(s => s.possible.length) ? [...possible][0]! : "unknown";
  if (!samples.every(s => s.o.mode === first.o.mode)) o.mode = "";
  else o.mode = first.o.mode;
  const plugin = plugins.find(p => p.id === o.domain);
  o.label = samples.every(s => s.o.label === first.o.label && s.o.verdict === o.verdict)
    ? first.o.label : plugin?.explain(o.verdict, o.mode) ?? first.o.label;
  r.possibleVerdicts = r.possibleVerdicts.filter(v => v.outcome !== row);
  for (const verdict of possible) r.possibleVerdicts.push({ outcome: row, verdict });
  r.quests = r.quests.filter(q => q.outcome !== row);
  for (const s of samples) for (const q of s.quests) ask(scene, plugins, r, row, q.claim, q.impact);

  // 나머지 주장을 고정한 채 이 주장 하나를 바꿔 결과가 달라지는지 비교한다.
  const changed = new Set<number>();
  variables.forEach((v,j) => {
    const stride = strides[j]!;
    let impact: "verdict" | "range" | undefined;
    for (const [i,s] of samples.entries()) {
      const position = Math.floor(i / stride) % v.samples.length;
      if (!position) continue;
      const other = samples[i - position * stride]!;
      if (!sameVerdicts(s,other)) {
        impact = "verdict"; break;
      }
      if (!samePerformance(s,other)) impact = "range";
    }
    if (impact) { changed.add(v.claim); ask(scene, plugins, r, row, v.claim, impact); }
  });
  // 값의 종류·단위도 선택한 모드에 따라 새로 생길 수 있다. 같은 단위의 여러 행은 나온 순서대로 맞춘다.
  const measures = new Map<string, Metric[]>();
  for (const sample of samples) {
    const groups = Map.groupBy(sample.metrics, m => JSON.stringify([m.kind,m.unit]));
    for (const [key,rows] of groups) if (rows.length > (measures.get(key)?.length ?? 0)) measures.set(key,rows);
  }
  r.metrics = r.metrics.filter(m => m.outcome !== row);
  for (const rows of measures.values()) rows.forEach((model,ordinal) => {
    if (model.kind === "limit" && o.option !== undefined) return;
    const m = { ...model, outcome:row };
    const values = samples.map(s => s.metrics.filter(x => x.kind === m.kind && x.unit === m.unit)[ordinal]);
    range(m, values, worlds);
    r.metrics.push(m);
  });
  r.assessments = r.assessments.filter(a => a.outcome !== row);
  r.measures = r.measures.filter(m => m.outcome !== row);
  for (const sample of samples) {
    for (const a of sample.assessments) if (!r.assessments.some(x => x.outcome === row && x.run === a.run && x.verdict === a.verdict))
      r.assessments.push({ ...a, outcome: row });
    for (const m of sample.measures) {
      const same = (x: typeof m) => x.run === m.run && x.kind === m.kind && x.unit === m.unit;
      if (r.measures.some(x => x.outcome === row && same(x))) continue;
      const values = samples.map(s => s.measures.find(same));
      const lows = values.map(x => x?.low ?? null), highs = values.map(x => x?.high ?? null);
      r.measures.push({ ...m, outcome: row, low: lows.every(x => x !== null) ? Math.min(...lows) : null,
        high: highs.every(x => x !== null) ? Math.max(...highs) : null });
    }
  }
  if (o.subjectKind === "workload") {
    const belongs = (b: { scenario: number; workload: number }) => b.scenario === o.scenario && b.workload === o.subjectRow;
    r.bindings = r.bindings.filter(b => !belongs(b));
    for (const b of first.bindings) if (samples.every(s => s.bindings.some(x => x.resourceKind === b.resourceKind && x.resource === b.resource && x.run === b.run)))
      r.bindings.push(b);
    for (const a of r.allocations.filter(belongs)) {
      const metric = r.metrics.find(m => m.outcome === row && m.kind === a.run)!;
      a.value = metric.basis === "assumed" ? null : metric.value;
    }
  }
  r.needs = r.needs.filter(n => n.outcome !== row);
  for (const requiredCapability of first.needs) if (samples.every(s => s.needs.includes(requiredCapability))) r.needs.push({ outcome: row, requiredCapability });
  if (!changed.size && priorVerdict !== "unknown" && priorVerdict === o.verdict) return;
  const evidence = [...new Set([...samples.flatMap(s => s.inputs), ...changed])];
  const parent = r.reasons.findLastIndex(reason => reason.outcome === row);
  const rule = variables.some(v => scene.claims[v.claim]!.conflictGroup !== undefined) ? "출처 충돌 후보별 판정과 범위"
    : variables.some(v => v.samples[0]?.node === undefined) ? "연결 설정 후보별 판정과 범위" : "일관된 배선 후보별 판정과 범위";
  const parents = parent < 0 ? [] : [parent];
  const limitRange = r.metrics.find(m => m.outcome === row && m.kind === "limit");
  if (limitRange && limitRange.low !== limitRange.high) {
    for (const [label,side] of [["하한","low"],["상한","high"]] as const) {
      const value = limitRange[side];
      if (value === null) continue;
      const sample = samples.find(s => s.metrics.some(m => m.kind === "limit" && m[side] === value))!;
      const bound = addReason(r, {outcome:row, stage:"negotiate", rule:`후보별 연결 한도 ${label} ${value} ${limitRange.unit}`,
        targetKind:o.subjectKind, targetRow:o.subjectRow}, sample.inputs);
      for (const source of new Set(sample.specs)) r.reasonSpecs.push({reason:bound,source});
      parents.push(bound);
    }
  }
  const proof = addReason(r, { outcome: row, stage: "judge", rule, targetKind: o.subjectKind, targetRow: o.subjectRow },
    evidence, parents);
  for (const source of new Set(samples.flatMap(s => s.specs))) r.reasonSpecs.push({ reason: proof, source });
}

export function resolveUnknowns(scene: Scene, plugins: readonly DomainPlugin[], result: Results,
  evaluateWiring: (s: Scene, p: readonly DomainPlugin[], profileChanged: boolean, resolveWiring: boolean) => Results,
  routeInputs: readonly RouteInputs[], readConflicts = true) {
  completeUnknowns(scene, plugins, result);
  const all: Variable[] = [];
  const profileLinks = new Map<number, Set<number>>();
  const conflicts = new Map<number, Map<SourceCandidate["value"], SourceCandidate>>();
  for (const { claim, candidate } of scene.claimSources) if (readConflicts && candidate) {
    const values = conflicts.get(claim) ?? new Map<SourceCandidate["value"], SourceCandidate>();
    const previous = values.get(candidate.value);
    if (!previous || confidenceOrder.indexOf(candidate.confidence) < confidenceOrder.indexOf(previous.confidence))
      values.set(candidate.value, candidate);
    conflicts.set(claim, values);
  }
  scene.claims.forEach((c,claim) => {
    if (c.value !== null || effectiveClaim(scene, c.ownerKind, c.owner, c.domain, c.field, c.condition) !== claim) return;
    const owners = c.domain ? plugins.filter(p => p.id === c.domain) : plugins;
    const values = new Set(conflicts.get(claim)?.keys() ?? owners.flatMap(p => p.profileValues?.(c) ?? []));
    if (!values.size) return;
    const samples: Variable["samples"] = [];
    for (const value of values) {
      if (c.ownerKind === "port" && c.reference !== undefined) {
        const reference = c.field === "connector" ? scene.connectors.findIndex(row => row.id === value)
          : scene.nodes.findIndex(n => n.item === scene.ports[c.owner]!.item && n.id === value);
        if (reference < 0) return;
        samples.push({value,reference});
      } else samples.push({value});
    }
    all.push({claim,samples});
    const links = new Set(result.options.filter(o => o.inputs.includes(claim)).map(o => o.connection));
    const port = c.ownerKind === "interface" ? scene.interfaces[c.owner]!.port : c.ownerKind === "port" ? c.owner : undefined;
    // 끝점 설정은 다른 영역의 서비스도 바꾼다. 중간 부품에서는 실제로 읽은 주장만 조합한다.
    scene.connections.forEach(({from,to},connection) => {
      if (port === from || port === to || c.ownerKind === "item" &&
          (scene.ports[from]!.item === c.owner || scene.ports[to]!.item === c.owner)) links.add(connection);
    });
    profileLinks.set(claim,links);
  });
  for (const [port,nodes] of attachmentCandidates(scene,result.demands.flatMap(d => d.via))) {
    const claim = portFacts(scene,port).attachment;
    if (!profileLinks.has(claim)) all.push({claim,samples:nodes.map(node => ({node,value:scene.nodes[node]!.id}))});
  }
  if (!all.length) return;
  const groups: { variables: Variable[]; subjects: number[][] }[] = [];
  const subjects = Map.groupBy(result.outcomes.keys(), row => {
    const o = result.outcomes[row]!;
    return JSON.stringify([o.subjectKind, o.subjectRow, o.scenario, o.direction, o.domain]);
  });
  // 충돌은 기본 경로에 없던 경로와 예산도 만들 수 있다. 시나리오의 작업은 모두 같은 세계에서 비교한다.
  for (const rows of subjects.values()) {
    const o = result.outcomes[rows[0]!]!;
    const members = scene.members.filter(m => m.scenario === o.scenario);
    const eligible = all.filter(v => {
      const c = scene.claims[v.claim]!;
      return c.ownerKind !== "workload" || members.some(m => m.workload === c.owner && (c.domain || m.evidence === v.claim));
    });
    let variables = eligible.filter(v => conflicts.has(v.claim));
    if (!variables.length) {
      // 일반 미확인 배선은 해당 시나리오가 지나가는 포트의 후보만 필요하다.
      const claims = new Set(rows.flatMap(row => inputs(result,row)));
      const links = new Set<number>();
      if (o.subjectKind === "connection") links.add(o.subjectRow);
      for (const m of members) {
        for (const id of routeInputs[m.workload]!.claims) claims.add(id);
        for (const resource of routeInputs[m.workload]!.resources) {
          const link = result.linkResources[resource - scene.resources.length];
          if (link) links.add(link.connection);
        }
        const row = result.outcomes.findIndex(v => v.subjectKind === "workload" && v.scenario === o.scenario && v.subjectRow === m.workload);
        if (row >= 0) for (const id of inputs(result,row)) claims.add(id);
      }
      for (const link of links) {
        for (const part of scene.parts.filter(p => p.connection === link))
          for (const port of [part.entry,part.exit]) claims.add(portFacts(scene,port).attachment);
        for (const option of result.options.filter(v => v.connection === link)) for (const id of option.inputs) claims.add(id);
      }
      for (const [claim,connections] of profileLinks) if ([...links].some(link => connections.has(link))) claims.add(claim);
      variables = eligible.filter(v => claims.has(v.claim));
    }
    if (!variables.length) continue;
    const group = groups.find(g => g.variables.length === variables.length && g.variables.every((v,i) => v === variables[i]));
    if (group) group.subjects.push(rows); else groups.push({ variables, subjects: [rows] });
  }
  // 각 배선에서 이미 합산한 사용량끼리 비교한다. 서로 배타적인 작업별 상한을 더할 수 없다.
  const provisional = result.resourceUsage.map(u => ({ ...u }));
  const usageKey = (r: Results, u: Results["resourceUsage"][number]) => JSON.stringify([u.scenario,u.unit,
    u.resourceKind === "scene" ? u.resource : linkKey(r,u.resource)]);
  const keys = provisional.map(u => usageKey(result,u));
  const knownUsage = new Map(keys.map((key,i) => [key,i]));
  const knownLinks = new Map(result.linkResources.map((_,i) => [linkKey(result,i),i]));
  const updated = new Set<number>();
  let world = 0;
  for (const { variables, subjects } of groups) {
    const affected = subjects.flat();
    const axes = new Map<number, number>();
    let count = 1;
    const strides = variables.map(v => {
      const group = scene.claims[v.claim]!.conflictGroup ?? v.claim;
      if (!axes.has(group)) { axes.set(group, count); count *= v.samples.length; }
      return axes.get(group)!;
    });
    const scenarios = new Set(affected.map(i => result.outcomes[i]!.scenario));
    const scope = provisional.flatMap((u,i) => scenarios.has(u.scenario) ? [i] : []);
    const profileChanged = variables.some(v => profileLinks.has(v.claim));
    const disputed = variables.some(v => conflicts.has(v.claim));
    if (!count || count > (profileChanged ? MAX_PROFILE_WORLDS : MAX_WIRINGS)) {
      if (profileChanged) {
        result.choices = result.choices.filter(c => !scenarios.has(c.scenario));
        result.reservations = result.reservations.filter(c => !scenarios.has(c.scenario));
      }
      for (const i of scope) {
        const u = result.resourceUsage[i]!;
        const dependent = affected.some(row => {
          const o = result.outcomes[row]!;
          if (o.subjectKind === "workload") return o.scenario === u.scenario;
          return u.resourceKind === "link" && result.linkResources[u.resource]!.connection === o.subjectRow;
        });
        if (!dependent) continue;
        u.used = null; u.basis = "calculated";
        if (disputed || u.resourceKind === "link" && affected.some(row => {
          const o = result.outcomes[row]!, link = result.linkResources[u.resource]!;
          return o.subjectKind === "connection" && o.subjectRow === link.connection && o.domain === link.domain;
        })) u.capacity = null;
        updated.add(i);
      }
      for (const row of affected) {
        const o = result.outcomes[row]!;
        o.verdict = "unknown";
        delete o.option;
        delete o.soloPath;
        o.path = null;
        o.mode = "";
        result.needs = result.needs.filter(n => n.outcome !== row);
        o.label = plugins.find(p => p.id === o.domain)?.explain("unknown", o.mode) ?? "배선 미확인";
        conservative(result, row, disputed);
        for (const m of result.measures.filter(m => m.outcome === row)) m.low = m.high = null;
        const runs = new Set(result.assessments.filter(a => a.outcome === row).map(a => a.run));
        result.assessments = result.assessments.filter(a => a.outcome !== row);
        if (!disputed) for (const run of runs) for (const verdict of ["ok","conditional","impossible"] as const)
          result.assessments.push({ outcome: row, run, verdict });
        if (o.subjectKind === "workload") {
          for (const a of result.allocations) if (a.workload === o.subjectRow && a.scenario === o.scenario) a.value = null;
          result.bindings = result.bindings.filter(b => b.workload !== o.subjectRow || b.scenario !== o.scenario);
        }
        result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== row);
        if (!disputed) for (const verdict of ["ok", "conditional", "impossible"] as const) result.possibleVerdicts.push({ outcome: row, verdict });
        const claims = variables.map(v => v.claim);
        addReason(result, { outcome: row, stage: "judge", rule: disputed ? "출처 후보 조합 상한" : count ? "배선 조합 상한" : "부착점 후보 없음", targetKind: o.subjectKind, targetRow: o.subjectRow }, claims);
        for (const id of claims) ask(scene, plugins, result, row, id);
      }
      continue;
    }
    const assignments = all.filter(v => axes.has(scene.claims[v.claim]!.conflictGroup ?? v.claim));
    const observations = subjects.map((): Observation[][] => []), worlds: number[] = [];
    const totals = new Map<number, Pick<Results["resourceUsage"][number], "used" | "capacity" | "basis">>();
    const added = new Set<number>();
    let choices: Results["choices"] = [], reservations: Results["reservations"] = [];
    for (let i = 0; i < count; i++, world++) {
      const claims = [...scene.claims];
      for (const v of assignments) {
        const stride = axes.get(claims[v.claim]!.conflictGroup ?? v.claim)!;
        const {value,node,reference = node} = v.samples[Math.floor(i / stride) % v.samples.length]!;
        const candidate = conflicts.get(v.claim)?.get(value);
        claims[v.claim] = { ...claims[v.claim]!, ...candidate, value, ...(reference === undefined ? {} : {reference}) };
        if (node === undefined) result.profileWorlds.push({world,claim:v.claim,value});
        else result.wirings.push({world,claim:v.claim,node});
      }
      const members = disputed ? scene.members.map(m => {
        if (m.evidence === undefined || !conflicts.has(m.evidence)) return m;
        const priority = claims[m.evidence]!.value;
        return typeof priority === "number" ? { ...m, priority } : m;
      }) : scene.members;
      const claimSources = disputed ? scene.claimSources.filter(s => !s.candidate || claims[s.claim]!.value === null ||
        claims[s.claim]!.value === s.candidate.value) : scene.claimSources;
      const concrete = { ...scene, claims, members, claimSources }, answer = evaluateWiring(concrete, plugins, profileChanged, disputed);
      if (!disputed) completeUnknowns(concrete, plugins, answer);
      const sameChoice = (c: Results["choices"][number]) => answer.choices.some(other =>
        other.scenario === c.scenario && other.connection === c.connection && other.profile === c.profile);
      if (i === 0) {
        choices = answer.choices.filter(c => scenarios.has(c.scenario));
        reservations = answer.reservations.filter(c => scenarios.has(c.scenario));
      } else {
        choices = choices.filter(sameChoice);
        reservations = reservations.filter(v => answer.reservations.some(a => a.scenario === v.scenario && a.workload === v.workload));
      }
      if (profileChanged && !disputed) result.choices = result.choices.filter(c => !scenarios.has(c.scenario) || sameChoice(c));
      // 새 예산과 그 예산을 참조하는 서비스는 세계의 행 번호를 결과 표의 행 번호로 옮긴다.
      const links: number[] = [];
      for (const [n,link] of answer.linkResources.entries()) {
        const key = linkKey(answer,n);
        let target = knownLinks.get(key);
        if (target === undefined) {
          const mapped = { ...link };
          if (link.pool) { mapped.pool = { ...link.pool, limit:null }; delete mapped.pool.bounds; }
          if (link.service?.poolResource !== undefined) mapped.service = { ...link.service, poolResource:links[link.service.poolResource]! };
          target = result.linkResources.push(mapped) - 1;
          knownLinks.set(key,target);
        }
        links.push(target);
      }
      const usage = new Map(answer.resourceUsage.filter(u => scenarios.has(u.scenario)).map(u => [usageKey(answer,u),u]));
      for (const [key,u] of usage) if (!knownUsage.has(key)) {
        const row = result.resourceUsage.length;
        const copy = { ...u, resource:u.resourceKind === "link" ? links[u.resource]! : u.resource,
          used:null, capacity:null, reasonRows:[] };
        result.resourceUsage.push(copy);
        provisional.push({ ...copy });
        keys.push(key);
        knownUsage.set(key,row);
        scope.push(row);
        added.add(row);
        if (i > 0) totals.set(row,{used:0,capacity:0,basis:"calculated"});
      }
      for (const row of scope) {
        const concreteUsage = usage.get(keys[row]!);
        const used = concreteUsage ? concreteUsage.used : 0, capacity = concreteUsage ? concreteUsage.capacity : 0;
        const prior = totals.get(row);
        if (!prior) totals.set(row,{used, capacity, basis:concreteUsage?.basis ?? "calculated"});
        else {
          if (prior.used !== used) prior.used = null;
          if (prior.capacity !== capacity) prior.capacity = null;
          if (concreteUsage?.basis === "assumed") prior.basis = "assumed";
        }
      }
      subjects.forEach((rows,j) => {
        const base = result.outcomes[rows[0]!]!;
        const matches = answer.outcomes.flatMap((o,n) => o.subjectKind === base.subjectKind && o.subjectRow === base.subjectRow &&
          (o.scenario === base.scenario || o.subjectKind === "connection" && o.scenario === null) &&
          o.direction === base.direction && o.domain === base.domain ? [snapshot(answer,n,result,links)] : []);
        observations[j]!.push(matches);
      });
      worlds.push(world);
    }
    if (disputed) {
      result.choices = result.choices.filter(c => !scenarios.has(c.scenario)).concat(choices);
      result.reservations = result.reservations.filter(c => !scenarios.has(c.scenario)).concat(reservations);
    }
    subjects.forEach((rows,j) => {
      const samples = observations[j]!, base = result.outcomes[rows[0]!]!;
      // 기본 장면에서 보이지 않던 서비스도 세계별 예산의 합집합에 남긴다.
      if (base.subjectKind === "connection") for (const world of samples) for (const {o} of world) {
        if (!o.unit || rows.some(n => sameBudget(result.outcomes[n]!,o))) continue;
        const outcome: Outcome = { ...o, scenario:base.scenario, verdict:"unknown" };
        delete outcome.option;
        rows.push(result.outcomes.push(outcome) - 1);
      }
      for (const row of rows) merge(scene, plugins, result, row, variables,
        samples.map(world => budgetObservation(result,row,world)), worlds, strides);
    });
    for (const [i, total] of totals) {
      const base = provisional[i]!, u = result.resourceUsage[i]!;
      if (!added.has(i) && total.used === base.used && total.capacity === base.capacity && total.basis === base.basis) continue;
      u.used = updated.has(i) && u.used !== total.used ? null : total.used;
      u.capacity = updated.has(i) && u.capacity !== total.capacity ? null : total.capacity;
      u.basis = u.used !== null && (u.basis === "assumed" || total.basis === "assumed") ? "assumed" : "calculated";
      updated.add(i);
      const outcome = affected.find(row => result.outcomes[row]!.scenario === u.scenario) ?? affected[0]!;
      const reason = addReason(result,{outcome, stage:"allocate", rule:profileChanged ? "연결 설정 후보별 자원 점유량" : "배선 후보별 자원 점유량",
        targetKind:u.resourceKind === "scene" ? "resource" : "linkResource", targetRow:u.resource},
        variables.map(v => v.claim),u.reasonRows);
      u.reasonRows = [reason];
    }
  }
}
