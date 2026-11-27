// 이더넷·PoE 인터페이스의 표시 어휘와 동시 사용 예시의 작업 시작값을 둔다.
import { CHANNEL, ETHERNET, MBPS, PD, PSE, WATTS } from "./input.ts";

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
