// USB 인터페이스의 표시 어휘와 전송 작업의 시작값을 둔다.
import { BULK, MB_PER_SECOND, observations, PCIE_TUNNEL, USB, USB4 } from "./input.ts";
import { USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND, USB_2_HIGH_SPEED_MODE, USB_3_2_PROTOCOL_ESTIMATES } from "./constants.ts";

export const dataQuests = [
  { ownerKind: "port", field: "attachment", title: "포트의 컨트롤러", steps: [
    "Windows 장치 관리자 → 보기 → 연결별 장치에서 이 포트에 꽂은 장치를 찾으세요.",
    "부모 허브와 컨트롤러를 따라 올라가 모델에 정의된 노드와 대조하세요.",
  ], read: "해당 포트가 연결된 내부 노드" },
  { ownerKind: "connection", field: "usbMode", title: "USB 협상 모드", steps: [
    "Windows USBView의 연결 트리에서 이 포트에 꽂은 장치를 선택하세요.",
    "연결 정보에서 현재 동작 속도를 읽으세요. 장치 설명자의 지원 속도는 별도 항목입니다.",
  ], read: "현재 USB 벌크 협상 모드. 표시만으로 레인 수를 알 수 없으면 미확인으로 두세요.",
  observation: { schema: observations, mode: BULK, fromLimit: (limit: number) => limit === USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND ? USB_2_HIGH_SPEED_MODE
    : USB_3_2_PROTOCOL_ESTIMATES.find(row => row.approxBestCaseMBPerSecond === limit)?.mode },
  },
];

export const dataDomainName = "데이터";
export const dataInterfaces = [
  { id: USB, name: "USB 데이터", roles: ["bidirectional"] },
  { id: USB4, name: "USB4 데이터", roles: ["bidirectional"] },
];
const DEFAULT_TRANSFER_MB_PER_SECOND = 800;
const request = { throughput: { value: DEFAULT_TRANSFER_MB_PER_SECOND, unit: MB_PER_SECOND } };
export const dataPresets = [
  { kind: BULK, name: "USB 데이터 전송", request },
  { kind: PCIE_TUNNEL, name: "PCIe 터널 전송", request },
];
