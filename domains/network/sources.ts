// 네트워크 추론 단계가 참조하는 IEEE 및 IETF 규격을 등록한다.
export const BASE_T = "base-t";
export const REACH = "copper-reach";
export const CAT6_REACH = "cat6-10g-reach";
export const FRAMING = "mac-framing";
export const POE_TYPE = "poe-type";
export const POE_AF = "poe-af";

export const sources = [
  { id: BASE_T, title: "IEEE 802.3 Clause 14·25·40·55·126, BASE-T PHY 모드",
    locator: "https://ieee802.org/3/archive.html" },
  { id: REACH, title: "IEEE 802.3 Clause 14·25·40·55·126, BASE-T channel reach",
    locator: "https://www.ieee802.org/3/ad_hoc/extended/length%20in%20802d3%20BASET%20and%20PoE_reva.pdf" },
  { id: CAT6_REACH, title: "IEEE P802.3an (2005-07), Cabling Types & Distances, Cat6 도달 거리와 외래 누화 완화",
    locator: "https://www.ieee802.org/3/an/public/jul05/flatman_1_0705.pdf" },
  { id: FRAMING, title: "RFC 6349 §4.1.1, MTU 1500 비태그 프레임 회선 점유량",
    locator: "https://www.rfc-editor.org/rfc/rfc6349.html#section-4.1.1" },
  { id: POE_TYPE, title: "IEEE 802.3 Clause 33·145, Type별 PSE·PD 전력",
    locator: "https://www.ieee802.org/3/minutes/may17/outgoing/IEEE_802d3_to_ISOIEC_SC25_WG3_0517.pdf" },
  { id: POE_AF, title: "IEEE 802.3af-2003 §33.3.5.2·§33.3.5.4, Type 1 PD 12.95 W",
    locator: "https://www.ieee802.org/3/4PPOE/email/msg01469.html" },
];
