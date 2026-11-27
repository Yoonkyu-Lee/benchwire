// network 영역이 쓰는 이더넷 PHY 속도, 구리 채널 도달 거리, 프레임과 PoE 규격값을 둔다.

// IEC 80000-13의 옥텟 한 개는 8 bit다. 두 전송률 모두 십진 메가 단위를 쓴다.
export const BITS_PER_BYTE = 8;

// 명목 MAC 속도는 한 방향 기준이다.
// 출처: IEEE 802.3 개정 802.3i·u·ab·bz·an, Clause 14·25·40·126·55 (신뢰도: official)
export const ETHERNET_BASE_T_RATES = [
  { mode: "10BASE-T", lineMbps: 10, amendment: "802.3i" },
  { mode: "100BASE-TX", lineMbps: 100, amendment: "802.3u" },
  { mode: "1000BASE-T", lineMbps: 1_000, amendment: "802.3ab" },
  { mode: "2.5GBASE-T", lineMbps: 2_500, amendment: "802.3bz" },
  { mode: "5GBASE-T", lineMbps: 5_000, amendment: "802.3bz" },
  { mode: "10GBASE-T", lineMbps: 10_000, amendment: "802.3an" },
] as const;

// 패치 코드를 포함한 규격 채널의 길이다. 추가 확인은 구형 Cat5의 전송 성능이나 인접 채널 누화 등 해당 조항의 조건을 뜻한다.
// 출처: IEEE 802.3 Clause 14·25·40 및 Annex 40A, §126.7.2 표 126-18·126-19, Clause 55 표 55-17, TIA TSB-5021·TSB-155-A (신뢰도: official)
export const ETHERNET_COPPER_CHANNEL_REACH = [
  { mode: "10BASE-T", category: "Cat3", screening: "any", reachM: 100, requiresExtraQualification: false },
  { mode: "100BASE-TX", category: "Cat5", screening: "any", reachM: 100, requiresExtraQualification: false },
  { mode: "1000BASE-T", category: "Cat5", screening: "any", reachM: 100, requiresExtraQualification: true },
  { mode: "1000BASE-T", category: "Cat5e", screening: "any", reachM: 100, requiresExtraQualification: false },
  { mode: "2.5GBASE-T", category: "Cat5e", screening: "any", reachM: 100, requiresExtraQualification: true },
  { mode: "2.5GBASE-T", category: "Cat6", screening: "any", reachM: 100, requiresExtraQualification: true },
  { mode: "2.5GBASE-T", category: "Cat6A", screening: "any", reachM: 100, requiresExtraQualification: false },
  { mode: "5GBASE-T", category: "Cat5e", screening: "any", reachM: 100, requiresExtraQualification: true },
  { mode: "5GBASE-T", category: "Cat6", screening: "any", reachM: 100, requiresExtraQualification: true },
  { mode: "5GBASE-T", category: "Cat6A", screening: "any", reachM: 100, requiresExtraQualification: false },
  // 비차폐 Cat6를 55 m보다 길게 쓰려면 외래 누화를 완화한 설치 채널을 검증한다.
  { mode: "10GBASE-T", category: "Cat6", screening: "unscreened", reachM: 55, mitigatedReachM: 100, requiresExtraQualification: true },
  { mode: "10GBASE-T", category: "Cat6", screening: "screened", reachM: 100, requiresExtraQualification: true },
  { mode: "10GBASE-T", category: "Cat6A", screening: "any", reachM: 100, requiresExtraQualification: false },
] as const;

// 구리 채널 등급을 규격표의 낮은 등급부터 비교한다.
export const COPPER_CATEGORIES = [...new Set(ETHERNET_COPPER_CHANNEL_REACH.map(row => row.category))];

// 태그 없는 최대 MAC 페이로드 효율은 MTU ÷ (MTU + 헤더 + FCS + 프리앰블 + SFD + IFG)다.
// 출처: IEEE 802.3 §3.2 및 §4.4, RFC 6349 §4.1.1 (신뢰도: official)
export const ETHERNET_UNTAGGED_FRAME = {
  mtuBytes: 1_500,
  macHeaderBytes: 14,
  fcsBytes: 4,
  preambleBytes: 7,
  sfdBytes: 1,
  interFrameGapByteTimes: 12,
} as const;

const { mtuBytes, macHeaderBytes, fcsBytes, preambleBytes, sfdBytes, interFrameGapByteTimes } = ETHERNET_UNTAGGED_FRAME;
export const MAC_PAYLOAD_FRACTION = mtuBytes / (mtuBytes + macHeaderBytes + fcsBytes + preambleBytes + sfdBytes + interFrameGapByteTimes);

// 각 Type의 최고 등급에서 PSE 포트 예산과 PD 입력 상한이다. Type 1은 802.3af 원판의 12.95 W를 쓴다.
// 출처: IEEE 802.3af-2003 §33.3.5.2·§33.3.5.4, IEEE 802.3at Clause 33, IEEE 802.3bt-2018 표 145-11·145-29 (신뢰도: official)
export const ETHERNET_POE_TYPE_LIMITS = [
  { type: 1, amendment: "802.3af", pseBudgetW: 15.4, maxPdInputW: 12.95 },
  { type: 2, amendment: "802.3at", pseBudgetW: 30, maxPdInputW: 25.5 },
  { type: 3, amendment: "802.3bt", pseBudgetW: 60, maxPdInputW: 51 },
  { type: 4, amendment: "802.3bt", pseBudgetW: 90, maxPdInputW: 71.3 },
] as const;
