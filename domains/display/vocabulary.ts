// 영상 인터페이스의 표시 어휘와 SPEC 4.4의 영상 작업 시작값을 둔다.
import { z } from "zod";

const displayMode = z.strictObject({ value: z.string().regex(/^\d+×\d+@\d+(?:\.\d+)?$/), unit: z.literal("") });
export const displayQuests = [{ ownerKind: "connection", field: "displayMode", title: "현재 화면 모드", steps: [
  "Windows 설정 → 시스템 → 디스플레이 → 고급 디스플레이에서 대상 화면을 선택하세요.",
  "활성 신호 모드의 해상도와 새로 고침 빈도를 확인하세요.",
], read: "가로×세로@주사율 형식으로 입력하세요. 예를 들어 3840×2160@60입니다.",
observation: { schema: z.strictObject({ displayMode: displayMode.meta({ title: "현재 화면 모드" }) }) },
}];
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

export const displayCardStats = [
  { scope: "interface", field: "maxRate", label: "DP 전송 등급" },
  { scope: "interface", field: "frlCode", label: "HDMI FRL 코드" },
  { scope: "interface", field: "version", label: "DP 판본" },
  { scope: "interface", field: "tmdsVersion", label: "HDMI TMDS 판본" },
] as const;
