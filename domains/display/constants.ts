// display 링크의 속도, 레인 배치, 인코딩과 영상 대역폭 계산에 쓰는 규격값을 둔다.
// 채널 인코딩 효율은 FEC, 패킷, 스트림 오버헤드를 빼기 전의 비율이다.

// 출처: VESA DisplayPort Technology Update (2017), “DP Link Rate Increase” (신뢰도: official)
export const DP_MAX_LANES = 4;

// 출처: VESA DisplayPort Technology Update (2019), “New DisplayPort Link Rates” (신뢰도: official)
export const DP_8B10B_CODING_EFFICIENCY = 8 / 10;

// 출처: VESA DisplayPort Technology Update (2019), “New DisplayPort Link Rates” (신뢰도: official)
export const DP_128B132B_CODING_EFFICIENCY = 128 / 132;

// 출처: VESA DisplayPort Technology Update (2019), “New DisplayPort Link Rates”, VESA SF Workshop (2025), “Link Rates” (신뢰도: official)
export const DP_LINK_RATES = [
  { rate: "RBR", rawGbpsPerLane: 1.62, codingEfficiency: DP_8B10B_CODING_EFFICIENCY },
  { rate: "HBR", rawGbpsPerLane: 2.7, codingEfficiency: DP_8B10B_CODING_EFFICIENCY },
  { rate: "HBR2", rawGbpsPerLane: 5.4, codingEfficiency: DP_8B10B_CODING_EFFICIENCY },
  { rate: "HBR3", rawGbpsPerLane: 8.1, codingEfficiency: DP_8B10B_CODING_EFFICIENCY },
  { rate: "UHBR10", rawGbpsPerLane: 10, codingEfficiency: DP_128B132B_CODING_EFFICIENCY },
  { rate: "UHBR13.5", rawGbpsPerLane: 13.5, codingEfficiency: DP_128B132B_CODING_EFFICIENCY },
  { rate: "UHBR20", rawGbpsPerLane: 20, codingEfficiency: DP_128B132B_CODING_EFFICIENCY },
] as const;

// 판본의 허용 속도는 표의 상한까지다. 실제 협상은 소스·싱크·경로의 공통 지원 속도로 제한된다.
// DP 2.1 인증에는 UHBR이 선택 사항이다.
// 출처: VESA DisplayPort Standard Version 1.4 발표, VESA SF Workshop (2025) “Link Rates”, https://compliance.vesa.org/ (신뢰도: official)
export const DP_VERSION_MAX_LINK_RATES = [
  { version: "1.2", maxRate: "HBR2" },
  { version: "1.4", maxRate: "HBR3" },
  { version: "2.0", maxRate: "UHBR20" },
  { version: "2.1", maxRate: "UHBR20" },
] as const;

// 출처: HDMI LA CES 2025 발표 자료의 판본별 대역폭 도표, https://hdmiforum.org/hdmi-forum-releases-version-2-0-hdmi-specification/ (신뢰도: official)
export const HDMI_TMDS_VERSION_LIMITS = [
  { version: "1.4", maxRawGbps: 10.2 },
  { version: "2.0", maxRawGbps: 18 },
] as const;

// 영상 데이터에 적용하는 비율이다. 오디오와 보조 패킷의 TERC4 부호화는 별도다.
// 출처: HDMI Specification 1.4b §3, §5.4, GTS HDMI IP User Guide §2 표 3 (신뢰도: official)
export const HDMI_TMDS_VIDEO_CODING_EFFICIENCY = 8 / 10;

// 출처: HDMI FPGA IP User Guide (2021-08-06) §5.5 “FRL Clocking Scheme” (신뢰도: review)
export const HDMI_FRL_CODING_EFFICIENCY = 16 / 18;

// 출처: HDMI FPGA IP User Guide (2021-08-06) §2, §5.2의 SCDC FRL rate (신뢰도: review)
export const HDMI_21_FRL_LINK_RATES = [
  { code: 1, lanes: 3, rawGbpsPerLane: 3 },
  { code: 2, lanes: 3, rawGbpsPerLane: 6 },
  { code: 3, lanes: 4, rawGbpsPerLane: 6 },
  { code: 4, lanes: 4, rawGbpsPerLane: 8 },
  { code: 5, lanes: 4, rawGbpsPerLane: 10 },
  { code: 6, lanes: 4, rawGbpsPerLane: 12 },
] as const;

