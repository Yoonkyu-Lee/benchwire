// 판정 표와 장면 표를 따라 터미널에 읽을 수 있는 성능·병목·근거를 만든다.
import { evidenceRows } from "../engine/evidence.ts";
import type { Claim, Scene, Verdict } from "../engine/contract.ts";
import type { Results, Target } from "../engine/results.ts";

const verdicts: Record<Verdict, string> = { ok: "✅", conditional: "⚠️", impossible: "❌", unknown: "❓" };
const stages = { physical: "물리 호환", negotiate: "링크 협상", path: "경로 합성", allocate: "자원 배분", judge: "판정" };
const runs = { solo: "단독", together: "동시" };
const metrics = { solo: "단독 성능", together: "동시 성능", drop: "하락량", dropPercent: "하락률", unused: "미사용 성능", limit: "연결 한도" };
const impacts = { verdict: "판정을 가름", range: "범위만 좁힘" };

// 사람이 읽는 출력이라 소수 셋째 자리까지만 보인다. 계산값은 결과 표에 그대로 있다.
const SHOWN_DECIMALS = 3;
function quantity(value: number | null, unit: string) {
  if (value === null) return "미확인";
  return `${Number(value.toFixed(SHOWN_DECIMALS))}${unit && unit !== "%" ? " " : ""}${unit}`;
}

function metricLines(m: Results["metrics"][number], delivery: boolean) {
  const lines: string[] = [];
  const name = delivery && (m.kind === "solo" || m.kind === "together") ? runs[m.kind] + " 전달량" : metrics[m.kind];
  const range = (m.low !== null || m.high !== null) && (m.low !== m.value || m.high !== m.value);
  const bound = m.range === "conservative" ? " (보수적 경계)" : "";
  if (range) lines.push(`${name} 범위 ${quantity(m.low, m.unit)} ~ ${quantity(m.high, m.unit)}${bound}`);
  if (m.value !== null || (!range && m.kind !== "dropPercent")) {
    const basis = m.basis === "assumed" && m.value !== null ? " (가정)" : "";
    lines.push(`${name} ${quantity(m.value, m.unit)}${basis}`);
  }
  return lines;
}

function measureLine(m: Results["measures"][number]) {
  const label = `${runs[m.run]} ${m.kind === "netCharge" ? "순충전" : m.kind}`;
  const low = quantity(m.low, m.unit);
  return m.low === m.high ? `${label} ${low}` : `${label} 범위 ${low} ~ ${quantity(m.high, m.unit)}`;
}

function terminalText(lines: string[]) {
  return lines.map(line => line.replace(/[\p{Cc}\u2028\u2029]/gu, " ")).join("\n");
}

