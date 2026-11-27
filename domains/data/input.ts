// USB 포트의 지원 모드, 케이블 등급과 전송 요청을 파일 경계에서 검사한다.
import { canonicalModeSet, modeSets } from "../../engine/contract.ts";
import { z } from "zod";
import { USB_2_HIGH_SPEED_MODE, USB_3_2_PROTOCOL_ESTIMATES, USB4_LINK_MODES, USB_C_CABLE_DATA_RATINGS_GBPS } from "./constants.ts";

export const DATA = "data";
export const BULK = "bulk";
export const PCIE_TUNNEL = "pcie-tunnel";
export const MB_PER_SECOND = "MB/s";
export const USB = "USB";
export const USB4 = "USB4";

const fact = <T extends z.ZodType>(value: T, unit = "") => z.strictObject({ value: value.nullable(), unit: z.literal(unit) });
const modeList = (names: readonly string[], title: string) => fact(z.string().refine(
  value => canonicalModeSet(value, names) !== undefined, "지원 모드를 중복 없이 쉼표로 구분하세요",
).meta({ enum: modeSets(names) })).meta({ title, modeOrder: names });

export { parseModes } from "../../engine/contract.ts";

const usb3Modes = USB_3_2_PROTOCOL_ESTIMATES.map(row => row.mode);
export const observations = z.strictObject({
  usbMode: fact(z.enum([USB_2_HIGH_SPEED_MODE, ...usb3Modes])).meta({ title: "현재 USB 벌크 협상 모드" }),
});
const usbParams = z.strictObject({ modes: modeList([USB_2_HIGH_SPEED_MODE, ...usb3Modes], "지원 USB 모드") });
const usb4Params = z.strictObject({
  modes: modeList(USB4_LINK_MODES.map(row => row.mode), "지원 USB4 모드"),
  usb3Modes: modeList(usb3Modes, "지원 USB 3.x 터널 모드"),
  pcie: fact(z.boolean()).meta({ title: "PCIe 터널 지원" }),
  tunnelGbps: fact(z.number().nonnegative(), "Gbps").meta({ title: "터널 한도", unit: "Gbps" }),
});

export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  if (protocol === USB) return usbParams;
  if (protocol === USB4) return usb4Params;
  return undefined;
}

export const attributes = z.strictObject({
  cableDataGbps: fact(z.literal(USB_C_CABLE_DATA_RATINGS_GBPS), "Gbps").optional().meta({ title: "케이블 데이터 정격", unit: "Gbps" }),
  cableUsb4: fact(z.boolean()).optional().meta({ title: "케이블 USB4 지원" }),
});
export const request = z.strictObject({ throughput: fact(z.number().nonnegative(), MB_PER_SECOND).meta({ title: "요청 처리량", unit: MB_PER_SECOND }) });
