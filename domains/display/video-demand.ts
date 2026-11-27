// CVT-RB v2 픽셀 클록과 비압축·DSC 영상 대역폭을 계산한다.
// 기본 순차주사 타이밍을 쓰며, 전송별 패킹과 DSC 슬라이스 오버헤드는 별도다.

import {
  CVT_RB_V2_HORIZONTAL_BLANK_PIXELS,
  CVT_RB_V2_MIN_VERTICAL_BLANK_LINES,
  CVT_RB_V2_MIN_VERTICAL_BLANK_US,
  CVT_RB_V2_PIXEL_CLOCK_STEP_HZ,
  VIDEO_CHROMA_SAMPLES,
} from "./constants.ts";

export type VideoChroma = (typeof VIDEO_CHROMA_SAMPLES)[number]["chroma"];

export function cvtRbV2PixelClockHz(widthPixels: number, heightLines: number, refreshHz: number): number {
  const framePeriodUs = 1_000_000 / refreshHz;
  const linePeriodUs = (framePeriodUs - CVT_RB_V2_MIN_VERTICAL_BLANK_US) / heightLines;
  const blankLines = Math.max(
    Math.floor(CVT_RB_V2_MIN_VERTICAL_BLANK_US / linePeriodUs) + 1,
    CVT_RB_V2_MIN_VERTICAL_BLANK_LINES,
  );
  const totalPixelsPerLine = widthPixels + CVT_RB_V2_HORIZONTAL_BLANK_PIXELS;
  const totalLines = heightLines + blankLines;
  const clockHz = totalPixelsPerLine * totalLines * refreshHz;
  return Math.floor(clockHz / CVT_RB_V2_PIXEL_CLOCK_STEP_HZ) * CVT_RB_V2_PIXEL_CLOCK_STEP_HZ;
}

export function uncompressedVideoBandwidthGbps(pixelClockHz: number, bitsPerComponent: number, chroma: VideoChroma): number {
  const { samplesPerPixel } = VIDEO_CHROMA_SAMPLES.find((row) => row.chroma === chroma)!;
  return videoBandwidthGbps(pixelClockHz, bitsPerComponent * samplesPerPixel);
}

export function videoBandwidthGbps(pixelClockHz: number, bitsPerPixel: number): number {
  return (pixelClockHz * bitsPerPixel) / 1_000_000_000;
}
