// 결합 판정 어댑터는 후보 문서를 받고 해당 연결 ID의 확정된 mate 불일치만 거절한다.
import { portKey, type SceneDocument } from "./document.ts";

export type ConnectionCheck = (candidate: SceneDocument, id: string) =>
  | ConnectionDecision | Promise<ConnectionDecision>;
export type ConnectionDecision =
  | { allowed: true }
  | { allowed: false; reason: string; required: readonly string[] };

export function occupiedPorts(scene: SceneDocument) {
  return new Set(scene.connections.flatMap(c => [
    portKey(c.from), portKey(c.to),
    ...c.parts.flatMap(p => [portKey({ instanceId: p.instanceId, id: p.entry }), portKey({ instanceId: p.instanceId, id: p.exit })]),
  ]));
}
