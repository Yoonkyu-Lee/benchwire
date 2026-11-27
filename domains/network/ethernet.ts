// 공통 BASE-T 모드, 설치 채널의 도달 거리와 태그 없는 MAC 페이로드 한도를 협상한다.
import { readClaim, compareQuantity, effectiveClaim, type Claim, type Scene, type Link, type Option } from "../../engine/contract.ts";
import { COPPER_CATEGORIES, ETHERNET_BASE_T_RATES, ETHERNET_COPPER_CHANNEL_REACH, MAC_PAYLOAD_FRACTION } from "./constants.ts";
import { channelPortsMatch, networkInterface, readNetworkClaim } from "./evidence.ts";
import { ETHERNET, MAC, MBPS, NETWORK, parseBaseTModes } from "./input.ts";
import { BASE_T, CAT6_REACH, FRAMING, REACH } from "./sources.ts";

type Mode = (typeof ETHERNET_BASE_T_RATES)[number]["mode"];
type Screening = "screened" | "unscreened";
interface Channel { category: number; screening: Screening; length: number }

function reach(mode: Mode, { category, screening, length }: Channel) {
  const relevant = ETHERNET_COPPER_CHANNEL_REACH.filter(row =>
    row.mode === mode && COPPER_CATEGORIES.indexOf(row.category) <= category &&
    (row.screening === "any" || row.screening === screening) &&
    (compareQuantity(length,row.reachM) <= 0 || "mitigatedReachM" in row && compareQuantity(length,row.mitigatedReachM) <= 0));
  if (relevant.some(row => !row.requiresExtraQualification)) return "ok";
  return relevant.length ? "conditional" : "impossible";
}

// IEEE BASE-T 채널 도달 거리 표의 모든 경계 사이에서 협상은 일정하다. 한 채널 안에 열린 길이가 둘이면 합산 경계를 따로 고정할 수 없다.
export function lengthRepresentatives(claim:Claim, scene:Scene) {
  if (claim.ownerKind!=="item" || claim.field!=="length") return;
  const links=scene.parts.filter(p=>p.item===claim.owner);
  if (links.length!==1) return;
  let known=0;
  for (const part of scene.parts.filter(p=>p.connection===links[0]!.connection && p.item!==claim.owner)) {
    const row=effectiveClaim(scene,"item",part.item,NETWORK,"length");
    const length=row===undefined ? null : readClaim(scene,row).value;
    if (typeof length!=="number") return;
    known+=length;
  }
  const link=scene.connections[links[0]!.connection]!;
  const modes=[link.from,link.to].map(port=>{
    const row=networkInterface(scene,[],port,ETHERNET,"bidirectional");
    const value=row===undefined ? null : readNetworkClaim(scene,[],"interface",row,"baseTModes");
    return typeof value==="string" ? parseBaseTModes(value) : null;
  });
  const reaches=ETHERNET_COPPER_CHANNEL_REACH.filter(r=>modes.every(end=>end===null || end.includes(r.mode)));
  const edges=[...new Set(reaches.flatMap(r=>"mitigatedReachM" in r ? [r.reachM,r.mitigatedReachM] : [r.reachM]))]
    .filter(total=>compareQuantity(known,total)<=0).sort((a,b)=>a-b);
  // 0은 이미 깔린 길이가 문턱의 허용 오차 안에 있을 때도 첫 구간을 대표한다.
  return [0,...edges.map((edge,i)=> (edges[i+1]===undefined ? edge+1 : (edge+edges[i+1]!)/2)-known)];
}

