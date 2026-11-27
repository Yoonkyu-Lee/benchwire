// 고정 PDO와 케이블 등급을 교차해 링크의 총 전력 한도와 그 근거를 낸다.
import { readClaim, effectiveClaim, type Link, type Option, type Scene } from "../../engine/contract.ts";
import {
  USB_C_EPR_CABLE_REPORTED_VOLTAGE_V, USB_C_UNMARKED_CABLE_MAX_CURRENT_A, USB_PD_FIXED_SOURCE_LIMITS,
  USB_PD_MAX_CURRENT_A, USB_PD_POWER_LIMITS_W,
} from "./constants.ts";
import { CABLE, PD, POWER, POWER_UNIT } from "./input.ts";
import { portBudget } from "./port-budget.ts";
import { PD_FIXED, TYPE_C_CABLE } from "./sources.ts";

const UNMARKED = USB_C_UNMARKED_CABLE_MAX_CURRENT_A;

function field(scene: Scene, iface: number, name: string, inputs: number[]) {
  const row = effectiveClaim(scene, "interface", iface, POWER, name);
  if (row === undefined) return undefined;
  inputs.push(row);
  return readClaim(scene,row).value;
}

function cableCurrent(scene: Scene, cables: (number | undefined)[], epr: boolean, inputs: number[]) {
  if (!cables.length) return epr ? [0, 0] as const : [UNMARKED, UNMARKED] as const;
  let low = USB_PD_MAX_CURRENT_A, high = USB_PD_MAX_CURRENT_A;
  for (const cable of cables) {
    if (cable === undefined) { low = 0; continue; }
    const marked = field(scene, cable, "eMarked", inputs);
    const current = field(scene, cable, "currentA", inputs);
    if (epr) {
      const voltage = field(scene, cable, "eprVoltage", inputs);
      if (marked === false || current === UNMARKED || voltage === 0) return [0, 0] as const;
      if (marked !== true || current !== USB_PD_MAX_CURRENT_A || voltage !== USB_C_EPR_CABLE_REPORTED_VOLTAGE_V) low = 0;
    } else if (marked === false || current === UNMARKED) {
      low = Math.min(low, UNMARKED);
      high = Math.min(high, UNMARKED);
    } else if (marked !== true || current !== USB_PD_MAX_CURRENT_A) low = Math.min(low, UNMARKED);
  }
  return [low, high] as const;
}

export function negotiatePower({ scene, ports }: Link): [Option] {
  const inputs: number[] = [];
  const option = { mode: PD, unit: POWER_UNIT, condition: "", inputs, specs: [PD_FIXED] };
  function find(port: number, protocol: string, role: string) {
    let iface: number | undefined;
    scene.interfaces.forEach((i, row) => {
      if (i.port !== port || i.domain !== POWER) return;
      inputs.push(i.evidence);
      if (i.protocol === protocol && i.role === role) iface = row;
    });
    return iface;
  }

  const sourcePort = ports[0]!;
  const source = find(sourcePort, PD, "source"), sink = find(ports.at(-1)!, PD, "sink");
  if (source === undefined || sink === undefined) return [{ ...option, verdict: "impossible", limit: 0,
    rule: "USB PD 전력 경로에 송전 포트와 수전 포트가 필요함" }];

  const sourceW = field(scene, source, "maxW", inputs) as number | null;
  const sinkW = field(scene, sink, "maxW", inputs) as number | null;
  const cables = ports.slice(1, -1).map(port => find(port, CABLE, "cable"));
  let low = 0, high = 0;
  let voltage = 0, common = false;
  for (const pdo of USB_PD_FIXED_SOURCE_LIMITS) {
    const { voltageV, maxCurrentA, range } = pdo;
    const offer = field(scene, source, "pdo" + voltageV, inputs) as number | null | undefined;
    const accept = field(scene, sink, "accepts" + voltageV, inputs);
    if (offer === undefined || offer === 0 || accept === undefined || accept === false) continue;
    common = true;
    const [cableLow, cableHigh] = cableCurrent(scene, cables, range === "EPR", inputs);
    const specW = USB_PD_POWER_LIMITS_W[range];
    const floor = accept === true ? Math.min(voltageV * Math.min(offer ?? 0, cableLow), sourceW ?? 0, sinkW ?? 0, specW) : 0;
    high = Math.max(high, Math.min(voltageV * Math.min(offer ?? maxCurrentA, cableHigh),
      sourceW ?? specW, sinkW ?? specW, specW));
    if (floor > low) { low = floor; voltage = voltageV; }
  }
  if (!common) return [{ ...option, verdict: "impossible", limit: 0, rule: "송전·수전 포트에 공통 고정 PDO가 없음" }];
  option.specs.push(TYPE_C_CABLE);
  if (high === 0) return [{ ...option, verdict: "impossible", limit: 0, rule: "공통 고정 PDO의 포트·케이블 전력 한도가 0 W" }];

  const rules = [low === high ? `공통 고정 PDO ${voltage} V · ${low / voltage} A · ${low} W` :
    `공통 고정 PDO의 포트·케이블 한도 ${low}–${high} W`];
  const budget = portBudget(scene, sourcePort);
  if (budget) {
    inputs.push(...budget.inputs);
    low = Math.min(low, budget.value ?? 0);
    high = Math.min(high, budget.value ?? high);
    rules.push(budget.value === null ? "접속 포트 조합표의 한도 미확인" : `접속 포트 조합표 한도 ${budget.value} W`);
  }
  const rule = rules.join(", ");
  return low === high ? [{ ...option, verdict: high > 0 ? "ok" : "impossible", limit: high, rule }] :
    [{ ...option, verdict: "unknown", limit: null, bounds: { low, high }, rule }];
}
