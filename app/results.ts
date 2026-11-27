// 엔진의 판정·경로·자원 표를 화면에서 선택할 행과 방향별 배선으로 바꾼다.
import { domainNames, workloadKindName } from "../domains/registry.ts";
import type { Direction, Interval, Scene, Verdict } from "../engine/contract.ts";
import type { Results, Run } from "../engine/results.ts";
import type { Layer } from "./layers.ts";

export const verdictText = { ok: "✅ 성립", conditional: "⚠️ 조건부", impossible: "❌ 불가", unknown: "❓ 미확인" };
const verdictIcon = { ok: "✅", conditional: "⚠️", impossible: "❌", unknown: "❓" };
const MAX_WIRE_WIDTH = 5;

export interface WireMark {
  kind: "negotiation" | "flow"; direction: Direction | null; layer: Layer; verdict: Verdict | null;
  text: string; title: string; unit: string; pool?: string; width?: number; dashed?: boolean; workload?: string;
}
export type Selection = { kind: "connection" | "workload"; id: string } | { kind: "resource"; row: number };
type Outcome = Results["outcomes"][number];

function domainName(domain: string) {
  return domainNames.get(domain) ?? (domain || "물리 연결");
}

function layerFor(domain: string, unit: string): WireMark["layer"] {
  return unit === "W" ? "power" : domain || "unclassified";
}

const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3, useGrouping: false });
export function quantity(value: number | null, unit: string) {
  return value === null ? "미확인" : [decimal.format(value), unit].filter(Boolean).join(" ");
}

export function interval({ low, high }: Interval, unit: string) {
  if (low === high) return quantity(low, unit);
  return `${quantity(low, "")}–${quantity(high, unit)}`;
}

function outcomeVerdict(result: Results, row: number, run: Run): Verdict | null {
  if (run === "together") return result.outcomes[row]!.verdict;
  const assessed = result.assessments.filter(a => a.outcome === row && a.run === run);
  return assessed.length ? assessed.length === 1 ? assessed[0]!.verdict : "unknown" : null;
}

function connectionMarks(result: Results, rows: readonly number[]): WireMark[] {
  return rows.map(row => {
    const o = result.outcomes[row]!;
    const option = o.option === undefined ? undefined : result.options[o.option];
    const unit = o.unit ?? "";
    const capacity = option?.bounds ? interval(option.bounds, unit) : option?.limit != null ? quantity(option.limit, unit) : "";
    const arrow = o.direction === "reverse" ? "←" : "→";
    const pool = o.pool ? `${o.pool.domain}/${o.pool.id}` : undefined;
    const text = [verdictIcon[o.verdict], arrow, o.label, capacity].filter(Boolean).join(" ");
    return { kind: "negotiation", direction: o.direction, layer: layerFor(o.domain, unit), verdict: o.verdict, text, unit,
      title: [text, domainName(o.domain), pool, option?.condition].filter(Boolean).join(" · "),
      ...(pool && { pool }), dashed: o.verdict === "unknown" || !!option?.bounds };
  });
}

export function resultView(scene: Scene, result: Results, scenario: number | null, run: Run) {
  const connections = new Map<number, number[]>();
  const workloads: ReturnType<typeof workloadView>[] = [];
  for (const [row, outcome] of result.outcomes.entries()) {
    if (outcome.subjectKind === "workload") {
      if (outcome.scenario === scenario) workloads.push(workloadView(scene, result, row, outcome, run));
    } else if (outcome.scenario === null || outcome.scenario === scenario) {
      const entries = connections.get(outcome.subjectRow) ?? [];
      entries.push(row);
      connections.set(outcome.subjectRow, entries);
    }
  }
  const wires = new Map<string, WireMark[]>();
  const negotiations = new Map<string, number[]>();
  for (const [row, entries] of connections) {
    const selected = entries.some(i => result.outcomes[i]!.scenario === scenario)
      ? entries.filter(i => result.outcomes[i]!.scenario === scenario) : entries;
    const id = scene.connections[row]!.id;
    wires.set(id, connectionMarks(result, selected));
    negotiations.set(id, selected);
  }
  const maxima = new Map<string, number>();
  for (const w of workloads) {
    const magnitude = w.metric?.value;
    if (magnitude != null && magnitude > 0) maxima.set(w.metric!.unit, Math.max(maxima.get(w.metric!.unit) ?? 0, magnitude));
  }
  for (const w of workloads) {
    const metric = w.metric;
    if (!metric || metric.value === 0 && metric.low === metric.high) continue;
    for (const s of w.steps) {
      const wire = wires.get(scene.connections[s.row]!.id);
      if (!wire) continue;
      const unit = metric.unit;
      const arrow = s.direction === "reverse" ? "←" : "→";
      const text = [w.verdict && verdictIcon[w.verdict], arrow, w.name, w.summary].filter(Boolean).join(" ");
      const maximum = maxima.get(unit);
      const width = maximum && metric.value !== null ? 2 + (MAX_WIRE_WIDTH - 2) * metric.value / maximum : 2;
      wire.push({ kind: "flow", workload: w.id, direction: s.direction, layer: layerFor(s.carrier?.domain ?? w.domain, unit),
        verdict: w.verdict, text, title: text, unit, width,
        dashed: w.verdict === "unknown" || metric.value === null || metric.low !== metric.high });
    }
  }
  const resources = result.resourceUsage.filter(r => r.scenario === scenario).map(r => ({
    ...r, label: resourceName(scene, result, r.resourceKind, r.resource),
  }));
  return { scene, result, scenario, run, wires, negotiations, workloads, resources };
}

export type ResultView = ReturnType<typeof resultView>;

function workloadView(scene: Scene, result: Results, row: number, o: Outcome, run: Run) {
  const workload = scene.workloads[o.subjectRow]!;
  const path = run === "solo" ? o.soloPath ?? o.path : o.path;
  const steps = result.steps.filter(s => s.path === path && s.kind === "connection").sort((a, b) => a.order - b.order);
  const carriers = new Set(steps.flatMap(s => s.carrier && s.carrier.domain !== o.domain ? [domainName(s.carrier.domain)] : []));
  const name = workloadKindName(o.domain, workload.kind);
  const metric = result.metrics.find(m => m.outcome === row && m.kind === run);
  const qualifiers = [metric?.basis === "assumed" ? "가정" : "", metric?.range === "conservative" ? "보수적 경계" : ""].filter(Boolean);
  const range = metric ? interval(metric, metric.unit) : "미확인";
  const summary = [range, ...qualifiers].join(" · ");
  const measures = result.measures.filter(m => m.outcome === row && m.run === run);
  return { id: workload.id, row, domain: o.domain, name: [name, ...[...carriers].map(c => c + " 경유")].join(" · "),
    verdict: outcomeVerdict(result, row, run), label: o.label, metric, summary, steps, measures };
}

export function resourceName(scene: Scene, result: Results, kind: "scene" | "link", row: number) {
  if (kind === "scene") {
    const r = scene.resources[row]!, item = scene.items[r.item]!;
    return `${item.alias || item.id} · ${r.id}`;
  }
  const r = result.linkResources[row]!;
  return [scene.connections[r.connection]!.id, r.direction === "forward" ? "→" : "←", domainName(r.domain),
    r.pool?.id ?? r.service?.mode, r.pool?.unit ?? r.service?.unit].filter(Boolean).join(" · ");
}
