// 미확인 부착점과 연결 설정을 장면 전체에서 일관되게 고정하고 후보별 판정·범위·출처를 합친다.
import type { DomainPlugin, Scene } from "./contract.ts";
import type { RouteInputs } from "./path.ts";
import { claimRows, readClaim, attachmentCandidates, effectiveClaim, evaluationScene, MAX_GRID_WORLDS, portFacts } from "./scene.ts";
import { availableOption } from "./pools.ts";
import { goalReasons, judgeGoals } from "./goals.ts";
import { addReason, type Results } from "./results.ts";
import { MAX_COMBINATIONS } from "./selection.ts";
import { physicalSteps } from "./physical.ts";

// 연결된 장비의 후보 곱이 커지면 일부 표본 대신 물리 상한을 쓴다.
const MAX_WIRINGS = 64;
// 두 끝의 기본 핀(각 6종)과 대안 지원 여부(각 2종)의 144개 조합도 함께 검산한다.
const MAX_PROFILE_WORLDS = 256;
type SourceCandidate = NonNullable<Scene["claimSources"][number]["candidate"]>;
// 한 값을 여러 출처가 지지하면 세계의 대표 신뢰도는 가장 높은 것을 쓰고 인용은 모두 남긴다.
const confidenceOrder: readonly SourceCandidate["confidence"][] = ["user_verified", "official", "review", "community", "inferred", "unknown"];
type Metric = Results["metrics"][number];
type Variable = { claim: number; kind: "profile" | "wiring" | "schema" | "grid"; samples: { value: string | number | boolean; attachmentNode?: number; connectorRow?: number }[] };

function worldReads(scene:Scene,result:Results,variables:readonly Variable[]) {
  return new Set(variables.filter(({claim,kind,samples})=>{
    const use=result.readClaims?.[claim];
    return use==="selection" || use==="range" &&
      !(kind==="schema" && !samples.length && readClaim(scene,claim).openDomain);
  }).map(v=>v.claim));
}

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
  const c = readClaim(scene,claim), o = result.outcomes[row]!;
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
      for (const id of inputs(result, row)) if (readClaim(scene,id).value === null) ask(scene, plugins, result, row, id);
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
  const path=o.path===null ? null : r.paths[o.path]!.key;
  return { o, path, selected, concreteOption, metrics, possible, inputs: inputs(r, row),
    measures: r.measures.filter(m => m.outcome === row), assessments: r.assessments.filter(a => a.outcome === row),
    specs: r.reasonSpecs.filter(s => r.reasons[s.reason]!.outcome === row).map(s => s.source),
    quests: r.quests.filter(q => q.outcome === row),
    bindings: r.bindings.filter(b => o.subjectKind === "workload" && b.scenario === o.scenario && b.workload === o.subjectRow).flatMap(b => {
      if (r === base || b.resourceKind === "scene") return [b];
      const key = linkKey(r, b.resource), resource = base.linkResources.findIndex((_,i) => linkKey(base, i) === key);
      return resource < 0 ? [] : [{ ...b, resource }];
    }),
    needs: r.needs.filter(n => n.outcome === row).map(n => n.requiredCapability),
    conditionalNeeds:r.needs.filter(n=>n.outcome===row && n.conditional).map(n=>n.requiredCapability) };
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
  return a.path===b.path && a.o.mode === b.o.mode && a.measures.length === b.measures.length && a.measures.every(x => b.measures.some(y =>
      y.run === x.run && y.kind === x.kind && y.unit === x.unit && y.low === x.low && y.high === x.high)) &&
    a.metrics.length === b.metrics.length && a.metrics.every((m, i) => {
      const n = b.metrics[i]!;
      return m.kind === n.kind && m.unit === n.unit && m.value === n.value && m.low === n.low && m.high === n.high && m.basis === n.basis;
    });
}

