// 링크 협상과 터널 예산 계산이 인용하는 규격 위치를 등록한다.
export const USB2_BULK = "usb2-bulk";
export const USB3_ESTIMATE = "usb3-estimate";
export const USB4_LINK = "usb4-link";
export const USB4_TUNNELS = "usb4-tunnels";
export const CABLE_DATA = "usb-c-data";

export const sources = [
  { id: USB2_BULK, title: "USB 2.0 Specification", locator: "§5.8.4 표 5-10, §7.1.9" },
  { id: USB3_ESTIMATE, title: "USB 3.2 Specification Rev 1.1", locator: "§4.4.11 및 표 5-1" },
  { id: USB4_LINK, title: "USB4 Specification v2.0", locator: "§2.2, §3.2, §4.3.1.2, §4.3.2.3 및 그림 4-30" },
  { id: USB4_TUNNELS, title: "USB4 Specification v2.0", locator: "§2.2, Ch. 8 USB3 Gen X Adapter Configuration Space" },
  { id: CABLE_DATA, title: "USB Type-C Cable and Connector Specification R2.5", locator: "표 3-1" },
] as const;
