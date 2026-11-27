// 이더넷과 PoE의 협상·수요·공유 자원 소비를 네트워크 영역으로 등록한다.
import { readClaim, effectiveClaim, type Demand, type DomainPlugin, type Verdict } from "../../engine/contract.ts";
import { MAC_PAYLOAD_FRACTION, PCIE_CARRIER, PCIE_NIC } from "./constants.ts";
import { negotiateEthernet } from "./ethernet.ts";
import { readNetworkClaim } from "./evidence.ts";
import {
  attributes, CHANNEL, ETHERNET, MAC, MBPS, NETWORK, observations, params, paramsFor, PD, POE, PSE, request, WATTS, WIRE_LINE,
} from "./input.ts";
import { negotiatePoe, poeBudgets, reservePoe } from "./poe.ts";
import { FRAMING, sources } from "./sources.ts";

const labels: Record<Verdict, string> = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const network: DomainPlugin = {
  id: NETWORK, sources, observations, params, paramsFor, attributes, request, resourceUnits: [MBPS, WATTS],
  requiredAttributes({ kind, protocols }) {
    if ((kind === "cable" || kind === "adapter") && protocols.has(CHANNEL))
      return { category: "", length: "m", screening: "", poeType: "", poeLoss: WATTS };
    return undefined;
  },
  profileValues(claim,scene) {
    if (claim.ownerKind!=="interface" || claim.field!=="budgetResource") return [];
    const item=scene.ports[scene.interfaces[claim.owner]!.port]!.item;
    return poeBudgets(scene,item).map(row=>scene.resources[row]!.id);
  },
  referenceError(claim,value,scene) {
    if (claim.ownerKind!=="interface" || claim.field!=="budgetResource" || value===null) return undefined;
    const item=scene.ports[scene.interfaces[claim.owner]!.port]!.item;
    if (!poeBudgets(scene,item).some(row=>scene.resources[row]!.id===value))
      return {at:"value",message:"이 모델에 없는 PoE 전력 예산 자원(W): "+value};
    return undefined;
  },
  negotiate(link) {
    const ends = link.scene.interfaces.filter(i => i.domain === NETWORK && [link.ports[0], link.ports.at(-1)].includes(i.port));
    const options = [];
    if (ends.some(i => i.protocol === PSE || i.protocol === PD)) options.push(negotiatePoe(link));
    if (!options.length || ends.some(i => i.protocol === ETHERNET)) options.push(negotiateEthernet(link));
    return options;
  },
  demand(scene, workload) {
    const inputs: number[] = [];
    const power = effectiveClaim(scene,"workload",workload,NETWORK,"watts")!==undefined;
    const requested = readNetworkClaim(scene, inputs, "workload", workload, power ? "watts" : "throughput") as number | null;
    const direct: Demand = { mode: power ? POE : MAC, unit: power ? WATTS : MBPS, elastic: !power, preference: 0, via: [], requested,
      rule: power ? "수전 포트의 고정 전력 요청" : "태그 없는 MTU 1500 MAC 페이로드 요청", inputs, specs: power ? [] : [FRAMING] };
    if (power) return [direct];
    const w = scene.workloads[workload]!, demands = [direct];
    const ethernet = { domain: NETWORK, mode: MAC };
    for (const iface of scene.interfaces) {
      if (iface.domain !== NETWORK || iface.protocol !== ETHERNET) continue;
      const attachment = effectiveClaim(scene, "port", iface.port, "", "attachment")!;
      const node = readClaim(scene,attachment).attachmentNode;
      if (node == null || scene.nodes[node]!.kind !== PCIE_NIC || w.from === node || w.to === node) continue;
      for (const carriers of [[PCIE_CARRIER, ethernet], [ethernet, PCIE_CARRIER]]) demands.push({ ...direct, via: [node], carriers,
        inputs: [...inputs, iface.evidence, attachment], rule: "PCIe NIC 경유 MAC 페이로드 · 8 Mbps당 터널 1 MB/s" });
    }
    return demands;
  },
  consume(scene, _workload, steps, demand, options) {
    if (demand.mode === POE) {
      if (!demand.requested) return [];
      return steps.flatMap(step => step.kind === "connection" && step.option !== null && options[step.option]!.mode === POE
        ? reservePoe(scene, step.row, step.direction) : []);
    }
    return steps.flatMap(step => step.kind !== "edge" ? [] : scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row) return [];
      const resource = scene.resources[use.resource]!;
      if (resource.domain !== NETWORK || resource.unit !== MBPS) return [];
      const line = resource.kind === WIRE_LINE;
      return [{ resource: use.resource, fixed: 0, coefficient: line ? 1 / MAC_PAYLOAD_FRACTION : 1,
        rule: line ? "회선의 원시 Mbps에서 MAC 프레임 점유량 예약" : "백플레인·업링크의 실효 MAC 페이로드 예약",
        inputs: [use.evidence], specs: line ? [FRAMING] : [] }];
    }));
  },
  explain(verdict, mode) { return (mode === POE ? "PoE " : "이더넷 ") + labels[verdict]; },
  quest(field) {
    switch (field) {
      case "baseTModes": return "이 포트가 협상할 수 있는 BASE-T 모드를 확인하세요.";
      case "networkRole": return "이 포트가 LAN, WAN 또는 회선 제공 포트인지 확인하세요.";
      case "category": return "케이블의 채널 등급을 확인하세요.";
      case "length": return "패치 코드를 포함한 케이블 길이(m)를 확인하세요.";
      case "screening": return "설치 채널의 차폐 여부를 확인하세요.";
      case "poeType": return "포트 또는 케이블이 지원하는 PoE Type을 확인하세요.";
      case "poeLoss": return "이 PoE 채널에서 예산에 예약할 최대 전력 손실(W)을 확인하세요.";
      case "budgetResource": return "송전 포트가 사용할 PoE 예산 자원을 확인하세요.";
      case "capacity": return "네트워크 자원의 용량을 확인하세요.";
      case "policy": return "공유 네트워크 자원의 동시 배분 정책을 확인하세요.";
      default: return field + " 값을 확인하세요.";
    }
  },
};
