// 슬롯 교체 사본을 만들고, 연결·작업·목표에서 대응이 불확실한 위치의 선택지를 돌려준다.
import { plugins } from "../domains/registry.ts";
import { compare, type Snapshot } from "../engine/compare.ts";
import type { Documents } from "./assessment.ts";
import { modelKey, type Model, type Port, type PortRef, type SceneDocument } from "./document.ts";

interface SwapOptions {
  originalId: string;
  replacementId: string;
  sceneId: string;
  replacement: Model;
  choices?: ReadonlyMap<string, string> | undefined;
}
type Endpoint = { id: string; label: string };
export interface SwapChoice {
  key: string;
  kind: "port" | "node";
  source: string;
  label: string;
  uses: readonly string[];
  options: readonly Endpoint[];
}
interface PortUse { partners: PortRef[]; uses: Set<string>; occupied: boolean }

const pairKey = (a: string, b: string) => JSON.stringify(a < b ? [a, b] : [b, a]);
const endpointKey = (kind: SwapChoice["kind"], id: string) => JSON.stringify([kind, id]);
function known(claim: Port["connector"] | undefined) {
  return claim?.conflicts?.length || typeof claim?.value !== "string" ? undefined : claim.value;
}

export function swapSlot(scene: SceneDocument, documents: Documents, options: SwapOptions):
  { document: SceneDocument | null; pending: readonly SwapChoice[] } {
  const { originalId, replacementId, sceneId, replacement, choices } = options;
  const items = new Map(scene.items.map(item => [item.instanceId, item]));
  const original = items.get(originalId);
  if (!original || !replacementId || items.has(replacementId) || !sceneId || scene.sceneId === sceneId)
    throw new Error("교체할 실물과 사본의 새 ID가 필요합니다.");
  const before = documents.models.get(modelKey(original));
  if (!before) throw new Error("교체할 실물의 모델 판본을 찾을 수 없습니다.");

  const ports = new Map<string, PortUse>();
  const localPairs: [string, string][] = [];
  function usePort(ref: PortRef, use: string, partner?: PortRef) {
    if (ref.instanceId !== originalId) return;
    const row = ports.get(ref.id) ?? { partners: [], uses: new Set<string>(), occupied: false };
    if (partner) {
      row.partners.push(partner);
      row.occupied = true;
    }
    row.uses.add(use);
    ports.set(ref.id, row);
  }
  for (const edge of scene.connections) {
    const chain = [edge.from, ...edge.parts.flatMap(part => [
      { instanceId: part.instanceId, id: part.entry }, { instanceId: part.instanceId, id: part.exit },
    ]), edge.to];
    for (let i = 0; i < chain.length; i += 2) {
      const a = chain[i]!, b = chain[i + 1]!;
      usePort(a, "연결 " + edge.id, b);
      usePort(b, "연결 " + edge.id, a);
      if (a.instanceId === originalId && b.instanceId === originalId) localPairs.push([a.id, b.id]);
    }
  }

  for (const scenario of scene.scenarios) for (const goal of scenario.goals ?? []) {
    if (goal.kind === "port" && goal.portId !== undefined) {
      usePort({ instanceId: goal.instanceId, id: goal.portId }, "목표 " + (goal.label ?? goal.id));
    }
  }

  const nodes = new Map<string, Set<string>>();
  const portNodes = new Set(before.ports.filter(port => known(port.attachment) === port.id).map(port => port.id));
  function useNode(ref:PortRef, use:string) {
    if (ref.instanceId !== originalId) return;
    const uses = nodes.get(ref.id) ?? new Set<string>();
    uses.add(use);
    nodes.set(ref.id, uses);
    if (portNodes.has(ref.id) && !replacement.nodes.some(node => node.id === ref.id)) usePort(ref,use);
  }

  const workloads=structuredClone(scene.workloads);
  type Sample = Pick<SceneDocument["workloads"][number]["request"][string], "value">;
  const instanceClaims: Sample[]=[];
  const nodeClaims: {source:string; sample:Sample}[]=[];
  const sharedNames=new Set<string>(), uniqueNames=new Set<string>();
  const conflictNodes:string[][]=[];
  const otherNodes=new Set(scene.items.filter(i=>i!==original).flatMap(i=>
    documents.models.get(modelKey(i))?.nodes.map(n=>n.id) ?? []));
  for (const work of workloads) {
    const use="작업 "+work.id;
    useNode(work.from,use);
    useNode(work.to,use);
    const plugin=plugins.find(p=>p.id===work.domain);
    for (const {instanceField,nodeField} of plugin?.requestNodes ?? []) {
      const instance=work.request[instanceField], node=work.request[nodeField];
      if (!instance || !node) continue;
      const owners=[instance,...(instance.conflicts ?? [])];
      const open=instance.value===null;
      if (!open && !owners.some(sample=>sample.value===originalId)) continue;
      const shared=owners.some(sample=>sample.value!==null && sample.value!==originalId);
      const candidates:string[]=[];
      for (const sample of [node,...(node.conflicts ?? [])]) {
        if (typeof sample.value!=="string") continue;
        const source=sample.value;
        candidates.push(source);
        if (open && !before.nodes.some(n=>n.id===source)) continue;
        // 실물 후보들이 노드 주장 하나를 공유하면 다른 실물의 경유 위치도 보존해야 한다.
        if (shared || open && otherNodes.has(source)) sharedNames.add(source);
        else if (open) uniqueNames.add(source);
        useNode({instanceId:originalId,id:source},sharedNames.has(source) ? use+" · 다른 경유 실물과 같은 노드 ID" : use);
        nodeClaims.push({source,sample});
      }
      if (candidates.length>1) conflictNodes.push(candidates);
      for (const sample of owners) if (sample.value===originalId) instanceClaims.push(sample);
    }
  }

  const mates = new Set(documents.connectors.mates.map(mate => pairKey(mate.a, mate.b)));
  function connector(ref: PortRef) {
    const item = items.get(ref.instanceId);
    const model = item && documents.models.get(modelKey(item));
    return known(model?.ports.find(port => port.id === ref.id)?.connector);
  }
  function choice(kind: SwapChoice["kind"], source: Endpoint, use: ReadonlySet<string>, options: Endpoint[]) {
    return { kind, key: endpointKey(kind, source.id), source: source.id, label: source.label, uses: [...use], options };
  }
  function select(row: SwapChoice, automatic = row.source) {
    const chosen = choices?.get(row.key) ?? automatic;
    const matches = row.options.filter(target => target.id === chosen);
    return matches.length === 1 ? matches[0]!.id : undefined;
  }

  const portTargets = new Map<string, string>();
  const portChoices = new Map<string, SwapChoice>();
  const occupied = new Map<string, string[]>();
  for (const [id, { partners, uses, occupied: physical }] of ports) {
    const old = before.ports.find(port => port.id === id)!;
    const oldConnector = known(old.connector);
    const peers = partners.filter(peer => peer.instanceId !== originalId).map(connector);
    const options = replacement.ports.filter(port => {
      const candidate = known(port.connector);
      return candidate !== undefined && (peers.length > 0
        ? peers.every(peer => peer === undefined ? candidate === oldConnector : mates.has(pairKey(candidate, peer)))
        : partners.length > 0 || candidate === oldConnector);
    }).map(({ id, label }) => ({ id, label }));
    const row = choice("port", old, uses, options);
    portChoices.set(id, row);
    const target = select(row);
    if (target === undefined) continue;
    portTargets.set(id, target);
    if (physical) occupied.set(target, [...occupied.get(target) ?? [], id]);
  }
  for (const ids of occupied.values()) if (ids.length > 1) for (const id of ids) portTargets.delete(id);
  const connectors = new Map(replacement.ports.map(port => [port.id, known(port.connector)]));
  for (const [a, b] of localPairs) {
    const left = connectors.get(portTargets.get(a) ?? ""), right = connectors.get(portTargets.get(b) ?? "");
    if (left && right && !mates.has(pairKey(left, right))) {
      portTargets.delete(a);
      portTargets.delete(b);
    }
  }
  const pending = [...portChoices.values()].filter(row => !portTargets.has(row.source));

  const nodeTargets = new Map<string, string>();
  const nodeChoices = new Map<string, SwapChoice>();
  for (const [id, uses] of nodes) {
    const throughPort = portNodes.has(id) && !replacement.nodes.some(node => node.id === id);
    const port = throughPort ? portTargets.get(id) : undefined;
    if (throughPort && !port) continue;
    const automatic = port ? known(replacement.ports.find(row => row.id === port)?.attachment) ?? id : id;
    const row = choice("node", before.nodes.find(node => node.id === id)!, uses,
      replacement.nodes.filter(n=>(!sharedNames.has(id) || n.id===id) && (!uniqueNames.has(id) || !otherNodes.has(n.id)))
        .map(({ id, label }) => ({ id, label })));
    nodeChoices.set(id,row);
    const target = select(row, automatic);
    if (target !== undefined) nodeTargets.set(id,target);
  }
  // 다른 값이라는 두 출처를 같은 노드에 대응하면 저장할 수 없는 충돌 주장이 된다.
  for (const group of conflictNodes) {
    const sources=Map.groupBy(new Set(group),id=>nodeTargets.get(id) ?? id);
    for (const ids of sources.values()) if (ids.length>1) for (const id of ids) nodeTargets.delete(id);
  }
  pending.push(...[...nodeChoices.values()].filter(row=>!nodeTargets.has(row.source)));
  if (pending.length) return { document: null, pending };

  for (const sample of instanceClaims) sample.value=replacementId;
  for (const {source,sample} of nodeClaims) sample.value=nodeTargets.get(source)!;
  function remap(ref: PortRef, targets: ReadonlyMap<string, string>) {
    return ref.instanceId === originalId ? { instanceId: replacementId, id: targets.get(ref.id)! } : ref;
  }
  return {
    document: {
      ...scene, sceneId,
      items: scene.items.map(item => item === original
        ? { instanceId: replacementId, modelId: replacement.modelId, revision: replacement.revision, state: "candidate" }
        : item),
      connections: scene.connections.map(edge => ({
        ...edge, from: remap(edge.from, portTargets), to: remap(edge.to, portTargets),
        parts: edge.parts.map(part => part.instanceId === originalId
          ? { instanceId: replacementId, entry: portTargets.get(part.entry)!, exit: portTargets.get(part.exit)! }
          : part),
      })),
      workloads: workloads.map(work => ({ ...work, from: remap(work.from, nodeTargets), to: remap(work.to, nodeTargets) })),
      scenarios: scene.scenarios.map(scenario => !scenario.purchases && !scenario.goals ? scenario : {
        ...scenario,
        ...(scenario.purchases && { purchases: scenario.purchases.map(row =>
          ("instanceId" in row && row.instanceId === originalId || "ownedInstanceId" in row && row.ownedInstanceId === originalId)
            ? { instanceId: replacementId, ...(row.need && { need: row.need }) } : row) }),
        ...(scenario.goals && { goals: scenario.goals.map(goal => goal.kind === "port" && goal.instanceId === originalId
          ? { ...goal, instanceId: replacementId, ...(goal.portId !== undefined && { portId: portTargets.get(goal.portId)! }) }
          : goal) }),
      }),
      ...(scene.personal && { personal: scene.personal.filter(row => row.instanceId !== originalId) }),
      ...(scene.layout?.placements && { layout: { ...scene.layout, placements: scene.layout.placements.map(row =>
        row.instanceId === originalId ? { ...row, instanceId: replacementId } : row) } }),
    },
    pending,
  };
}

// 판정한 뒤 비교 자리에서만 두 실물의 ID를 맞춰 병목·퀘스트의 기술 변화만 남긴다.
export function compareSwap(before: Snapshot, after: Snapshot, originalId: string, replacementId: string) {
  const items = after.scene.items.map(item => item.id === replacementId ? { ...item, id: originalId } : item);
  return compare(before, { ...after, scene: { ...after.scene, items } });
}