export function printResults(scene: Scene, result: Results): string {
  const lines = [`장면 ${scene.id}`];
  const evidence: string[] = [];

  function onItem(part: { item: number; id: string }) {
    return `${scene.items[part.item]!.id}/${part.id}`;
  }

  function targetName(kind: Target | Claim["ownerKind"], row: number): string {
    switch (kind) {
      case "item": return scene.items[row]!.id;
      case "port": return onItem(scene.ports[row]!);
      case "interface": {
        const iface = scene.interfaces[row]!;
        return `${onItem(scene.ports[iface.port]!)}/${iface.id}`;
      }
      case "edge": return onItem(scene.edges[row]!);
      case "resource": return onItem(scene.resources[row]!);
      case "connector": return scene.connectors[row]!.id;
      case "mate": {
        const mate = scene.mates[row]!;
        return `${scene.connectors[mate.a]!.id} ↔ ${scene.connectors[mate.b]!.id}`;
      }
      case "connection": return scene.connections[row]!.id;
      case "workload": return scene.workloads[row]!.id;
      case "demand": {
        const demand = result.demands[row]!;
        return `${scene.workloads[demand.workload]!.id}/${demand.mode}`;
      }
      case "linkResource": {
        const link = result.linkResources[row]!;
        const direction = link.direction === "forward" ? "정방향" : "역방향";
        return `${scene.connections[link.connection]!.id} (${direction}, ${link.domain})`;
      }
    }
  }

  function writeClaim(claim: number, pad: string) {
    const c = scene.claims[claim]!;
    const value = c.value === null ? "미확인" : JSON.stringify(c.value);
    const condition = c.condition ? ` · 조건 ${c.condition}` : "";
    const unit = c.unit ? " " + c.unit : "";
    const origin = c.inferredFrom ? " · 원본 " + c.inferredFrom : "";
    const field = `${pad}주장 ${targetName(c.ownerKind, c.owner)} · ${c.field}`;
    evidence.push(c.conflictGroup === undefined ? `${field} = ${value}${unit} [${c.confidence}]${condition}${origin}`
      : `${field} · 출처 충돌${condition}`);
    const citations = scene.claimSources.filter(s => s.claim === claim);
    const groups = Map.groupBy(citations, s => JSON.stringify(s.candidate));
    for (const rows of groups.values()) {
      const candidate = rows[0]!.candidate;
      if (candidate) {
        const origin = candidate.inferredFrom ? " · 원본 " + candidate.inferredFrom : "";
        evidence.push(`${pad}  충돌 후보 ${JSON.stringify(candidate.value)}${unit} [${candidate.confidence}]${origin}`);
      }
      for (const { source } of rows) {
        const s = scene.sources[source]!;
        evidence.push(`${pad}${candidate ? "    " : "  "}출처 ${s.title} (${s.locator})`);
      }
    }
  }

  function writeOutcome(row: number, label: string, indent: string) {
    const outcome = result.outcomes[row]!;
    const domain = outcome.domain ? ` [${outcome.domain}]` : "";
    const heading = `${indent}${verdicts[outcome.verdict]} ${label}${domain}`;
    lines.push(`${heading} · ${outcome.label}`);
    evidence.push(heading);
    indent += "  ";
    lines.push(`${indent}모드 ${outcome.mode || "—"}`);

    const assessments = result.assessments.filter(a => a.outcome === row);
    for (const m of result.metrics.filter(m => m.outcome === row)) {
      for (const metric of metricLines(m, assessments.length > 0)) lines.push(indent + metric);
      if (m.low === m.high || m.range !== "witnessed") continue;
      for (const [side,world,value] of [["하한",m.lowWorld,m.low],["상한",m.highWorld,m.high]] as const) {
        if (world === undefined) continue;
        const claims = [
          ...result.profileWorlds.filter(v => v.world === world),
          ...result.wirings.filter(v => v.world === world).map(v => ({claim:v.claim, value:scene.nodes[v.node]!.id})),
        ];
        const values = claims.map(v => {
          const c = scene.claims[v.claim]!;
          return `${targetName(c.ownerKind,c.owner)} · ${c.field} = ${v.value}${c.unit ? " " + c.unit : ""}`;
        });
        if (values.length) evidence.push(`${indent}${metrics[m.kind]} ${side} ${quantity(value,m.unit)} ← ${values.join(", ")}`);
      }
    }
    const measures = result.measures.filter(m => m.outcome === row);
    for (const run of ["solo", "together"] as const) {
      for (const m of measures.filter(m => m.run === run)) lines.push(indent + measureLine(m));
      const possible = assessments.filter(a => a.run === run).map(a => verdicts[a.verdict]);
      if (possible.length) lines.push(`${indent}${runs[run]} ${possible.length > 1 ? "가능한 판정" : "판정"} ${possible.join(" ")}`);
    }
    if (outcome.subjectKind === "workload") {
      for (const b of result.bindings.filter(b => b.workload === outcome.subjectRow && b.scenario === outcome.scenario)) {
        const resource = targetName(b.resourceKind === "scene" ? "resource" : "linkResource", b.resource);
        lines.push(`${indent}${runs[b.run]} 병목 ${resource}`);
      }
    }
    for (const n of result.needs.filter(n => n.outcome === row)) lines.push(`${indent}필요한 결합 형태 ${n.requiredCapability}`);
    const possible = result.possibleVerdicts.filter(p => p.outcome === row).map(p => verdicts[p.verdict]);
    if (possible.length > 1 && !assessments.some(a => a.run === "together")) lines.push(`${indent}가능한 판정 ${possible.join(" ")}`);
    for (const q of result.quests.filter(q => q.outcome === row)) {
      const c = scene.claims[q.claim]!;
      const impact = q.impact ? ` · ${impacts[q.impact]}` : "";
      lines.push(`${indent}확인할 것 · ${q.instruction} (${targetName(c.ownerKind, c.owner)} · ${c.field})${impact}`);
    }

    for (const { reason, depth, reference } of evidenceRows(result, { outcome: row })) {
      const pad = indent + "  ".repeat(depth);
      if (reference) {
        evidence.push(`${pad}↳ 근거 #${reason + 1}`);
        continue;
      }
      const r = result.reasons[reason]!;
      const run = r.run ? runs[r.run] + " " : "";
      evidence.push(`${pad}#${reason + 1} [${stages[r.stage]}] ${run}${r.rule} · ${targetName(r.targetKind, r.targetRow)}`);
      for (const { claim } of result.reasonInputs.filter(i => i.reason === reason)) writeClaim(claim, pad + "  ");
      for (const { source } of result.reasonSpecs.filter(s => s.reason === reason)) {
        const s = result.specSources[source]!;
        evidence.push(`${pad}  규격 ${s.title} (${s.locator})`);
      }
    }
  }

  function writeConnection(o: Results["outcomes"][number], row: number, indent: string) {
    const c = scene.connections[o.subjectRow]!;
    const [from, to] = o.direction === "reverse" ? [c.to, c.from] : [c.from, c.to];
    writeOutcome(row, `연결 ${c.id} · ${targetName("port", from)} → ${targetName("port", to)}`, indent);
  }

  result.outcomes.forEach((o, row) => {
    if (o.subjectKind !== "connection" || o.scenario !== null) return;
    lines.push("");
    evidence.push("");
    writeConnection(o, row, "");
  });
  scene.scenarios.forEach((s, scenario) => {
    lines.push("", `시나리오 ${s.id}`);
    evidence.push("", `시나리오 ${s.id}`);
    for (const choice of result.choices.filter(c => c.scenario === scenario)) {
      const label = `  연결 설정 ${targetName("connection", choice.connection)} · ${choice.profile}`;
      lines.push(label);
      evidence.push(label, `    [${stages.negotiate}] ${choice.rule}`);
      for (const claim of choice.inputs) writeClaim(claim, "    ");
      for (const s of result.specSources.filter(s => s.domain === choice.domain && choice.specs.includes(s.id)))
        evidence.push(`    규격 ${s.title} (${s.locator})`);
    }
    const search = result.searches.find(s => s.scenario === scenario);
    if (search?.truncated) lines.push(`  조합 탐색이 잘림 · 확인한 조합 ${search.examined}개`);
    result.outcomes.forEach((o, row) => {
      if (o.scenario !== scenario) return;
      if (o.subjectKind === "connection") writeConnection(o, row, "  ");
      else writeOutcome(row, `워크로드 ${scene.workloads[o.subjectRow]!.id}`, "  ");
    });
  });

  if (result.errors.length) {
    lines.push("", "영역 플러그인 계약 오류");
    const steps = { negotiate: "링크 협상", demand: "수요 계산", consume: "자원 소비" };
    for (const e of result.errors) {
      const name = e.stage === "negotiate" ? targetName("linkResource", e.row)
        : targetName("workload", e.stage === "demand" ? e.row : result.paths[e.row]!.workload);
      const what = e.spec ? `미등록 규격 ${e.spec}` : `유한하지 않은 ${e.field}`;
      const resource = e.resource === undefined ? "" : ` · 자원 ${targetName("resource", e.resource)}`;
      lines.push(`  ${e.domain} · ${steps[e.stage]} · ${name}${resource} · ${what}`);
    }
  }
  return terminalText(result.reasons.length || result.choices.length ? lines.concat("", "근거", evidence) : lines);
}

