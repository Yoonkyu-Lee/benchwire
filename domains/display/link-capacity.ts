// DP, HDMI와 DP Alt Mode 링크의 채널 인코딩 후 이론상 용량을 계산한다.
// FEC, 패킷, 스트림 오버헤드는 별도다.

import {
  DP_ALT_MODE_PIN_ASSIGNMENTS,
  DP_LINK_RATES,
  HDMI_21_FRL_LINK_RATES,
  HDMI_FRL_CODING_EFFICIENCY,
  HDMI_TMDS_VERSION_LIMITS,
  HDMI_TMDS_VIDEO_CODING_EFFICIENCY,
} from "./constants.ts";

export type DpLinkRate = (typeof DP_LINK_RATES)[number]["rate"];
export type DpAltModePin = (typeof DP_ALT_MODE_PIN_ASSIGNMENTS)[number]["pin"];
export type HdmiTmdsVersion = (typeof HDMI_TMDS_VERSION_LIMITS)[number]["version"];
export type HdmiFrlCode = (typeof HDMI_21_FRL_LINK_RATES)[number]["code"];

export function dpLinkCapacityGbps(rate: DpLinkRate, lanes: number): number {
  const { rawGbpsPerLane, codingEfficiency } = DP_LINK_RATES.find((row) => row.rate === rate)!;
  return rawGbpsPerLane * lanes * codingEfficiency;
}

export function dpAltModeCapacityGbps(rate: DpLinkRate, pin: DpAltModePin): number {
  const { maxDpLanes } = DP_ALT_MODE_PIN_ASSIGNMENTS.find((row) => row.pin === pin)!;
  return dpLinkCapacityGbps(rate, maxDpLanes);
}

export function hdmiTmdsCapacityGbps(version: HdmiTmdsVersion): number {
  const { maxRawGbps } = HDMI_TMDS_VERSION_LIMITS.find((row) => row.version === version)!;
  return maxRawGbps * HDMI_TMDS_VIDEO_CODING_EFFICIENCY;
}

export function hdmiFrlCapacityGbps(code: HdmiFrlCode): number {
  const { rawGbpsPerLane, lanes } = HDMI_21_FRL_LINK_RATES.find((row) => row.code === code)!;
  return rawGbpsPerLane * lanes * HDMI_FRL_CODING_EFFICIENCY;
}