export function negotiateEthernet({ scene, connection, ports }: Link): Option {
  const inputs = [scene.connections[connection]!.evidence];
  const base = { mode: MAC, unit: MBPS, condition: "", inputs };
  const ends = [ports[0]!, ports.at(-1)!].map(port => networkInterface(scene, inputs, port, ETHERNET, "bidirectional"));
  const pass = channelPortsMatch(scene, inputs, ports);
  if (!pass || ends.some(row => row === undefined))
    return { ...base, verdict: "impossible", limit: null, rule: "양 끝의 이더넷 포트와 중간 부품의 이더넷 통과 포트 필요", specs: [BASE_T] };

  const roles = ends.map(row => readNetworkClaim(scene, inputs, "interface", row!, "networkRole"));
  const roleKnown = roles.every(role => role !== null);
  const [a, b] = roles;
  const allowsRole = a === "lan" && b === "lan" || a === "wan" && b === "provider" || a === "provider" && b === "wan";
  if (roleKnown && !allowsRole)
    return { ...base, verdict: "impossible", limit: null, rule: `포트 역할 ${a} ↔ ${b} 결합 불가`, specs: [] };

  const modes = ends.map(row => {
    const value = readNetworkClaim(scene, inputs, "interface", row!, "baseTModes");
    return typeof value === "string" ? parseBaseTModes(value) : null;
  });

  const cables = scene.parts.filter(part => part.connection === connection).map(({ item }) => {
    const category = readNetworkClaim(scene, inputs, "item", item, "category") as typeof COPPER_CATEGORIES[number] | null;
    return {
      category: category === null ? null : COPPER_CATEGORIES.indexOf(category),
      length: readNetworkClaim(scene, inputs, "item", item, "length") as number | null,
      screening: readNetworkClaim(scene, inputs, "item", item, "screening") as Screening | null,
    };
  });
  const partialLength = cables.reduce((length, cable) => length + (cable.length ?? 0), 0);
  const maxCategory = COPPER_CATEGORIES.length - 1;
  const pessimistic: Channel = {
    category: Math.min(...cables.map(c => c.category ?? 0), maxCategory),
    screening: cables.length && cables.every(c => c.screening === "screened") ? "screened" : "unscreened",
    length: cables.length && cables.every(c => c.length !== null) ? partialLength : Infinity,
  };
  const optimistic: Channel = {
    category: Math.min(...cables.map(c => c.category ?? maxCategory), maxCategory),
    screening: cables.some(c => c.screening === "unscreened") ? "unscreened" : "screened",
    length: partialLength,
  };

  const observation = effectiveClaim(scene, "connection", connection, NETWORK, "linkSpeed");
  const observed = observation === undefined ? null : readClaim(scene,observation).value;
  if (observation !== undefined) inputs.push(observation);
  const observedOption = typeof observed === "number" && observation !== undefined ? { observation } : {};
  const candidates = ETHERNET_BASE_T_RATES.flatMap(rate => {
    if (typeof observed === "number") return rate.lineMbps === observed
      ? [{...rate,confirmed:"ok" as const,possible:"ok" as const}] : [];
    if (modes.some(end => end !== null && !end.includes(rate.mode))) return [];
    const possible = reach(rate.mode, optimistic);
    if (possible === "impossible") return [];
    const confirmed = reach(rate.mode, pessimistic);
    return [{ ...rate, confirmed, possible }];
  });
  const specs = [BASE_T, REACH];
  if (modes.every(end => end === null || end.includes("10GBASE-T"))) specs.push(CAT6_REACH);
  const best = candidates.at(-1);
  if (!best) {
    const common = ETHERNET_BASE_T_RATES.some(rate => modes.every(end => end === null || end.includes(rate.mode)));
    return { ...base, verdict: "impossible", limit: null, specs,
      rule: common ? "케이블 등급·차폐·채널 길이가 공통 BASE-T 모드의 도달 거리 조건을 충족하지 않음" : "양 끝에 공통 BASE-T 모드 없음" };
  }

  const limit = best.lineMbps * MAC_PAYLOAD_FRACTION;
  const measured = typeof observed === "number";
  const modeKnown = roleKnown && (measured || modes.every(end => end !== null));
  if (!modeKnown || !measured && best.confirmed !== best.possible) {
    const guaranteed = candidates.findLast(candidate => candidate.confirmed === "ok");
    const low = modeKnown && guaranteed ? guaranteed.lineMbps * MAC_PAYLOAD_FRACTION : 0;
    return { ...base, ...observedOption, limit: null, bounds: { low, high: limit }, verdict: "unknown", specs: [...specs, FRAMING],
      rule: `포트 역할·지원 모드·채널 미확인에서 최대 ${best.mode} ${best.lineMbps} Mbps, MAC 페이로드 한도 ${low}–${limit} Mbps` };
  }

  const grade = pessimistic.category === optimistic.category ? COPPER_CATEGORIES[optimistic.category] : "등급 미확인";
  const endpointSpeeds = modes.map(end => end === null || measured && !end.includes(best.mode) ? null :
    ETHERNET_BASE_T_RATES.findLast(rate => end.includes(rate.mode))!.lineMbps);
  const unusedLine = endpointSpeeds.every(speed => speed !== null) ? Math.max(...endpointSpeeds) - best.lineMbps : 0;
  const channel = measured ? "현재 배선에서 관측" : `${grade} 채널 ${partialLength} m`;
  const rule = `${best.mode} (${best.amendment}) 회선 ${best.lineMbps} Mbps · ${channel} · MAC 페이로드 ${limit} Mbps` +
    (unusedLine > 0 ? ` · 포트 미사용 회선 성능 ${unusedLine} Mbps` : "");
  const condition = best.confirmed === "conditional" ? rule + " · 설치 채널의 외래 누화 등 도달 거리 조건 확인 및 필요한 완화 적용" : "";
  return { ...base, ...observedOption, limit, ...(unusedLine > 0 ? { unused: unusedLine * MAC_PAYLOAD_FRACTION } : {}),
    condition, rule, verdict: condition ? "conditional" : "ok", specs: [...specs, FRAMING] };
}
