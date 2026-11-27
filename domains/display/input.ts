// 포트가 주장하는 링크 매개변수와 영상 작업의 요청 필드를 저장 경계에서 검사한다.
import { z } from "zod";
import {
  CVT_RB_V2_MIN_VERTICAL_BLANK_US, DP_ALT_MODE_PIN_ASSIGNMENTS, DP_LINK_RATES, DP_MAX_LANES,
  HDMI_21_FRL_LINK_RATES, HDMI_TMDS_VERSION_LIMITS, VIDEO_CHROMA_SAMPLES,
} from "./constants.ts";

const fact = <T extends z.ZodType>(value: T, unit = "") => z.strictObject({ value: value.nullable(), unit: z.literal(unit) });
const refresh = fact(z.number().positive().lt(1_000_000 / CVT_RB_V2_MIN_VERTICAL_BLANK_US), "Hz");
const dscBpp = z.number().positive().max(Number.MAX_SAFE_INTEGER);

// 해당 설정의 인코더나 디코더에서 확인한 DSC 목표. 0은 지원하지 않음이다.
const dscCapability = fact(z.union([z.literal(0), dscBpp]), "bpp");
const dpParams = z.strictObject({
  version: fact(z.string().min(1)),
  // 링크 속도 상한은 하위 속도도 지원한다는 주장이다.
  maxRate: fact(z.enum(DP_LINK_RATES.map(row => row.rate))),
  lanes: fact(z.literal([1, 2, DP_MAX_LANES])),
  dscBpp: dscCapability,
});
const altModeParams = dpParams.extend({ pin: fact(z.enum(DP_ALT_MODE_PIN_ASSIGNMENTS.map(row => row.pin))) });
const hdmiParams = z.strictObject({
  tmdsVersion: fact(z.enum(HDMI_TMDS_VERSION_LIMITS.map(row => row.version))),
  frlCode: fact(z.literal([0, ...HDMI_21_FRL_LINK_RATES.map(row => row.code)])),
  dscBpp: dscCapability,
});

export const params = z.strictObject({});
export function paramsFor(protocol: string) {
  switch (protocol) {
    case "DP":
    case "DP Tunnel": return dpParams;
    case "DP Alt Mode": return altModeParams;
    case "HDMI": return hdmiParams;
    default: return undefined;
  }
}

export const request = z.strictObject({
  width: fact(z.int().positive(), "px"),
  height: fact(z.int().positive(), "px"),
  refresh: refresh,
  bitsPerComponent: fact(z.int().positive(), "bpc"),
  chroma: fact(z.enum(VIDEO_CHROMA_SAMPLES.map(row => row.chroma))),
  dscBpp: fact(dscBpp, "bpp").optional(),
  fallbackRefresh: refresh.optional(),
});

export const attributes = z.strictObject({});
