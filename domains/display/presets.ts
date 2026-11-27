// SPEC 4.4의 영상 작업 예시를 편집의 시작값으로 둔다.
export const displayDomainName = "영상";
const DEFAULT_VIDEO = { width: 3840, height: 2160, refresh: 240, bitsPerComponent: 10, chroma: "4:4:4" };

export const displayPresets = [{
  kind: "video", name: "영상 출력",
  request: {
    width: { value: DEFAULT_VIDEO.width, unit: "px" },
    height: { value: DEFAULT_VIDEO.height, unit: "px" },
    refresh: { value: DEFAULT_VIDEO.refresh, unit: "Hz" },
    bitsPerComponent: { value: DEFAULT_VIDEO.bitsPerComponent, unit: "bpc" },
    chroma: { value: DEFAULT_VIDEO.chroma, unit: "" },
  },
  labels: { width: "가로", height: "세로", refresh: "주사율", bitsPerComponent: "색 깊이",
    chroma: "색차 샘플링", dscBpp: "DSC 목표", fallbackRefresh: "대안 주사율" },
}];
