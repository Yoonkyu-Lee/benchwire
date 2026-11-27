// data 영역이 쓰는 USB 신호·터널·케이블 규격값과 처리량 참고값을 둔다.

// D+/D− 차동쌍 하나를 양방향이 번갈아 쓴다. 비트 스터핑 양은 데이터에 따라 달라진다.
// 출처: USB 2.0 Specification §1.1, §7.1.8–§7.1.9, USB 3.2 Specification Rev 1.1 §4.3.1 (신뢰도: official)
export const USB_2_HIGH_SPEED = {
  rawGbps: 0.48,
  lanes: 1,
  coding: "NRZI",
  duplex: "half",
} as const;

// 512바이트 벌크 패킷의 이상적 단방향 페이로드 상한이며 스터핑과 경쟁 트래픽은 별도다.
// 출처: USB 2.0 Specification §5.8.4 표 5-10 (신뢰도: official)
export const USB_2_HIGH_SPEED_BULK_LIMIT_MB_PER_SECOND = 53.248;

// 레인 수와 속도는 한 방향 기준이다. 부호 블록 비율은 링크·프로토콜 오버헤드 전의 이론값에 쓴다.
// 출처: USB 3.2 Specification Rev 1.1 §4.4.11 및 표 5-1 (신뢰도: official)
export const USB_3_2_LINK_MODES = [
  { mode: "Gen 1x1", lanesPerDirection: 1, rawGbpsPerLane: 5, payloadBits: 8, encodedBits: 10 },
  { mode: "Gen 1x2", lanesPerDirection: 2, rawGbpsPerLane: 5, payloadBits: 8, encodedBits: 10 },
  { mode: "Gen 2x1", lanesPerDirection: 1, rawGbpsPerLane: 10, payloadBits: 128, encodedBits: 132 },
  { mode: "Gen 2x2", lanesPerDirection: 2, rawGbpsPerLane: 10, payloadBits: 128, encodedBits: 132 },
] as const;

// USB4의 기본 신호 속도와 RS-FEC 미사용 시의 데이터 부호 블록이다.
// 출처: USB4 Specification v2.0 (2025-11) §2.2, §4.3.1.2 및 USB DevDays (2019) USB4 Logical Layer p. 54 (신뢰도: official)
export const USB4_NRZ_LINK_MODES = [
  { mode: "Gen 2x2", lanesPerDirection: 2, rawGbpsPerLane: 10, payloadBits: 64, encodedBits: 66 },
  { mode: "Gen 3x2", lanesPerDirection: 2, rawGbpsPerLane: 20, payloadBits: 128, encodedBits: 132 },
] as const;

// 40 Gbps/레인은 표기 속도다. PAM3 매핑 뒤에도 RS-FEC와 전송 패킷 오버헤드가 있다.
// 출처: USB4 Specification v2.0 (2025-11) §2.2, §3.2, §4.3.2.3 및 그림 4-30 (신뢰도: official)
export const USB4_GEN4_PAM3 = {
  nominalGbpsPerLane: 40,
  gigaBaudPerLane: 25.6,
  bitsPerMapping: 11,
  tritsPerMapping: 7,
  fecPayloadSymbols: 480,
  fecBlockSymbols: 504,
} as const;

// 비대칭은 선택 사항이다. 어느 방향에 송신 차동쌍 3개를 줄지는 협상에 달려 있다.
// 출처: USB4 Specification v2.0 (2025-11) 그림 2-3–2-4 및 USB-IF USB 80Gbps 발표 (2022-10-18) (신뢰도: official)
export const USB4_GEN4_LINK_WIDTHS = [
  { mode: "symmetric", fastDirectionPairs: 2, reverseDirectionPairs: 2 },
  { mode: "asymmetric", fastDirectionPairs: 3, reverseDirectionPairs: 1 },
] as const;

// 흐름 제어·프레이밍·프로토콜 오버헤드를 반영한 규격의 애플리케이션 처리량 추정 상한이다.
// 출처: USB 3.2 Specification Rev 1.1 §4.4.11 (신뢰도: official)
export const USB_3_2_PROTOCOL_ESTIMATES = [
  { mode: "Gen 1x1", approxBestCaseMBPerSecond: 450 },
  { mode: "Gen 1x2", approxBestCaseMBPerSecond: 900 },
  { mode: "Gen 2x1", approxBestCaseMBPerSecond: 1_100 },
  { mode: "Gen 2x2", approxBestCaseMBPerSecond: 2_200 },
] as const;

