// USB 포트의 지원 모드, 케이블 등급과 전송 요청을 파일 경계에서 검사한다.
import { z } from "zod";
import { USB_2_HIGH_SPEED_MODE, USB_3_2_PROTOCOL_ESTIMATES, USB4_LINK_MODES, USB_C_CABLE_DATA_RATINGS_GBPS } from "./constants.ts";

export const DATA = "data";
export const BULK = "bulk";
export const PCIE_TUNNEL = "pcie-tunnel";
export const MB_PER_SECOND = "MB/s";
export const USB = "USB";
export const USB4 = "USB4";

const fact = <T extends z.ZodType>(value: T, unit = "") => z.strictObject({ value: value.nullable(), unit: z.literal(unit) });
const modeList = (names: readonly string[]) => z.string().refine(value => {
  const modes = parseModes(value);
  return modes.length === new Set(modes).size && modes.every(mode => names.includes(mode));
}, "지원 모드를 중복 없이 쉼표로 구분하세요");

export function parseModes(value: string): string[] {
  return value.trim() ? value.split(",").map(mode => mode.trim()) : [];
}

const usb3Modes = USB_3_2_PROTOCOL_ESTIMATES.map(row => row.mode);
const usbParams = z.strictObject({ modes: fact(modeList([USB_2_HIGH_SPEED_MODE, ...usb3Modes])) });
const usb4Params = z.strictObject({
  modes: fact(modeList(USB4_LINK_MODES.map(row => row.mode))),
  usb3Modes: fact(modeList(usb3Modes)),
  pcie: fact(z.boolean()),
  tunnelGbps: fact(z.number().nonnegative(), "Gbps"),
});

export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  if (protocol === USB) return usbParams;
  if (protocol === USB4) return usb4Params;
  return undefined;
}

export const attributes = z.strictObject({
  cableDataGbps: fact(z.literal(USB_C_CABLE_DATA_RATINGS_GBPS), "Gbps").optional(),
  cableUsb4: fact(z.boolean()).optional(),
});
export const request = z.strictObject({ throughput: fact(z.number().nonnegative(), MB_PER_SECOND) });
