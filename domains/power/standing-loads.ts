// 패스스루 상시 소비를 입력 링크와 그 포트에 공급하는 소스 내부 전력 예산에 연결한다.
// 입력 링크의 물리 판정과 여러 장치를 직렬로 잇는 상위 공급 경로는 이 훅에서 확인할 수 없다.
import { readClaim, effectiveClaim, type Scene, type StandingLoad } from "../../engine/contract.ts";
import { PD, POWER, POWER_UNIT } from "./input.ts";
import { negotiatePower } from "./negotiate.ts";

export function standingLoads(scene: Scene): StandingLoad[] {
  const loads: StandingLoad[] = [];
  scene.connections.forEach((c, connection) => {
    for (const direction of ["forward", "reverse"] as const) {
      const [from, to] = direction === "forward" ? [c.from, c.to] : [c.to, c.from];
      const sink = scene.interfaces.findIndex(i => i.port === to && i.domain === POWER && i.protocol === PD && i.role === "sink");
      if (sink < 0) continue;
      const reserve = effectiveClaim(scene, "interface", sink, POWER, "reserveW");
      if (reserve === undefined) continue;

      const parts = scene.parts.filter(p => p.connection === connection).sort((a, b) => a.order - b.order);
      const through = parts.flatMap(p => [p.entry, p.exit]);
      if (direction === "reverse") through.reverse();
      const [option] = negotiatePower({ scene, connection, direction, ports: [from, ...through, to] });
      if (option.verdict === "impossible") continue;

      const targets: StandingLoad["targets"][number][] = [{ connection, direction, domain: POWER, mode: PD }];
      const inputs = [reserve, c.evidence, ...option.inputs];
      const sourceItem = scene.ports[from]!.item;
      const attachment = effectiveClaim(scene, "port", from, "", "attachment")!;
      const start = readClaim(scene,attachment).attachmentNode;
      inputs.push(attachment);
      // 부착점이 미확인이면 이 실물의 후보 노드마다 연결될 수 있는 자원을 보존한다.
      const upstream = new Set(start == null ? scene.nodes.flatMap((node, i) => node.item === sourceItem ? [i] : []) : [start]);
      for (const node of upstream) scene.edges.forEach((edge, row) => {
        if (edge.item !== sourceItem || edge.to !== node) return;
        upstream.add(edge.from);
        inputs.push(edge.evidence);
        for (const use of scene.resourceUses) {
          if (use.edge !== row) continue;
          const resource = scene.resources[use.resource]!;
          if (resource.unit !== POWER_UNIT) continue;
          if (!targets.some(t => "resource" in t && t.resource === use.resource))
            targets.push({ resource: use.resource, ...(start == null ? { possible: true } : {}) });
          inputs.push(use.evidence);
        }
      });

      const amount = readClaim(scene,reserve).value as number | null;
      loads.push({ item: scene.ports[to]!.item, id: "reserveW:" + scene.ports[to]!.id, amount, unit: POWER_UNIT, targets,
        rule: amount === null ? "패스스루 자체 소비 미확인" : `패스스루 자체 소비 ${amount} W 우선 사용`, inputs, specs: option.specs });
    }
  });
  return loads;
}