export function printVariant(scene: Scene, base: Results, variant: Results, scenario: number, order: number): string {
  const lines = [`대안 ${order} · 시나리오 ${scene.scenarios[scenario]!.id}`];
  const before = new Map(base.choices.filter(c => c.scenario === scenario).map(c => [c.connection, c.profile]));
  const after = new Map(variant.choices.filter(c => c.scenario === scenario).map(c => [c.connection, c.profile]));
  for (const connection of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(connection), to = after.get(connection);
    if (from !== to) lines.push(`  연결 설정 ${scene.connections[connection]!.id} · ${from ?? "—"} → ${to ?? "—"}`);
  }
  variant.outcomes.forEach((o, row) => {
    if (o.subjectKind !== "workload" || o.scenario !== scenario) return;
    lines.push(`  ${verdicts[o.verdict]} 워크로드 ${scene.workloads[o.subjectRow]!.id}${o.mode ? ` · ${o.mode}` : ""}`);
    const delivery = variant.assessments.some(a => a.outcome === row);
    for (const m of variant.metrics.filter(m => m.outcome === row && (m.kind === "solo" || m.kind === "together")))
      for (const metric of metricLines(m, delivery)) lines.push("    " + metric);
    for (const m of variant.measures.filter(m => m.outcome === row)) lines.push("    " + measureLine(m));
  });
  return terminalText(lines);
}
