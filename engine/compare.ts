// 두 판정 스냅샷에서 영속 ID로 맞춘 결과의 의미가 달라진 행만 돌려준다.
import { bestOption } from "./negotiate.ts";
import type { Results } from "./results.ts";
import type { Claim, Scene } from "./scene.ts";

export interface Snapshot { scene: Scene; result: Results }
export interface Difference {
  key: string;
  before: number | null;
  after: number | null;
  changed: readonly string[];
}
type Outcome = Results["outcomes"][number];
type Binding = Results["bindings"][number];

function outcomeKey(scene: Scene, outcome: Outcome): string {
  if (outcome.subjectKind === "workload") {
    return JSON.stringify(["workload", scene.scenarios[outcome.scenario!]!.id, scene.workloads[outcome.subjectRow]!.id]);
  }
  return JSON.stringify(["connection", scene.connections[outcome.subjectRow]!.id, outcome.direction, outcome.domain,
    outcome.unit ?? null, outcome.pool?.domain ?? null, outcome.pool?.id ?? null]);
}

export function ownerIdentity(scene: Scene, kind: Claim["ownerKind"], row: number): string[] {
  switch (kind) {
    case "item": return [scene.items[row]!.id];
    case "port": case "resource": case "edge": {
      const part = kind === "port" ? scene.ports[row]! : kind === "resource" ? scene.resources[row]! : scene.edges[row]!;
      return [scene.items[part.item]!.id, part.id];
    }
    case "interface": {
      const iface = scene.interfaces[row]!;
      return [...ownerIdentity(scene, "port", iface.port), iface.id];
    }
    case "workload": return [scene.workloads[row]!.id];
    case "connection": return [scene.connections[row]!.id];
    case "connector": return [scene.connectors[row]!.id];
    case "mate": {
      const mate = scene.mates[row]!;
      return [scene.connectors[mate.a]!.id, scene.connectors[mate.b]!.id].sort();
    }
  }
}

export function claimIdentity(scene: Scene, claim: Claim): string {
  return JSON.stringify([claim.ownerKind, ownerIdentity(scene, claim.ownerKind, claim.owner), claim.domain, claim.field, claim.condition]);
}

export function linkIdentity({ scene, result }: Snapshot, row: number) {
  const link = result.linkResources[row]!;
  const owner = link.service?.poolResource === undefined ? undefined : result.linkResources[link.service.poolResource];
  const pool = link.pool ?? owner?.pool;
  const unit = link.service?.unit ?? link.pool?.unit ?? result.options.find(o => o.linkResource === row)?.unit ?? null;
  return { connection: scene.connections[link.connection]!.id, domain: link.domain,
    direction: link.pool?.scope === "connection" ? null : link.direction,
    unit, mode: link.service?.mode ?? null, pool: pool?.id ?? null, poolDomain: owner?.domain ?? (link.pool ? link.domain : null) };
}

function bindingIdentity(snapshot: Snapshot, binding: Binding) {
  const { resource, resourceKind, run } = binding;
  if (resourceKind === "link") return [run, "link", linkIdentity(snapshot, resource)];
  const r = snapshot.scene.resources[resource]!;
  return [run, "scene", ownerIdentity(snapshot.scene, "resource", resource), r.domain, r.unit];
}

export function connectionOption({ result }: Snapshot, outcome: Outcome) {
  if (outcome.subjectKind !== "connection" || outcome.unit === undefined) return undefined;
  const rows = result.options.flatMap((o, row) => o.connection === outcome.subjectRow &&
    o.direction === outcome.direction && o.domain === outcome.domain && o.unit === outcome.unit && o.mode === outcome.mode &&
    o.pool?.domain === outcome.pool?.domain && o.pool?.id === outcome.pool?.id ? [row] : []);
  if (!rows.length) return undefined;
  const { limit, unit, bounds, condition } = bestOption(result, rows).option;
  return { limit, unit, condition, ...(limit === null && bounds ? { bounds } : {}) };
}

// 지표가 여러 번 나와도 행 순서에 기대지 않고 수량과 등장 횟수를 비교한다.
function multiset(rows: readonly unknown[]) {
  return rows.map(row => JSON.stringify(row)).sort().join("\n");
}

function fields(snapshot: Snapshot, row: number) {
  const { scene, result } = snapshot;
  const o = result.outcomes[row]!;
  const measures = result.measures.filter(m => m.outcome === row);
  const metrics = result.metrics.filter(m => m.outcome === row);
  const link = connectionOption(snapshot, o);
  const bindings = o.subjectKind !== "workload" ? [] : result.bindings
    .filter(b => b.scenario === o.scenario && b.workload === o.subjectRow).map(b => bindingIdentity(snapshot, b));
  return {
    verdict: multiset([[o.verdict],
      ...result.possibleVerdicts.filter(v => v.outcome === row).map(v => [v.verdict]),
      ...result.assessments.filter(a => a.outcome === row).map(a => [a.run, a.verdict])]),
    mode: JSON.stringify([o.domain, o.mode]),
    value: multiset([
      ...metrics.map(m => [m.kind, m.unit, m.value]),
      ...measures.filter(m => m.low === m.high).map(m => [m.run, m.kind, m.unit, m.low]),
      ...(link ? [["limit", link.unit, link.limit]] : []),
    ]),
    range: multiset([
      ...metrics.filter(m => m.range || m.low !== m.value || m.high !== m.value)
        .map(m => [m.kind, m.unit, m.low, m.high, m.range ?? null]),
      ...measures.filter(m => m.low !== m.high).map(m => [m.run, m.kind, m.unit, m.low, m.high]),
      ...(link?.bounds ? [["limit", link.unit, link.bounds.low, link.bounds.high]] : []),
    ]),
    bottleneck: multiset(bindings),
    assumption: multiset(metrics.filter(m => m.basis === "assumed").map(m => [m.kind, m.unit])),
    quest: multiset(result.quests.filter(q => q.outcome === row)
      .map(q => [claimIdentity(scene, scene.claims[q.claim]!), q.instruction])),
    condition: link?.condition ?? "",
    need: multiset(result.needs.filter(n => n.outcome === row).map(n => n.requiredCapability)),
  };
}

export function compare(a: Snapshot, b: Snapshot): readonly Difference[] {
  const before = new Map(a.result.outcomes.map((o, row) => [outcomeKey(a.scene, o), row]));
  const after = new Map(b.result.outcomes.map((o, row) => [outcomeKey(b.scene, o), row]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.flatMap<Difference>(key => {
    const left = before.get(key) ?? null;
    const right = after.get(key) ?? null;
    if (left === null) return [{ key, before: null, after: right, changed: ["added"] }];
    if (right === null) return [{ key, before: left, after: null, changed: ["removed"] }];
    const old = fields(a, left), next = fields(b, right);
    const changed = (Object.keys(old) as (keyof typeof old)[]).filter(field => old[field] !== next[field]);
    return changed.length ? [{ key, before: left, after: right, changed }] : [];
  });
}
