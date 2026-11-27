// 장면의 유효 주장과 프로토콜 선언을 읽고 네트워크 판정이 인용할 행을 모은다.
import { effectiveClaim, type Claim, type Scene } from "../../engine/contract.ts";
import { CHANNEL, NETWORK } from "./input.ts";

export function readNetworkClaim(scene: Scene, inputs: number[], kind: Claim["ownerKind"], owner: number, field: string) {
  const row = effectiveClaim(scene, kind, owner, NETWORK, field);
  if (row === undefined) return null;
  inputs.push(row);
  return scene.claims[row]!.value;
}

export function networkInterface(scene: Scene, inputs: number[], port: number, protocol: string, role: string) {
  let row: number | undefined;
  scene.interfaces.forEach((entry, i) => {
    if (entry.port !== port) return;
    inputs.push(entry.evidence);
    if (entry.domain === NETWORK && entry.protocol === protocol && entry.role === role) row = i;
  });
  return row;
}

export function channelPortsMatch(scene: Scene, inputs: number[], ports: number[]) {
  const rows = ports.slice(1, -1).map(port => networkInterface(scene, inputs, port, CHANNEL, "bidirectional"));
  return rows.every(row => row !== undefined);
}
