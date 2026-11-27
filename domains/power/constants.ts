// power 영역이 쓰는 USB PD 전압·전류와 USB-C 전류 광고 및 케이블 등급을 둔다.

// 출처: USB Power Delivery r3.2 v1.2 (2026-08) §3.2.5.3, 표 3.1·3.5·6.13 (신뢰도: official)
export const USB_PD_MAX_CURRENT_A = 5;
// 고정 공급 PDO의 최대 전류는 10 mA 단위다. USB Power Delivery r3.2 v1.2 표 6.13.
export const USB_PD_FIXED_CURRENT_STEP_A = 0.01;

// 표준 고정 PDO별 전류 상한이다. 실제 제공 전류는 포트의 가용 전력과 케이블 등급에 달려 있다.
// 출처: USB Power Delivery r3.2 v1.2 (2026-08) 표 3.1·3.2·3.5·3.6 (신뢰도: official)
export const USB_PD_FIXED_SOURCE_LIMITS = [
  { range: "SPR", voltageV: 5, maxCurrentA: 3 },
  { range: "SPR", voltageV: 9, maxCurrentA: 3 },
  { range: "SPR", voltageV: 15, maxCurrentA: 3 },
  { range: "SPR", voltageV: 20, maxCurrentA: USB_PD_MAX_CURRENT_A },
  { range: "EPR", voltageV: 28, maxCurrentA: USB_PD_MAX_CURRENT_A },
  { range: "EPR", voltageV: 36, maxCurrentA: USB_PD_MAX_CURRENT_A },
  { range: "EPR", voltageV: 48, maxCurrentA: USB_PD_MAX_CURRENT_A },
] as const;

// 출처: USB Power Delivery r3.2 v1.2 (2026-08) §3.2.4·§3.2.5.3, 표 3.1·3.5 (신뢰도: official)
export const USB_PD_POWER_LIMITS_W = { SPR: 100, EPR: 240 } as const;

// 출처: USB Type-C Cable and Connector Specification Release 2.5 §3.1.2 및 표 3-1 (신뢰도: official)
export const USB_C_CABLE_CURRENT_RATINGS_A = [3, 5] as const;

// 3 A 초과 케이블과 full-featured C-to-C 케이블에는 전자 표지가 필요하다.
// 출처: USB Type-C Cable and Connector Specification Release 2.5 §3.1.2 및 표 3-1 (신뢰도: official)
export const USB_C_UNMARKED_CABLE_MAX_CURRENT_A = USB_C_CABLE_CURRENT_RATINGS_A[0];

// EPR은 5 A를 지원하고 전자 표지가 EPR 대응과 50 V를 보고하는 케이블이 필요하다.
// 출처: USB Type-C Cable and Connector Specification Release 2.5 p. 148, USB Power Delivery r3.2 v1.2 §3.2.5.3 (신뢰도: official)
export const USB_C_EPR_CABLE_REPORTED_VOLTAGE_V = 50;

// 출처: USB Type-C Cable and Connector Specification Release 2.5 §2.3.4 및 표 2-1 (신뢰도: official)
export const USB_C_CURRENT_NOMINAL_VOLTAGE_V = 5;

// Default 광고에서 USB 2.0·3.2는 구성 완료 후 고전력 동작의 상한이다. 초기 연결·정지 상태의 한도는 버스 규격을 따른다.
// 출처: USB Type-C Cable and Connector Specification Release 2.5 §4.6.2.1 및 표 4-20 (신뢰도: official)
export const USB_C_DEFAULT_CURRENT_LIMITS = [
  { bus: "USB 2.0", maxCurrentMa: 500 },
  { bus: "USB 3.2 x1", maxCurrentMa: 900 },
  { bus: "USB 3.2 x2", maxCurrentMa: 1_500 },
] as const;

// Source는 CC의 Rp로 Default, 1.5 A, 3 A 중 하나를 알린다. Default는 버스별 한도를 따르고 명시적 PD 계약이 우선한다.
// 출처: USB Type-C Cable and Connector Specification Release 2.5 §4.6.2.1, 표 4-19·4-20·4-27 (신뢰도: official)
export const USB_C_EXPLICIT_RP_CURRENT_LEVELS_MA = [1_500, 3_000] as const;
