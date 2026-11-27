// 장면 표의 행 번호는 한 번의 로드 안에서만 유효하고, 파일은 실물·지역 ID를 저장한다.

export type Value = string | number | boolean | null;
export type Confidence = "official" | "review" | "community" | "user_verified" | "inferred" | "unknown";
export type Owner = "item" | "port" | "interface" | "edge" | "resource" | "mate" | "connector" | "connection" | "workload";
export interface Claim {
  id: string; scope: "model" | "personal" | "scene" | "catalog"; ownerKind: Owner; owner: number;
  // 같은 모델 판본의 같은 주장에 기대는 실물은 후보 세계 안에서도 값을 공유한다.
  conflictGroup?: number; inferredFrom?: string;
  reference?: number | null; domain: string; field: string; condition: string; value: Value; unit: string; confidence: Confidence;
}
export interface Scene {
  id: string;
  models: { id: string; revision: string; kind: string; name: string; brand: string; category: string }[];
  items: { id: string; model: number; alias: string; state: string }[];
  nodes: { item: number; id: string; kind: string; label: string }[];
  ports: { item: number; id: string; label: string; location: string }[];
  interfaces: { id: string; port: number; domain: string; protocol: string; role: string; evidence: number }[];
  edges: { id: string; item: number; from: number; to: number; evidence: number }[];
  resources: { id: string; item: number; domain: string; kind: string; unit: string }[];
  resourceUses: { edge: number; resource: number; evidence: number }[];
  connectors: { id: string; endForm: number }[];
  mates: { a: number; b: number; evidence: number }[];
  connections: { id: string; from: number; to: number; evidence: number }[];
  parts: { connection: number; order: number; item: number; entry: number; exit: number }[];
  workloads: { id: string; domain: string; kind: string; from: number; to: number }[];
  scenarios: { id: string }[];
  members: { scenario: number; workload: number; priority?: number; evidence?: number }[];
  claims: Claim[];
  sources: { id: string; title: string; locator: string; retrievedAt: string }[];
  claimSources: { claim: number; source: number; candidate?: { value: Exclude<Value, null>; confidence: Confidence; inferredFrom?: string } }[];
}

// 조건이 맞는 주장을 먼저 쓰고 같은 조건에서는 개인 검증을 우선한다.
export function effectiveClaim(scene: Scene, ownerKind: Owner, owner: number, domain: string, field: string, condition = ""): number | undefined {
  let best: number | undefined;
  let rank = -1;
  scene.claims.forEach((c, row) => {
    if (c.ownerKind !== ownerKind || c.owner !== owner || c.domain !== domain || c.field !== field) return;
    if (c.condition && c.condition !== condition) return;
    const priority = (c.condition === condition ? 2 : 0) + (c.scope === "personal" ? 1 : 0);
    if (priority > rank) { best = row; rank = priority; }
  });
  return best;
}

export function portFacts(scene: Scene, row: number) {
  const attachment = effectiveClaim(scene, "port", row, "", "attachment")!;
  const connectorClaim = effectiveClaim(scene, "port", row, "", "connector")!;
  return { ...scene.ports[row]!, attachment, connectorClaim, node: scene.claims[attachment]!.reference ?? null,
    connector: scene.claims[connectorClaim]!.reference ?? null };
}

export function resourceFacts(scene: Scene, row: number) {
  const domain = scene.resources[row]!.domain;
  return { capacity: effectiveClaim(scene, "resource", row, domain, "capacity")!,
    policy: effectiveClaim(scene, "resource", row, domain, "policy")! };
}

// 간선·포트·작업의 끝과 경유 노드는 서로 구별한다. 나머지 고립 노드는 포트끼리 일치하거나 갈라지는 수만큼 대표한다.
export function attachmentCandidates(scene: Scene, via: readonly number[]) {
  const ports = new Set([...scene.connections.flatMap(c => [c.from, c.to]), ...scene.parts.flatMap(p => [p.entry, p.exit])]);
  const unknown = [...ports].filter(p => portFacts(scene,p).node === null);
  const candidates = new Map<number, number[]>();
  if (!unknown.length) return candidates;
  const relevant = new Set([...scene.edges.flatMap(e => [e.from,e.to]), ...scene.workloads.flatMap(w => [w.from,w.to]), ...via]);
  for (const port of ports) {
    const node = portFacts(scene, port).node;
    if (node !== null) relevant.add(node);
  }
  for (const item of new Set(unknown.map(p => scene.ports[p]!.item))) {
    const pending = unknown.filter(p => scene.ports[p]!.item === item);
    const local = scene.nodes.flatMap((n,i) => n.item === item ? [i] : []);
    const isolated = local.filter(n => !relevant.has(n)).slice(0, pending.length);
    const nodes = [...local.filter(n => relevant.has(n)), ...isolated];
    for (const p of pending) candidates.set(p, nodes);
  }
  return candidates;
}
