// USB 인터페이스의 표시 어휘와 전송 작업의 시작값을 둔다.
import { BULK, MB_PER_SECOND, PCIE_TUNNEL, USB, USB4 } from "./input.ts";

export const dataDomainName = "데이터";
export const dataInterfaces = [
  { id: USB, name: "USB 데이터", roles: ["bidirectional"] },
  { id: USB4, name: "USB4 데이터", roles: ["bidirectional"] },
];
const DEFAULT_TRANSFER_MB_PER_SECOND = 800;
const request = { throughput: { value: DEFAULT_TRANSFER_MB_PER_SECOND, unit: MB_PER_SECOND } };
export const dataPresets = [
  { kind: BULK, name: "USB 데이터 전송", request },
  { kind: PCIE_TUNNEL, name: "PCIe 터널 전송", request },
];
