// 방향별 영상 전송 한도와 DSC 인코더·디코더의 출처를 연결 옵션으로 낸다.
// DP 터널 케이블의 한도는 data 예산에서 가져온다. 한 연결에서 공통 영상 프로토콜이 여럿이면 선택은 미확인이다.
import { effectiveClaim, type Link, type Option, type Value, type Verdict } from "../../engine/contract.ts";
import { altModeProfiles, supportsDisplayRole } from "./alt-mode.ts";
import {
  DP_ALT_MODE_PIN_ASSIGNMENTS, DP_LINK_RATES, DP_MAX_LANES, DP_VERSION_MAX_LINK_RATES, HDMI_21_FRL_LINK_RATES,
  HDMI_TMDS_VERSION_LIMITS,
} from "./constants.ts";
import { SUBSAMPLED, UNCOMPRESSED, VIDEO_UNIT } from "./demand.ts";
import { DSC_MODE, type DisplayOption } from "./dsc.ts";
import {
  dpAltModeCapacityGbps, dpLinkCapacityGbps, hdmiFrlCapacityGbps, hdmiTmdsCapacityGbps,
  type DpAltModePin, type HdmiFrlCode, type HdmiTmdsVersion,
} from "./link-capacity.ts";
import { DP_ALT_MODE, DP_RATES, DP_TUNNEL, DP_VERSIONS, DSC, HDMI_FRL, HDMI_TMDS } from "./sources.ts";

const PROTOCOLS = ["DP", "DP Alt Mode", "DP Tunnel", "HDMI"] as const;

type Limit = Pick<Option, "limit" | "bounds">;

interface Capacity extends Limit {
  unused?: number;
  specs: string[];
  rule: string;
  verdict: Verdict;
  dscTransport?: Limit & Pick<Option, "rule" | "verdict">;
  subsampled?: Verdict;
}

