// display 영역의 스키마, 영상 협상, 작업 수요와 내부 자원 예약을 엔진 계약에 붙인다.
import type { DomainPlugin, Verdict } from "../../engine/contract.ts";
import { displayDemand, DSC_PREFIX, VIDEO_UNIT } from "./demand.ts";
import { attributes, params, request } from "./input.ts";
import { negotiateDisplay } from "./negotiate.ts";
import { sources } from "./sources.ts";

const labels: Record<Verdict, string> = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const display: DomainPlugin = {
  id: "display", sources, params, attributes, request, negotiate: negotiateDisplay, demand: displayDemand,
  consume(scene, _workload, steps) {
    return steps.flatMap(step => step.kind === "edge" ? scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row) return [];
      const resource = scene.resources[use.resource]!;
      if (resource.domain !== "display" || resource.unit !== VIDEO_UNIT) return [];
      return [{ resource: use.resource, coefficient: 1, fixed: 0,
        rule: "내부 영상 자원에서 이 스트림의 대역폭 예약", inputs: [use.evidence], specs: [] }];
    }) : []);
  },
  explain(verdict, mode) {
    const label = mode.startsWith(DSC_PREFIX) ? "DSC 영상" : "영상";
    return label + " " + labels[verdict];
  },
  quest(field) {
    if (field === "attachment") return "이 포트가 어느 출력 GPU에 연결되는지 확인하세요.";
    if (field === "dscBpp") return "송신 인코더와 수신 디코더에서 사용할 수 있는 DSC 목표 bpp를 확인하세요.";
    if (field === "pin") return "USB-C 연결의 DP Alt Mode 핀 할당을 확인하세요.";
    return "영상 연결의 " + field + " 값을 확인하세요.";
  },
};
