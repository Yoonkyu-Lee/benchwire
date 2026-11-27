// 방향에 맞는 공통 영상 규격을 찾아 양 끝과 모든 중간 포트의 한도를 적용한다.
// 부품은 같은 프로토콜의 통과 포트로 취급하며, 한도에는 채널 인코딩까지만 반영한다.
import { effectiveClaim, type Link, type Option, type Value, type Verdict } from "../../engine/contract.ts";
import { DP_ALT_MODE_PIN_ASSIGNMENTS, DP_LINK_RATES, DP_VERSION_MAX_LINK_RATES, HDMI_TMDS_VERSION_LIMITS } from "./constants.ts";
import { dscTarget, DSC_PREFIX, SUBSAMPLED, UNCOMPRESSED, VIDEO_UNIT } from "./demand.ts";
import {
  dpAltModeCapacityGbps, dpLinkCapacityGbps, hdmiFrlCapacityGbps, hdmiTmdsCapacityGbps,
  type DpAltModePin, type HdmiFrlCode, type HdmiTmdsVersion,
} from "./link-capacity.ts";
import { DP_ALT_MODE, DP_RATES, DP_VERSIONS, DSC, HDMI_FRL, HDMI_TMDS } from "./sources.ts";

const PROTOCOLS = ["DP", "DP Alt Mode", "HDMI"] as const;

interface Capacity {
  limit: number | null;
  unused?: number;
  specs: string[];
  rule: string;
  verdict: Verdict;
  dscTransport?: Verdict;
  subsampled?: Verdict;
}

function dpCapacity(read: (row: number, field: string) => Value, rows: number[], altMode: boolean): Capacity {
  const ports = rows.map(row => {
    const version = read(row, "version");
    const maxRate = read(row, "maxRate");
    const lanes = read(row, "lanes") as number | null;
    const rank = DP_LINK_RATES.findIndex(r => r.rate === maxRate);
    const ceiling = DP_VERSION_MAX_LINK_RATES.find(r => r.version === version);
    const conflict = ceiling !== undefined && rank > DP_LINK_RATES.findIndex(r => r.rate === ceiling.maxRate);
    return { rank, lanes, conflict };
  });
  const specs = [DP_RATES, DP_VERSIONS];
  let pin: DpAltModePin | null = null;
  let label = "DP";
  if (altMode) {
    specs.push(DP_ALT_MODE);
    const sourcePin = read(rows[0]!, "pin") as DpAltModePin | null;
    const sinkPin = read(rows.at(-1)!, "pin") as DpAltModePin | null;
    if (sourcePin !== null && sinkPin !== null && sourcePin !== sinkPin)
      return { limit: null, verdict: "impossible", rule: "양 끝의 DP Alt Mode 핀 할당이 다름", specs };
    pin = sourcePin ?? sinkPin;
    if (pin === null)
      return { limit: null, verdict: "unknown", rule: "DP Alt Mode 핀 할당 미확인", specs };
    label = "DP Alt Mode 핀 " + pin;
  }

  if (ports.some(p => p.conflict))
    return { limit: null, verdict: "unknown", rule: label + " 판본과 지원 링크 속도 주장이 충돌함", specs };
  if (ports.some(p => p.rank < 0 || p.lanes === null))
    return { limit: null, verdict: "unknown", rule: label + " 경로의 지원 링크 속도 또는 레인 수 미확인", specs };

  const rate = DP_LINK_RATES[Math.min(...ports.map(p => p.rank))]!.rate;
  const pinLanes = DP_ALT_MODE_PIN_ASSIGNMENTS.find(p => p.pin === pin)?.maxDpLanes ?? Infinity;
  const lanes = Math.min(pinLanes, ...ports.map(p => p.lanes!));
  const limit = dpLinkCapacityGbps(rate, lanes);
  const unused = Math.max(...[ports[0]!, ports.at(-1)!].map(p => {
    const rate = DP_LINK_RATES[p.rank]!.rate;
    const cap = dpLinkCapacityGbps(rate, p.lanes!);
    return pin === null ? cap : Math.min(cap, dpAltModeCapacityGbps(rate, pin));
  })) - limit;
  return { limit, ...(unused > 0 ? { unused } : {}), specs, verdict: "ok",
    rule: `${label} 공통 ${rate} × ${lanes}레인 인코딩 후 한도 ${limit} Gbps` };
}

