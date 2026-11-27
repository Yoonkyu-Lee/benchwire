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
const poeType = fact(z.literal([0, ...ETHERNET_POE_TYPE_LIMITS.map(row => row.type)])).meta({ title: "PoE 유형" });

const ethernet = z.strictObject({ baseTModes: fact(modes).meta({ title: "지원 BASE-T 모드" }),
  networkRole: fact(z.enum(["lan", "wan", "provider"])).meta({ title: "네트워크 연결 역할" }) });
const pse = z.strictObject({ poeType, budgetResource: fact(z.string().min(1)).meta({ title: "전력 예산 자원 ID" }) });
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
  category: fact(z.enum(COPPER_CATEGORIES)).meta({ title: "케이블 등급" }),
  length: quantity("m").meta({ title: "케이블 길이", unit: "m" }),
  screening: fact(z.enum(["screened", "unscreened"])).meta({ title: "차폐 방식" }),
  poeType,
  poeLoss: power.meta({ title: "PoE 채널 손실", unit: WATTS }),
});

export const request = z.union([
  z.strictObject({ throughput: quantity(MBPS).meta({ title: "요청 처리량", unit: MBPS }) }),
  z.strictObject({ watts: power.meta({ title: "요청 전력", unit: WATTS }) }),
]);