function merge(scene: Scene, plugins: readonly DomainPlugin[], r: Results, row: number, variables: Variable[],
  samples: ReturnType<typeof snapshot>[], worlds: number[], strides: number[]) {
  const o = r.outcomes[row]!, priorVerdict = o.verdict;
  delete o.possiblePaths;
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
  // 모드가 없는 세계의 확정된 0은 다른 세계에서 확인한 각 전달 단위로도 0이다.
  if (o.subjectKind === "workload" && samples.some(s => s.o.path === null)) {
    const units = new Map([...Map.groupBy(samples.flatMap(s => s.metrics.filter(m => m.unit)), m => m.kind)]
      .map(([kind,rows]) => [kind,[...new Set(rows.map(m => m.unit))]]));
    for (const s of samples) if (s.o.path === null) {
      s.metrics = s.metrics.flatMap(m => !m.unit && m.low === 0 && m.high === 0 && units.has(m.kind)
        ? units.get(m.kind)!.map(unit => ({...m,unit})) : [m]);
    }
  }
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
      const rates = r.metrics.filter(m => m.outcome === row && m.kind === a.run);
      const metric = rates.length === 1 ? rates[0] : rates.find(m => m.unit === a.unit);
      a.value = metric?.basis === "calculated" ? metric.value : null;
      if (metric) a.unit = metric.unit;
    }
  }
  r.needs = r.needs.filter(n => n.outcome !== row);
  for (const requiredCapability of new Set(samples.flatMap(s=>s.needs))) {
    const certain=samples.every(s=>s.needs.includes(requiredCapability) && !s.conditionalNeeds.includes(requiredCapability));
    r.needs.push({ outcome:row,requiredCapability,...(certain ? {} : {conditional:true}) });
  }
  if (!changed.size && priorVerdict !== "unknown" && priorVerdict === o.verdict) return;
  const evidence = [...new Set([...samples.flatMap(s => s.inputs), ...changed])];
  const parent = r.reasons.findLastIndex(reason => reason.outcome === row);
  const rule = variables.some(v => readClaim(scene,v.claim).conflictGroup !== undefined) ? "출처 충돌 후보별 판정과 범위"
    : variables.some(v=>v.kind==="schema") ? "미확인 주장 후보별 판정과 범위"
    : variables.some(v => v.kind === "profile") ? "연결 설정 후보별 판정과 범위" : "일관된 배선 후보별 판정과 범위";
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

// 작업·연결·주장의 장면 행 번호만 세계 간에 같다. outcome·근거 행은 최종 결과에서 다시 연결한다.
function mergeGoalWorld(result: Results, sample: Results, scenarios: ReadonlySet<number>, first: boolean,
  world: number, assigned: Variable[], scene: Scene) {
  for (const [i,g] of result.goals.entries()) {
    if (!scenarios.has(g.scenario)) continue;
    const observed = sample.goals[i]!;
    g.verdict = first || g.verdict === observed.verdict ? observed.verdict : "unknown";
    g.combined = true;
    g.truncated = (!first && g.truncated) || observed.truncated;
    if (first) { delete g.limitClaims; delete g.openClaims; }
    if (observed.limitClaims) g.limitClaims=[...new Set([...(g.limitClaims ?? []),...observed.limitClaims])];
    if (observed.openClaims?.length) g.openClaims=[...new Set([...(g.openClaims ?? []),...observed.openClaims])];
    const witnesses = result.goalWitnesses.filter(w => w.goal === i);
    if (witnesses.length < 2 && !observed.truncated) {
      const nested = sample.goalWitnesses.filter(w => w.goal === i);
      const failures = nested.length ? nested : sample.goalEvidence.filter(e => e.goal === i && e.verdict === "impossible")
        .map(e => ({workload:e.workload,high:e.high,assignments:[]}));
      for (const w of failures) {
        if (witnesses.some(prior => prior.workload === w.workload)) continue;
        const assignments = assigned.map(v => ({claim:v.claim,value:readClaim(scene,v.claim).value!}));
        assignments.push(...w.assignments.filter(a => !assignments.some(b => a.claim === b.claim)));
        const witness = {goal:i,world,workload:w.workload,high:w.high,assignments};
        result.goalWitnesses.push(witness); witnesses.push(witness);
        if (witnesses.length === 2 || !nested.length) break;
      }
    }
    for (const check of result.goalEvidence.filter(e => e.goal === i)) {
      const value = sample.goalEvidence.find(e => e.goal === i && e.workload === check.workload)!;
      check.verdict = first || check.verdict === value.verdict ? value.verdict : "unknown";
      check.low = first ? value.low : check.low === null || value.low === null ? null : Math.min(check.low,value.low);
      check.high = first ? value.high : check.high === null || value.high === null ? null : Math.max(check.high,value.high);
      check.connections = first ? [...value.connections] : [...new Set([...check.connections,...value.connections])];
      if (first) delete check.portVisits;
      for (const visit of value.portVisits ?? []) {
        const visits = check.portVisits ??= [];
        if (!visits.some(v => v.connection === visit.connection && v.port === visit.port)) visits.push(visit);
      }
      check.claims = first ? [...value.claims] : [...new Set([...check.claims,...value.claims])];
    }
  }
}