function hdmiCapacity(read: (row: number, field: string) => Value, rows: number[]): Capacity {
  const frl = rows.map(row => read(row, "frlCode") as HdmiFrlCode | 0 | null);
  const tmds = rows.map(row => read(row, "tmdsVersion") as HdmiTmdsVersion | null);
  const specs = [HDMI_FRL, HDMI_TMDS];
  if (!frl.includes(0) && frl.includes(null))
    return { limit: null, verdict: "unknown", rule: "HDMI 경로의 FRL 지원 미확인", specs };
  const frlCap = frl.includes(0) ? null : hdmiFrlCapacityGbps(Math.min(...frl as HdmiFrlCode[]) as HdmiFrlCode);
  const tmdsCap = tmds.includes(null) ? null : Math.min(...(tmds as HdmiTmdsVersion[]).map(hdmiTmdsCapacityGbps));
  if (frlCap !== null && tmdsCap === null && frlCap < Math.max(...HDMI_TMDS_VERSION_LIMITS.map(row => hdmiTmdsCapacityGbps(row.version))))
    return { limit: null, verdict: "unknown", rule: "HDMI 경로의 공통 TMDS 한도 미확인", specs };
  const limit = frlCap === null ? tmdsCap : Math.max(frlCap, tmdsCap ?? 0);
  const dscTransport = frl.includes(0) ? "impossible" : frlCap === null || frlCap !== limit ? "unknown" : "ok";
  if (limit === null) return { limit, verdict: "unknown", rule: "HDMI 경로의 공통 TMDS 또는 FRL 한도 미확인", specs, dscTransport };
  const name = limit === frlCap ? "FRL" : "TMDS";
  return { limit, verdict: "ok", rule: `HDMI ${name} 공통 인코딩 후 한도 ${limit} Gbps`, specs,
    dscTransport, subsampled: "unknown" };
}

export function negotiateDisplay({ scene, connection, ports }: Link): Option[] {
  const inputs = [scene.connections[connection]!.evidence];
  const declarations = ports.map(port => scene.interfaces.flatMap((i, row) => {
    if (i.port !== port || i.domain !== "display") return [];
    inputs.push(i.evidence);
    return [{ ...i, row }];
  }));
  const common = PROTOCOLS.flatMap(protocol => {
    const interfaces = declarations.map((entries, i) => entries.filter(entry => entry.protocol === protocol &&
      (entry.role === "bidirectional" || (i === 0 ? entry.role === "source" : i === ports.length - 1 && entry.role === "sink"))));
    return interfaces.every(entries => entries.length > 0) ? [{ protocol, interfaces }] : [];
  });

  function read(row: number, field: string) {
    const claim = effectiveClaim(scene, "interface", row, "display", field);
    if (claim === undefined) return null;
    inputs.push(claim);
    return scene.claims[claim]!.value;
  }

  const chosen = common.length === 1 && common[0]!.interfaces.every(entries => entries.length === 1) ? common[0] : undefined;
  const rows = chosen?.interfaces.map(entries => entries[0]!.row) ?? [];
  let capacity: Capacity;
  if (chosen) {
    capacity = chosen.protocol === "HDMI" ? hdmiCapacity(read, rows) : dpCapacity(read, rows, chosen.protocol === "DP Alt Mode");
  } else {
    capacity = common.length > 0
      ? { limit: null, verdict: "unknown", rule: "동일 방향의 공통 영상 인터페이스 선택 미확인", specs: [] }
      : { limit: null, verdict: "impossible", rule: "이 방향의 공통 영상 프로토콜 없음", specs: [] };
  }

  const base = { limit: capacity.limit, unit: VIDEO_UNIT, rule: capacity.rule,
    ...(capacity.unused === undefined ? {} : { unused: capacity.unused }) };
  const options: Option[] = [{ ...base, mode: UNCOMPRESSED, verdict: capacity.verdict, inputs: [...inputs], specs: capacity.specs, condition: "" }];
  const subsampled = capacity.subsampled ?? capacity.verdict;
  options.push({ ...options[0]!, mode: SUBSAMPLED, verdict: subsampled,
    rule: subsampled === "unknown" && capacity.verdict === "ok" ? "HDMI의 크로마 서브샘플링 전송 한도 미확인" : capacity.rule });

  const endpoints = chosen ? [read(rows[0]!, "dscBpp"), read(rows.at(-1)!, "dscBpp")] : [];
  const targets = new Map<number | null, number[]>();
  for (const target of endpoints) if (typeof target === "number" && target > 0) targets.set(target, []);
  scene.workloads.forEach((work, workload) => {
    if (work.domain !== "display") return;
    const target = dscTarget(scene, workload);
    if (target) {
      const claims = targets.get(target.value);
      if (!claims) targets.set(target.value, [target.claim]);
      else if (claims.length) claims.push(target.claim);
    }
  });
  for (const [target, targetInputs] of targets) {
    const transport = capacity.dscTransport ?? capacity.verdict;
    const blocked = endpoints.includes(0) || target !== null && endpoints.some(bpp => bpp !== null && bpp !== target);
    const verdict = blocked || transport === "impossible" ? "impossible"
      : transport === "unknown" || target === null || endpoints.includes(null) ? "unknown" : "conditional";
    const condition = verdict === "conditional" ? `양 끝이 DSC ${target} bpp로 동작할 때 · ${capacity.rule}` : "";
    const rule = blocked ? "송신과 수신에 공통 DSC 목표가 없음" : verdict === "unknown" ? "DSC 전송 조건 또는 목표 bpp 미확인" : capacity.rule;
    options.push({ ...base, mode: DSC_PREFIX + (target ?? "unknown"), verdict, condition, rule, inputs: [...inputs, ...targetInputs], specs: [...capacity.specs, DSC] });
  }
  return options;
}
