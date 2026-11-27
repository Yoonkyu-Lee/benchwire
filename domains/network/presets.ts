// 이더넷·PoE 작업은 M3의 동시 사용 예시에서 시작한다.
import { MBPS, WATTS } from "./input.ts";

export const networkDomainName = "네트워크";
const EXAMPLE_TRAFFIC_MBPS = 900;
const EXAMPLE_POE_W = 12;

export const networkPresets = [
  { kind: "traffic", name: "이더넷 전송",
    request: { throughput: { value: EXAMPLE_TRAFFIC_MBPS, unit: MBPS } },
    labels: { throughput: "요청 처리량" } },
  { kind: "power", name: "PoE 전력 공급",
    request: { watts: { value: EXAMPLE_POE_W, unit: WATTS } },
    labels: { watts: "요청 전력" } },
] as const;
