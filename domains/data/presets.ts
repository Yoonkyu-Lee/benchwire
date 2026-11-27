// USB 전송 작업을 시작할 요청값과 화면 이름을 둔다.
import { BULK, MB_PER_SECOND, PCIE_TUNNEL } from "./input.ts";

export const dataDomainName = "데이터";
const DEFAULT_TRANSFER_MB_PER_SECOND = 800;
const request = { throughput: { value: DEFAULT_TRANSFER_MB_PER_SECOND, unit: MB_PER_SECOND } };
const labels = { throughput: "요청 처리량" };

export const dataPresets = [
  { kind: BULK, name: "USB 데이터 전송", request, labels },
  { kind: PCIE_TUNNEL, name: "PCIe 터널 전송", request, labels },
];