export function resolveUnknowns(scene: Scene, plugins: readonly DomainPlugin[], result: Results,
  evaluateWiring: (s: Scene, p: readonly DomainPlugin[], profileChanged: boolean, resolveWiring: boolean) => {result:Results;routes:RouteInputs[]},
  routeInputs: readonly RouteInputs[], readConflicts = true) {
  completeUnknowns(scene, plugins, result);
  if (scene.goals?.length) Object.assign(result,judgeGoals(scene,result));
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
  const topology={interfaces:scene.interfaces,ports:scene.ports,resources:scene.resources};
  claimRows(scene).forEach(claim => {
    const c=readClaim(scene,claim);
    if (c.value !== null || effectiveClaim(scene, c.ownerKind, c.owner, c.domain, c.field, c.condition) !== claim) return;
    const owners = c.domain ? plugins.filter(p => p.id === c.domain) : plugins;
    const declared=owners.flatMap(p => p.profileValues?.(c,topology) ?? []);
    const hasGoals=Boolean(scene.goals?.length);
    const conflict=conflicts.get(claim);
    const connectors=c.connectorRow===null ? scene.connectors.map(row=>row.id) : undefined;
    if (!conflict && !connectors && !declared.length && !(hasGoals && (c.discrete || c.openDomain))) return;
    const values=new Set(conflict?.keys() ?? connectors ?? (hasGoals ? c.discrete ?? declared : declared));
    const samples: Variable["samples"] = [];
    for (const value of values) {
      if (c.connectorRow !== undefined) {
        const connectorRow = scene.connectors.findIndex(row => row.id === value);
        if (connectorRow < 0) return;
        samples.push({value,connectorRow});
      } else if (c.attachmentNode !== undefined) {
        const attachmentNode = scene.nodes.findIndex(n => n.item === scene.ports[c.owner]!.item && n.id === value);
        if (attachmentNode < 0) return;
        samples.push({value,attachmentNode});
      } else samples.push({value});
    }
    all.push({claim,kind:conflict ? "profile" : c.numericGrid ? "grid" : declared.length ? "profile" : "schema",samples});
    const links = new Set((result.hookReads ?? []).flatMap(r=>!r.claims.includes(claim) ? [] : r.hook==="laneProfiles" ? [r.row]
      : r.hook==="negotiate" || r.hook==="pools" ? [result.linkResources[r.row]!.connection] : []));
    const port = c.ownerKind === "interface" ? scene.interfaces[c.owner]!.port : c.ownerKind === "port" ? c.owner : undefined;
    // 끝점 설정은 다른 영역의 서비스도 바꾼다. 중간 부품에서는 실제로 읽은 주장만 조합한다.
    scene.connections.forEach(({from,to},connection) => {
      if (port === from || port === to || c.ownerKind === "item" &&
          (scene.ports[from]!.item === c.owner || scene.ports[to]!.item === c.owner)) links.add(connection);
    });
    profileLinks.set(claim,links);
  });
  for (const [port,nodes] of attachmentCandidates(scene)) {
    const claim = portFacts(scene,port).attachment;
    if (!profileLinks.has(claim)) all.push({claim,kind:"wiring",samples:nodes.map(node => ({attachmentNode:node,value:scene.nodes[node]!.id}))});
  }
  if (!all.length) return;
  // 같은 판본의 출처 후보는 서로 다른 실물에서도 한 축이다. 각 실물의 참조 번호는 따로 고정한다.
  const axis=(v:Variable)=>readClaim(scene,v.claim).conflictGroup??v.claim;
  function dimensions(variables:Variable[]) {
    const axes=new Map<number,number>();
    let count=1;
    for (const v of variables) if (!axes.has(axis(v))) {
      axes.set(axis(v),count);
      count=Math.min(MAX_GRID_WORLDS+1,count*v.samples.length);
    }
    return {axes,count,assignments:all.filter(v=>axes.has(axis(v)))};
  }
  function fixed(dim:ReturnType<typeof dimensions>,i:number) {
    const claims=Array.from(claimRows(scene),row=>readClaim(scene,row));
    for (const v of dim.assignments) {
      const sample=v.samples[Math.floor(i/dim.axes.get(axis(v))!)%v.samples.length]!;
      claims[v.claim]={...claims[v.claim]!,...conflicts.get(v.claim)?.get(sample.value),...sample};
    }
    const claimSources=scene.claimSources.filter(s=>!s.candidate || claims[s.claim]!.value===null || claims[s.claim]!.value===s.candidate.value);
    return evaluationScene({...scene,claims,claimSources});
  }
  const worldLimit=(variables:Variable[])=>variables.some(v=>v.kind==="grid") ? MAX_GRID_WORLDS : variables.some(v=>v.kind==="schema")
    ? MAX_COMBINATIONS : variables.some(v=>v.kind==="profile") ? MAX_PROFILE_WORLDS : MAX_WIRINGS;
  // 결합품은 물리 단계에서 결정된다. 이 단계가 읽은 주장만 함께 고정하면 같은 요구 집합의 세계를 한 번에 계산할 수 있다.
  const physicalInputs=new Set(result.physical.flatMap(s=>s.inputs));
  const physicalVariables=all.filter(v=>readClaim(scene,v.claim).ownerKind==="port" && physicalInputs.has(v.claim));
  if (physicalVariables.length) {
    const dim=dimensions(physicalVariables);
    if (!dim.count || dim.count>worldLimit(physicalVariables)) result.incompleteNeeds=scene.scenarios.map((_,i)=>i);
    else {
      const seen=new Set<string>();
      const members:NonNullable<Results["needCases"]>["members"]=[];
      for (let i=0;i<dim.count;i++) {
        const concrete=fixed(dim,i);
        const needs=concrete.connections.flatMap((_,connection)=>{
          const capabilities=new Set((["forward","reverse"] as const).flatMap(d=>physicalSteps(concrete,connection,d)
            .flatMap(s=>s.required ? [s.required] : [])));
          return [...capabilities].sort().map(capability=>({connection,capability}));
        });
        const key=JSON.stringify(needs);
        if (!seen.has(key)) {
          for (const n of needs) members.push({set:seen.size,...n});
          seen.add(key);
        }
      }
      result.needCases={size:seen.size,members};
    }
  }
  let goalVariables:Variable[]=[];
  if (scene.goals?.length) {
    const read=worldReads(scene,result,all);
    for (;;) {
      goalVariables=all.filter(v=>read.has(v.claim));
      const dim=dimensions(goalVariables);
      const unread=all.filter(v=>!read.has(v.claim));
      if (!goalVariables.length || !unread.length || dim.count>worldLimit(goalVariables)) break;
      const before=read.size;
      for (let i=0;i<dim.count && read.size===before;i++) {
        const answer=evaluateWiring(fixed(dim,i),plugins,true,false);
        const inputs=worldReads(scene,answer.result,all);
        for (const v of unread) if (inputs.has(v.claim)) read.add(v.claim);
      }
      if (before===read.size) break;
    }
  }
  const groups: { variables: Variable[]; subjects: number[][] }[] = [];
  const subjects = Map.groupBy(result.outcomes.keys(), row => {
    const o = result.outcomes[row]!;
    return JSON.stringify([o.subjectKind, o.subjectRow, o.scenario, o.direction, o.domain]);
  });
  // 충돌은 기본 경로에 없던 경로와 예산도 만들 수 있다. 시나리오의 작업은 모두 같은 세계에서 비교한다.
  if (scene.goals?.length) {
    if (goalVariables.length) groups.push({variables:goalVariables,subjects:[...subjects.values()]});
  } else for (const rows of subjects.values()) {
    const o = result.outcomes[rows[0]!]!;
    const members = scene.members.filter(m => m.scenario === o.scenario);
    const eligible = all.filter(v => {
      const c = readClaim(scene,v.claim);
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
      }
      for (const read of result.hookReads ?? []) {
        const relevant=read.hook==="negotiate" || read.hook==="pools" ? links.has(result.linkResources[read.row]!.connection)
          : read.hook==="laneProfiles" ? links.has(read.row)
          : read.hook==="policy" ? members.some(m=>routeInputs[m.workload]!.resources.has(read.row))
          : read.hook==="standingLoads" || members.some(m=>m.workload===(read.hook==="consume" ? result.paths[read.row]?.workload : read.row));
        if (relevant) for (const id of read.claims) claims.add(id);
      }
      for (const [claim,connections] of profileLinks) if ([...links].some(link => connections.has(link))) claims.add(claim);
      variables = eligible.filter(v=>claims.has(v.claim) && (!readClaim(scene,v.claim).domain || readClaim(scene,v.claim).ownerKind==="resource" || result.readClaims?.[v.claim]));
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
    const dim=dimensions(variables), {count,assignments}=dim;
    const strides=variables.map(v=>dim.axes.get(axis(v))!);
    const scenarios = new Set(affected.map(i => result.outcomes[i]!.scenario));
    // 같은 시나리오의 모든 작업은 같은 후보 축을 쓴다. 연결만 검산하는 묶음은 목표를 덮지 않는다.
    const goalScenarios = new Set<number>();
    if (result.goals.length) for (const i of affected) {
      const o = result.outcomes[i]!;
      if (o.subjectKind === "workload" && o.scenario !== null) goalScenarios.add(o.scenario);
    }
    const scope = provisional.flatMap((u,i) => scenarios.has(u.scenario) ? [i] : []);
    const profileChanged = variables.some(v => profileLinks.has(v.claim));
    const disputed = variables.some(v => conflicts.has(v.claim));
    if (!count || count > worldLimit(variables)) {
      const missing=variables.filter(v=>!v.samples.length);
      const openClaims=missing.filter(v=>v.kind!=="grid").map(v=>v.claim);
      const finite=variables.filter(v=>v.samples.length);
      const combinationLimit=missing.some(v=>v.kind==="grid") ||
        (count || dimensions(finite).count)>worldLimit(variables);
      const incomplete=new Set(result.incompleteNeeds);
      for (const s of scenarios) {
        if (s===null) scene.scenarios.forEach((_,i)=>incomplete.add(i));
        else incomplete.add(s);
      }
      result.incompleteNeeds=[...incomplete];
      for (const [i,g] of result.goals.entries()) if (goalScenarios.has(g.scenario)) {
        g.verdict = "unknown"; g.truncated = true;
        if (combinationLimit) g.limitClaims=variables.filter(v=>v.samples.length>1 || v.kind==="grid" && !v.samples.length).map(v=>v.claim);
        const unresolved = new Set([...(g.openClaims ?? []),...openClaims]);
        for (const v of finite) unresolved.delete(v.claim);
        if (unresolved.size) g.openClaims=[...unresolved]; else delete g.openClaims;
        for (const e of result.goalEvidence.filter(e => e.goal === i)) {
          e.verdict = "unknown"; e.low = e.high = null; e.connections = [];
          delete e.portVisits;
          e.claims = variables.map(v => v.claim);
        }
      }
      if (profileChanged) {
        result.choices = result.choices.filter(c => !scenarios.has(c.scenario));
        result.reservations = result.reservations.filter(c => !scenarios.has(c.scenario));
        for (const reason of result.reasons) if (reason.profile && scenarios.has(result.outcomes[reason.outcome]!.scenario)) {
          reason.rule = "후보 조합 상한으로 연결 설정 검산 안 함";
          delete reason.profile;
        }
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
        const blocked = o.subjectKind === "connection" && result.physical.some(s =>
          s.connection === o.subjectRow && s.direction === o.direction && s.verdict === "impossible");
        o.verdict = blocked ? "impossible" : "unknown";
        delete o.option;
        delete o.soloPath;
        delete o.possiblePaths;
        o.path = null;
        o.mode = "";
        o.label = plugins.find(p => p.id === o.domain)?.explain(o.verdict, o.mode) ?? (blocked ? "연결 불가" : "배선 미확인");
        result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== row);
        if (blocked) {
          result.possibleVerdicts.push({ outcome:row, verdict:"impossible" });
          result.metrics = result.metrics.filter(m => m.outcome !== row);
          if (o.unit) result.metrics.push({ outcome:row, kind:"limit", unit:o.unit, value:0, low:0, high:0, basis:"calculated" });
          continue;
        }
        conservative(result, row, disputed || variables===goalVariables);
        for (const m of result.measures.filter(m => m.outcome === row)) m.low = m.high = null;
        const runs = new Set(result.assessments.filter(a => a.outcome === row).map(a => a.run));
        result.assessments = result.assessments.filter(a => a.outcome !== row);
        if (!disputed) for (const run of runs) for (const verdict of ["ok","conditional","impossible"] as const)
          result.assessments.push({ outcome: row, run, verdict });
        if (o.subjectKind === "workload") {
          for (const a of result.allocations) if (a.workload === o.subjectRow && a.scenario === o.scenario) a.value = null;
          result.bindings = result.bindings.filter(b => b.workload !== o.subjectRow || b.scenario !== o.scenario);
        }
        if (!disputed) for (const verdict of ["ok", "conditional", "impossible"] as const) result.possibleVerdicts.push({ outcome: row, verdict });
        const claims = variables.map(v => v.claim);
        addReason(result, { outcome: row, stage: "judge", rule: variables===goalVariables
          ? (combinationLimit ? "주장 조합 상한으로 모든 후보를 확인하지 못함" : "주장의 가능한 값을 모두 열거할 수 없음")
          : disputed ? "출처 후보 조합 상한" : count ? "배선 조합 상한" : "부착점 후보 없음", targetKind: o.subjectKind, targetRow: o.subjectRow }, claims);
        for (const id of claims) ask(scene, plugins, result, row, id);
      }
      continue;
    }
    const observations = subjects.map((): Observation[][] => []), worlds: number[] = [];
    const totals = new Map<number, Pick<Results["resourceUsage"][number], "used" | "capacity" | "basis">>();
    const added = new Set<number>();
    let choices: Results["choices"] = [], reservations: Results["reservations"] = [];
    for (let i = 0; i < count; i++, world++) {
      const concrete=fixed(dim,i);
      for (const v of assignments) {
        const value=readClaim(concrete,v.claim).value!;
        if (v.kind !== "wiring") result.profileWorlds.push({world,claim:v.claim,value});
        else result.wirings.push({world,claim:v.claim,node:readClaim(concrete,v.claim).attachmentNode!});
      }
      const nested=disputed && variables!==goalVariables;
      const {result:answer}=evaluateWiring(concrete,plugins,variables===goalVariables || profileChanged,nested);
      const capped=answer.searches.filter(s=>s.truncated).map(s=>s.scenario).concat(answer.incompleteNeeds ?? []);
      if (capped.length) result.incompleteNeeds=[...new Set([...(result.incompleteNeeds ?? []),...capped])];
      if (!nested) {
        completeUnknowns(concrete, plugins, answer);
        if (goalScenarios.size) Object.assign(answer,judgeGoals(concrete,answer));
      }
      mergeGoalWorld(result,answer,goalScenarios,i === 0,world,assignments,concrete);
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
  for (const e of result.goalEvidence) e.reasons = goalReasons(scene.goals![e.goal]!,result,e.outcome);
}
