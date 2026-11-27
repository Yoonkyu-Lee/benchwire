// 이더넷 인터페이스와 채널, 송·수전 포트, 네트워크 작업의 저장 필드를 검증한다.
import { z } from "zod";
import { COPPER_CATEGORIES, ETHERNET_BASE_T_RATES, ETHERNET_POE_TYPE_LIMITS } from "./constants.ts";

export const NETWORK = "network";
export const ETHERNET = "Ethernet";
export const CHANNEL = "Ethernet channel";
export const PSE = "PoE PSE";
export const PD = "PoE PD";
export const MAC = "mac";
export const POE = "poe";
export const MBPS = "Mbps";
export const WATTS = "W";
export const WIRE_LINE = "line";

const baseTModes = ETHERNET_BASE_T_RATES.map(row => row.mode);
export function parseBaseTModes(value: string) {
  return value === "" ? [] : value.split(",");
}
const modes = z.string().refine(value => {
  const parts = parseBaseTModes(value);
  return new Set(parts).size === parts.length && parts.every(part => baseTModes.some(mode => mode === part));
}, "지원하는 BASE-T 모드를 쉼표로 구분해 모두 적으세요");

const fact = <T extends z.ZodType>(value: T, unit = "") => z.strictObject({ value: value.nullable(), unit: z.literal(unit) });
const quantity = (unit: string) => fact(z.number().nonnegative(), unit);
const power = quantity(WATTS);
const poeType = fact(z.literal([0, ...ETHERNET_POE_TYPE_LIMITS.map(row => row.type)]));

const ethernet = z.strictObject({ baseTModes: fact(modes), networkRole: fact(z.enum(["lan", "wan", "provider"])) });
const pse = z.strictObject({ poeType, budgetResource: fact(z.string().min(1)) });
const pd = z.strictObject({ poeType });
export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  switch (protocol) {
    case ETHERNET: return ethernet;
    case PSE: return pse;
    case PD: return pd;
    default: return undefined;
  }
}

export const attributes = z.strictObject({
  category: fact(z.enum(COPPER_CATEGORIES)),
  length: quantity("m"),
  screening: fact(z.enum(["screened", "unscreened"])),
  poeType,
  poeLoss: power,
});

export const request = z.union([
  z.strictObject({ throughput: quantity(MBPS) }),
  z.strictObject({ watts: power }),
]);
