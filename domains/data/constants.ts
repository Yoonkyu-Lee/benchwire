// USB 링크의 신호 속도와 벌크 처리량 계산에 쓰는 규격값을 둔다.

// 출처: USB 2.0 Specification §5.8.4 표 5-10, §7.1.9 (신뢰도: official)
export const USB_2_HIGH_SPEED_MODE = "High Speed";
export const USB_2_HIGH_SPEED_SIGNAL_GBPS = 0.48;
export const USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND = 53.248;

// 흐름 제어·프레이밍·프로토콜 오버헤드를 반영한 애플리케이션 처리량 추정 상한이다.
// 출처: USB 3.2 Specification Rev 1.1 §4.4.11 및 표 5-1 (신뢰도: official)
export const USB_3_2_PROTOCOL_ESTIMATES = [
  { mode: "Gen 1x1", lanes: 1, rawGbps: 5, approxBestCaseMBPerSecond: 450 },
  { mode: "Gen 1x2", lanes: 2, rawGbps: 10, approxBestCaseMBPerSecond: 900 },
  { mode: "Gen 2x1", lanes: 1, rawGbps: 10, approxBestCaseMBPerSecond: 1_100 },
  { mode: "Gen 2x2", lanes: 2, rawGbps: 20, approxBestCaseMBPerSecond: 2_200 },
] as const;

// 방향별 부호 블록 페이로드다. 프레이밍·흐름 제어·대역폭 예약 전의 상한이다.
// 출처: USB4 Specification v2.0 §2.2, §3.2, §4.3.1.2, §4.3.2.3 및 그림 4-30 (신뢰도: official)
export const USB4_LINK_MODES = [
  { mode: "Gen 2x2", rawGbps: 20, payloadGbps: 20 * 64 / 66 },
  { mode: "Gen 3x2", rawGbps: 40, payloadGbps: 40 * 128 / 132 },
  { mode: "Gen 4x2", rawGbps: 80, payloadGbps: 2 * 25.6 * 11 / 7 * 480 / 504 },
] as const;

// 출처: USB Type-C Cable and Connector Specification R2.5 표 3-1, USB-IF Compliance Updates "Cables and Connectors" (신뢰도: official)
export const USB_C_CABLE_DATA_RATINGS_GBPS = [USB_2_HIGH_SPEED_SIGNAL_GBPS, 5, 10, 20, 40, 80] as const;

export const GIGABITS_PER_MEGABYTE = 8 / 1_000;
