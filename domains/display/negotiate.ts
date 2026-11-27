// 방향에 맞는 공통 영상 규격을 찾아 양 끝과 모든 중간 포트의 한도를 적용한다.
// 부품은 같은 프로토콜의 통과 포트로 취급하며, 한도에는 채널 인코딩까지만 반영한다.
import { effectiveClaim, type Link, type Option, type Value, type Verdict } from "../../engine/contract.ts";
import {
  DP_ALT_MODE_PIN_ASSIGNMENTS, DP_LINK_RATES, DP_MAX_LANES, DP_VERSION_MAX_LINK_RATES, HDMI_21_FRL_LINK_RATES,
  HDMI_TMDS_VERSION_LIMITS,
} from "./constants.ts";
import { dscTarget, DSC_PREFIX, SUBSAMPLED, UNCOMPRESSED, VIDEO_UNIT } from "./demand.ts";
import {
  dpAltModeCapacityGbps, dpLinkCapacityGbps, hdmiFrlCapacityGbps, hdmiTmdsCapacityGbps,
  type DpAltModePin, type HdmiFrlCode, type HdmiTmdsVersion,
} from "./link-capacity.ts";
import { DP_ALT_MODE, DP_RATES, DP_VERSIONS, DSC, HDMI_FRL, HDMI_TMDS } from "./sources.ts";

const PROTOCOLS = ["DP", "DP Alt Mode", "HDMI"] as const;

type Limit = Pick<Option, "limit" | "bounds">;

interface Capacity extends Limit {
  unused?: number;
  specs: string[];
  rule: string;
  verdict: Verdict;
  dscTransport?: Limit & Pick<Option, "rule" | "verdict">;
  subsampled?: Verdict;
}

