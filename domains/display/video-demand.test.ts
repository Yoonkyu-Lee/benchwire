// 공개 CVT-RB v2 타이밍과 영상 대역폭을 대조한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dpLinkCapacityGbps } from "./link-capacity.ts";
import { cvtRbV2PixelClockHz, uncompressedVideoBandwidthGbps, videoBandwidthGbps } from "./video-demand.ts";

// 출처: VESA CVT 1.2 §5.4. 표의 클록은 1 kHz 단위 내림 값을 쓴다.
const referenceModes = [
  // 522.614 MHz. https://canmycabledoit.com/modes/4k-60hz/ 의 CVT-RB v2 계산표
  { widthPixels: 3840, heightLines: 2160, refreshHz: 60, pixelClockHz: 522_614_000, gbps: 12.542736 },
  // 1075.804 MHz. https://canmycabledoit.com/modes/4k-120hz/ 의 CVT-RB v2 계산표
  { widthPixels: 3840, heightLines: 2160, refreshHz: 120, pixelClockHz: 1_075_804_000, gbps: 25.819296 },
  // 1306.206 MHz. https://canmycabledoit.com/modes/4k-144hz/ 의 CVT-RB v2 계산표
  { widthPixels: 3840, heightLines: 2160, refreshHz: 144, pixelClockHz: 1_306_206_000, gbps: 31.348944 },
  // 679.10 MHz. https://bbs.archlinux.org/viewtopic.php?id=267818 의 cvt12 2560 1440 165 -b 출력
  { widthPixels: 2560, heightLines: 1440, refreshHz: 165, pixelClockHz: 679_100_000, gbps: 16.2984 },
];

for (const { widthPixels, heightLines, refreshHz, pixelClockHz, gbps } of referenceModes) {
  test(`CVT-RB v2 ${widthPixels}×${heightLines} ${refreshHz} Hz의 픽셀 클록과 8 bpc 4:4:4 수요`, () => {
    const actualClockHz = cvtRbV2PixelClockHz(widthPixels, heightLines, refreshHz);

    assert.equal(actualClockHz, pixelClockHz);
    assert.equal(uncompressedVideoBandwidthGbps(actualClockHz, 8, "4:4:4"), gbps);
  });
}

test("수직 블랭킹 시간으로 계산한 줄 수가 작으면 최소 15줄을 쓴다", () => {
  // 출처: VESA CVT 1.2 §5.4. 640×480 24 Hz: 720×495 × 24 Hz = 8.5536 MHz를 8.553 MHz로 내림.
  assert.equal(cvtRbV2PixelClockHz(640, 480, 24), 8_553_000);
});

test("100 MHz·10 bpc에서 크로마 표본 수에 따라 비압축 수요가 달라진다", () => {
  // 출처: ITU-T H.266 표 2. 픽셀당 3, 2, 1.5 표본에서 각각 30, 20, 15 bpp.
  assert.equal(uncompressedVideoBandwidthGbps(100_000_000, 10, "4:4:4"), 3);
  assert.equal(uncompressedVideoBandwidthGbps(100_000_000, 10, "4:2:2"), 2);
  assert.equal(uncompressedVideoBandwidthGbps(100_000_000, 10, "4:2:0"), 1.5);
});

test("3840×2160 144 Hz·10 bpc는 HBR3 4레인에 12 bpp로 압축하면 들어간다", () => {
  // 출처: VESA CVT 1.2 §5.4, VESA HBR3 발표, VESA DisplayPort DSC FAQ의 12 bpp 산출 예.
  const pixelClockHz = cvtRbV2PixelClockHz(3840, 2160, 144);
  const uncompressedGbps = uncompressedVideoBandwidthGbps(pixelClockHz, 10, "4:4:4");
  const compressedGbps = videoBandwidthGbps(pixelClockHz, 12);
  const linkGbps = dpLinkCapacityGbps("HBR3", 4);

  assert.equal(uncompressedGbps, 39.18618);
  assert.equal(compressedGbps, 15.674472);
  assert.ok(compressedGbps < linkGbps && linkGbps < uncompressedGbps);
});
