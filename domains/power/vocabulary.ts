// USB PD 인터페이스 표시 어휘와 미확인 값으로 시작하는 충전 요청을 둔다.
import { CABLE, PD, POWER_UNIT } from "./input.ts";
import { USB_PD_FIXED_SOURCE_LIMITS } from "./constants.ts";

export const powerQuests = [
  { ownerKind: "resource", field: "capacity", title: "총 출력", steps: [
    "충전기의 표시나 설명서에서 지금 연결한 포트 조합의 전체 출력 한도를 확인하세요.",
    "실측할 때는 해당 포트 조합을 유지하고 PD 전력계로 각 포트의 최대 동시 출력을 확인하세요.",
  ], read: "연결된 포트 전체의 출력 한도(W). Windows 배터리 전력은 수전 기기의 값입니다." },
  { ownerKind: "interface", field: "maxW", protocol: PD, title: "포트 최대 전력", steps: [
    "충전기의 포트 표시 또는 설명서에서 이 포트와 현재 접속 조합의 출력 한도를 확인하세요.",
  ], read: "해당 USB PD 포트의 최대 전력(W)" },
  ...USB_PD_FIXED_SOURCE_LIMITS.map(({ voltageV }) => ({ ownerKind: "interface", field: `pdo${voltageV}`, protocol: PD,
    title: `${voltageV} V 송전 PDO`, steps: ["PD 분석기를 해당 포트에 연결하고 송전 기기가 광고한 고정 PDO 목록을 여세요."],
    read: `${voltageV} V 항목의 최대 전류(A). 목록에 해당 전압이 없으면 0 A를 입력하세요.` })),
];

export const powerDomainName = "전력";
export const powerInterfaces = [
  { id: PD, name: "USB PD 충전", roles: ["source", "sink"] },
  { id: CABLE, name: "USB-C 전력 케이블", roles: ["cable"] },
];
export const powerPresets = [{
  kind: "charge", name: "USB PD 충전",
  request: { requestedW: { value: null, unit: POWER_UNIT }, loadW: { value: null, unit: POWER_UNIT } },
}];

export const powerCardStats = [
  { scope: "resource", field: "capacity", label: "전력 예산" },
  { scope: "interface", field: "maxW", label: "포트 최대 전력" },
  { scope: "interface", field: "currentA", label: "케이블 정격" },
] as const;
