// 판정 표와 장면 표를 따라 터미널에 읽을 수 있는 성능·병목·근거를 만든다.
import type { Claim, Scene, Verdict } from "../engine/contract.ts";
import type { Results, Target } from "../engine/results.ts";

const verdicts: Record<Verdict, string> = { ok: "✅", conditional: "⚠️", impossible: "❌", unknown: "❓" };
const stages = { physical: "물리 호환", negotiate: "링크 협상", path: "경로 합성", allocate: "자원 배분", judge: "판정" };
const runs = { solo: "단독", together: "동시" };
const metrics = { solo: "단독 성능", together: "동시 성능", drop: "하락량", dropPercent: "하락률", unused: "미사용 성능" };

// 사람이 읽는 출력이라 소수 셋째 자리까지만 보인다. 계산값은 결과 표에 그대로 있다.
const SHOWN_DECIMALS = 3;
function quantity(value: number | null, unit: string) {
  if (value === null) return "미확인";
  return `${Number(value.toFixed(SHOWN_DECIMALS))}${unit && unit !== "%" ? " " : ""}${unit}`;
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
      const name = assessments.length && (m.kind === "solo" || m.kind === "together") ? runs[m.kind] + " 전달량" : metrics[m.kind];
      const range = (m.low !== null || m.high !== null) && (m.low !== m.value || m.high !== m.value);
      const bound = m.range === "conservative" ? " (보수적 경계)" : "";
      if (range) lines.push(`${indent}${name} 범위 ${quantity(m.low, m.unit)} ~ ${quantity(m.high, m.unit)}${bound}`);
      if (m.value !== null || (!range && m.kind !== "dropPercent")) {
        const basis = m.basis === "assumed" && m.value !== null ? " (가정)" : "";
        lines.push(`${indent}${name} ${quantity(m.value, m.unit)}${basis}`);
      }
    }
    const measures = result.measures.filter(m => m.outcome === row);
    for (const run of ["solo", "together"] as const) {
      for (const m of measures.filter(m => m.run === run)) {
        const label = `${indent}${runs[run]} ${m.kind === "netCharge" ? "순충전" : m.kind}`;
        const low = quantity(m.low, m.unit);
        lines.push(m.low === m.high ? `${label} ${low}` : `${label} 범위 ${low} ~ ${quantity(m.high, m.unit)}`);
      }
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
      lines.push(`${indent}확인할 것 · ${q.instruction} (${targetName(c.ownerKind, c.owner)} · ${c.field})`);
    }

    const seen = new Set<number>();
    function writeReason(reason: number, pad: string) {
      if (seen.has(reason)) {
        evidence.push(`${pad}↳ 근거 #${reason + 1}`);
        return;
      }
      seen.add(reason);
      const r = result.reasons[reason]!;
      const run = r.run ? runs[r.run] + " " : "";
      evidence.push(`${pad}#${reason + 1} [${stages[r.stage]}] ${run}${r.rule} · ${targetName(r.targetKind, r.targetRow)}`);
      for (const { claim } of result.reasonInputs.filter(i => i.reason === reason)) {
        const c = scene.claims[claim]!;
        const value = c.value === null ? "미확인" : JSON.stringify(c.value);
        const condition = c.condition ? ` · 조건 ${c.condition}` : "";
        evidence.push(`${pad}  주장 ${targetName(c.ownerKind, c.owner)} · ${c.field} = ${value}${c.unit ? ` ${c.unit}` : ""} [${c.confidence}]${condition}`);
        for (const { source } of scene.claimSources.filter(s => s.claim === claim)) {
          const s = scene.sources[source]!;
          evidence.push(`${pad}    출처 ${s.title} (${s.locator})`);
        }
      }
      for (const { source } of result.reasonSpecs.filter(s => s.reason === reason)) {
        const s = result.specSources[source]!;
        evidence.push(`${pad}  규격 ${s.title} (${s.locator})`);
      }
      for (const { prior } of result.reasonParents.filter(p => p.reason === reason)) writeReason(prior, pad + "  ");
    }

    const priors = new Set(result.reasonParents.filter(p => result.reasons[p.reason]!.outcome === row).map(p => p.prior));
    result.reasons.forEach((r, reason) => {
      if (r.outcome === row && !priors.has(reason)) writeReason(reason, indent);
    });
  }

  result.outcomes.forEach((o, row) => {
    if (o.subjectKind !== "connection") return;
    const c = scene.connections[o.subjectRow]!;
    const [from, to] = o.direction === "reverse" ? [c.to, c.from] : [c.from, c.to];
    lines.push("");
    evidence.push("");
    writeOutcome(row, `연결 ${c.id} · ${targetName("port", from)} → ${targetName("port", to)}`, "");
  });
  scene.scenarios.forEach((s, scenario) => {
    lines.push("", `시나리오 ${s.id}`);
    evidence.push("", `시나리오 ${s.id}`);
    result.outcomes.forEach((o, row) => {
      if (o.subjectKind === "workload" && o.scenario === scenario) writeOutcome(row, `워크로드 ${scene.workloads[o.subjectRow]!.id}`, "  ");
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
  const report = result.reasons.length ? lines.concat("", "근거", evidence) : lines;
  return report.map(line => line.replace(/[\p{Cc}\u2028\u2029]/gu, " ")).join("\n");
}
