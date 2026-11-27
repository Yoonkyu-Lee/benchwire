// 전달 전력과 기기 소비의 차로 순충전 전력 범위와 가능한 판정을 구한다.
import type { Verdict } from "../../engine/contract.ts";
import { POWER_UNIT } from "./input.ts";

type KnownVerdict = Exclude<Verdict, "unknown">;

export function assessCharge(delivered: { low: number | null; high: number | null }, loadW: number | null, targetW: number | null = 0) {
  // 소비를 모르면 0 W 이상이며, 전달 전력도 음수가 될 수 없다.
  const low = loadW === null ? null : (delivered.low ?? 0) - loadW;
  const high = delivered.high === null ? null : delivered.high - (loadW ?? 0);
  const possible: KnownVerdict[] = [];
  const canCharge = high === null || high >= 0;
  if (high === null || high >= (targetW ?? 0)) possible.push("ok");
  if (canCharge && (targetW === null || targetW > 0 && (low === null || low < targetW))) possible.push("conditional");
  if (low === null || low < 0) possible.push("impossible");
  return { possible, metrics: [{ kind: "netCharge" as const, unit: POWER_UNIT, value: low === high ? low : null, low, high }] };
}