// DP 4레인은 고속 차동쌍을 모두 쓴다. USB 2.0의 전용 배선은 두 구성 모두에서 남는다.
// 레인 수는 핀 할당의 물리적 상한이다. A·B의 일부 핀은 초기 능동 케이블에서 비어 있을 수 있다.
// 출처: VESA USB DevDays (2019) pp. 21–23, VESA SF Workshop (2025) “DP Alt Mode Capability VDO” (신뢰도: official)
// 출처: USB Type-C and Power Delivery DisplayPort Alternate Mode, 표 1 및 DisplayPortAltModePinAssignment.aidl (A·B·F 기존 배치, 신뢰도: review)
export const DP_ALT_MODE_PIN_ASSIGNMENTS = [
  { pin: "A", maxDpLanes: 4, usb3xDifferentialPairs: 0, deprecated: true },
  { pin: "B", maxDpLanes: 2, usb3xDifferentialPairs: 2, deprecated: true },
  { pin: "C", maxDpLanes: 4, usb3xDifferentialPairs: 0, deprecated: false },
  { pin: "D", maxDpLanes: 2, usb3xDifferentialPairs: 2, deprecated: false },
  { pin: "E", maxDpLanes: 4, usb3xDifferentialPairs: 0, deprecated: false },
  { pin: "F", maxDpLanes: 2, usb3xDifferentialPairs: 2, deprecated: true },
] as const;

// 순차주사의 줄 주기(μs)는 (명목 프레임 주기 − 최소 수직 블랭킹 시간) ÷ 활성 줄 수로 추정한다.
// 총 픽셀 × 총 줄 × 목표 Hz를 클록 단위로 내림하고, 픽셀 클록(Hz)에 bpp를 곱해 영상 수요(bps)를 구한다.
// 출처: VESA Coordinated Video Timings 1.2 §3.4.3, §5.4 및 표 5-4 (신뢰도: official)
export const CVT_RB_V2_HORIZONTAL_BLANK_PIXELS = 80;

// 출처: VESA Coordinated Video Timings 1.2 §3.4.3, §5.4 및 표 5-4 (신뢰도: official)
export const CVT_RB_V2_MIN_VERTICAL_BLANK_US = 460;

// 수직 블랭킹 줄 수는 최소 시간 ÷ 추정 줄 주기를 내린 뒤 1을 더한 값과 이 하한 중 큰 값이다.
// 출처: VESA Coordinated Video Timings 1.2 §3.4.3, §5.4 및 표 5-4 (신뢰도: official)
export const CVT_RB_V2_MIN_VERTICAL_BLANK_LINES = 1 + 8 + 6; // 앞 여백 + 동기 펄스 + 뒤 여백

// 출처: VESA Coordinated Video Timings 1.2 §5.4 표 5-4 (신뢰도: official)
export const CVT_RB_V2_PIXEL_CLOCK_STEP_HZ = 1000;

// 영상 최적화 타이밍의 목표 Hz에만 곱한다. 블랭킹 줄 수에는 명목 Hz를 쓴다.
// 출처: VESA Coordinated Video Timings 1.2 §3.4.3, §5.4 및 표 5-4 (신뢰도: official)
export const CVT_RB_V2_VIDEO_REFRESH_MULTIPLIER = 1000 / 1001;

// 같은 압축 스트림의 송신 끝은 인코딩, 수신 끝은 디코딩을 지원해야 한다.
// 4:4:4 목표 범위는 공개 예시다. 사용할 bpp는 전송 규격과 양쪽 끝의 공통 지원으로 정한다.
// 출처: VESA Tokyo Workshop (2024) “Interoperable End-to-End Visual Ecosystem”, VESA DSC FAQ 및 Display Compression Codecs 비교표 (신뢰도: official)
export const DSC_444_EXAMPLE_TARGET_RANGE_BPP = [8, 12] as const;

// 보통 조건에서 시각적 무손실 품질을 위한 권고 하한이다.
// 출처: VESA DSC Source Device Guidelines 1.0 “Bit Rate vs. Mean Squared Error” (신뢰도: official)
export const DSC_VISUALLY_LOSSLESS_RECOMMENDED_MIN_BPP = [
  { chroma: "4:4:4", bpp: 8 },
  { chroma: "4:2:2", bpp: 7 },
  { chroma: "4:2:0", bpp: 6 },
] as const;
