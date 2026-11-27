// 두 장면을 평가해 달라진 판정의 전후 값과 원인 주장을 터미널에 출력한다.
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { claimIdentity, compare, connectionOption, linkIdentity, ownerIdentity, type Difference, type Snapshot } from "../engine/compare.ts";
import { evaluate } from "../engine/evaluate.ts";
import type { Claim, Verdict } from "../engine/contract.ts";
import type { Results, Run } from "../engine/results.ts";
import { plugins, trial } from "./domains.ts";
import { loadScene } from "./load.ts";

const verdicts: Record<Verdict, string> = { ok: "✅", conditional: "⚠️", impossible: "❌", unknown: "❓" };
const runs: Record<Run, string> = { solo: "단독", together: "동시" };
const labels: Record<string, string> = { added: "추가", removed: "삭제", verdict: "판정", mode: "모드", value: "값",
  range: "범위", bottleneck: "병목", assumption: "가정", quest: "퀘스트", condition: "조건", need: "필요한 결합 형태" };
const metricLabels = { solo: "단독", together: "동시", drop: "하락량", dropPercent: "하락률", unused: "미사용 성능" };
const direction = (d: string | null) => d === "forward" ? "정방향" : d === "reverse" ? "역방향" : "양방향";

function clean(text: string) {
  return text.replace(/[\p{Cc}\u2028\u2029]+/gu, " ");
}

function quantity(value: number | null, unit: string) {
  return value === null ? "미확인" : String(value) + (unit && unit !== "%" ? " " : "") + unit;
}

function title({ scene, result }: Snapshot, row: number) {
  const o = result.outcomes[row]!;
  if (o.subjectKind === "workload")
    return `시나리오 ${scene.scenarios[o.scenario!]!.id} · 작업 ${scene.workloads[o.subjectRow]!.id}`;
  const tags = [direction(o.direction), o.domain, o.unit, o.pool ? `${o.pool.domain}/${o.pool.id}` : ""].filter(Boolean);
  return `연결 ${scene.connections[o.subjectRow]!.id} · ${tags.join(" · ")}`;
}

function bindings(result: Results, row: number) {
  const o = result.outcomes[row]!;
  return o.subjectKind === "workload"
    ? result.bindings.filter(b => b.scenario === o.scenario && b.workload === o.subjectRow)
    : [];
}

function resourceLabel(snapshot: Snapshot, b: Results["bindings"][number]) {
  if (b.resourceKind === "scene") return ownerIdentity(snapshot.scene, "resource", b.resource).join("/");
  const l = linkIdentity(snapshot, b.resource);
  const pool = l.pool ? l.poolDomain + "/" + l.pool : "";
  return [l.connection, direction(l.direction), l.domain, l.unit, l.mode, pool].filter(Boolean).join(" · ");
}

function interval(low: number | null, high: number | null, unit: string) {
  return low === high ? quantity(low, unit) : `${quantity(low, unit)} ~ ${quantity(high, unit)}`;
}

function side(snapshot: Snapshot, row: number | null, prefix: string) {
  if (row === null) return [`  ${prefix} —`];
  const { scene, result } = snapshot;
  const o = result.outcomes[row]!;
  const link = connectionOption(snapshot, o);
  const metrics = result.metrics.filter(m => m.outcome === row).map(m => {
    const isRange = m.range || m.value !== m.low || m.value !== m.high;
    const range = isRange ? ` (범위 ${interval(m.low, m.high, m.unit)}${m.range === "conservative" ? ", 보수적" : ""})` : "";
    return `${metricLabels[m.kind]} ${quantity(m.value, m.unit)}${m.basis === "assumed" ? " (가정)" : ""}${range}`;
  });
  const measures = result.measures.filter(m => m.outcome === row).map(m =>
    `${runs[m.run]} ${m.kind} ${interval(m.low, m.high, m.unit)}`);
  const assessments = result.assessments.filter(a => a.outcome === row).map(a => `${runs[a.run]} 판정 ${verdicts[a.verdict]}`);
  const possible = new Set(result.possibleVerdicts.filter(p => p.outcome === row).map(p => verdicts[p.verdict]));
  const limit = link ? "한도 " + (link.bounds ? interval(link.bounds.low, link.bounds.high, link.unit) : quantity(link.limit, link.unit)) : "";
  const lines = [`  ${prefix} ${[verdicts[o.verdict], o.domain && `[${o.domain}]`, o.mode && `모드 ${o.mode}`,
    limit, ...metrics, ...measures, ...assessments].filter(Boolean).join(" · ")}`];
  if (link?.condition) lines.push(`    조건 ${link.condition}`);
  if (possible.size > 1) lines.push(`    가능한 판정 ${[...possible].join(" ")}`);
  for (const b of bindings(result, row)) lines.push(`    ${runs[b.run]} 병목 ${resourceLabel(snapshot, b)}`);
  for (const n of result.needs.filter(n => n.outcome === row)) lines.push(`    필요한 결합 형태 ${n.requiredCapability}`);
  for (const q of result.quests.filter(q => q.outcome === row)) {
    const c = scene.claims[q.claim]!;
    lines.push(`    확인할 것 ${q.instruction} · ${ownerIdentity(scene, c.ownerKind, c.owner).join("/")} · ${c.field}`);
  }
  return lines;
}

