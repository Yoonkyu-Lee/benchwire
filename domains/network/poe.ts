// PoE 방향과 Type 호환을 확인하고 PSE 포트 예산에 송전 전력과 채널 손실을 예약한다.
import type { Consumption, Direction, Link, Option, Scene } from "../../engine/contract.ts";
import { ETHERNET_POE_TYPE_LIMITS } from "./constants.ts";
import { channelPortsMatch, networkInterface, readNetworkClaim } from "./evidence.ts";
import { NETWORK, PD, POE, PSE, WATTS } from "./input.ts";
import { POE_AF, POE_TYPE } from "./sources.ts";

function powerPath(scene: Scene, connection: number, direction: Direction) {
  const link = scene.connections[connection]!;
  const inputs = [link.evidence];
  const start = direction === "forward" ? link.from : link.to;
  const end = direction === "forward" ? link.to : link.from;
  const source = networkInterface(scene, inputs, start, PSE, "source");
  const sink = networkInterface(scene, inputs, end, PD, "sink");
  const absent = source === undefined || sink === undefined;
  if (absent) return { inputs };

  const parts = scene.parts.filter(part => part.connection === connection);
  const types = [readNetworkClaim(scene, inputs, "interface", source, "poeType"),
    readNetworkClaim(scene, inputs, "interface", sink, "poeType"),
    ...parts.map(part => readNetworkClaim(scene, inputs, "item", part.item, "poeType"))] as (number | null)[];
  const type = ETHERNET_POE_TYPE_LIMITS.find(entry => entry.type ===
    Math.min(...types.map(type => type ?? ETHERNET_POE_TYPE_LIMITS.at(-1)!.type)));
  const losses = parts.map(part => readNetworkClaim(scene, inputs, "item", part.item, "poeLoss") as number | null);
  const loss = losses.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const id = readNetworkClaim(scene, inputs, "interface", source, "budgetResource");
  const item = scene.ports[start]!.item;
  const resource = scene.resources.findIndex(r => r.item === item && r.id === id && r.domain === NETWORK && r.unit === WATTS);
  const budget = resource < 0 ? null : readNetworkClaim(scene, inputs, "resource", resource, "capacity") as number | null;
  return { inputs, source, sink, type, loss, resource, budget, missingBudget: id !== null && resource < 0,
    pending: types.includes(null) || losses.includes(null) || budget === null };
}

export function negotiatePoe({ scene, connection, direction, ports }: Link): Option {
  const path = powerPath(scene, connection, direction);
  const { inputs, source, sink, type, budget, loss, missingBudget, pending } = path;
  const pass = channelPortsMatch(scene, inputs, ports);
  const specs = type?.type === 1 ? [POE_TYPE, POE_AF] : [POE_TYPE];
  const common = { mode: POE, unit: WATTS, condition: "", inputs, specs };
  if (!pass || source === undefined || sink === undefined)
    return { ...common, verdict: "impossible", limit: null, rule: "PoE 송전 포트 → 수전 포트 방향과 통과 채널 필요" };
  if (type === undefined) return { ...common, verdict: "impossible", limit: 0, rule: "PoE를 지원하지 않는 포트 또는 채널" };
  if (missingBudget) return { ...common, verdict: "impossible", limit: null, rule: "송전 포트가 지정한 W 예산 자원 없음" };

  const limit = Math.min(type.maxPdInputW, Math.max(0, Math.min(budget ?? type.pseBudgetW, type.pseBudgetW) - loss!));
  const rule = `PoE Type ${type.type} (${type.amendment}), 송전 규격 상한 ${type.pseBudgetW} W · 수전 규격 상한 ${type.maxPdInputW} W`;
  if (pending && limit > 0) return { ...common, verdict: "unknown", limit: null, bounds: { low: 0, high: limit },
    rule: rule + " · 포트 예산·Type 또는 채널 손실 미확인" };
  return { ...common, verdict: limit > 0 ? "ok" : "impossible", limit,
    rule: rule + ` · 송전 포트 예산 ${budget ?? "미확인"} W, 채널 손실 예약 ${loss} W, 수전 한도 ${limit} W` };
}

export function reservePoe(scene: Scene, connection: number, direction: Direction): Consumption[] {
  const path = powerPath(scene, connection, direction);
  if (path.resource === undefined || path.resource < 0) return [];
  return [{ resource: path.resource, fixed: path.loss!, coefficient: 1,
    rule: "송전 포트에서 수전 요청과 채널 손실을 W로 예약", inputs: path.inputs,
    specs: path.type?.type === 1 ? [POE_TYPE, POE_AF] : [POE_TYPE] }];
}
