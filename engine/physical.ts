// 연결의 맞물림과 부품 내부의 유향 통로를 신호 진행 순서대로 확인한다.
import type { Direction, Scene } from "./contract.ts";
import type { PhysicalStep } from "./results.ts";
import { portFacts } from "./scene.ts";
import { routes } from "./route.ts";

export function physicalSteps(scene: Scene, connection: number, direction: Direction): PhysicalStep[] {
  const c = scene.connections[connection]!;
  const forward = direction === "forward";
  const parts = scene.parts.filter(p => p.connection === connection).sort((a, b) => forward ? a.order - b.order : b.order - a.order);
  let prior = forward ? c.from : c.to;
  const steps: PhysicalStep[] = [];
  function mate(exit: number) {
    const first = portFacts(scene, prior), second = portFacts(scene, exit);
    const inputs = [c.evidence, first.connectorClaim, second.connectorClaim];
    for (const port of [first, second]) if (port.connector !== null) inputs.push(scene.connectors[port.connector]!.endForm);
    if (first.connector === null || second.connector === null) {
      steps.push({ connection, direction, order: steps.length, kind: "mate", entry: prior, exit, verdict: "unknown", required: "", passages: [], truncated: false, inputs });
      return;
    }
    const pair = scene.mates.find(m => m.a === first.connector && m.b === second.connector || m.b === first.connector && m.a === second.connector);
    const accepted = scene.mates.filter(m => m.a === first.connector || m.b === first.connector)
      .map(m => scene.connectors[m.a === first.connector ? m.b : m.a]!.id).sort();
    steps.push({ connection, direction, order: steps.length, kind: "mate", entry: prior, exit, verdict: pair ? "ok" : "impossible",
      required: pair ? "" : accepted.join(" / ") || scene.connectors[first.connector]!.id + " 결합 부품", passages: [], truncated: false,
      inputs: [...inputs, ...(pair ? [pair.evidence] : scene.mates.filter(m => m.a === first.connector || m.b === first.connector).map(m => m.evidence))] });
  }
  for (const part of parts) {
    const entry = forward ? part.entry : part.exit, exit = forward ? part.exit : part.entry;
    mate(entry);
    const a = portFacts(scene, entry), b = portFacts(scene, exit);
    const arcs = scene.edges.flatMap((e, row) => e.item === part.item ? [{ ...e, row, key: e.id }] : []);
    const passage = a.node === null || b.node === null ? null : routes(arcs, a.node, b.node);
    const verdict = a.node === null || b.node === null ? "unknown" : passage?.found.length ? "ok" : "impossible";
    steps.push({ connection, direction, order: steps.length, kind: "part", entry, exit, verdict,
      required: verdict === "impossible" ? a.id + " → " + b.id + " 방향의 변환" : "",
      passages: (passage?.found ?? []).map(path => path.map(e => e.row)), truncated: passage?.truncated ?? false,
      inputs: [c.evidence, a.attachment, b.attachment, ...(passage?.found[0] ?? arcs).map(e => e.evidence)] });
    prior = exit;
  }
  mate(forward ? c.to : c.from);
  return steps;
}