function claimProof({ scene, result }: Snapshot, row: number | null) {
  const claims = new Map<string, Set<number>>();
  const bound = new Set<string>();
  if (row === null) return { claims, bound };
  const bottlenecks = bindings(result, row);
  for (const input of result.reasonInputs) {
    const r = result.reasons[input.reason]!;
    if (r.outcome !== row) continue;
    const key = claimIdentity(scene, scene.claims[input.claim]!);
    const entries = claims.get(key) ?? new Set<number>();
    entries.add(input.claim);
    claims.set(key, entries);
    if (bottlenecks.some(b => r.targetRow === b.resource && r.targetKind === (b.resourceKind === "scene" ? "resource" : "linkResource")))
      bound.add(key);
  }
  return { claims, bound };
}

function factValues(snapshot: Snapshot, rows: Set<number> | undefined) {
  return [...new Set([...(rows ?? [])].map(row => {
    const { value, unit } = snapshot.scene.claims[row]!;
    return JSON.stringify([value, unit]);
  }))].sort().join("\n");
}

function claimTitle(snapshot: Snapshot, claim: Claim) {
  const name = ownerIdentity(snapshot.scene, claim.ownerKind, claim.owner).join("/");
  return [name, claim.field, claim.condition && `조건 ${claim.condition}`].filter(Boolean).join(" · ");
}

function appendFacts(lines: string[], snapshot: Snapshot, rows: Set<number> | undefined, prefix: string) {
  if (!rows) return;
  for (const row of rows) {
    const c = snapshot.scene.claims[row]!;
    const value = typeof c.value === "number" || c.value === null ? quantity(c.value, c.unit) : JSON.stringify(c.value);
    lines.push(`    ${prefix} ${value} [${c.confidence}]`);
    for (const { source } of snapshot.scene.claimSources.filter(i => i.claim === row)) {
      const s = snapshot.scene.sources[source]!;
      lines.push(`      출처 ${s.title} (${s.locator})`);
    }
  }
}

function causes(a: Snapshot, b: Snapshot, diff: Difference) {
  const left = claimProof(a, diff.before), right = claimProof(b, diff.after);
  const keys = [...new Set([...left.claims.keys(), ...right.claims.keys()])].sort();
  const changed = keys.filter(key => factValues(a, left.claims.get(key)) !== factValues(b, right.claims.get(key)));
  const paired = changed.filter(key => left.claims.has(key) && right.claims.has(key));
  const chosen = new Set(paired.length ? paired : changed);
  if (!chosen.size || diff.changed.includes("bottleneck")) for (const key of [...left.bound, ...right.bound]) chosen.add(key);
  const lines: string[] = [];
  if (!chosen.size) {
    for (const [snapshot, row, prefix] of [[a, diff.before, "전"], [b, diff.after, "후"]] as const) {
      const { result } = snapshot;
      const reason = result.reasons.findLastIndex(r => r.outcome === row && r.stage === "negotiate");
      if (reason < 0) continue;
      lines.push(`  근거 ${prefix} · ${result.reasons[reason]!.rule}`);
      for (const { source } of result.reasonSpecs.filter(s => s.reason === reason)) {
        const s = result.specSources[source]!;
        lines.push(`    규격 ${s.title} (${s.locator})`);
      }
    }
  }
  for (const key of chosen) {
    const old = left.claims.get(key), next = right.claims.get(key);
    const c = old ? a.scene.claims[old.values().next().value!]! : b.scene.claims[next!.values().next().value!]!;
    lines.push(`  근거 ${claimTitle(old ? a : b, c)}`);
    appendFacts(lines, a, old, "전");
    appendFacts(lines, b, next, "후");
  }
  return lines;
}

function main() {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true,
      options: { models: { type: "string" }, connectors: { type: "string" } } });
    const [left, right, extra] = positionals;
    if (!left || !right || extra !== undefined)
      throw new Error("사용법 · node cli/compare.ts <장면 A> <장면 B> [--models <폴더>] [--connectors <파일>]");
    function open(file: string): Snapshot {
      const dir = dirname(file);
      const scene = loadScene(file, { modelsDir: values.models ?? dir, connectorsFile: values.connectors ?? join(dir, "connectors.json") }, plugins);
      return { scene, result: evaluate(scene, plugins) };
    }
    const a = open(left), b = open(right);
    const lines = [`로드아웃 비교 · ${a.scene.id} → ${b.scene.id}`];
    if ([a, b].some(s => s.result.outcomes.some(o => o.domain === trial.id))) lines.push("시험 전용 영역 trial");
    const changes = compare(a, b);
    if (!changes.length) lines.push("달라진 판정 없음");
    for (const diff of changes) {
      const name = diff.after !== null ? title(b, diff.after) : title(a, diff.before!);
      lines.push(name + " · 변경 " + diff.changed.map(field => labels[field]).join(", "));
      lines.push(...side(a, diff.before, "전"), ...side(b, diff.after, "후"), "  가격 차이 미산정", ...causes(a, b, diff));
    }
    console.log(lines.map(clean).join("\n"));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error("오류 · " + clean(error.message));
    process.exitCode = 1;
  }
}

main();
