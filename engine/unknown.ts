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
// 편집 때마다 계산하는 기본 결과의 예산이다. 10기기와 50기기의 Edge 판정 지연으로 정한다.
const MAX_BASE_WORLDS = 144;
// 50기기 × 8세계의 측정 비용을 기본 편집 예산으로 두고 작은 장면은 그 안에서 더 확인한다.
const BASE_DEVICE_WORLDS = 400;
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
    const metrics=result.metrics.filter(m => m.outcome === row);
    for (const m of metrics) Object.assign(m,{value:null,low:0,high:null,basis:"calculated",range:"conservative"});
    if (o.unit && !metrics.some(m=>m.kind==="limit")) result.metrics.push({
      outcome:row,kind:"limit",unit:o.unit,value:null,low:0,high:null,basis:"calculated",range:"conservative",
    });
    return;
  }
  const demands = result.demands.filter(d => d.workload === o.subjectRow);
  for (const m of result.metrics.filter(m => m.outcome === row)) {
    const matching = demands.filter(d => d.unit === m.unit);
    const upper = !disputed && matching.length && matching.every(d => d.requested !== null) ? Math.max(...matching.map(d => d.requested!)) : null;
    m.value = null; m.basis = "calculated"; m.range = "conservative";
    delete m.lowWorld; delete m.highWorld;
    if (m.kind === "solo" || m.kind === "together") { m.low = 0; m.high = upper; }
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

// 훅이 선언한 열린 값의 경계는 유지한다. 퀘스트는 그 훅을 사용한 작업·연결과 같은 자원을 쓰는 경쟁 작업에만 잇는다.
function markIncomplete(scene:Scene,plugins:readonly DomainPlugin[],result:Results,routes:RouteInputs[],open:Variable[],limited:Variable[],lockedScenario?:number) {
  if (!open.length && !limited.length) return;
  const uncertainChoices=new Set<Results["choices"][number]>();
  const uncertainJobs=new Set<Results["outcomes"][number]>();
  for (const [row,o] of result.outcomes.entries()) {
    const claims=new Set(inputs(result,row));
    const work=o.subjectKind==="workload";
    const peers=work ? competingWorks(o.subjectRow,scene.members.filter(m=>m.scenario===o.scenario).map(m=>m.workload),routes) : new Set<number>();
    const links=new Set<number>(work ? [] : [o.subjectRow]);
    const resources=new Set<number>();
    for (const w of peers) {
      for (const id of routes[w]!.claims) claims.add(id);
      for (const id of routes[w]!.resources) {
        resources.add(id);
        const link=result.linkResources[id-scene.resources.length];
        if (link) links.add(link.connection);
      }
    }
    for (const h of result.hookReads ?? []) {
      const link=h.hook==="negotiate" || h.hook==="pools" ? result.linkResources[h.row] : undefined;
      const applies=link ? links.has(link.connection) && (work || o.domain===link.domain && o.direction===link.direction)
        : h.hook==="laneProfiles" ? links.has(h.row) : h.hook==="policy" ? resources.has(h.row)
        : h.hook==="consume" ? peers.has(result.paths[h.row]?.workload ?? -1) : h.hook!=="standingLoads" && peers.has(h.row);
      if (applies) for (const id of h.claims) claims.add(id);
    }
    // 한 연결의 설정을 채점한 작업들의 조회는 그 설정을 사용하는 연결·작업 모두의 선택 근거다.
    const settings=result.choices.filter(c=>c.scenario===o.scenario && links.has(c.connection) &&
      (c.scenario!==lockedScenario || limited.some(v=>c.inputs.includes(v.claim))));
    for (const setting of settings) {
      for (const id of setting.inputs) claims.add(id);
      for (const m of scene.members.filter(m=>m.scenario===o.scenario)) {
        const route=routes[m.workload]!;
        const reaches=[...route.resources].some(id=>result.linkResources[id-scene.resources.length]?.connection===setting.connection);
        if (!reaches) continue;
        if (m.evidence!==undefined) claims.add(m.evidence);
        for (const id of route.claims) claims.add(id);
        for (const h of result.hookReads ?? []) if (h.hook==="demand" && h.row===m.workload) for (const id of h.claims) claims.add(id);
      }
    }
    const capped=limited.filter(v=>claims.has(v.claim));
    const pending=open.filter(v=>claims.has(v.claim));
    if (!capped.length && !pending.length) continue;
    const ids=[...pending,...capped].map(v=>v.claim);
    o.conservative={cause:capped.length ? "limit" : "open",claims:ids};
    for (const id of ids) ask(scene,plugins,result,row,id);
    const settingMayChange=settings.length>0 && result.searches.some(s=>s.scenario===o.scenario && s.examined>1);
    if (!capped.length && !settingMayChange) {
      addReason(result,{outcome:row,stage:"judge",rule:"열린 주장을 읽은 범위와 가능한 판정",
        targetKind:o.subjectKind,targetRow:o.subjectRow},ids);
      if (work && peers.size>1 && o.verdict==="unknown") {
        const alternatives=result.paths.filter(p=>p.workload===o.subjectRow && p.verdict!=="impossible");
        if (alternatives.length>1) {
          // 동시 배분에서 선택한 모드가 바뀔 수 있다. 단독에서 선택한 모드의 가능한 판정만으로 좁히지 않는다.
          const possible=new Set(result.possibleVerdicts.filter(v=>v.outcome===row).map(v=>v.verdict));
          for (const path of alternatives) {
            const verdict=path.conditioned ? "conditional" : "ok";
            if (!possible.has(verdict)) {
              possible.add(verdict);
              result.possibleVerdicts.push({outcome:row,verdict});
            }
          }
        }
      }
      continue;
    }
    for (const choice of settings) uncertainChoices.add(choice);
    if (work) uncertainJobs.add(o);
    const disputed=capped.some(v=>readClaim(scene,v.claim).conflictGroup!==undefined);
    const wiring=capped.length>0 && capped.every(v=>v.kind==="wiring");
    const physicalBlock=!work && result.physical.some(s=>s.connection===o.subjectRow && s.direction===o.direction && s.verdict==="impossible" && !s.inputs.some(i=>ids.includes(i)));
    const boundedPath=work && o.verdict==="unknown" && o.path!==null && !settingMayChange &&
      capped.every(v=>v.kind==="schema") && result.paths.filter(p=>p.workload===o.subjectRow).length===1 &&
      result.metrics.some(m=>m.outcome===row && m.kind==="solo" && m.range==="conservative" && m.high!==null);
    if (!physicalBlock && !boundedPath) {
      o.verdict="unknown"; delete o.option; delete o.soloPath; delete o.possiblePaths;
      o.path=null; o.mode="";
      o.label=plugins.find(p=>p.id===o.domain)?.explain("unknown","") ?? "배선 미확인";
      result.possibleVerdicts=result.possibleVerdicts.filter(v=>v.outcome!==row);
      result.assessments=result.assessments.filter(v=>v.outcome!==row);
      if (!disputed) for (const verdict of ["ok","conditional","impossible"] as const) result.possibleVerdicts.push({outcome:row,verdict});
      const variableDemand=result.hookReads?.some(h=>h.hook==="demand" && h.row===o.subjectRow && h.claims.some(c=>ids.includes(c)));
      conservative(result,row,disputed || !!variableDemand);
      if (work) {
        for (const a of result.allocations) if (a.workload===o.subjectRow && a.scenario===o.scenario) a.value=null;
        result.bindings=result.bindings.filter(b=>b.workload!==o.subjectRow || b.scenario!==o.scenario);
      }
      for (const m of result.measures.filter(m=>m.outcome===row)) m.low=m.high=null;
    }
    for (const m of result.metrics.filter(m=>m.outcome===row && m.low!==m.high)) m.range="conservative";
    addReason(result,{outcome:row,stage:"judge",rule:!capped.length ? "미확인 주장에 따라 연결 설정이 달라짐" : wiring ? "배선 조합 상한" : "주장 후보 조합 상한",
      targetKind:o.subjectKind,targetRow:o.subjectRow},ids);
  }
  result.choices=result.choices.filter(c=>!uncertainChoices.has(c));
  result.reservations=result.reservations.filter(r=>![...uncertainJobs].some(o=>o.scenario===r.scenario && o.subjectRow===r.workload));
  for (const reason of result.reasons) if (reason.profile && [...uncertainChoices].some(c=>
    c.scenario===result.outcomes[reason.outcome]!.scenario && c.profile===reason.profile &&
    reason.targetKind==="connection" && reason.targetRow===c.connection)) {
    reason.rule="미확인 주장으로 연결 설정을 확정하지 못함";
    delete reason.profile;
  }

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
  const pending=samples.flatMap(s=>s.o.conservative ? [s.o.conservative] : []);
  if (pending.length) o.conservative={cause:"open",claims:[...new Set(pending.flatMap(p=>p.claims))]};
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
    const success = sample.goalSuccesses?.find(w => w.goal === i);
    if (!observed.truncated && (observed.verdict === "ok" || success) && !result.goalSuccesses?.some(w => w.goal === i)) {
      const assignments = assigned.map(v => ({ claim: v.claim, value: readClaim(scene, v.claim).value! }));
      assignments.push(...(success?.assignments ?? []).filter(a => !assignments.some(b => b.claim === a.claim)));
      (result.goalSuccesses ??= []).push({ goal: i, assignments });
    }
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
  routes:RouteInputs[], evaluateWorld: (world: Scene) => {result:Results;routes:RouteInputs[]}, lockedScenario?:number) {
  completeUnknowns(scene, plugins, result);
  if (scene.goals?.length) Object.assign(result,judgeGoals(scene,result));
  const all: Variable[] = [];
  const conflicts = new Map<number, Map<SourceCandidate["value"], SourceCandidate>>();
  for (const { claim, candidate } of scene.claimSources) if (candidate) {
    const values = conflicts.get(claim) ?? new Map<SourceCandidate["value"], SourceCandidate>();
    const previous = values.get(candidate.value);
    if (!previous || confidenceOrder.indexOf(candidate.confidence) < confidenceOrder.indexOf(previous.confidence))
      values.set(candidate.value, candidate);
    conflicts.set(claim, values);
  }
  const topology={nodes:scene.nodes,interfaces:scene.interfaces,ports:scene.ports,resources:scene.resources};
  claimRows(scene).forEach(claim => {
    const c=readClaim(scene,claim);
    if (c.value !== null || effectiveClaim(scene, c.ownerKind, c.owner, c.domain, c.field, c.condition) !== claim) return;
    const owners = c.domain ? plugins.filter(p => p.id === c.domain) : plugins;
    const declared=owners.flatMap(p => p.profileValues?.(c,topology) ?? []);

    const conflict=conflicts.get(claim);
    const connectors=c.connectorRow===null ? scene.connectors.map(row=>row.id) : undefined;
    if (!conflict && !connectors && !declared.length && !c.discrete && !c.openDomain) return;
    const partition=c.openDomain && !conflict ? owners.flatMap(p=>p.representatives?.(c,scene) ?? []) : [];
    const values=new Set(conflict?.keys() ?? connectors ?? (declared.length ? declared : c.discrete ?? partition));
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
  });
  for (const [port,nodes] of attachmentCandidates(scene)) {
    const claim = portFacts(scene,port).attachment;
    if (!all.some(v=>v.claim===claim)) all.push({claim,kind:"wiring",samples:nodes.map(node => ({attachmentNode:node,value:scene.nodes[node]!.id}))});
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
  const open=(v:Variable)=>v.kind==="schema" && !v.samples.length;
  const read=worldReads(scene,result,all);
  const cache=new Map<number,ReturnType<typeof evaluateWorld> & {scene:Scene}>();
  function sample(dim:ReturnType<typeof dimensions>,i:number) {
    const prior=cache.get(i);
    if (prior) return prior;
    const concrete=fixed(dim,i);
    const answer={scene:concrete,...evaluateWorld(concrete)};
    cache.set(i,answer);
    return answer;
  }
  let variables:Variable[]=[];
  const hasGoals=!!scene.goals?.length;
  let capped:Variable[]|undefined, baseOpen:Variable[]|undefined;
  const devices=scene.items.filter(i=>scene.models[i.model]!.kind!=="cable").length;
  const baseLimit=Math.max(1,Math.min(MAX_BASE_WORLDS,Math.floor(BASE_DEVICE_WORLDS/Math.max(1,devices))));
  let checkedGoals:Results|undefined;
  const goalScenarios=new Set(result.goals.map(g=>g.scenario));
  for (;;) {
    variables=all.filter(v=>read.has(v.claim) && !open(v));
    const dim=dimensions(variables);
    if (!capped && (!dim.count || dim.count>baseLimit)) {
      capped=variables;
      baseOpen=all.filter(v=>open(v) && (read.has(v.claim) || result.readClaims?.[v.claim]==="range"));
    }
    const unread=all.filter(v=>!read.has(v.claim));
    if (!variables.length || !dim.count || capped && dim.count>worldLimit(variables)) break;
    const large=!!capped;
    if (large && (!hasGoals || all.some(v=>open(v) && read.has(v.claim)))) break;
    if (!large && !unread.length) break;
    // 기본 상한 밖에서는 큰 장면 표를 보관하지 않고 같은 평가에서 목표와 새로 읽힌 주장만 모은다.
    const collector=large ? {...result,...judgeGoals(scene,result),goalWitnesses:[],goalSuccesses:[]} : undefined;
    const before=read.size;
    for (let i=0;i<dim.count && read.size===before;i++) {
      const answer=sample(dim,i);
      for (const id of worldReads(scene,answer.result,unread)) read.add(id);
      if (collector) {
        cache.delete(i);
        if (read.size!==before) break;
        completeUnknowns(answer.scene,plugins,answer.result);
        Object.assign(answer.result,judgeGoals(answer.scene,answer.result));
        mergeGoalWorld(collector,answer.result,goalScenarios,i===0,i,dim.assignments,answer.scene);
      }
    }
    if (before===read.size) {
      if (collector) checkedGoals=collector;
      break;
    }
    if (unread.some(v=>read.has(v.claim) && !open(v))) cache.clear();
  }
  const dim=dimensions(variables), {count,assignments}=dim;
  const openVariables=all.filter(v=>open(v) && read.has(v.claim));
  const goalsCapped=!count || count>worldLimit(variables);
  const goalsIncomplete=goalsCapped || !!openVariables.length;
  function finishGoals() {
    if (goalsIncomplete) {
      // 후보를 다 확인하지 못한 작업이 속한 시나리오만 추가 구매 요구가 열려 있다.
      const unresolved=result.outcomes.flatMap(o=>o.conservative && o.scenario!==null ? [o.scenario] : []);
      if (unresolved.length) result.incompleteNeeds=[...new Set([...(result.incompleteNeeds ?? []),...unresolved])];
      const missing=all.filter(v=>read.has(v.claim));
      for (const [i,g] of result.goals.entries()) {
        g.verdict="unknown"; g.truncated=true;
        if (goalsCapped) g.limitClaims=variables.filter(v=>v.samples.length!==1).map(v=>v.claim);
        if (openVariables.length) g.openClaims=openVariables.map(v=>v.claim);
        for (const e of result.goalEvidence.filter(e=>e.goal===i)) {
          e.verdict="unknown"; e.low=e.high=null; e.connections=[]; delete e.portVisits;
          e.claims=missing.map(v=>v.claim);
          if (e.outcome<0) continue;
          for(const v of missing) ask(scene,plugins,result,e.outcome,v.claim);
          addReason(result,{outcome:e.outcome,stage:"judge",rule:goalsCapped ? "주장 조합 상한으로 모든 후보를 확인하지 못함" : "주장의 가능한 값을 모두 열거할 수 없음",
            targetKind:"workload",targetRow:e.workload},e.claims);
        }
      }
    }
    for (const e of result.goalEvidence) e.reasons=goalReasons(scene.goals![e.goal]!,result,e.outcome);
  }
  if (capped || !variables.length) {
    markIncomplete(scene,plugins,result,routes,baseOpen ?? all.filter(v=>open(v) && (read.has(v.claim) || result.readClaims?.[v.claim]==="range")),capped ?? [],lockedScenario);
    if (checkedGoals) {
      result.goals=checkedGoals.goals; result.goalEvidence=checkedGoals.goalEvidence;
      result.goalWitnesses=checkedGoals.goalWitnesses;
      if (checkedGoals.goalSuccesses?.length) result.goalSuccesses=checkedGoals.goalSuccesses;
    }
    finishGoals();
    return;
  }
  const subjects=[...Map.groupBy(result.outcomes.keys(),row=>{
    const o=result.outcomes[row]!;
    return JSON.stringify([o.subjectKind,o.subjectRow,o.scenario,o.direction,o.domain]);
  }).values()];
  // 각 배선에서 이미 합산한 사용량끼리 비교한다. 서로 배타적인 작업별 상한을 더할 수 없다.
  const provisional = result.resourceUsage.map(u => ({ ...u }));
  const usageKey = (r: Results, u: Results["resourceUsage"][number]) => JSON.stringify([u.scenario,u.unit,
    u.resourceKind === "scene" ? u.resource : linkKey(r,u.resource)]);
  const keys = provisional.map(u => usageKey(result,u));
  const knownUsage = new Map(keys.map((key,i) => [key,i]));
  const knownLinks = new Map(result.linkResources.map((_,i) => [linkKey(result,i),i]));
  const affected = subjects.flat();
  const strides=variables.map(v=>dim.axes.get(axis(v))!);
  const scenarios = new Set(affected.map(i => result.outcomes[i]!.scenario));
  // 같은 시나리오의 모든 작업은 같은 후보 축을 쓴다. 연결만 검산하는 묶음은 목표를 덮지 않는다.
  const scope = provisional.flatMap((u,i) => scenarios.has(u.scenario) ? [i] : []);
  const profileChanged = variables.some(v => v.kind!=="wiring");
  const disputed = variables.some(v => conflicts.has(v.claim));
  const observations = subjects.map((): Observation[][] => []), worlds: number[] = [];
  const totals = new Map<number, Pick<Results["resourceUsage"][number], "used" | "capacity" | "basis">>();
  const added = new Set<number>();
  let choices: Results["choices"] = [], reservations: Results["reservations"] = [];
  for (let world = 0; world < count; world++) {
    const {scene:concrete,result:answer,routes:worldRoutes}=sample(dim,world);
    cache.delete(world);
    for (const v of assignments) {
      const value=readClaim(concrete,v.claim).value!;
      if (v.kind !== "wiring") result.profileWorlds.push({world,claim:v.claim,value});
      else result.wirings.push({world,claim:v.claim,node:readClaim(concrete,v.claim).attachmentNode!});
    }
    const incompleteScenarios=answer.searches.filter(s=>s.truncated).map(s=>s.scenario).concat(answer.incompleteNeeds ?? []);
    if (incompleteScenarios.length) result.incompleteNeeds=[...new Set([...(result.incompleteNeeds ?? []),...incompleteScenarios])];
    completeUnknowns(concrete, plugins, answer);
    if (goalScenarios.size && !goalsIncomplete) Object.assign(answer,judgeGoals(concrete,answer));
    markIncomplete(concrete,plugins,answer,worldRoutes,all.filter(v=>open(v) && answer.readClaims?.[v.claim]),[],lockedScenario);
    if (!goalsIncomplete) mergeGoalWorld(result,answer,goalScenarios,world === 0,world,assignments,concrete);

    const sameChoice = (c: Results["choices"][number]) => answer.choices.some(other =>
      other.scenario === c.scenario && other.connection === c.connection && other.profile === c.profile);
    if (world === 0) {
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
      if (world > 0) totals.set(row,{used:0,capacity:0,basis:"calculated"});
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
    u.used = total.used;
    u.capacity = total.capacity;
    u.basis = u.used !== null && (u.basis === "assumed" || total.basis === "assumed") ? "assumed" : "calculated";
    const outcome = affected.find(row => result.outcomes[row]!.scenario === u.scenario) ?? affected[0]!;
    const reason = addReason(result,{outcome, stage:"allocate", rule:profileChanged ? "연결 설정 후보별 자원 점유량" : "배선 후보별 자원 점유량",
      targetKind:u.resourceKind === "scene" ? "resource" : "linkResource", targetRow:u.resource},
      variables.map(v => v.claim),u.reasonRows);
    u.reasonRows = [reason];
  }
  finishGoals();
}
