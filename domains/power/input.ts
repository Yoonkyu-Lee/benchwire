// 고정 PDO, 케이블 표지, 접속 조합표와 충전 요청의 저장 필드 및 단위를 검증한다.
import { z } from "zod";
import { USB_C_CABLE_CURRENT_RATINGS_A, USB_C_EPR_CABLE_REPORTED_VOLTAGE_V, USB_PD_FIXED_SOURCE_LIMITS } from "./constants.ts";

export const POWER = "power";
export const POWER_UNIT = "W";
export const PD = "USB PD";
export const CABLE = "USB-C cable";

const fact = <T extends z.ZodType>(value: T, unit = "") => z.strictObject({ value: value.nullable(), unit: z.literal(unit) });
const watts = fact(z.number().nonnegative(), POWER_UNIT);
// 빠진 전압은 목록에 없다는 뜻이고, 명시적인 null은 해당 전압에서 협상 가능한지 미확인이다.
const pd = z.strictObject({
  ...Object.fromEntries(USB_PD_FIXED_SOURCE_LIMITS.flatMap(({ voltageV, maxCurrentA }) => [
    ["pdo" + voltageV, fact(z.number().nonnegative().max(maxCurrentA), "A").optional()],
    ["accepts" + voltageV, fact(z.boolean()).optional()],
  ])),
  maxW: watts,
  reserveW: watts.optional(),
});
const cable = z.strictObject({
  currentA: fact(z.literal(USB_C_CABLE_CURRENT_RATINGS_A), "A"),
  eMarked: fact(z.boolean()),
  eprVoltage: fact(z.literal([0, USB_C_EPR_CABLE_REPORTED_VOLTAGE_V]), "V"),
});

export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  if (protocol === PD) return pd;
  if (protocol === CABLE) return cable;
  return undefined;
}

export const attributes = z.record(z.string().regex(/^budget:[^:]+:[^:]+$/), watts);
export const request = z.strictObject({ requestedW: watts, loadW: watts, targetW: watts.optional() });
