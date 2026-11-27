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
    ["pdo" + voltageV, fact(z.number().nonnegative().max(maxCurrentA), "A").optional().meta({
      title: `${voltageV} V 송전 PDO 전류`, unit: "A",
      researchOmission: { headings: ["all source PDOs", "전체 송전 PDO"], voltageV },
    })],
    ["accepts" + voltageV, fact(z.boolean()).optional().meta({
      title: `${voltageV} V 수전 지원`, researchOmission: { headings: ["all sink PDOs", "전체 수전 PDO"], voltageV },
    })],
  ])),
  maxW: watts.meta({ title: "포트 최대 전력", unit: POWER_UNIT }),
  reserveW: watts.optional().meta({ title: "패스스루 선점 전력", unit: POWER_UNIT }),
});
const cable = z.strictObject({
  currentA: fact(z.literal(USB_C_CABLE_CURRENT_RATINGS_A), "A").meta({ title: "정격 전류", unit: "A" }),
  eMarked: fact(z.boolean()).meta({ title: "전자 표지 있음" }),
  eprVoltage: fact(z.literal([0, USB_C_EPR_CABLE_REPORTED_VOLTAGE_V]), "V").meta({ title: "EPR 표시 전압", unit: "V" }),
});

export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  if (protocol === PD) return pd;
  if (protocol === CABLE) return cable;
  return undefined;
}

export const attributes = z.record(z.string().regex(/^budget:[^:]+:[^:]+$/).meta({ title: "접속 조합 키", description: "예: budget:a+b:a" }),
  watts.meta({ title: "접속 조합별 출력 한도", unit: POWER_UNIT }));
export const request = z.strictObject({ requestedW: watts.meta({ title: "요청 전력", unit: POWER_UNIT }),
  loadW: watts.meta({ title: "기기 소비 전력", unit: POWER_UNIT }),
  targetW: watts.optional().meta({ title: "목표 순충전", unit: POWER_UNIT }) });