function dpCapacity(read: (row: number, field: string) => Value, rows: number[], altMode: boolean): Capacity {
  const ports = rows.map(row => {
    const version = read(row, "version");
    const maxRate = read(row, "maxRate");
    const lanes = read(row, "lanes") as number | null;
    const rank = DP_LINK_RATES.findIndex(r => r.rate === maxRate);
    const ceiling = DP_VERSION_MAX_LINK_RATES.find(r => r.version === version);
    const highestRank = ceiling === undefined ? DP_LINK_RATES.length - 1 : DP_LINK_RATES.findIndex(r => r.rate === ceiling.maxRate);
    return { rank, lanes, highestRank };
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

  if (ports.some(p => p.rank > p.highestRank))
    return { limit: null, verdict: "unknown", rule: label + " 판본과 지원 링크 속도 주장이 충돌함", specs };

  const pinLanes = DP_ALT_MODE_PIN_ASSIGNMENTS.find(p => p.pin === pin)?.maxDpLanes ?? DP_MAX_LANES;
  const lowRate = DP_LINK_RATES[Math.min(...ports.map(p => Math.max(0, p.rank)))]!.rate;
  const highRate = DP_LINK_RATES[Math.min(...ports.map(p => p.rank < 0 ? p.highestRank : p.rank))]!.rate;
  const lowLanes = Math.min(pinLanes, ...ports.map(p => p.lanes ?? 1));
  const lanes = Math.min(pinLanes, ...ports.map(p => p.lanes ?? DP_MAX_LANES));
  const low = dpLinkCapacityGbps(lowRate, lowLanes);
  const limit = dpLinkCapacityGbps(highRate, lanes);
  if (low !== limit) return {
    limit: null, bounds: { low, high: limit }, verdict: "unknown", specs,
    rule: `${label} 지원 속도·레인 수에 따른 인코딩 후 한도 ${low}–${limit} Gbps`,
  };

  const rate = highRate;
  const ends = [ports[0]!, ports.at(-1)!];
  const unused = ends.every(p => p.rank >= 0 && p.lanes !== null) ? Math.max(...ends.map(p => {
    const rate = DP_LINK_RATES[p.rank]!.rate;
    const cap = dpLinkCapacityGbps(rate, p.lanes!);
    return pin === null ? cap : Math.min(cap, dpAltModeCapacityGbps(rate, pin));
  })) - limit : 0;
  return { limit, ...(unused > 0 ? { unused } : {}), specs, verdict: "ok",
    rule: `${label} 공통 ${rate} × ${lanes}레인 인코딩 후 한도 ${limit} Gbps` };
}

function hdmiCapacity(read: (row: number, field: string) => Value, rows: number[]): Capacity {
  const frl = rows.map(row => read(row, "frlCode") as HdmiFrlCode | 0 | null);
  const tmds = rows.map(row => read(row, "tmdsVersion") as HdmiTmdsVersion | null);
  const maxFrl = HDMI_21_FRL_LINK_RATES.at(-1)!.code;
  const commonFrl = Math.min(...frl.map(code => code ?? maxFrl)) as HdmiFrlCode | 0;
  const frlHigh = commonFrl === 0 ? 0 : hdmiFrlCapacityGbps(commonFrl);
  const frlLow = frl.includes(null) ? 0 : frlHigh;
  const maxTmds = Math.max(...HDMI_TMDS_VERSION_LIMITS.map(row => hdmiTmdsCapacityGbps(row.version)));
  const tmdsCapacities = tmds.map(version => version === null ? null : hdmiTmdsCapacityGbps(version));
  const tmdsLow = Math.min(...tmdsCapacities.map(limit => limit ?? 0));
  const tmdsHigh = Math.min(...tmdsCapacities.map(limit => limit ?? maxTmds));
  const low = Math.max(frlLow, tmdsLow);
  const high = Math.max(frlHigh, tmdsHigh);
  const specs = [HDMI_FRL, HDMI_TMDS];
  const dscTransport: Capacity["dscTransport"] = frlHigh === 0
    ? { limit: 0, verdict: "impossible", rule: "HDMI 경로의 FRL 미지원" }
    : frlLow === frlHigh
      ? { limit: frlHigh, verdict: "ok", rule: `HDMI FRL 공통 인코딩 후 한도 ${frlHigh} Gbps` }
      : { limit: null, bounds: { low: frlLow, high: frlHigh }, verdict: "unknown",
        rule: `HDMI FRL 공통 인코딩 후 한도 ${frlLow}–${frlHigh} Gbps` };
  if (low !== high) return {
    limit: null, bounds: { low, high }, verdict: "unknown", specs, dscTransport, subsampled: "unknown",
    rule: `HDMI TMDS·FRL 공통 인코딩 후 한도 ${low}–${high} Gbps`,
  };
  const name = high === frlLow ? "FRL" : "TMDS";
  return { limit: high, verdict: "ok", rule: `HDMI ${name} 공통 인코딩 후 한도 ${high} Gbps`, specs,
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

  const base = { unit: VIDEO_UNIT, rule: capacity.rule,
    ...(capacity.unused === undefined ? {} : { unused: capacity.unused }) };
  const plain = { ...base, limit: capacity.limit, verdict: capacity.verdict, inputs: [...inputs], specs: capacity.specs, condition: "" };
  const uncompressed = { ...plain, mode: UNCOMPRESSED, ...(capacity.bounds ? { bounds: capacity.bounds } : {}) };
  const subsampled = capacity.subsampled === "unknown"
    ? { ...plain, mode: SUBSAMPLED, verdict: "unknown" as const, rule: "HDMI의 크로마 서브샘플링 전송 한도 미확인" }
    : { ...uncompressed, mode: SUBSAMPLED };
  const options: Option[] = [uncompressed, subsampled];

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
    const transport = capacity.dscTransport ?? capacity;
    const blocked = endpoints.includes(0) || target !== null && endpoints.some(bpp => bpp !== null && bpp !== target);
    const codecKnown = target !== null && !endpoints.includes(null);
    const verdict = blocked || transport.verdict === "impossible" ? "impossible"
      : transport.verdict === "unknown" || !codecKnown ? "unknown" : "conditional";
    const bounds = transport.bounds && !codecKnown ? { low: 0, high: transport.bounds.high } : transport.bounds;
    const condition = verdict === "conditional" || codecKnown && bounds && verdict === "unknown"
      ? `양 끝이 DSC ${target} bpp로 동작할 때 · ${transport.rule}` : "";
    const rule = blocked ? "송신과 수신에 공통 DSC 목표가 없음" : verdict === "unknown" ? "DSC 전송 조건 또는 목표 bpp 미확인" : transport.rule;
    options.push({ ...base, mode: DSC_PREFIX + (target ?? "unknown"), limit: transport.limit, ...(bounds ? { bounds } : {}),
      verdict, condition, rule,
      inputs: [...inputs, ...targetInputs], specs: [...capacity.specs, DSC] });
  }
  return options;
}
