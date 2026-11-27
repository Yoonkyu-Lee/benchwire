// display 영역의 스키마, 영상 협상, 작업 수요와 내부 자원 예약을 엔진 계약에 붙인다.
import type { Consumption, DomainPlugin, Verdict } from "../../engine/contract.ts";
import { displayDemand, VIDEO_UNIT } from "./demand.ts";
import { DSC_MODE, matchDisplay } from "./dsc.ts";
import { attributes, params, paramsFor, request } from "./input.ts";
import { negotiateDisplay } from "./negotiate.ts";
import { sources } from "./sources.ts";

const labels: Record<Verdict, string> = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };
const STREAM_UNIT = "streams";

export const display: DomainPlugin = {
  id: "display", sources, params, paramsFor, attributes, request, resourceUnits: [VIDEO_UNIT, STREAM_UNIT],
  negotiate: negotiateDisplay, demand: displayDemand, match: matchDisplay,
  consume(scene, _workload, steps) {
    const streams = new Map<number, number[]>();
    const consumption: Consumption[] = [];
    for (const step of steps) {
      if (step.kind !== "edge") continue;
      for (const use of scene.resourceUses) {
        if (use.edge !== step.row) continue;
        const resource = scene.resources[use.resource]!;
        if (resource.domain !== "display") continue;
        if (resource.unit === STREAM_UNIT) {
          const inputs = streams.get(use.resource) ?? [];
          inputs.push(use.evidence);
          streams.set(use.resource, inputs);
        } else if (resource.unit === VIDEO_UNIT) {
          consumption.push({ resource: use.resource, coefficient: 1, fixed: 0,
            rule: "내부 영상 자원에서 이 스트림의 대역폭 예약", inputs: [use.evidence], specs: [] });
        }
      }
    }
    for (const [resource, inputs] of streams)
      consumption.push({ resource, coefficient: 0, fixed: 1, rule: "장비 내부 자원에서 동시 영상 스트림 한 자리 예약", inputs, specs: [] });
    return consumption;
  },
  explain(verdict, mode) {
    const label = mode === DSC_MODE ? "DSC 영상" : "영상";
    return label + " " + labels[verdict];
  },
  quest(field) {
    if (field === "attachment") return "이 포트가 어느 출력 GPU에 연결되는지 확인하세요.";
    if (field === "dscBpp") return "송신 인코더와 수신 디코더에서 사용할 수 있는 DSC 목표 bpp를 확인하세요.";
    if (field === "pin") return "USB-C 연결의 DP Alt Mode 핀 할당을 확인하세요.";
    if (field === "frlCode") return "HDMI 포트나 케이블이 지원하는 최대 FRL 코드를 확인하세요.";
    if (field === "lanes") return "DP 포트나 케이블이 지원하는 최대 레인 수를 확인하세요.";
    if (field === "fallbackRefresh") return "허용할 폴백 주사율(Hz)을 확인하세요.";
    if (field === "capacity") return "동시 영상 스트림 수 또는 영상 대역폭 한도를 확인하세요.";
    return "영상 연결의 " + field + " 값을 확인하세요.";
  },
};
