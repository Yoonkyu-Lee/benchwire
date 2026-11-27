// DSC 전송 옵션의 양 끝과 수요가 지정한 목표 bpp를 대조한다.
import { readClaim, compareQuantity, type Demand, type Link, type Option, type Trace, type Verdict } from "../../engine/contract.ts";
import { DSC } from "./sources.ts";

export const DSC_MODE = "dsc";

export interface DisplayOption extends Option {
  encoderClaim?: number;
  decoderClaim?: number;
}

export interface DisplayDemand extends Demand {
  dscBpp?: number | null;
  dscClaim?: number;
}

export function matchDisplay({ scene }: Link, option: DisplayOption, demand: DisplayDemand): Trace & { verdict: Verdict } {
  if (demand.mode !== DSC_MODE)
    return { verdict: "ok", rule: "요청한 비압축 영상 모드 일치", inputs: [], specs: [] };

  const inputs = [option.encoderClaim, option.decoderClaim, demand.dscClaim].filter(claim => claim !== undefined);
  const encoder = option.encoderClaim === undefined ? null : readClaim(scene,option.encoderClaim).value;
  const decoder = option.decoderClaim === undefined ? null : readClaim(scene,option.decoderClaim).value;
  const target = demand.dscBpp ?? null;
  const rejects = (capability: typeof encoder) => capability === 0 ||
    (capability !== null && target !== null && (typeof capability !== "number" || compareQuantity(capability,target) !== 0));
  const blocked = [rejects(encoder) ? "송신 인코더" : "", rejects(decoder) ? "수신 디코더" : ""].filter(Boolean);
  const proof = { inputs, specs: [DSC] };

  if (blocked.length)
    return { ...proof, verdict: "impossible", rule: target === null
      ? blocked.join("·") + "의 DSC 미지원"
      : `${blocked.join("·")}가 DSC 목표 ${target} bpp를 지원하지 않음` };
  if (target === null || encoder === null || decoder === null)
    return { ...proof, verdict: "unknown", rule: "DSC 목표 bpp 또는 송신 인코더·수신 디코더의 지원값 미확인" };
  return { ...proof, verdict: "conditional", rule: `송신 인코더와 수신 디코더가 DSC ${target} bpp로 동작할 때` };
}
