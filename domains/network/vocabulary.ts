// 이더넷·PoE 인터페이스의 표시 어휘와 동시 사용 예시의 작업 시작값을 둔다.
import { CHANNEL, ETHERNET, MAC, MBPS, observations, PD, PSE, WATTS } from "./input.ts";
import { MAC_PAYLOAD_FRACTION } from "./constants.ts";

export const networkQuests = [{ ownerKind: "connection", field: "linkSpeed", title: "이더넷 링크 속도",
  steps: ["Windows 설정 → 네트워크 및 인터넷 → 이더넷에서 이 배선에 연결된 어댑터의 속성을 여세요."],
  read: "링크 속도(수신/전송)를 Mbps로 읽으세요. 1 Gbps는 1000 Mbps입니다.",
  observation: { schema: observations, mode: MAC, fromLimit: (limit: number) => Math.round(limit / MAC_PAYLOAD_FRACTION) },
}];

export const networkDomainName = "네트워크";
export const networkInterfaces = [
  { id: ETHERNET, name: "이더넷 포트", roles: ["bidirectional"] },
  { id: CHANNEL, name: "이더넷 채널", roles: ["bidirectional"] },
  { id: PSE, name: "PoE 송전 포트", roles: ["source"] },
  { id: PD, name: "PoE 수전 포트", roles: ["sink"] },
];
const EXAMPLE_TRAFFIC_MBPS = 900;
const EXAMPLE_POE_W = 12;

export const networkPresets = [
  { kind: "traffic", name: "이더넷 전송", request: { throughput: { value: EXAMPLE_TRAFFIC_MBPS, unit: MBPS } } },
  { kind: "power", name: "PoE 전력 공급", request: { watts: { value: EXAMPLE_POE_W, unit: WATTS } } },
] as const;
