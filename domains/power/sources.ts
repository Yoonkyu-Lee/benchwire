// 전력 협상과 케이블 등급의 규격 출처를 등록한다.
export const PD_FIXED = "pd-fixed";
export const TYPE_C_CABLE = "type-c-cable";

export const sources = [
  { id: PD_FIXED, title: "USB Power Delivery r3.2 v1.2 (2026-08) §3.2.4·§3.2.5.3, 표 3.1·3.5",
    locator: "https://www.usb.org/sites/default/files/USB_PD_R3.2_V1.2%283%29.zip" },
  { id: TYPE_C_CABLE, title: "USB Type-C Cable and Connector Specification Release 2.5 §3.1.2, 표 3-1, p. 148",
    locator: "https://www.usb.org/document-library/usb-type-cr-cable-and-connector-specification-release-25" },
];
