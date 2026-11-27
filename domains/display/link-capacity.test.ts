// 링크 용량을 공개 규격의 속도와 채널 인코딩 기준값에 대조한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dpAltModeCapacityGbps,
  dpLinkCapacityGbps,
  hdmiFrlCapacityGbps,
  hdmiTmdsCapacityGbps,
} from "./link-capacity.ts";

test("DP 4레인에서 HBR3는 25.92 Gbps, UHBR20은 77.58 Gbps다", () => {
  // 출처: VESA DP 2.0 발표 및 2019 DisplayPort Technology Update. UHBR20은 FEC 전 80 × 128/132.
  assert.equal(dpLinkCapacityGbps("HBR3", 4), 25.92);
  assert.equal(Number(dpLinkCapacityGbps("UHBR20", 4).toFixed(2)), 77.58);
});

test("DP Alt Mode에서 HBR3 핀 C는 25.92 Gbps, 핀 D는 12.96 Gbps다", () => {
  // 출처: VESA USB DevDays (2019) pp. 21–23, VESA SF Workshop (2025) DP Alt Mode Capability VDO.
  assert.equal(dpAltModeCapacityGbps("HBR3", "C"), 25.92);
  assert.equal(dpAltModeCapacityGbps("HBR3", "D"), 12.96);
});

test("HDMI TMDS의 최대 영상 인코딩 후 용량은 1.4에서 8.16 Gbps, 2.0에서 14.4 Gbps다", () => {
  // 출처: HDMI LA CES 2025 대역폭 도표의 10.2·18 Gbps, HDMI 1.4b §3, §5.4의 8/10.
  assert.equal(hdmiTmdsCapacityGbps("1.4"), 8.16);
  assert.equal(hdmiTmdsCapacityGbps("2.0"), 14.4);
});

test("HDMI FRL 코드 2는 16 Gbps, 코드 6은 42.67 Gbps다", () => {
  // 출처: HDMI FPGA IP User Guide §5.2, §5.5. 3 × 6과 4 × 12에 각각 16/18을 곱한다.
  assert.equal(hdmiFrlCapacityGbps(2), 16);
  assert.equal(Number(hdmiFrlCapacityGbps(6).toFixed(2)), 42.67);
});
