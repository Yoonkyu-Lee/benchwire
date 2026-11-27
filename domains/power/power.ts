// USB PD 협상과 전력 수요 및 내부 예산 소비를 엔진 계약에 붙인다.
import { effectiveClaim, type DomainPlugin, type Verdict } from "../../engine/contract.ts";
import { attributes, params, paramsFor, PD, POWER, POWER_UNIT, request } from "./input.ts";
import { negotiatePower } from "./negotiate.ts";
import { sources } from "./sources.ts";

const labels: Record<Verdict, string> = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const power: DomainPlugin = {
  id: POWER, sources, params, paramsFor, attributes, request, resourceUnits: [POWER_UNIT],
  negotiate: negotiatePower,
  demand(scene, workload) {
    const claim = effectiveClaim(scene, "workload", workload, POWER, "requestedW")!;
    const requested = scene.claims[claim]!.value as number | null;
    return [{ mode: PD, unit: POWER_UNIT, requested, elastic: true, via: [], preference: 0,
      rule: "요청 전달 전력", inputs: [claim], specs: [] }];
  },
  consume(scene, _workload, steps) {
    return steps.flatMap(step => step.kind !== "edge" ? [] : scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row) return [];
      const resource = scene.resources[use.resource]!;
      if (resource.domain !== POWER || resource.unit !== POWER_UNIT) return [];
      return [{ resource: use.resource, coefficient: 1, fixed: 0,
        rule: "내부 총 전력 예산을 지나는 전달 전력", inputs: [use.evidence], specs: [] }];
    }));
  },
  explain(verdict) { return "전력 전달 " + labels[verdict]; },
  quest(field) {
    if (field.startsWith("budget:")) return "현재 접속 포트 조합의 출력 한도(W)를 확인하세요.";
    if (field === "currentA" || field === "eMarked" || field === "eprVoltage")
      return "USB-C 케이블의 전자 표지, 정격 전류와 EPR 전압을 확인하세요.";
    if (field === "reserveW") return "패스스루 입력에서 중간 장치가 먼저 쓰는 전력(W)을 확인하세요.";
    return "전력 경로의 " + field + " 값을 확인하세요.";
  },
};
