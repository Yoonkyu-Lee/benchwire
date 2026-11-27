// display 규격의 원시 속도, 활성 레인 수, 인코딩 비율에서 링크 한도를 계산한다.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DP_ALT_MODE_PIN_ASSIGNMENTS,
  DP_LINK_RATES,
  DP_MAX_LANES,
  DP_VERSION_MAX_LINK_RATES,
  HDMI_21_FRL_LINK_RATES,
  HDMI_FRL_CODING_EFFICIENCY,
  HDMI_TMDS_VERSION_LIMITS,
  HDMI_TMDS_VIDEO_CODING_EFFICIENCY,
} from "./constants.ts";

test("DP 1.4 소스와 DP 2.1 싱크의 규격 상한 중 낮은 쪽의 인코딩 후 한도는 25.92 Gbps다", () => {
  const sourceVersion = DP_VERSION_MAX_LINK_RATES.find(({ version }) => version === "1.4");
  const sinkVersion = DP_VERSION_MAX_LINK_RATES.find(({ version }) => version === "2.1");
  const source = DP_LINK_RATES.find(({ rate }) => rate === sourceVersion?.maxRate);
  const sink = DP_LINK_RATES.find(({ rate }) => rate === sinkVersion?.maxRate);
  assert.ok(source && sink);

  const sourceGbps = source.rawGbpsPerLane * DP_MAX_LANES * source.codingEfficiency;
  const sinkGbps = sink.rawGbpsPerLane * DP_MAX_LANES * sink.codingEfficiency;

  assert.equal(Math.min(sourceGbps, sinkGbps), 25.92);
  assert.ok(sinkGbps > sourceGbps);
});

test("Alt Mode에서 USB 3.x와 고속 차동쌍을 나눈 HBR3의 인코딩 후 한도는 12.96 Gbps다", () => {
  const shared = DP_ALT_MODE_PIN_ASSIGNMENTS.find(({ pin }) => pin === "D");
  const hbr3 = DP_LINK_RATES.find(({ rate }) => rate === "HBR3");
  assert.ok(shared && hbr3);

  assert.equal(hbr3.rawGbpsPerLane * shared.maxDpLanes * hbr3.codingEfficiency, 12.96);
});

test("HDMI TMDS의 원시 속도 상한과 영상 인코딩 비율에서 8.16 및 14.4 Gbps가 나온다", () => {
  const capacitiesGbps = HDMI_TMDS_VERSION_LIMITS.map(
    ({ maxRawGbps }) => maxRawGbps * HDMI_TMDS_VIDEO_CODING_EFFICIENCY,
  );

  assert.deepEqual(capacitiesGbps.toSorted((a, b) => a - b), [8.16, 14.4]);
});

test("HDMI FRL 원시 속도와 활성 레인 수에서 9–48 Gbps, 18 Gbps 모드의 인코딩 후 한도 16 Gbps가 나온다", () => {
  const capacitiesGbps = HDMI_21_FRL_LINK_RATES.map(({ lanes, rawGbpsPerLane }) => lanes * rawGbpsPerLane);

  assert.deepEqual(capacitiesGbps.toSorted((a, b) => a - b), [9, 18, 24, 32, 40, 48]);
  const mode = HDMI_21_FRL_LINK_RATES.find(({ code }) => code === 2);
  assert.ok(mode);
  assert.equal(mode.lanes * mode.rawGbpsPerLane * HDMI_FRL_CODING_EFFICIENCY, 16);
});