// data·display 자원이 공유하는 터널 종류다. USB 2.0은 전용 배선을 쓰고 PCIe 지원은 장치 역할에 따라 다르다.
// 출처: USB4 Specification v2.0 (2025-11) §2.2 및 USB DevDays (2019) USB4 System Overview (신뢰도: official)
export const USB4_TUNNEL_PROTOCOLS = ["USB3", "DP", "PCIe"] as const;

// USB3 Gen X 어댑터의 USB 3.2 Gen 2x2 신호 속도다. USB4 v2의 별도 Gen T 터널은 20 Gbps를 넘을 수 있다.
// 출처: USB4 Specification v2.0 (2025-11) Ch. 8 USB3 Gen X Adapter Configuration Space, USB-IF USB 80Gbps 발표 (신뢰도: official)
export const USB4_USB3_GEN_X_MAX_SIGNAL_GBPS = 20;

// Thunderbolt 3 고유 터널 모드의 프로토콜이다. USB 전용 모드와 독 안에서 PCIe로 연결된 USB 컨트롤러는 별도다.
// 출처: Thunderbolt 3 Technology Brief, “How Thunderbolt 3 Works” 및 “Thunderbolt Mode” (신뢰도: official)
export const THUNDERBOLT_3_TUNNEL_PROTOCOLS = ["DP", "PCIe"] as const;

// PCIe 호스트 인증 최소 요건이다. 터널에서 파일을 읽고 쓰는 처리량과는 별개다.
// 출처: “What Is Thunderbolt 4?”의 16→32 Gbps 설명과 “Thunderbolt Technology: A Universe of Possibilities”의 PC 데이터 요건 표 (신뢰도: official)
export const THUNDERBOLT_HOST_PCIE_MINIMUMS = [
  { version: 3, minPcieGbps: 16 },
  { version: 4, minPcieGbps: 32 },
  { version: 5, minPcieGbps: 64 },
] as const;

// 40 Gbps 링크에서 디스플레이가 없는 기술 자료의 PCIe 데이터 예시다.
// 출처: Thunderbolt 3 Technology Brief p. 6, 그림 7 “Data Only” (신뢰도: official)
export const THUNDERBOLT_3_DATA_ONLY_EXAMPLE_GBPS = 22;

// 등급별 신호 속도다. USB 2.0 속도는 전력 로고에 표시하지 않고, 10 Gbps C-to-C 단독 인증은 폐기됐다.
// 출처: USB-IF USB Type-C Cable Logo Usage Guidelines, USB Type-C Spec Release 2.5 표 3-1, USB-IF Compliance Updates “Cables and Connectors” (신뢰도: official)
export const USB_C_CABLE_DATA_RATINGS_GBPS = [0.48, 5, 10, 20, 40, 80] as const;

// C-to-C 패시브 케이블의 참고 길이다. 적합 여부는 전기적 성능으로 판정한다.
// 출처: USB Type-C Cable and Connector Specification Release 2.5 표 3-1 및 주 2–3 (신뢰도: official)
export const USB_C_PASSIVE_CABLE_PRACTICAL_LENGTHS = [
  { assemblyFamily: "CC2", practicalLengthM: 4 },
  { assemblyFamily: "CC3G1", practicalLengthM: 2 },
  { assemblyFamily: "CC3G2", practicalLengthM: 1 },
  { assemblyFamily: "CC4G3", practicalLengthM: 0.8 },
] as const;

// 같은 논리 버스의 다운스트림 트래픽은 허브의 업스트림 하나를 공유한다. USB 3.2 허브의 USB 2.0과 SuperSpeed 버스는 각각 센다.
// 출처: USB 2.0 Specification §11.1, USB 3.2 Specification Rev 1.1 §3.2.6.2, §4.4.11 (신뢰도: official)
export const USB_HUB_UPSTREAM_PORTS_PER_BUS = 1;
