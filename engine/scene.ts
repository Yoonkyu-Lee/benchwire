// 장면 표의 행 번호는 한 번의 로드 안에서만 유효하고, 파일은 실물·지역 ID를 저장한다.

export type ClaimUse = "selection" | "range";
export type Value = string | number | boolean | null;
// 한 수치 주장의 501점 격자를 전부 확인할 수 있는 세계 예산이다.
export const MAX_GRID_WORLDS = 512;
export type Confidence = "official" | "review" | "community" | "user_verified" | "inferred" | "unknown";
export type Owner = "item" | "port" | "interface" | "edge" | "resource" | "mate" | "connector" | "connection" | "workload";
export interface MeasurementContext { firmware?: string | null | undefined; measurementCondition?: string | null | undefined }
export interface Claim extends MeasurementContext {
  // 입력 스키마가 허용하는 값이다. 큰 격자는 빈 배열과 numericGrid로 검산 상한을 나타낸다.
  discrete?: readonly Exclude<Value,null>[];
  numericGrid?: true;
  openDomain?: true;
  observedPorts?: ({instanceId:string; id:string} & MeasurementContext)[];
  inactive?: "firmware" | "unknownFirmware" | "measurementCondition" | "unknownMeasurementCondition" | "wiring";
  id: string; scope: "model" | "personal" | "scene" | "catalog"; ownerKind: Owner; owner: number;
  // 같은 모델 판본의 같은 주장에 기대는 실물은 후보 세계 안에서도 값을 공유한다.
  conflictGroup?: number; inferredFrom?: string;
  connectorRow?: number | null; attachmentNode?: number | null; domain: string; field: string; condition: string; value: Value; unit: string; confidence: Confidence;
}
// 순서가 같은 주장끼리는 앞선 행이 이긴다. 같은 소유자의 행 번호를 작은 번호부터 잇는다.
// claims는 색인을 만든 주장 표다. 다른 표를 가진 장면(플러그인이 만든 복사본)에는 쓰지 않는다.
interface ClaimIndex { claims: readonly Claim[]; first: Record<Owner, number[]>; next: number[] }
export type Goal = { scenario: number; id: string } & (
  | { kind: "scenario" } | { kind: "workload"; workload: number }
  | { kind: "metric"; workloads: number[]; run: "solo" | "together"; metric: string; metricDomain?: string; unit: string; minimum: number }
  | { kind: "port"; workloads: number[]; item: number; port?: number });
export interface Scene {
  // 평가 입구(evaluationScene)에서 만든다. 없으면 effectiveClaim이 주장 표 전체를 훑는다.
  claimIndex?: ClaimIndex;
  // 훅 한 번의 조회 기록이다. 평가 원본과 다른 호출에는 공유하지 않는다.
  claimReads?: Set<number>;
  // 엔진의 값 조회는 현재 세계의 표에 기록한다. 훅은 호출 범위의 조회를 모아 같은 표에 반영한다.
  claimUses?: ClaimUse[];
  id: string;
  models: { id: string; revision: string; kind: string; name: string; brand: string; category: string }[];
  items: ({ id: string; model: number; alias: string; state: string } & MeasurementContext)[];
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
  scenarios: { id: string; name?: string }[];
  goals?: Goal[];
  members: { scenario: number; workload: number; priority?: number; evidence?: number }[];
  claims: Claim[];
  sources: { id: string; title: string; locator: string; retrievedAt: string }[];
  claimSources: { claim: number; source: number; candidate?: { value: Exclude<Value, null>; confidence: Confidence; inferredFrom?: string } }[];
}

function buildClaimIndex(claims: readonly Claim[]): ClaimIndex {
  const first: ClaimIndex["first"] = { item: [], port: [], interface: [], edge: [], resource: [],
    mate: [], connector: [], connection: [], workload: [] };
  const next = new Array<number>(claims.length);
  for (let row = claims.length - 1; row >= 0; row--) {
    const { ownerKind, owner } = claims[row]!;
    const heads = first[ownerKind];
    next[row] = heads[owner] ?? -1;
    heads[owner] = row;
  }
  return { claims, first, next };
}

// 평가마다 그 장면의 주장 표로 새로 만든다. 주장 수에 비례하는 비용이라 평가 시간에 견줘 작다.
export function evaluationScene(scene: Scene): Scene {
  return { ...scene, claimIndex: buildClaimIndex(scene.claims) };
}

