// 영상 인터페이스의 표시 어휘와 SPEC 4.4의 영상 작업 시작값을 둔다.
export const displayDomainName = "영상";
const roles = ["source", "sink", "bidirectional"] as const;
export const displayInterfaces = [
  { id: "DP", name: "DisplayPort", roles },
  { id: "DP Tunnel", name: "DisplayPort 터널", roles },
  { id: "DP Alt Mode", name: "DisplayPort 대체 모드", roles },
  { id: "HDMI", name: "HDMI", roles },
];
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
}];
