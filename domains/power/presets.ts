// 충전 요청과 실물의 소비량은 사용자가 정할 때까지 미확인으로 둔다.
import { POWER_UNIT } from "./input.ts";

export const powerDomainName = "전력";
export const powerPresets = [{
  kind: "charge", name: "USB PD 충전",
  request: { requestedW: { value: null, unit: POWER_UNIT }, loadW: { value: null, unit: POWER_UNIT } },
  labels: { requestedW: "요청 전력", loadW: "기기 소비 전력", targetW: "목표 순충전" },
}];
