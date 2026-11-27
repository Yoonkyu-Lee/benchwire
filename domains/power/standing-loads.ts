// 패스스루 상시 소비를 입력 링크와 그 포트에 공급하는 소스 내부 전력 예산에 연결한다.
// 입력 링크의 물리 판정과 여러 장치를 직렬로 잇는 상위 공급 경로는 이 훅에서 확인할 수 없다.
import { effectiveClaim, type Scene, type StandingLoad } from "../../engine/contract.ts";
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
      const start = scene.claims[attachment]!.reference;
      if (start != null) {
        // 출력 노드에서 거슬러 올라가 실제로 그 포트에 공급하는 내부 엣지의 자원만 차감한다.
        inputs.push(attachment);
        const upstream = new Set([start]);
        for (const node of upstream) scene.edges.forEach((edge, row) => {
          if (edge.item !== sourceItem || edge.to !== node) return;
          upstream.add(edge.from);
          inputs.push(edge.evidence);
          for (const use of scene.resourceUses) {
            if (use.edge !== row) continue;
            const resource = scene.resources[use.resource]!;
            if (resource.domain !== POWER || resource.unit !== POWER_UNIT) continue;
            if (!targets.some(t => "resource" in t && t.resource === use.resource)) targets.push({ resource: use.resource });
            inputs.push(use.evidence);
          }
        });
      }

      const amount = scene.claims[reserve]!.value as number | null;
      loads.push({ item: scene.ports[to]!.item, id: "reserveW:" + scene.ports[to]!.id, amount, unit: POWER_UNIT, targets,
        rule: amount === null ? "패스스루 자체 소비 미확인" : `패스스루 자체 소비 ${amount} W 우선 사용`, inputs, specs: option.specs });
    }
  });
  return loads;
}
