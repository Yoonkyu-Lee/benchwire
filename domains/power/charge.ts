// 전달 전력과 기기 소비의 차로 순충전 전력 범위와 가능한 판정을 구한다.
import type { Interval, KnownVerdict } from "../../engine/contract.ts";
import { POWER_UNIT } from "./input.ts";

// SPEC 14의 충전 판정은 목표를 생략하면 방전 여부를 기준으로 삼는다.
export const DEFAULT_TARGET_W = 0;

export function assessCharge(delivered: Interval, loadW: number | null, targetW: number | null = DEFAULT_TARGET_W) {
  // 소비를 모르면 0 W 이상이며, 전달 전력도 음수가 될 수 없다.
  const low = loadW === null ? null : (delivered.low ?? 0) - loadW;
  const high = delivered.high === null ? null : delivered.high - (loadW ?? 0);
  const possible: KnownVerdict[] = [];
  const canCharge = high === null || high >= 0;
  if (high === null || high >= (targetW ?? 0)) possible.push("ok");
  if (canCharge && (targetW === null || targetW > 0 && (low === null || low < targetW))) possible.push("conditional");
  if (low === null || low < 0) possible.push("impossible");
  return { possible, metrics: [{ kind: "netCharge", unit: POWER_UNIT, low, high }] };
}
