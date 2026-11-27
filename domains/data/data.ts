// USB 데이터의 벌크·PCIe 터널 수요와 허브·호스트 컨트롤러 자원 소비를 등록한다.
import { effectiveClaim, type DomainPlugin, type Verdict } from "../../engine/contract.ts";
import { attributes, BULK, DATA, MB_PER_SECOND, params, paramsFor, PCIE_TUNNEL, request } from "./input.ts";
import { usbServices } from "./negotiate.ts";
import { sources } from "./sources.ts";

const labels: Record<Verdict, string> = { ok: "성립", conditional: "조건부", impossible: "불가", unknown: "미확인" };

export const data: DomainPlugin = {
  id: DATA, sources, params, paramsFor, attributes, request, resourceUnits: [MB_PER_SECOND],
  negotiate(link) { return usbServices(link).options; },
  pools(link) { return usbServices(link).pools; },
  demand(scene, workload) {
    const row = effectiveClaim(scene, "workload", workload, DATA, "throughput");
    const requested = row === undefined ? null : scene.claims[row]!.value as number | null;
    const mode = scene.workloads[workload]!.kind === PCIE_TUNNEL ? PCIE_TUNNEL : BULK;
    return [{ mode, unit: MB_PER_SECOND, requested, via: [], preference: 0, elastic: true,
      rule: "요청한 데이터 페이로드 처리량", inputs: row === undefined ? [] : [row], specs: [] }];
  },
  consume(scene, _workload, steps) {
    return steps.flatMap(step => step.kind !== "edge" ? [] : scene.resourceUses.flatMap(use => {
      if (use.edge !== step.row || scene.resources[use.resource]!.domain !== DATA) return [];
      return [{ resource: use.resource, fixed: 0, coefficient: 1,
        rule: "내부 데이터 자원에서 전송 처리량 예약", inputs: [use.evidence], specs: [] }];
    }));
  },
  explain(verdict, mode) { return (mode === PCIE_TUNNEL ? "PCIe 터널 " : "USB 벌크 전송 ") + labels[verdict]; },
  quest(field) {
    switch (field) {
      case "modes": return "포트가 지원하는 USB 링크 모드를 확인하세요.";
      case "cableDataGbps": return "케이블 또는 변환 부품의 USB 데이터 등급(Gbps)을 확인하세요.";
      case "cableUsb4": return "케이블 또는 변환 부품이 USB4 신호를 통과시키는지 확인하세요.";
      case "usb3Modes": return "포트가 지원하는 USB4 USB3 터널의 USB 3.2 모드를 확인하세요.";
      case "pcie": return "포트가 PCIe 터널을 지원하는지 확인하세요.";
      case "tunnelGbps": return "장비의 USB4 가용 터널 예산(Gbps)을 확인하세요.";
      case "throughput": return "전송에 필요한 처리량(MB/s)을 확인하세요.";
      case "capacity": return "허브 또는 호스트 컨트롤러의 공유 처리량(MB/s)을 확인하세요.";
      case "policy": return "데이터 자원의 동시 배분 정책을 확인하세요.";
      default: return field + " 값을 확인하세요.";
    }
  },
};
