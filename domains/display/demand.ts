// 요청 해상도·색과 허용한 DSC·주사율 폴백을 고정 영상 대역폭 행으로 바꾼다.
import { effectiveClaim, type Demand, type Scene } from "../../engine/contract.ts";
import { CHROMA, CVT_RB_V2, DSC } from "./sources.ts";
import { cvtRbV2PixelClockHz, uncompressedVideoBandwidthGbps, videoBandwidthGbps, type VideoChroma } from "./video-demand.ts";

export const UNCOMPRESSED = "uncompressed";
export const SUBSAMPLED = "uncompressed:subsampled";
export const DSC_PREFIX = "dsc:";
export const VIDEO_UNIT = "Gbps";

export function dscTarget(scene: Scene, workload: number) {
  const claim = effectiveClaim(scene, "workload", workload, "display", "dscBpp");
  return claim === undefined ? undefined : { claim, value: scene.claims[claim]!.value as number | null };
}

export function displayDemand(scene: Scene, workload: number): Demand[] {
  const inputs: number[] = [];
  function read(field: string) {
    const row = effectiveClaim(scene, "workload", workload, "display", field);
    if (row === undefined) return null;
    inputs.push(row);
    return scene.claims[row]!.value;
  }

  const width = read("width") as number | null;
  const height = read("height") as number | null;
  const bpc = read("bitsPerComponent") as number | null;
  const chroma = read("chroma") as VideoChroma | null;
  const refresh = read("refresh") as number | null;
  const requestInputs = [...inputs];
  const mode = chroma === null || chroma === "4:4:4" ? UNCOMPRESSED : SUBSAMPLED;
  const specs = [CVT_RB_V2, CHROMA];
  const common = { unit: VIDEO_UNIT, elastic: false, via: [] };

  function clock(hz: number | null) {
    if (width === null || height === null || hz === null) return null;
    const value = cvtRbV2PixelClockHz(width, height, hz);
    return value > 0 && Number.isFinite(value) ? value : null;
  }

  function uncompressed(pixelClock: number | null) {
    if (pixelClock === null || bpc === null || chroma === null) return null;
    return uncompressedVideoBandwidthGbps(pixelClock, bpc, chroma);
  }

  const requestedClock = clock(refresh);
  const demands: Demand[] = [{
    ...common, mode, preference: 0, requested: uncompressed(requestedClock),
    rule: "CVT-RB v2 요청 타이밍의 비압축 영상 대역폭", inputs: requestInputs, specs,
  }];
  const target = dscTarget(scene, workload);
  if (target) {
    demands.push({
      ...common, mode: DSC_PREFIX + (target.value ?? "unknown"), preference: 1,
      requested: requestedClock === null || bpc === null || chroma === null || target.value === null ? null : videoBandwidthGbps(requestedClock, target.value),
      rule: target.value === null ? "요청 타이밍의 DSC 목표 bpp 미확인" : `요청 타이밍에 허용한 DSC ${target.value} bpp 영상 대역폭`, inputs: [...requestInputs, target.claim], specs: [...specs, DSC],
    });
  }
  const fallbackClaim = effectiveClaim(scene, "workload", workload, "display", "fallbackRefresh");
  if (fallbackClaim !== undefined) {
    const fallback = scene.claims[fallbackClaim]!.value as number | null;
    if (fallback === null || refresh === null || fallback < refresh) {
      demands.push({
        ...common, mode, preference: 2, requested: uncompressed(clock(fallback)),
        rule: fallback === null ? "허용한 폴백 주사율 미확인" : `허용한 ${fallback} Hz 폴백의 비압축 영상 대역폭`,
        inputs: [...requestInputs, fallbackClaim], specs,
      });
    }
  }
  return demands;
}
