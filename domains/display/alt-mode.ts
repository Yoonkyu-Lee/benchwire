// USB-C DP Alt Mode의 양 끝 핀 주장을 설정별로 맞추고 USB 벌크에 남는 레인과 그 근거를 낸다.
import { readClaim, effectiveClaim, type Claim, type LaneProfile, type Link, type Scene } from "../../engine/contract.ts";
import { DP_ALT_MODE_PIN_ASSIGNMENTS, DP_FOUR_LANE_PROFILE, DP_TWO_LANE_PROFILE } from "./constants.ts";
import type { DpAltModePin } from "./link-capacity.ts";

export function pinValues(claim: Claim) {
  if (claim.ownerKind !== "interface" || claim.field !== "pin") return [];
  // 두 레인 설정은 지원과 거절 한 가지씩이면 된다. 기본 핀은 양 끝의 값 자체가 일치해야 한다.
  if (claim.condition === DP_TWO_LANE_PROFILE.id) return [...DP_TWO_LANE_PROFILE.pins, DP_FOUR_LANE_PROFILE.pins[0]];
  return DP_ALT_MODE_PIN_ASSIGNMENTS.map(row => row.pin);
}

export function supportsDisplayRole(role: string, wanted: string) {
  return role === "bidirectional" || role === wanted;
}

type Pair = readonly [number,number];
export function altModeProfiles(scene: Scene, pairs: readonly Pair[]) {
  return [DP_FOUR_LANE_PROFILE,DP_TWO_LANE_PROFILE].flatMap(({id,pins:allowed,usbLanes}) => {
    const matches = pairs.flatMap(pair => {
      const claims = pair.map(row => effectiveClaim(scene,"interface",row,"display","pin",id));
      const pinAt = (row: number | undefined) => row === undefined ? null : readClaim(scene,row).value as DpAltModePin | null;
      const pins = [pinAt(claims[0]),pinAt(claims[1])] as const;
      const [a,b] = pins, pin = a ?? b;
      if (pin !== null && !allowed.some(value => value === pin) || a !== null && b !== null && a !== b) return [];
      return [{ id, pins, usbLanes, inputs:claims.filter(row => row !== undefined) }];
    });
    const best = matches.find(m => !m.pins.includes(null)) ?? matches[0];
    return best ? [best] : [];
  });
}

export function usbLaneProfiles({scene,ports}: Link): LaneProfile[] {
  const ends = ports.map(port => scene.interfaces.flatMap((i,row) => i.port === port && i.domain === "display" &&
    i.protocol === "DP Alt Mode" ? [{row,role:i.role}] : []));
  if (ends.length < 2 || !ends.slice(1,-1).every(rows => rows.some(i => supportsDisplayRole(i.role,"bidirectional")))) return [];
  // 영상 신호가 반대 방향으로만 성립해도 이 링크의 USB 레인 배정은 양방향에 적용된다.
  const pairs = ends[0]!.flatMap(a => ends.at(-1)!.flatMap(b =>
    supportsDisplayRole(a.role,"source") && supportsDisplayRole(b.role,"sink") ||
    supportsDisplayRole(a.role,"sink") && supportsDisplayRole(b.role,"source") ? [[a.row,b.row] as const] : []));
  const profiles = altModeProfiles(scene,pairs);
  if (!profiles.length) return [];
  const service = {domain:"data",mode:"bulk"};
  return [{...service,profile:"usb-only",inputs:[]}, ...profiles.flatMap(p =>
    p.usbLanes && !p.pins.includes(null) ? [{...service,profile:p.id,maxLanes:p.usbLanes,inputs:p.inputs}] : [])];
}
