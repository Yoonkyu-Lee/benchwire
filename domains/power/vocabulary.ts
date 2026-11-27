// USB PD 인터페이스 표시 어휘와 미확인 값으로 시작하는 충전 요청을 둔다.
import { CABLE, PD, POWER_UNIT } from "./input.ts";

export const powerDomainName = "전력";
export const powerInterfaces = [
  { id: PD, name: "USB PD 충전", roles: ["source", "sink"] },
  { id: CABLE, name: "USB-C 전력 케이블", roles: ["cable"] },
];
export const powerPresets = [{
  kind: "charge", name: "USB PD 충전",
  request: { requestedW: { value: null, unit: POWER_UNIT }, loadW: { value: null, unit: POWER_UNIT } },
}];