function dpCapacity(read: (row: number, field: string) => Value, rows: number[], protocol: "DP" | "DP Alt Mode" | "DP Tunnel",
  pins?: readonly [DpAltModePin | null, DpAltModePin | null]): Capacity {
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
  let pinCanMismatch = false;
  let label: string = protocol;
  if (protocol === "DP Tunnel") specs.push(DP_TUNNEL);
  if (protocol === "DP Alt Mode") {
    specs.push(DP_ALT_MODE);
    const [sourcePin, sinkPin] = pins ?? [read(rows[0]!, "pin") as DpAltModePin | null,
      read(rows.at(-1)!, "pin") as DpAltModePin | null];
    if (sourcePin !== null && sinkPin !== null && sourcePin !== sinkPin)
      return { limit: null, verdict: "impossible", rule: "양 끝의 DP Alt Mode 핀 할당이 다름", specs };
    pin = sourcePin ?? sinkPin;
    if (pin === null)
      return { limit: null, verdict: "unknown", rule: "DP Alt Mode 핀 할당 미확인", specs };
    pinCanMismatch = sourcePin === null || sinkPin === null;
    label = "DP Alt Mode 핀 " + pin;
  }

  if (ports.some(p => p.rank > p.highestRank))
    return { limit: null, verdict: "unknown", rule: label + " 판본과 지원 링크 속도 주장이 충돌함", specs };

  const pinLanes = DP_ALT_MODE_PIN_ASSIGNMENTS.find(p => p.pin === pin)?.maxDpLanes ?? DP_MAX_LANES;
  const lowRate = DP_LINK_RATES[Math.min(...ports.map(p => Math.max(0, p.rank)))]!.rate;
  const highRate = DP_LINK_RATES[Math.min(...ports.map(p => p.rank < 0 ? p.highestRank : p.rank))]!.rate;
  const lowLanes = Math.min(pinLanes, ...ports.map(p => p.lanes ?? 1));
  const lanes = Math.min(pinLanes, ...ports.map(p => p.lanes ?? DP_MAX_LANES));
  const low = pinCanMismatch ? 0 : dpLinkCapacityGbps(lowRate, lowLanes);
  const limit = dpLinkCapacityGbps(highRate, lanes);
  if (low !== limit) {
    const basis = pinCanMismatch ? "양 끝 핀 일치 여부와 지원 속도·레인 수" : "지원 속도·레인 수";
    return { limit: null, bounds: { low, high: limit }, verdict: "unknown", specs,
      rule: `${label} ${basis}에 따른 인코딩 후 한도 ${low}–${limit} Gbps` };
  }

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

export function negotiateDisplay({ scene, connection, ports }: Link): DisplayOption[] {
  const declarationsInputs = [scene.connections[connection]!.evidence];
  const declarations = ports.map(port => scene.interfaces.flatMap((i, row) => {
    if (i.port !== port || i.domain !== "display") return [];
    declarationsInputs.push(i.evidence);
    return [{ ...i, row }];
  }));
  const common = PROTOCOLS.flatMap(protocol => {
    const last = ports.length - 1;
    const interfaces = declarations.flatMap((entries, i) => {
      if (protocol === "DP Tunnel" && i !== 0 && i !== last) return [];
      const role = i === 0 ? "source" : i === last ? "sink" : "bidirectional";
      return [entries.filter(entry => entry.protocol === protocol && supportsDisplayRole(entry.role,role))];
    });
    return interfaces.every(entries => entries.length > 0) ? [{ protocol, interfaces }] : [];
  });

  const chosen = common.length === 1 && common[0]!.interfaces.every(entries => entries.length === 1) ? common[0] : undefined;
  const rows = chosen?.interfaces.map(entries => entries[0]!.row) ?? [];
  if (chosen?.protocol === "DP Alt Mode") {
    const profiles = altModeProfiles(scene,[[rows[0]!,rows.at(-1)!]]);
    const options = profiles.flatMap(p => optionsFor(p.id,p.pins,p.inputs));
    if (options.length) return options;
  }
  return optionsFor();

  function optionsFor(profile?: string, pins?: readonly [DpAltModePin | null, DpAltModePin | null], pinClaims: number[] = []): DisplayOption[] {
    const inputs = [...declarationsInputs, ...pinClaims];
    function read(row: number, field: string) {
      const claim = effectiveClaim(scene, "interface", row, "display", field);
      if (claim === undefined) return null;
      inputs.push(claim);
      return scene.claims[claim]!.value;
    }

    let capacity: Capacity;
    if (chosen) {
      capacity = chosen.protocol === "HDMI" ? hdmiCapacity(read, rows) : dpCapacity(read, rows, chosen.protocol, pins);
    } else {
      capacity = common.length > 0
        ? { limit: null, verdict: "unknown", rule: "동일 방향의 공통 영상 인터페이스 선택 미확인", specs: [] }
        : { limit: null, verdict: "impossible", rule: "이 방향의 공통 영상 프로토콜 없음", specs: [] };
    }

    const base = { unit: VIDEO_UNIT, rule: capacity.rule, ...(profile ? { profile } : {}),
      ...(chosen?.protocol === "DP Tunnel" ? { pool: { domain: "data", id: "usb4-tunnel", perUnit: 1 } } : {}),
      ...(capacity.unused === undefined ? {} : { unused: capacity.unused }) };
    const plain = { ...base, limit: capacity.limit, verdict: capacity.verdict, inputs: [...inputs], specs: capacity.specs, condition: "" };
    const uncompressed = { ...plain, mode: UNCOMPRESSED, ...(capacity.bounds ? { bounds: capacity.bounds } : {}) };
    const subsampled = capacity.subsampled === "unknown"
      ? { ...plain, mode: SUBSAMPLED, verdict: "unknown" as const, rule: "HDMI의 크로마 서브샘플링 전송 한도 미확인" }
      : { ...uncompressed, mode: SUBSAMPLED };
    const encoderClaim = chosen ? effectiveClaim(scene, "interface", rows[0]!, "display", "dscBpp") : undefined;
    const decoderClaim = chosen ? effectiveClaim(scene, "interface", rows.at(-1)!, "display", "dscBpp") : undefined;
    const codecInputs = [encoderClaim, decoderClaim].filter(claim => claim !== undefined);
    const { limit, bounds, verdict, rule } = capacity.dscTransport ?? capacity;
    const dsc: DisplayOption = { ...base, mode: DSC_MODE, limit, ...(bounds ? { bounds } : {}),
      verdict: verdict === "ok" ? "conditional" : verdict, condition: "", rule,
      inputs: [...inputs, ...codecInputs], specs: [...capacity.specs, DSC],
      ...(encoderClaim === undefined ? {} : { encoderClaim }), ...(decoderClaim === undefined ? {} : { decoderClaim }),
    };
    return [uncompressed, subsampled, dsc];
  }
}
