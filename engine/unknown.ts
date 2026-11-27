// 같은 부착점은 모든 경로·단독·동시 실행에서 같은 노드로 고정하고 배선별 결과를 합친다.
import type { DomainPlugin, Scene } from "./contract.ts";
import type { RouteInputs } from "./path.ts";
import { attachmentCandidates, portFacts } from "./scene.ts";
import { addReason, type Results } from "./results.ts";

// 연결된 장비의 후보 곱이 커지면 일부 표본 대신 물리 상한을 쓴다.
const MAX_WIRINGS = 64;
type Metric = Results["metrics"][number];
type Variable = { claim: number; nodes: number[] };


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

function ask(scene: Scene, plugins: readonly DomainPlugin[], result: Results, row: number, claim: number) {
  if (result.quests.some(q => q.outcome === row && q.claim === claim)) return;
  const c = scene.claims[claim]!, o = result.outcomes[row]!;
  const plugin = plugins.find(p => p.id === (c.domain || o.domain));
  result.quests.push({ outcome: row, claim, instruction: plugin?.quest(c.field) ?? (c.field + " 값을 확인하세요.") });
}

function conservative(result: Results, row: number) {
  const o = result.outcomes[row]!;
  if (o.subjectKind !== "workload") return;
  const demands = result.demands.filter(d => d.workload === o.subjectRow);
  for (const m of result.metrics.filter(m => m.outcome === row)) {
    const matching = demands.filter(d => d.unit === m.unit);
    const upper = matching.length && matching.every(d => d.requested !== null) ? Math.max(...matching.map(d => d.requested!)) : null;
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
    if (o.verdict === "unknown") {
      for (const id of inputs(result, row)) if (scene.claims[id]!.value === null) ask(scene, plugins, result, row, id);
      if (!result.possibleVerdicts.some(v => v.outcome === row)) {
        for (const verdict of ["ok", "conditional", "impossible"] as const) result.possibleVerdicts.push({ outcome: row, verdict });
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

function snapshot(r: Results, row: number) {
  const o = r.outcomes[row]!;
  const metrics = r.metrics.filter(m => m.outcome === row);
  const possible = r.possibleVerdicts.filter(v => v.outcome === row).map(v => v.verdict).sort();
  return { o, metrics, possible, inputs: inputs(r, row),
    specs: r.reasonSpecs.filter(s => r.reasons[s.reason]!.outcome === row).map(s => s.source),
    quests: r.quests.filter(q => q.outcome === row).map(q => q.claim),
    bindings: r.bindings.filter(b => o.subjectKind === "workload" && b.scenario === o.scenario && b.workload === o.subjectRow),
    needs: r.needs.filter(n => n.outcome === row).map(n => n.requiredCapability) };
}

function sameOutcome(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  return a.o.verdict === b.o.verdict && a.o.mode === b.o.mode &&
    a.possible.length === b.possible.length && a.possible.every((v, i) => v === b.possible[i]) &&
    a.metrics.length === b.metrics.length && a.metrics.every((m, i) => {
      const n = b.metrics[i]!;
      return m.kind === n.kind && m.unit === n.unit && m.value === n.value && m.low === n.low && m.high === n.high && m.basis === n.basis;
    });
}

function merge(scene: Scene, plugins: readonly DomainPlugin[], r: Results, row: number, variables: Variable[],
  samples: ReturnType<typeof snapshot>[], worlds: number[], strides: number[]) {
  const o = r.outcomes[row]!, priorVerdict = o.verdict;
  const possible = new Set(samples.flatMap(s => s.possible));
  const first = samples[0]!;
  o.verdict = possible.size === 1 ? [...possible][0]! : "unknown";
  if (!samples.every(s => s.o.mode === first.o.mode)) o.mode = "";
  else o.mode = first.o.mode;
  const plugin = plugins.find(p => p.id === o.domain);
  o.label = plugin?.explain(o.verdict, o.mode) ?? first.o.label;
  r.possibleVerdicts = r.possibleVerdicts.filter(v => v.outcome !== row);
  for (const verdict of possible) r.possibleVerdicts.push({ outcome: row, verdict });
  r.quests = r.quests.filter(q => q.outcome !== row);
  for (const id of new Set(samples.flatMap(s => s.quests))) ask(scene, plugins, r, row, id);

  // 같은 다른 배선을 고정한 채 이 주장 하나를 바꿔 결과가 달라지는지 비교한다.
  const changed = variables.flatMap((v, j) => {
    const stride = strides[j]!;
    return samples.some((s,i) => Math.floor(i / stride) % v.nodes.length !== 0 &&
      !sameOutcome(s, samples[i - (Math.floor(i / stride) % v.nodes.length) * stride]!)) ? [v.claim] : [];
  });
  for (const id of changed) ask(scene, plugins, r, row, id);
  for (const m of r.metrics.filter(m => m.outcome === row)) {
    const ordinal = r.metrics.filter(other => other.outcome === row && other.kind === m.kind && other.unit === m.unit).indexOf(m);
    const values = samples.map(s => s.metrics.filter(x => x.kind === m.kind && x.unit === m.unit)[ordinal]);
    range(m, values, worlds);
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
  if (!changed.length && priorVerdict !== "unknown" && priorVerdict === o.verdict) return;
  const evidence = [...new Set([...samples.flatMap(s => s.inputs), ...variables.map(v => v.claim)])];
  const parent = r.reasons.findLastIndex(reason => reason.outcome === row);
  const proof = addReason(r, { outcome: row, stage: "judge", rule: "일관된 배선 후보별 판정과 범위", targetKind: o.subjectKind, targetRow: o.subjectRow },
    evidence, parent < 0 ? [] : [parent]);
  for (const source of new Set(samples.flatMap(s => s.specs))) r.reasonSpecs.push({ reason: proof, source });
}

export function resolveUnknowns(scene: Scene, plugins: readonly DomainPlugin[], result: Results,
  evaluateWiring: (s: Scene, p: readonly DomainPlugin[]) => Results, routeInputs: readonly RouteInputs[]) {
  completeUnknowns(scene, plugins, result);
  const candidates = attachmentCandidates(scene, result.demands.flatMap(d => d.via));
  if (!candidates.size) return;
  const all = [...candidates].map(([port, nodes]) => ({ claim: portFacts(scene, port).attachment, nodes }));
  const groups: { variables: Variable[]; affected: number[] }[] = [];
  result.outcomes.forEach((o, row) => {
    const claims = new Set<number>();
    if (o.subjectKind === "connection") {
      for (const p of scene.parts.filter(p => p.connection === o.subjectRow))
        for (const port of [p.entry,p.exit]) claims.add(portFacts(scene,port).attachment);
      for (const opt of result.options.filter(v => v.connection === o.subjectRow && v.direction === o.direction && v.domain === o.domain))
        for (const id of opt.inputs) claims.add(id);
    } else {
      const members = scene.members.filter(m => m.scenario === o.scenario).map(m => m.workload);
      for (const w of competingWorks(o.subjectRow, members, routeInputs))
        for (const id of routeInputs[w]!.claims) claims.add(id);
    }
    const variables = all.filter(v => claims.has(v.claim));
    if (!variables.length) return;
    const group = groups.find(g => g.variables.length === variables.length && g.variables.every((v,i) => v === variables[i]));
    if (group) group.affected.push(row); else groups.push({ variables, affected: [row] });
  });
  let world = 0;
  for (const { variables, affected } of groups) {
    const count = variables.reduce((n,v) => n * v.nodes.length, 1);
    if (!count || count > MAX_WIRINGS) {
      for (const row of affected) {
        const o = result.outcomes[row]!;
        o.verdict = "unknown";
        o.label = plugins.find(p => p.id === o.domain)?.explain("unknown", o.mode) ?? "배선 미확인";
        conservative(result, row);
        if (o.subjectKind === "workload") {
          for (const a of result.allocations) if (a.workload === o.subjectRow && a.scenario === o.scenario) a.value = null;
          result.bindings = result.bindings.filter(b => b.workload !== o.subjectRow || b.scenario !== o.scenario);
        }
        result.possibleVerdicts = result.possibleVerdicts.filter(v => v.outcome !== row);
        for (const verdict of ["ok", "conditional", "impossible"] as const) result.possibleVerdicts.push({ outcome: row, verdict });
        const claims = variables.map(v => v.claim);
        addReason(result, { outcome: row, stage: "judge", rule: count ? "배선 조합 상한" : "부착점 후보 없음", targetKind: o.subjectKind, targetRow: o.subjectRow }, claims);
        for (const id of claims) ask(scene, plugins, result, row, id);
      }
      continue;
    }
    const strides: number[] = [];
    let stride = 1;
    for (const v of variables) { strides.push(stride); stride *= v.nodes.length; }
    const observations = affected.map((): ReturnType<typeof snapshot>[] => []), worlds: number[] = [];
    for (let i = 0; i < count; i++, world++) {
      const claims = [...scene.claims];
      variables.forEach((v,j) => {
        const node = v.nodes[Math.floor(i / strides[j]!) % v.nodes.length]!;
        claims[v.claim] = { ...claims[v.claim]!, reference: node, value: scene.nodes[node]!.id };
        result.wirings.push({ world, claim: v.claim, node });
      });
      const concrete = { ...scene, claims }, answer = evaluateWiring(concrete, plugins);
      completeUnknowns(concrete, plugins, answer);
      // 결과 행 순서는 장면의 연결·영역·방향과 시나리오 멤버 순서로 고정된다.
      affected.forEach((row,j) => observations[j]!.push(snapshot(answer, row)));
      worlds.push(world);
    }
    affected.forEach((row,j) => merge(scene, plugins, result, row, variables, observations[j]!, worlds, strides));
  }
}