// 조건이 맞는 주장을 먼저 쓰고 같은 조건에서는 개인 검증을 우선한다.
export function effectiveClaim(scene: Scene, ownerKind: Owner, owner: number, domain: string, field: string, condition = "", use: ClaimUse = "selection"): number | undefined {
  let best: number | undefined, chosen: Claim | undefined;
  let rank = -1;
  const index = scene.claimIndex?.claims === scene.claims ? scene.claimIndex : undefined;
  const first = index ? index.first[ownerKind][owner] ?? -1 : 0;
  for (let row = first; row >= 0 && row < scene.claims.length; row = index ? index.next[row]! : row + 1) {
    const c = scene.claims[row]!;
    if (c.inactive || c.ownerKind !== ownerKind || c.owner !== owner || c.domain !== domain || c.field !== field) continue;
    if (c.condition && c.condition !== condition) continue;
    const priority = (c.condition === condition ? 2 : 0) + (c.scope === "personal" ? 1 : 0);
    if (priority > rank) { best = row; chosen = c; rank = priority; }
  }
  if (best!==undefined) recordRead(scene,best,chosen!,use);
  return best;
}

export function claimRows(scene:Scene) {
  return scene.claims.keys();
}

export function readClaim(scene:Scene,row:number,use:ClaimUse | "evidence"="selection"):Claim {
  const claim=scene.claims[row]!;
  recordRead(scene,row,claim,use);
  return claim;
}

function recordRead(scene:Scene,row:number,claim:Claim,use:ClaimUse | "evidence") {
  scene.claimReads?.add(row);
  if (use!=="evidence" && !scene.claimReads && scene.claimUses && claim?.value===null && scene.claimUses[row]!=="selection")
    scene.claimUses[row]=use;
}

// 값 조회와 달리 입력 형식에 필드가 존재하는지만 검사한다.
export function hasClaimPrefix(scene:Scene,kind:Owner,owner:number,domain:string,prefix:string) {
  const index=scene.claimIndex?.claims===scene.claims ? scene.claimIndex : undefined;
  for (let row=index ? index.first[kind][owner] ?? -1 : 0;row>=0 && row<scene.claims.length;row=index ? index.next[row]! : row+1) {
    const c=scene.claims[row]!;
    if (!c.inactive && c.ownerKind===kind && c.owner===owner && c.domain===domain && c.field.startsWith(prefix)) return true;
  }
  return false;
}

// 관측 당시의 양 끝과 모든 경유 부품을 지금 배선과 같은 순서의 영속 ID로 비교한다.
export function connectionPorts(scene: Scene, row: number) {
  const c = scene.connections[row]!;
  return [c.from,...scene.parts.filter(p=>p.connection===row).flatMap(p=>[p.entry,p.exit]),c.to].map(port=>{
    const p=scene.ports[port]!, item=scene.items[p.item]!;
    return {instanceId:item.id,id:p.id,firmware:item.firmware,measurementCondition:item.measurementCondition};
  });
}

export function portFacts(scene: Scene, row: number) {
  const attachment = effectiveClaim(scene, "port", row, "", "attachment")!;
  const connectorClaim = effectiveClaim(scene, "port", row, "", "connector")!;
  return { ...scene.ports[row]!, attachment, connectorClaim, node: readClaim(scene,attachment).attachmentNode ?? null,
    connector: readClaim(scene,connectorClaim).connectorRow ?? null };
}

export function resourceFacts(scene: Scene, row: number) {
  const domain = scene.resources[row]!.domain;
  return { capacity: effectiveClaim(scene, "resource", row, domain, "capacity", "", "range")!,
    policy: effectiveClaim(scene, "resource", row, domain, "policy")! };
}

// 부착점은 같은 실물의 모든 내부 노드 중 하나다.
export function attachmentCandidates(scene: Scene) {
  const ports = new Set([...scene.connections.flatMap(c => [c.from, c.to]), ...scene.parts.flatMap(p => [p.entry, p.exit])]);
  const candidates = new Map<number, number[]>();
  for (const port of ports) if (portFacts(scene,port).node === null) {
    const item=scene.ports[port]!.item;
    candidates.set(port,scene.nodes.flatMap((n,i)=>n.item===item ? [i] : []));
  }
  return candidates;
}
