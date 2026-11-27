// 편집할 포트의 점유와 후보 배선에 필요한 결합 형태를 확인한다.
import type { Scene } from "../engine/contract.ts";
import { physicalSteps } from "../engine/physical.ts";
import { portKey, type SceneDocument, type SceneIntent } from "./document.ts";

export function requiredMateCapabilities(scene: Scene, id: string) {
  const row = scene.connections.findIndex(connection => connection.id === id);
  const steps = [...physicalSteps(scene, row, "forward"), ...physicalSteps(scene, row, "reverse")];
  return [...new Set(steps.filter(step => step.kind === "mate" && step.verdict === "impossible").map(step => step.required))];
}

export function moveConnectionEnd(scene: SceneDocument, { id, end, target }: Extract<SceneIntent, { kind: "move-connection-end" }>) {
  const index = scene.connections.findIndex(row => row.id === id);
  const edge = scene.connections[index];
  if (!edge || occupiedPorts(scene).has(portKey(target))) return undefined;
  return { ...scene, connections: scene.connections.with(index, { ...edge, [end]: target }) };
}

export function occupiedPorts(scene: SceneDocument) {
  return new Set(scene.connections.flatMap(c => [
    portKey(c.from), portKey(c.to),
    ...c.parts.flatMap(p => [portKey({ instanceId: p.instanceId, id: p.entry }), portKey({ instanceId: p.instanceId, id: p.exit })]),
  ]));
}
