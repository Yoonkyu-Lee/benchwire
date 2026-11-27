// 전달 전력과 기기 소비의 차로 순충전 전력 범위와 가능한 판정을 구한다.
import { compareQuantity, type Interval, type KnownVerdict } from "../../engine/contract.ts";
import { POWER_UNIT } from "./input.ts";

// SPEC 14의 충전 판정은 목표를 생략하면 방전 여부를 기준으로 삼는다.
export const DEFAULT_TARGET_W = 0;

export function assessCharge(delivered: Interval, loadW: number | null, targetW: number | null = DEFAULT_TARGET_W) {
  // 소비를 모르면 0 W 이상이며, 전달 전력도 음수가 될 수 없다.
  const net = (supply: number, load: number) => compareQuantity(supply,load) === 0 ? 0 : supply - load;
  const low = loadW === null ? null : net(delivered.low ?? 0,loadW);
  const high = delivered.high === null ? null : net(delivered.high,loadW ?? 0);
  const possible: KnownVerdict[] = [];
  const canCharge = high === null || compareQuantity(high,0) >= 0;
  if (high === null || compareQuantity(high,targetW ?? 0) >= 0) possible.push("ok");
  if (canCharge && (targetW === null || compareQuantity(targetW,0) > 0 && (low === null || compareQuantity(low,targetW) < 0))) possible.push("conditional");
  if (low === null || compareQuantity(low,0) < 0) possible.push("impossible");
  return { possible, metrics: [{ kind: "netCharge", unit: POWER_UNIT, low, high }] };
}
